/**
 * Presentation model for OUTBOUND Activity (Step 7B): direct Sends and payout
 * batches returned by the owner-scoped dashboard API. Pure and dependency-free
 * so the dashboard's HTML renderer and the Activity view share one definition
 * (and it stays out of the wallet/ethers bundle).
 *
 * Outbound items are activity only. They are never summed into any receivables
 * figure (outstanding, overdue, received this month, paid count).
 */

export const OUTBOUND_TYPES = ["payment_sent", "payout_batch"] as const;
export type OutboundType = (typeof OUTBOUND_TYPES)[number];

export interface ActivityItem {
  id: string;
  type: string;
  timestamp: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customerName: string | null;
  counterparty: string | null;
  amountAtomic: string | null;
  token: string | null;
  status: string | null;
  transactionHash: string | null;
  recipientCount?: number | null;
  feeAtomic?: string | null;
  recipients?: Array<{ recipient: string; amountAtomic: string }> | null;
  recipientsTruncated?: boolean;
}

export const EXPLORER_TX_BASE = "https://explorer.arc.io/tx/";
const USDC_DECIMALS = 6;

export const isOutbound = (type: string): type is OutboundType => (OUTBOUND_TYPES as readonly string[]).includes(type);

/** Exact atomic → decimal USDC text (at least 2 decimals). Anything not a plain integer string shows as unavailable. */
export function formatAtomic(atomic: string | null | undefined): string {
  if (typeof atomic !== "string" || !/^\d+$/.test(atomic)) return "—";
  const digits = atomic.replace(/^0+(?=\d)/, "").padStart(USDC_DECIMALS + 1, "0");
  const whole = digits.slice(0, -USDC_DECIMALS);
  let fraction = digits.slice(-USDC_DECIMALS).replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${whole}.${fraction}`;
}

export const shortWallet = (address: string): string => (/^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Unknown wallet");

/** The Arc Mainnet explorer transaction link, only for a well-formed transaction hash. */
export const explorerTxHref = (hash: string | null | undefined): string | null =>
  typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${EXPLORER_TX_BASE}${hash}` : null;

export interface OutboundView {
  kind: "sent" | "batch";
  label: string;
  title: string;
  detail: string;
  /** Always shown with an explicit minus sign: it is money that left the wallet. */
  amountText: string;
  statusText: string;
  explorerHref: string | null;
  feeText: string | null;
  recipients: Array<{ address: string; shortAddress: string; amountText: string }>;
  recipientsNote: string | null;
}

/** The view of a persisted outbound item, or null for any other activity type. */
export function describeOutbound(item: ActivityItem): OutboundView | null {
  if (!isOutbound(item.type)) return null;
  const amount = `−${formatAtomic(item.amountAtomic)} USDC`;
  const statusText = item.status === "confirmed" ? "Confirmed" : "Unverified status";
  const explorerHref = explorerTxHref(item.transactionHash);
  if (item.type === "payment_sent") {
    return {
      kind: "sent", label: "Sent", title: `To ${shortWallet(item.counterparty ?? "")}`, detail: "Direct USDC transfer",
      amountText: amount, statusText, explorerHref, feeText: null, recipients: [], recipientsNote: null,
    };
  }
  const count = typeof item.recipientCount === "number" && Number.isSafeInteger(item.recipientCount) ? item.recipientCount : 0;
  const shown = Array.isArray(item.recipients) ? item.recipients : [];
  const fee = item.feeAtomic === undefined || item.feeAtomic === null ? null : item.feeAtomic;
  return {
    kind: "batch", label: "Payout batch", title: `${count} recipient${count === 1 ? "" : "s"}`, detail: "ArcFX Multisender",
    amountText: amount, statusText, explorerHref,
    feeText: fee === null ? null : /^0+$/.test(fee) ? "No ArcFX fee" : `ArcFX fee ${formatAtomic(fee)} USDC`,
    recipients: shown.map((r) => ({ address: r.recipient, shortAddress: shortWallet(r.recipient), amountText: `${formatAtomic(r.amountAtomic)} USDC` })),
    recipientsNote: item.recipientsTruncated || (count > shown.length && shown.length > 0)
      ? `Showing the first ${shown.length} of ${count} recipients. The transaction on the explorer lists all of them.` : null,
  };
}
