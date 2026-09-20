/**
 * Direct Arc Mainnet USDC Send: validation, the reviewed snapshot, and a
 * one-shot executor. The executor re-checks the wallet immediately before
 * asking for a signature and never runs twice for one review.
 */
import { MAINNET, checkRecipient, describeTxError, feeBlocker, formatUsdc, isRevertedReceiptError, parseUsdcAmount, sameAddress, sameChain } from "./mainnetPayments";

export type SendInput = { recipient: string; amount: string };
export type SendErrors = Partial<Record<keyof SendInput, string>>;

export type WalletSnapshot = {
  account: string | null;
  chainIdHex: string | null;
  /** ERC-20 USDC balance of `account`, or null when it could not be read. */
  balanceAtomic: bigint | null;
  /** Native (18-decimal) balance. On Arc the same funds as balanceAtomic, and where the network fee is paid from. */
  nativeWei?: bigint | null;
};

export type SendReview = {
  account: string;
  chainIdHex: string;
  recipient: string;
  amountAtomic: bigint;
  token: string;
  balanceAtomic: bigint;
  /** Estimated network fee in native wei at the current maximum fee rate, or null when the network could not simulate. */
  feeEstimateWei: bigint | null;
};

export function validateSend(input: SendInput, account: string | null): { errors: SendErrors; recipient?: string; amountAtomic?: bigint } {
  const errors: SendErrors = {};
  const to = checkRecipient(input.recipient, account);
  if (!to.ok) errors.recipient = to.error;
  const amount = parseUsdcAmount(input.amount);
  if (!amount.ok) errors.amount = amount.error;
  return {
    errors,
    recipient: to.ok ? to.address : undefined,
    amountAtomic: amount.ok ? amount.value : undefined,
  };
}

/** Why a send cannot proceed with this wallet state, or null. Order matters: most actionable first. */
export function walletBlocker(wallet: WalletSnapshot, amountAtomic: bigint | null, feeWei: bigint | null = null): string | null {
  if (!wallet.account) return "Connect your wallet on Arc Mainnet to continue.";
  if (!sameChain(wallet.chainIdHex, MAINNET.chainIdHex)) return "Your wallet is not on Arc Mainnet (chain 5042). Switch networks explicitly to continue.";
  if (wallet.balanceAtomic === null) return "Could not read your USDC balance because Arc Mainnet's RPC is unavailable. Try again shortly.";
  if (amountAtomic !== null && wallet.balanceAtomic < amountAtomic) {
    return `Insufficient USDC balance: you have ${formatUsdc(wallet.balanceAtomic)} USDC and this payment needs ${formatUsdc(amountAtomic)} USDC.`;
  }
  return amountAtomic === null ? null : feeBlocker(wallet.nativeWei, amountAtomic, feeWei);
}

export function buildSendReview(input: SendInput, wallet: WalletSnapshot, feeEstimateWei: bigint | null = null): { review?: SendReview; errors: SendErrors; blocker: string | null } {
  const checked = validateSend(input, wallet.account);
  const blocker = Object.keys(checked.errors).length ? null : walletBlocker(wallet, checked.amountAtomic ?? null, feeEstimateWei);
  if (Object.keys(checked.errors).length || blocker || !wallet.account || !wallet.chainIdHex || wallet.balanceAtomic === null) {
    return { errors: checked.errors, blocker };
  }
  return {
    errors: {},
    blocker: null,
    review: {
      account: wallet.account,
      chainIdHex: wallet.chainIdHex,
      recipient: checked.recipient!,
      amountAtomic: checked.amountAtomic!,
      token: MAINNET.usdc,
      balanceAtomic: wallet.balanceAtomic,
      feeEstimateWei,
    },
  };
}

/** Anything that differs from what the payer reviewed stops the send. Balance may move as long as it still covers the amount. */
export function sendReviewChange(reviewed: SendReview, live: { recipient: string; amountAtomic: bigint | null; wallet: WalletSnapshot }): string | null {
  if (!sameAddress(reviewed.account, live.wallet.account)) return "The selected wallet account changed.";
  if (!sameChain(reviewed.chainIdHex, live.wallet.chainIdHex)) return "The wallet network changed.";
  if (!sameAddress(reviewed.recipient, live.recipient)) return "The recipient changed.";
  if (live.amountAtomic === null || reviewed.amountAtomic !== live.amountAtomic) return "The amount changed.";
  return walletBlocker(live.wallet, reviewed.amountAtomic, reviewed.feeEstimateWei);
}

export type SendState =
  | { phase: "checking" }
  | { phase: "blocked"; reason: string }
  | { phase: "awaiting-wallet" }
  | { phase: "submitted"; hash: string }
  | { phase: "confirmed"; hash: string; blockNumber: number | null; at: number }
  | { phase: "reverted"; hash: string }
  | { phase: "rejected"; message: string }
  | { phase: "error"; message: string };

export type SubmittedTx = { hash: string; wait: () => Promise<{ status: number | null; blockNumber?: number | null } | null> };

/**
 * One transaction per review. A second call while one is in flight, or after a
 * transaction has been broadcast for this review, does nothing. Create a new
 * executor for each review.
 */
export function createSendExecutor(deps: {
  readWallet: () => Promise<WalletSnapshot>;
  live: () => { recipient: string; amountAtomic: bigint | null };
  submit: (review: SendReview) => Promise<SubmittedTx>;
  onState: (state: SendState) => void;
  now?: () => number;
}) {
  let inFlight = false;
  let done = false;
  const now = deps.now ?? Date.now;
  return async function send(review: SendReview): Promise<void> {
    if (inFlight || done) return;
    inFlight = true;
    try {
      deps.onState({ phase: "checking" });
      let wallet: WalletSnapshot;
      try { wallet = await deps.readWallet(); }
      catch (error) { deps.onState({ phase: "blocked", reason: describeTxError(error, "payment").message }); return; }
      const changed = sendReviewChange(review, { ...deps.live(), wallet });
      if (changed) { deps.onState({ phase: "blocked", reason: `${changed} Review the payment again. Nothing was sent.` }); return; }

      deps.onState({ phase: "awaiting-wallet" });
      let tx: SubmittedTx;
      try { tx = await deps.submit(review); }
      catch (error) {
        const failure = describeTxError(error, "payment");
        deps.onState(failure.kind === "rejected" ? { phase: "rejected", message: failure.message } : { phase: "error", message: failure.message });
        return;
      }
      // One broadcast per review, whatever happens next: an unknown outcome must
      // never be answered by sending again from the same review.
      done = true;
      deps.onState({ phase: "submitted", hash: tx.hash });
      try {
        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) {
          deps.onState({ phase: "confirmed", hash: tx.hash, blockNumber: receipt.blockNumber ?? null, at: now() });
        } else if (receipt && receipt.status === 0) {
          deps.onState({ phase: "reverted", hash: tx.hash });
        } else {
          deps.onState({ phase: "error", message: `The transaction ${tx.hash} was submitted but its result could not be confirmed. Check the explorer before trying again.` });
        }
      } catch (error) {
        if (isRevertedReceiptError(error)) { deps.onState({ phase: "reverted", hash: tx.hash }); return; }
        const failure = describeTxError(error, "payment");
        deps.onState({ phase: "error", message: `${failure.message} The transaction ${tx.hash} may still confirm; check the explorer before trying again.` });
      }
    } finally {
      inFlight = false;
    }
  };
}
