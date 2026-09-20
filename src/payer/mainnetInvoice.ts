import { getAddress, isAddress, isHexString } from "ethers";

export const ARC_MAINNET_PAYER = {
  network: "arc-mainnet",
  chainId: 5042,
  chainIdHex: "0x13b2",
  caip2: "eip155:5042",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  paymentsAddress: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
  usdcAddress: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
} as const;

export type PublicInvoice = {
  id: string;
  network: string | null;
  number: string;
  paymentId: string;
  payTo: string;
  status: string;
  token: string | null;
  tokenAddress: string | null;
  amount: string | null;
  amountAtomic: string | null;
  paid: string;
  paidAtomic: string;
  outstanding: string | null;
  outstandingAtomic: string | null;
  dueDate: string | null;
  note: string | null;
  issuedAt: string | null;
};

export type AuthoritativePayment = {
  invoiceId: string;
  invoiceNumber: string;
  network: typeof ARC_MAINNET_PAYER.network;
  tokenAddress: string;
  recipient: string;
  paymentId: string;
  netAtomic: bigint;
  status: "sent" | "partial" | "overdue";
};

function decimalAtomic(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Authoritative invoice ${field} is missing or invalid.`);
  }
  return BigInt(value);
}

function exactAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Authoritative invoice ${field} is missing or invalid.`);
  }
  return getAddress(value);
}

/** Every transaction input is derived only from this public invoice response. */
export function authoritativeMainnetPayment(invoice: PublicInvoice): AuthoritativePayment {
  if (invoice.network !== ARC_MAINNET_PAYER.network) throw new Error("This invoice is not an Arc Mainnet invoice.");
  if (!(invoice.status === "sent" || invoice.status === "partial" || invoice.status === "overdue")) {
    throw new Error("This invoice is not eligible for payment.");
  }
  const tokenAddress = exactAddress(invoice.tokenAddress, "token");
  if (tokenAddress.toLowerCase() !== ARC_MAINNET_PAYER.usdcAddress.toLowerCase()) {
    throw new Error("This invoice does not use canonical Arc Mainnet USDC.");
  }
  const recipient = exactAddress(invoice.payTo, "recipient");
  if (typeof invoice.paymentId !== "string" || !isHexString(invoice.paymentId, 32)) {
    throw new Error("Authoritative invoice payment ID is missing or invalid.");
  }
  if (typeof invoice.id !== "string" || !invoice.id) throw new Error("Authoritative invoice ID is missing or invalid.");

  const amountAtomic = decimalAtomic(invoice.amountAtomic, "amount");
  const paidAtomic = decimalAtomic(invoice.paidAtomic, "paid amount");
  const outstandingAtomic = decimalAtomic(invoice.outstandingAtomic, "outstanding amount");
  if (amountAtomic <= 0n || paidAtomic > amountAtomic || outstandingAtomic !== amountAtomic - paidAtomic || outstandingAtomic <= 0n) {
    throw new Error("Authoritative invoice outstanding amount is not payable.");
  }
  return { invoiceId: invoice.id, invoiceNumber: invoice.number, network: ARC_MAINNET_PAYER.network, tokenAddress, recipient, paymentId: invoice.paymentId, netAtomic: outstandingAtomic, status: invoice.status };
}

export const BPS_DENOM = 10_000n;

/** ArcFXPayments.pay(): `fee = (gross * FEE_BPS) / BPS_DENOM` (Solidity floor). */
export function contractFee(grossAtomic: bigint, feeBps: bigint): bigint {
  return (grossAtomic * feeBps) / BPS_DENOM;
}

/** ArcFXPayments.pay(): `net = gross - fee`, the amount the recipient receives. */
export function contractNet(grossAtomic: bigint, feeBps: bigint): bigint {
  return grossAtomic - contractFee(grossAtomic, feeBps);
}

/**
 * The smallest gross whose contract net is exactly `netAtomic`.
 *
 * A continuous ceiling (net * 10000 / (10000 - bps)) can land one unit past a
 * fee-floor step and overpay the recipient (0.01 USDC: 10016 → net 10001).
 * contractNet() rises by 0 or 1 per unit of gross (bps < 10000), so an exact
 * gross always exists; start from the floor estimate, step to the first gross
 * reaching the net, then prove equality. Anything else fails closed.
 */
export function grossForNet(netAtomic: bigint, feeBps: bigint): bigint {
  if (netAtomic <= 0n || feeBps < 0n || feeBps >= BPS_DENOM) throw new Error("Invalid payment fee configuration.");
  let gross = (netAtomic * BPS_DENOM) / (BPS_DENOM - feeBps);
  for (let i = 0; contractNet(gross, feeBps) < netAtomic; i++) {
    if (i > 8) throw new Error("Could not compute an exact contract payment amount.");
    gross++;
  }
  for (let i = 0; gross > 1n && contractNet(gross - 1n, feeBps) >= netAtomic; i++) {
    if (i > 8) throw new Error("Could not compute an exact contract payment amount.");
    gross--;
  }
  if (contractNet(gross, feeBps) !== netAtomic) throw new Error("Could not compute an exact contract payment amount.");
  return gross;
}

export function allowanceAction(allowance: bigint, grossAtomic: bigint): "approve" | "pay" {
  if (allowance < 0n || grossAtomic <= 0n) throw new Error("Invalid allowance or payment amount.");
  return allowance >= grossAtomic ? "pay" : "approve";
}

export function sameAuthoritativePayment(a: AuthoritativePayment, b: AuthoritativePayment): boolean {
  return a.invoiceId === b.invoiceId && a.network === b.network
    && a.tokenAddress.toLowerCase() === b.tokenAddress.toLowerCase()
    && a.recipient.toLowerCase() === b.recipient.toLowerCase()
    && a.paymentId.toLowerCase() === b.paymentId.toLowerCase()
    && a.netAtomic === b.netAtomic;
}

/** Everything the payer reviewed before a wallet prompt. */
export type PaymentReview = {
  intent: AuthoritativePayment;
  grossAtomic: bigint;
  feeAtomic: bigint;
  account: string;
  chainIdHex: string;
};

/**
 * Why a re-read no longer matches what the payer reviewed, or null. Allowance
 * is deliberately not part of this: it changes because ArcFX asked for an
 * approval, and is handled by allowanceTransition().
 */
export function reviewChange(reviewed: PaymentReview, latest: PaymentReview): string | null {
  if (reviewed.account.toLowerCase() !== latest.account.toLowerCase()) return "The selected wallet account changed.";
  if (reviewed.chainIdHex.toLowerCase() !== latest.chainIdHex.toLowerCase()) return "The wallet network changed.";
  const a = reviewed.intent, b = latest.intent;
  if (a.invoiceId !== b.invoiceId || a.network !== b.network) return "The invoice changed.";
  if (a.tokenAddress.toLowerCase() !== b.tokenAddress.toLowerCase()) return "The invoice token changed.";
  if (a.recipient.toLowerCase() !== b.recipient.toLowerCase()) return "The invoice recipient changed.";
  if (a.paymentId.toLowerCase() !== b.paymentId.toLowerCase()) return "The invoice payment ID changed.";
  if (a.netAtomic !== b.netAtomic) return "The outstanding amount changed.";
  if (reviewed.grossAtomic !== latest.grossAtomic || reviewed.feeAtomic !== latest.feeAtomic) return "The payment amount or fee changed.";
  return null;
}

/**
 * Classify an allowance re-read. Sufficient allowance that follows a confirmed
 * ArcFX approval for exactly this gross is the expected transition; sufficient
 * allowance that appeared any other way is surfaced for review.
 */
export function allowanceTransition(
  allowance: bigint,
  grossAtomic: bigint,
  approvedGross: bigint | null,
): "needs-approval" | "approval-confirmed" | "already-sufficient" {
  if (allowanceAction(allowance, grossAtomic) === "approve") return "needs-approval";
  return approvedGross === grossAtomic ? "approval-confirmed" : "already-sufficient";
}
