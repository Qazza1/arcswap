import { BrowserProvider, Contract, formatUnits } from "ethers";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";
import {
  ARC_MAINNET_PAYER,
  allowanceAction,
  allowanceTransition,
  authoritativeMainnetPayment,
  contractFee,
  contractNet,
  grossForNet,
  reviewChange,
  type AuthoritativePayment,
  type PaymentReview,
  type PublicInvoice,
} from "./mainnetInvoice";
import "./payer.css";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const PAYMENTS_ABI = [
  "function pay(address token, address recipient, uint256 gross, bytes32 paymentId) external",
  "function quoteFee(uint256 gross) view returns (uint256 fee, uint256 net)",
  "function FEE_BPS() view returns (uint256)",
];

const root = document.getElementById("payer-root");
const invoiceId = new URLSearchParams(location.search).get("invoice") || "";

let invoice: PublicInvoice | null = null;
let intent: AuthoritativePayment | null = null;
let provider: BrowserProvider | null = null;
let signerAddress: string | null = null;
let grossAtomic: bigint | null = null;
let feeAtomic: bigint | null = null;
let allowance: bigint | null = null;
// Gross amount of an approval this page requested and saw confirmed.
let approvedGross: bigint | null = null;
let busy = false;
let paymentIncluded = false;
let notice: { text: string; type?: string; transactionHash?: string } | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function usdc(value: bigint | null): string { return value === null ? "—" : `${formatUnits(value, ARC_MAINNET_PAYER.usdcDecimals)} USDC`; }
function short(value: string): string { return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function stateNotice(text: string, type = "") { return el("div", `payer-notice ${type}`.trim(), text); }
function exactMainnetSelected(): boolean {
  return Boolean(arcfxWallet.connected && arcfxWallet.address && arcfxWallet.chainId?.toLowerCase() === ARC_MAINNET_PAYER.chainIdHex && arcfxWallet.provider);
}
function walletReady(): boolean {
  return Boolean(exactMainnetSelected() && provider && signerAddress && signerAddress.toLowerCase() === arcfxWallet.address?.toLowerCase());
}
function failureMessage(error: unknown): string {
  const value = error as { code?: number; message?: string; shortMessage?: string; reason?: string };
  if (value?.code === 4001 || /rejected|denied/i.test(String(value?.message))) return "Wallet confirmation was rejected. No payment was sent.";
  return value?.shortMessage || value?.reason || value?.message || "The action could not be completed.";
}

async function loadAuthoritativeInvoice(): Promise<AuthoritativePayment> {
  if (!invoiceId || invoiceId.length > 160) throw new Error("A valid invoice link is required.");
  const result = await arcfxApi.publicInvoice(invoiceId);
  const next = authoritativeMainnetPayment(result.invoice as PublicInvoice);
  invoice = result.invoice as PublicInvoice;
  return next;
}

/** Contract-exact quote for the current intent, cross-checked against quoteFee(). */
async function readQuote(): Promise<{ gross: bigint; fee: bigint }> {
  if (!intent || !provider) throw new Error("Connect a wallet on Arc Mainnet first.");
  const payments = new Contract(ARC_MAINNET_PAYER.paymentsAddress, PAYMENTS_ABI, provider);
  const feeBps = BigInt(await payments.FEE_BPS());
  const gross = grossForNet(intent.netAtomic, feeBps);
  const quote = await payments.quoteFee(gross);
  // The recipient must receive exactly the outstanding amount: never less, and
  // never a rounding overpayment.
  if (BigInt(quote.net) !== intent.netAtomic || BigInt(quote.fee) !== contractFee(gross, feeBps) || contractNet(gross, feeBps) !== intent.netAtomic) {
    throw new Error("The payment contract quote does not match the invoice exactly. No transaction was requested.");
  }
  return { gross, fee: BigInt(quote.fee) };
}

async function readAllowance(): Promise<bigint> {
  if (!intent || !provider || !signerAddress) throw new Error("Connect a wallet on Arc Mainnet first.");
  const token = new Contract(intent.tokenAddress, ERC20_ABI, provider);
  return BigInt(await token.allowance(signerAddress, ARC_MAINNET_PAYER.paymentsAddress));
}

async function refreshQuoteAndAllowance(): Promise<void> {
  if (!intent || !provider || !signerAddress) return;
  const quote = await readQuote();
  grossAtomic = quote.gross;
  feeAtomic = quote.fee;
  allowance = await readAllowance();
}

function currentReview(): PaymentReview {
  if (!intent || grossAtomic === null || feeAtomic === null || !signerAddress || !arcfxWallet.chainId) {
    throw new Error("Payment details are incomplete. No transaction was requested.");
  }
  return { intent, grossAtomic, feeAtomic, account: signerAddress, chainIdHex: arcfxWallet.chainId };
}

/**
 * Re-read every authoritative input and compare it with what the payer
 * reviewed. Any difference stops the flow and shows the new values for review.
 */
async function recheckReviewed(reviewed: PaymentReview): Promise<void> {
  if (!walletReady()) throw new Error("Wallet account or network changed. No transaction was requested.");
  const latestIntent = await loadAuthoritativeInvoice();
  intent = latestIntent;
  const quote = await readQuote();
  grossAtomic = quote.gross;
  feeAtomic = quote.fee;
  const changed = reviewChange(reviewed, currentReview());
  if (changed) throw new Error(`${changed} Review the updated payment before continuing. No transaction was requested.`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function render(message?: { text: string; type?: string; transactionHash?: string }) {
  if (message) notice = message;
  if (!root) return;
  root.replaceChildren();
  const shell = el("div", "payer-shell");
  const brand = el("a", "payer-brand") as HTMLAnchorElement;
  brand.href = "/";
  const logo = document.createElement("img");
  logo.src = "/arcfx-logo-transparent.png";
  logo.alt = "ArcFX";
  logo.className = "payer-brand-logo";
  brand.append(logo);
  shell.append(brand);
  const card = el("section", "payer-card");
  if (!intent || !invoice) {
    const body = el("div", "payer-body");
    if (notice) body.append(stateNotice(notice.text, notice.type));
    else body.append(el("div", "payer-loading", "Loading invoice…"));
    card.append(body);
    shell.append(card); root.append(shell); return;
  }
  const header = el("header", "payer-head");
  header.append(el("p", "payer-kicker", "Authoritative invoice · Arc Mainnet"), el("h1", "payer-title", `Invoice ${intent.invoiceNumber}`));
  if (invoice.note) header.append(el("p", "payer-subtitle", invoice.note));
  card.append(header);
  const body = el("div", "payer-body");
  if (notice) {
    const alert = stateNotice(notice.text, notice.type);
    if (notice.transactionHash) {
      alert.append(document.createTextNode(" "));
      const link = el("a", "payer-link", "View transaction");
      link.href = `${ARC_MAINNET_PAYER.explorerUrl}/tx/${notice.transactionHash}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      alert.append(link);
    }
    body.append(alert);
  }
  const amount = el("section", "payer-amount");
  amount.append(el("small", "", "Outstanding amount"), el("strong", "", usdc(intent.netAtomic)));
  body.append(amount);
  const details = el("dl", "payer-grid");
  const row = (label: string, value: string) => { details.append(el("dt", "", label), el("dd", "", value)); };
  row("Recipient", short(intent.recipient));
  row("Network", `Arc Mainnet · ${ARC_MAINNET_PAYER.caip2}`);
  row("Payment ID", short(intent.paymentId));
  row("Invoice status", intent.status);
  body.append(details);
  if (grossAtomic !== null) {
    body.append(el("p", "payer-fee", `You pay ${usdc(grossAtomic)}. ArcFX fee: ${usdc(feeAtomic)}. The recipient receives ${usdc(intent.netAtomic)}.`));
  } else {
    body.append(el("p", "payer-fee", "Connect a wallet on Arc Mainnet to retrieve the contract's current fee quote and allowance."));
  }
  const actions = el("div", "payer-action");
  if (paymentIncluded) {
    actions.append(el("p", "payer-fine", "This browser observed the payment transaction included. Further payment attempts are disabled; wait for the authoritative invoice status refresh."));
  } else if (!walletReady()) {
    const wrongNetwork = Boolean(arcfxWallet.connected && arcfxWallet.address && arcfxWallet.chainId?.toLowerCase() !== ARC_MAINNET_PAYER.chainIdHex);
    const connect = el("button", "payer-button", wrongNetwork ? "Switch to Arc Mainnet" : "Connect wallet on Arc Mainnet");
    connect.type = "button";
    connect.disabled = busy;
    connect.addEventListener("click", () => void (wrongNetwork ? switchWalletToMainnet() : connectWallet()));
    actions.append(connect, el("p", "payer-fine", wrongNetwork
      ? "ArcFX requires Arc Mainnet · Chain 5042. Switching is requested only after you select this action."
      : "Connect the selected wallet to continue. ArcFX does not switch networks automatically."));
  } else if (grossAtomic !== null && allowance !== null) {
    const nextAction = allowanceAction(allowance, grossAtomic);
    const button = el("button", "payer-button", nextAction === "approve" ? `Approve exactly ${usdc(grossAtomic)}` : `Pay ${usdc(grossAtomic)}`);
    button.type = "button"; button.disabled = busy;
    button.addEventListener("click", () => void (nextAction === "approve" ? approveExact() : submitPayment()));
    actions.append(button);
    if (nextAction === "approve") actions.append(el("p", "payer-fine", "Approval is a separate wallet transaction. It authorizes only this required gross payment amount—never unlimited USDC."));
    else actions.append(el("p", "payer-fine", "Allowance is sufficient. Wallet confirmation is still required before the payment transaction is submitted."));
  }
  body.append(actions, el("p", "payer-fine", "A submitted transaction is not marked Paid here. ArcFX’s backend monitor remains authoritative for settlement status."));
  card.append(body); shell.append(card); root.append(shell);
}

async function connectWallet() {
  if (busy) return;
  busy = true; render({ text: "Connecting the selected wallet…" });
  try {
    const state = await arcfxWallet.connectCurrentNetwork();
    await establishWallet(state);
    notice = undefined;
    render();
  } catch (error) {
    render({ text: failureMessage(error), type: "error" });
  } finally { busy = false; render(); }
}

async function establishWallet(state: { connected: boolean; chainId: string | null; address: string | null }): Promise<void> {
  if (!state.connected || state.chainId?.toLowerCase() !== ARC_MAINNET_PAYER.chainIdHex || !arcfxWallet.provider || !state.address) {
    throw new Error("Arc Mainnet (chain 5042) is required before a payment can be prepared.");
  }
  provider = new BrowserProvider(arcfxWallet.provider);
  signerAddress = state.address;
  if (signerAddress.toLowerCase() === intent?.recipient.toLowerCase()) throw new Error("You cannot pay your own invoice.");
  await refreshQuoteAndAllowance();
}

/** User-triggered network selection only. It performs no approval or payment. */
async function switchWalletToMainnet() {
  if (busy) return;
  busy = true; render({ text: "Requesting Arc Mainnet from the selected wallet…" });
  try {
    const switched = await arcfxWallet.switchToArcMainnet();
    if (!switched) throw new Error("Arc Mainnet was not selected. No payment action was requested.");
    await establishWallet(arcfxWallet.state);
    notice = undefined;
    render();
  } catch (error) {
    render({ text: failureMessage(error), type: "error" });
  } finally { busy = false; render(); }
}

async function approveExact() {
  if (busy || !intent || !provider || !signerAddress || grossAtomic === null || allowanceAction(allowance || 0n, grossAtomic) !== "approve") return;
  busy = true; render({ text: "Rechecking the authoritative invoice before requesting approval…" });
  try {
    if (signerAddress.toLowerCase() === intent.recipient.toLowerCase()) throw new Error("You cannot pay your own invoice.");
    const reviewed = currentReview();
    await recheckReviewed(reviewed);
    allowance = await readAllowance();
    const before = allowanceTransition(allowance, reviewed.grossAtomic, approvedGross);
    if (before !== "needs-approval") {
      // Allowance already covers this payment; nothing to approve. The payer
      // still reviews and confirms the payment separately.
      render(before === "approval-confirmed"
        ? { text: "Approval confirmed. Review the payment and click Pay.", type: "success" }
        : { text: "Your USDC allowance already covers this payment. Review the payment and click Pay.", type: "warning" });
      return;
    }
    render({ text: `Confirm the approval of exactly ${usdc(reviewed.grossAtomic)} in your wallet. This is not the payment.` });
    const signer = await provider.getSigner();
    const token = new Contract(intent.tokenAddress, ERC20_ABI, signer);
    const tx = await token.approve(ARC_MAINNET_PAYER.paymentsAddress, reviewed.grossAtomic);
    render({ text: "Waiting for the approval to be included…" });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("The approval transaction did not succeed. No payment was sent.");
    approvedGross = reviewed.grossAtomic;
    // A wallet RPC can briefly serve the pre-approval allowance after the
    // receipt. Re-read a bounded number of times instead of asking the payer
    // to approve again.
    for (let attempt = 0; attempt < 8; attempt++) {
      allowance = await readAllowance();
      if (allowanceAction(allowance, reviewed.grossAtomic) === "pay") break;
      await sleep(1500);
    }
    await recheckReviewed(reviewed);
    if (allowanceTransition(allowance, reviewed.grossAtomic, approvedGross) !== "approval-confirmed") {
      render({ text: "The approval is confirmed on chain, but your wallet has not reported the new allowance yet. Wait a moment and reload this page; do not approve again.", type: "warning", transactionHash: receipt.hash });
      return;
    }
    render({ text: "Approval confirmed. Review the payment and click Pay.", type: "success", transactionHash: receipt.hash });
  } catch (error) {
    render({ text: failureMessage(error), type: "error" });
  } finally { busy = false; render(); }
}

async function submitPayment() {
  if (busy || !intent || !provider || !signerAddress || grossAtomic === null) return;
  if (paymentIncluded) return;
  busy = true; render({ text: "Rechecking the authoritative invoice before requesting payment…" });
  try {
    if (!walletReady()) throw new Error("Wallet account or network changed. No payment was sent.");
    if (signerAddress.toLowerCase() === intent.recipient.toLowerCase()) throw new Error("You cannot pay your own invoice.");
    const reviewed = currentReview();
    await recheckReviewed(reviewed);
    allowance = await readAllowance();
    if (allowanceAction(allowance, reviewed.grossAtomic) !== "pay") throw new Error("USDC allowance is no longer sufficient. No payment was sent.");
    const signer = await provider.getSigner();
    const payments = new Contract(ARC_MAINNET_PAYER.paymentsAddress, PAYMENTS_ABI, signer);
    render({ text: "Confirm the ArcFX payment in your wallet. This is a separate transaction." });
    const tx = await payments.pay(reviewed.intent.tokenAddress, reviewed.intent.recipient, reviewed.grossAtomic, reviewed.intent.paymentId);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("The payment transaction did not succeed.");
    paymentIncluded = true;
    let statusText = "Transaction included. ArcFX is waiting for authoritative settlement monitoring.";
    try {
      const refreshed = await arcfxApi.publicInvoice(invoiceId);
      const refreshedStatus = String((refreshed.invoice as PublicInvoice).status || "pending");
      statusText = refreshedStatus === "paid" || refreshedStatus === "partial"
        ? `Transaction included. Authoritative invoice status: ${refreshedStatus}.`
        : "Transaction included. Authoritative settlement is still pending monitor observation.";
    } catch { /* the receipt remains useful even if status refresh is briefly unavailable */ }
    render({ text: statusText, type: "success", transactionHash: receipt.hash });
  } catch (error) {
    render({ text: failureMessage(error), type: "error" });
  } finally { busy = false; render(); }
}

arcfxWallet.onChange((state) => {
  // Nothing has been prepared until the payer connects: a wallet that merely
  // finishes its silent restore is not a change to a reviewed payment.
  if (!signerAddress) return;
  if (!state.connected || state.chainId?.toLowerCase() !== ARC_MAINNET_PAYER.chainIdHex || signerAddress.toLowerCase() !== state.address?.toLowerCase()) {
    provider = null; signerAddress = null; grossAtomic = null; feeAtomic = null; allowance = null; approvedGross = null;
    if (intent) render({ text: "Wallet network changed. Mainnet payment is disabled until Arc Mainnet is selected again.", type: "error" });
  }
});

void (async () => {
  try { intent = await loadAuthoritativeInvoice(); render(); }
  catch (error) { render({ text: failureMessage(error), type: "error" }); }
})();
