/**
 * Arc Mainnet Multisend / Payouts: CSV parsing, batch validation, the fee math
 * of the DEPLOYED ArcFXMultisender, the reviewed snapshot, and a two-step
 * (approve, then execute) executor. bigint only; no floats.
 *
 * Deployed contract (Mainnet 0xc37D…45D3, verified against the release record):
 *   multisendFree(token, recipients[], amounts[])  1..5 recipients, no fee
 *   multisend(token, recipients[], amounts[])      1..500 recipients,
 *       fee = floor(total * 10 / 10000), pulled in addition to the total
 *   Both revert on a zero recipient, a zero amount, or a length mismatch; both
 *   check allowance and balance for total + fee; the whole batch is atomic.
 */
import { id as keccakUtf8 } from "ethers";
import {
  MAINNET, MULTISENDER, checkRecipient, describeTxError, feeBlocker, formatUsdc, isRevertedReceiptError, parseUsdcAmount, sameAddress, sameChain,
} from "./mainnetPayments";
import { allowanceAction, allowanceTransition } from "../payer/mainnetInvoice";
import type { SubmittedTx } from "./sendCore";

// ── Fee math: the exact Solidity integer arithmetic ───────────────────────────

export type BatchFunction = "multisendFree" | "multisend";

/** `fee = isPro ? (total * FEE_BPS) / BPS_DENOM : 0` (floor). */
export function contractBatchFee(total: bigint, isPro: boolean): bigint {
  return isPro ? (total * MULTISENDER.feeBps) / MULTISENDER.bpsDenom : 0n;
}

/** `pull = total + fee`: what the wallet is debited and what must be allowed. */
export function contractBatchPull(total: bigint, isPro: boolean): bigint {
  return total + contractBatchFee(total, isPro);
}

/** The contract has no free-tier switch: ≤5 recipients can use the fee-free function, more must use the Pro function. */
export function functionFor(count: number): BatchFunction {
  return count <= MULTISENDER.freeLimit ? "multisendFree" : "multisend";
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export type CsvRow = { line: number; recipient: string; amount: string; reference: string };
export type CsvError = { line: number; message: string };
export type CsvParse = { rows: CsvRow[]; errors: CsvError[]; hadHeader: boolean };

export const CSV_MAX_BYTES = 512 * 1024;
export const CSV_MAX_LINES = 5_000;
const REFERENCE_MAX = 80;

function splitLine(text: string, delimiter: string): { cells: string[]; unbalanced: boolean } {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell);
  return { cells: cells.map((v) => v.trim()), unbalanced: quoted };
}

function detectDelimiter(firstLine: string): string {
  let best = ",", bestCount = -1;
  for (const d of [",", ";", "\t"]) {
    const count = splitLine(firstLine, d).cells.length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Parse `recipient,amount[,reference]` locally. Never skips a bad row: every
 * structural problem is returned with its 1-based line number, and a file with
 * any structural error is meant to be rejected whole.
 */
export function parseCsv(text: string): CsvParse {
  const errors: CsvError[] = [];
  const rows: CsvRow[] = [];
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(source).length > CSV_MAX_BYTES) {
    return { rows, errors: [{ line: 0, message: `The file is larger than ${CSV_MAX_BYTES / 1024} KB. A batch holds at most ${MULTISENDER.maxLimit} recipients.` }], hadHeader: false };
  }
  const lines = source.split(/\r\n|\n|\r/);
  if (lines.length > CSV_MAX_LINES) {
    return { rows, errors: [{ line: 0, message: `The file has more than ${CSV_MAX_LINES} lines. A batch holds at most ${MULTISENDER.maxLimit} recipients.` }], hadHeader: false };
  }
  const firstContent = lines.find((l) => l.trim() !== "");
  if (firstContent === undefined) return { rows, errors: [{ line: 0, message: "The file is empty." }], hadHeader: false };
  const delimiter = detectDelimiter(firstContent);
  let hadHeader = false, headerChecked = false;
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return; // a blank line is not a row
    const { cells, unbalanced } = splitLine(raw, delimiter);
    if (unbalanced) { errors.push({ line, message: "A quoted value is missing its closing quote." }); return; }
    if (!headerChecked) {
      headerChecked = true;
      if (/^(recipient|address|wallet|to)$/i.test(cells[0]) && /^(amount|value|usdc)$/i.test(cells[1] ?? "")) { hadHeader = true; return; }
    }
    if (cells.length < 2) { errors.push({ line, message: "Expected recipient and amount separated by a comma." }); return; }
    if (cells.length > 3) { errors.push({ line, message: `Expected at most 3 columns (recipient, amount, reference) but found ${cells.length}. If an amount contains a comma, remove it.` }); return; }
    const reference = cells[2] ?? "";
    if (reference.length > REFERENCE_MAX) { errors.push({ line, message: `The reference is longer than ${REFERENCE_MAX} characters.` }); return; }
    rows.push({ line, recipient: cells[0], amount: cells[1], reference });
  });
  return { rows, errors, hadHeader };
}

/** The example address is deliberately INVALID so an unedited template can never move funds. */
export const CSV_TEMPLATE = "recipient,amount,reference\n0xREPLACE_WITH_RECIPIENT_ADDRESS,10.00,Invoice 1042\n";

// ── Batch validation ──────────────────────────────────────────────────────────

export type BatchRowInput = { line: number; recipient: string; amount: string; reference?: string };
export type BatchEntry = { line: number; recipient: string; amountAtomic: bigint; reference: string };
export type RowError = { line: number; field: "recipient" | "amount"; message: string };

export type Batch = {
  entries: BatchEntry[];
  rowErrors: RowError[];
  /** Problems with the batch as a whole (count limits). */
  batchErrors: string[];
  duplicates: Array<{ recipient: string; lines: number[] }>;
  count: number;
  fn: BatchFunction;
  isPro: boolean;
  totalAtomic: bigint;
  feeAtomic: bigint;
  pullAtomic: bigint;
  valid: boolean;
};

export function buildBatch(rows: BatchRowInput[], opts: { sender: string | null; allowDuplicates?: boolean }): Batch {
  const rowErrors: RowError[] = [];
  const batchErrors: string[] = [];
  const entries: BatchEntry[] = [];
  for (const row of rows) {
    const to = checkRecipient(row.recipient, opts.sender);
    const amount = parseUsdcAmount(row.amount);
    if (!to.ok) rowErrors.push({ line: row.line, field: "recipient", message: to.error });
    if (!amount.ok) rowErrors.push({ line: row.line, field: "amount", message: amount.error });
    if (to.ok && amount.ok) entries.push({ line: row.line, recipient: to.address, amountAtomic: amount.value, reference: row.reference ?? "" });
  }
  const seen = new Map<string, number[]>();
  for (const e of entries) seen.set(e.recipient.toLowerCase(), [...(seen.get(e.recipient.toLowerCase()) || []), e.line]);
  const duplicates = [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([recipient, lines]) => ({ recipient, lines }));
  if (duplicates.length && !opts.allowDuplicates) {
    for (const d of duplicates) for (const line of d.lines) {
      rowErrors.push({ line, field: "recipient", message: `This address also appears on line ${d.lines.filter((l) => l !== line).join(", ")}. Confirm duplicates are intended to continue.` });
    }
  }
  if (rows.length === 0) batchErrors.push("Add at least one recipient.");
  if (rows.length > MULTISENDER.maxLimit) batchErrors.push(`Too many recipients: ${rows.length}. One batch holds at most ${MULTISENDER.maxLimit}.`);
  const count = rows.length;
  const fn = functionFor(count);
  const isPro = fn === "multisend";
  const totalAtomic = entries.reduce((sum, e) => sum + e.amountAtomic, 0n);
  const feeAtomic = contractBatchFee(totalAtomic, isPro);
  return {
    entries, rowErrors, batchErrors, duplicates, count, fn, isPro, totalAtomic, feeAtomic,
    pullAtomic: totalAtomic + feeAtomic,
    valid: rows.length > 0 && rowErrors.length === 0 && batchErrors.length === 0 && entries.length === rows.length,
  };
}

// ── Review snapshot ───────────────────────────────────────────────────────────

export type BatchReview = {
  account: string;
  chainIdHex: string;
  token: string;
  contract: string;
  fn: BatchFunction;
  count: number;
  recipients: string[];
  amounts: bigint[];
  /** keccak256 of the ordered recipient/amount list, so a swap of any row is detected. */
  listHash: string;
  totalAtomic: bigint;
  feeAtomic: bigint;
  pullAtomic: bigint;
  balanceAtomic: bigint;
  /** Estimated network fee (native wei) of the NEXT wallet step: the approval, or the batch once approved. Refreshed after approval. */
  feeEstimateWei: bigint | null;
};

export function hashList(recipients: string[], amounts: bigint[]): string {
  return keccakUtf8(recipients.map((r, i) => `${r.toLowerCase()}:${amounts[i].toString()}`).join("|"));
}

export type BatchWallet = { account: string | null; chainIdHex: string | null; balanceAtomic: bigint | null; allowanceAtomic: bigint | null; nativeWei?: bigint | null };

export function batchWalletBlocker(wallet: BatchWallet, pullAtomic: bigint, feeWei: bigint | null = null): string | null {
  if (!wallet.account) return "Connect your wallet on Arc Mainnet to continue.";
  if (!sameChain(wallet.chainIdHex, MAINNET.chainIdHex)) return "Your wallet is not on Arc Mainnet (chain 5042). Switch networks explicitly to continue.";
  if (wallet.balanceAtomic === null) return "Could not read your USDC balance because Arc Mainnet's RPC is unavailable. Try again shortly.";
  if (wallet.balanceAtomic < pullAtomic) {
    return `Insufficient USDC balance: this batch debits ${formatUsdc(pullAtomic)} USDC (recipients plus fee) and you have ${formatUsdc(wallet.balanceAtomic)} USDC.`;
  }
  return feeBlocker(wallet.nativeWei, pullAtomic, feeWei);
}

export function buildBatchReview(batch: Batch, wallet: BatchWallet, feeEstimateWei: bigint | null = null): { review?: BatchReview; blocker: string | null } {
  if (!batch.valid) return { blocker: null };
  const blocker = batchWalletBlocker(wallet, batch.pullAtomic, feeEstimateWei);
  if (blocker || !wallet.account || !wallet.chainIdHex || wallet.balanceAtomic === null) return { blocker };
  const recipients = batch.entries.map((e) => e.recipient);
  const amounts = batch.entries.map((e) => e.amountAtomic);
  return {
    blocker: null,
    review: {
      account: wallet.account, chainIdHex: wallet.chainIdHex, token: MAINNET.usdc, contract: MAINNET.multisender,
      fn: batch.fn, count: batch.count, recipients, amounts, listHash: hashList(recipients, amounts),
      totalAtomic: batch.totalAtomic, feeAtomic: batch.feeAtomic, pullAtomic: batch.pullAtomic, balanceAtomic: wallet.balanceAtomic, feeEstimateWei,
    },
  };
}

/** The reviewed batch versus a fresh build of the form. Any difference returns the user to Review. */
export function batchReviewChange(reviewed: BatchReview, live: Batch, wallet: BatchWallet): string | null {
  if (!sameAddress(reviewed.account, wallet.account)) return "The selected wallet account changed.";
  if (!sameChain(reviewed.chainIdHex, wallet.chainIdHex)) return "The wallet network changed.";
  if (reviewed.token.toLowerCase() !== MAINNET.usdc.toLowerCase() || !sameAddress(reviewed.contract, MAINNET.multisender)) return "The token or contract does not match Arc Mainnet USDC and the ArcFX Multisender.";
  if (!live.valid) return "The batch was edited and is no longer valid.";
  const recipients = live.entries.map((e) => e.recipient);
  const amounts = live.entries.map((e) => e.amountAtomic);
  if (live.count !== reviewed.count || hashList(recipients, amounts) !== reviewed.listHash) return "The recipient list or an amount changed.";
  if (live.fn !== reviewed.fn) return "The contract function changed.";
  if (live.totalAtomic !== reviewed.totalAtomic || live.feeAtomic !== reviewed.feeAtomic || live.pullAtomic !== reviewed.pullAtomic) return "The total or fee changed.";
  return batchWalletBlocker(wallet, reviewed.pullAtomic, reviewed.feeEstimateWei);
}

// ── Executor: approve exactly, then execute, one mutation at a time ──────────

export type BatchState =
  | { phase: "checking" }
  | { phase: "blocked"; reason: string }
  | { phase: "not-needed"; message: string }
  | { phase: "approval-awaiting-wallet" }
  | { phase: "approval-submitted"; hash: string }
  | { phase: "approved"; hash: string }
  | { phase: "approval-unsynced"; hash: string }
  | { phase: "execute-awaiting-wallet" }
  | { phase: "submitted"; hash: string }
  | { phase: "confirmed"; hash: string; blockNumber: number | null; at: number }
  | { phase: "reverted"; hash: string }
  | { phase: "rejected"; message: string }
  | { phase: "error"; message: string };

export function createBatchExecutor(deps: {
  readWallet: () => Promise<BatchWallet>;
  live: () => Batch;
  approve: (amountAtomic: bigint) => Promise<SubmittedTx>;
  execute: (review: BatchReview) => Promise<SubmittedTx>;
  onState: (state: BatchState) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  syncAttempts?: number;
}) {
  let inFlight = false;
  let executed = false;
  let approvedPull: bigint | null = null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const attempts = deps.syncAttempts ?? 8;

  async function guard(review: BatchReview): Promise<BatchWallet | null> {
    deps.onState({ phase: "checking" });
    let wallet: BatchWallet;
    try { wallet = await deps.readWallet(); }
    catch (error) { deps.onState({ phase: "blocked", reason: describeTxError(error, "batch").message }); return null; }
    const changed = batchReviewChange(review, deps.live(), wallet);
    if (changed) { deps.onState({ phase: "blocked", reason: `${changed} Review the batch again. Nothing was sent.` }); return null; }
    return wallet;
  }

  async function approve(review: BatchReview): Promise<void> {
    if (inFlight || executed) return;
    inFlight = true;
    try {
      const wallet = await guard(review);
      if (!wallet) return;
      const step = allowanceTransition(wallet.allowanceAtomic ?? 0n, review.pullAtomic, approvedPull);
      if (wallet.allowanceAtomic === null) { deps.onState({ phase: "blocked", reason: "Could not read your USDC allowance because Arc Mainnet's RPC is unavailable. Try again shortly." }); return; }
      if (step !== "needs-approval") { deps.onState({ phase: "not-needed", message: "Your USDC allowance already covers this batch. Review it and click Execute batch." }); return; }
      deps.onState({ phase: "approval-awaiting-wallet" });
      let tx: SubmittedTx;
      try { tx = await deps.approve(review.pullAtomic); }
      catch (error) {
        const failure = describeTxError(error, "approval");
        deps.onState(failure.kind === "rejected" ? { phase: "rejected", message: failure.message } : { phase: "error", message: failure.message });
        return;
      }
      deps.onState({ phase: "approval-submitted", hash: tx.hash });
      try {
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) { deps.onState({ phase: "error", message: "The approval transaction did not succeed. No batch was sent." }); return; }
      } catch (error) {
        const reverted = isRevertedReceiptError(error);
        deps.onState({ phase: "error", message: reverted ? "The approval transaction reverted. No batch was sent." : `${describeTxError(error, "approval").message} The approval ${tx.hash} may still confirm; reload before approving again.` });
        return;
      }
      approvedPull = review.pullAtomic;
      // A wallet RPC can briefly serve the pre-approval allowance. Re-read a few
      // times rather than asking for a second approval.
      let latest: BatchWallet | null = null;
      for (let i = 0; i < attempts; i++) {
        try { latest = await deps.readWallet(); } catch { latest = null; }
        if (latest?.allowanceAtomic !== null && latest?.allowanceAtomic !== undefined && allowanceAction(latest.allowanceAtomic, review.pullAtomic) === "pay") break;
        await sleep(1500);
      }
      if (!latest || latest.allowanceAtomic === null || allowanceAction(latest.allowanceAtomic, review.pullAtomic) !== "pay") {
        deps.onState({ phase: "approval-unsynced", hash: tx.hash });
        return;
      }
      const changed = batchReviewChange(review, deps.live(), latest);
      if (changed) { deps.onState({ phase: "blocked", reason: `${changed} Review the batch again. Nothing was sent.` }); return; }
      deps.onState({ phase: "approved", hash: tx.hash });
    } finally {
      inFlight = false;
    }
  }

  async function execute(review: BatchReview): Promise<void> {
    if (inFlight || executed) return;
    inFlight = true;
    try {
      const wallet = await guard(review);
      if (!wallet) return;
      if (wallet.allowanceAtomic === null) { deps.onState({ phase: "blocked", reason: "Could not read your USDC allowance because Arc Mainnet's RPC is unavailable. Try again shortly." }); return; }
      if (allowanceAction(wallet.allowanceAtomic, review.pullAtomic) !== "pay") {
        deps.onState({ phase: "blocked", reason: "Your USDC allowance no longer covers this batch. Approve the exact amount first. Nothing was sent." });
        return;
      }
      deps.onState({ phase: "execute-awaiting-wallet" });
      let tx: SubmittedTx;
      try { tx = await deps.execute(review); }
      catch (error) {
        const failure = describeTxError(error, "batch");
        deps.onState(failure.kind === "rejected" ? { phase: "rejected", message: failure.message } : { phase: "error", message: failure.message });
        return;
      }
      executed = true; // one broadcast per review
      deps.onState({ phase: "submitted", hash: tx.hash });
      try {
        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) deps.onState({ phase: "confirmed", hash: tx.hash, blockNumber: receipt.blockNumber ?? null, at: now() });
        else if (receipt && receipt.status === 0) deps.onState({ phase: "reverted", hash: tx.hash });
        else deps.onState({ phase: "error", message: `The transaction ${tx.hash} was submitted but its result could not be confirmed. Check the explorer before trying again.` });
      } catch (error) {
        if (isRevertedReceiptError(error)) { deps.onState({ phase: "reverted", hash: tx.hash }); return; }
        deps.onState({ phase: "error", message: `${describeTxError(error, "batch").message} The transaction ${tx.hash} may still confirm; check the explorer before trying again.` });
      }
    } finally {
      inFlight = false;
    }
  }

  return { approve, execute };
}
