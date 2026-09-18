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

/** Gross up a recipient net amount using integer ceiling division. */
export function grossForNet(netAtomic: bigint, feeBps: bigint): bigint {
  const denominator = 10_000n - feeBps;
  if (netAtomic <= 0n || feeBps < 0n || denominator <= 0n) throw new Error("Invalid payment fee configuration.");
  return (netAtomic * 10_000n + denominator - 1n) / denominator;
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
