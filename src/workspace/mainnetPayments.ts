/**
 * Shared Arc Mainnet constants and integer-only helpers for Send and
 * Multisend / Payouts. No DOM, wallet, or network access here.
 *
 * ADDRESS WARNING: the two ArcFX contracts swap roles between networks.
 *   Arc Mainnet : ArcFXMultisender 0xc37D…45D3, ArcFXPayments 0xF7ae…1398
 *   Arc Testnet : ArcFXMultisender 0xF7ae…1398, ArcFXPayments 0xc37D…45D3
 * The legacy /multisend page hard-codes the Testnet multisender; on Mainnet
 * that address is ArcFXPayments. Nothing in this file or its consumers may use
 * a Testnet address.
 */
import { getAddress, isAddress } from "ethers";

export const MAINNET = {
  network: "arc-mainnet",
  chainId: 5042,
  chainIdHex: "0x13b2",
  caip2: "eip155:5042",
  explorer: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  multisender: "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
  payments: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
} as const;

/** ArcFXMultisender (deployed Mainnet, runtime hash 7543d59e…b74c). */
export const MULTISENDER = {
  freeLimit: 5,
  maxLimit: 500,
  feeBps: 10n,
  bpsDenom: 10_000n,
} as const;

/** Never a valid destination for user funds: they would be stranded. */
export const PROTECTED_ADDRESSES: ReadonlyArray<{ address: string; label: string }> = [
  { address: MAINNET.usdc, label: "the USDC token contract" },
  { address: MAINNET.multisender, label: "the ArcFX Multisender contract" },
  { address: MAINNET.payments, label: "the ArcFX Payments contract" },
  { address: "0x0000000000000000000000000000000000000000", label: "the zero address" },
];

const MAX_AMOUNT_DIGITS = 30;

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export const sameChain = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

// Not a discriminated union: the repo is not in strict mode, where boolean discriminants do not narrow.
export type Parsed<T> = { ok: boolean; value?: T; error?: string };

/** Exact USDC amount → 6-decimal atomic bigint. No floats anywhere. */
export function parseUsdcAmount(text: string): Parsed<bigint> {
  const amount = String(text ?? "").trim();
  if (!amount) return { ok: false, error: "Enter an amount greater than 0." };
  if (/^\d+,\d+$/.test(amount)) return { ok: false, error: `Use a dot for decimals, for example ${amount.replace(",", ".")}.` };
  if (!/^\d+(\.\d+)?$/.test(amount)) return { ok: false, error: "Enter a plain number, for example 25.50." };
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > MAINNET.usdcDecimals) return { ok: false, error: `USDC supports up to ${MAINNET.usdcDecimals} decimal places.` };
  const atomic = BigInt(whole + fraction.padEnd(MAINNET.usdcDecimals, "0"));
  if (atomic <= 0n) return { ok: false, error: "Enter an amount greater than 0." };
  if (atomic.toString().length > MAX_AMOUNT_DIGITS) return { ok: false, error: "That amount is too large." };
  return { ok: true, value: atomic };
}

/** Exact atomic → decimal string, at least 2 decimals, trailing zeros trimmed beyond that. */
export function formatUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const s = abs.toString().padStart(MAINNET.usdcDecimals + 1, "0");
  const whole = s.slice(0, -MAINNET.usdcDecimals);
  let fraction = s.slice(-MAINNET.usdcDecimals).replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export type AddressCheck = { ok: boolean; address?: string; error?: string };

/** Validates and checksums a recipient. `sender` is rejected as a pointless self-transfer. */
export function checkRecipient(text: string, sender?: string | null): AddressCheck {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a recipient wallet address." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return { ok: false, error: "Enter a 0x wallet address with 40 hexadecimal characters." };
  if (!isAddress(raw)) return { ok: false, error: "This address has an invalid checksum. Check it for typos before continuing." };
  const address = getAddress(raw);
  for (const blocked of PROTECTED_ADDRESSES) {
    if (sameAddress(address, blocked.address)) return { ok: false, error: `This is ${blocked.label}. Funds sent there could not be recovered.` };
  }
  if (BigInt(address) <= 0xffn) return { ok: false, error: "This is a reserved system address, not a wallet. Funds sent there could not be recovered." };
  if (sender && sameAddress(address, sender)) return { ok: false, error: "This is your own wallet. Choose a different recipient." };
  return { ok: true, address };
}

/**
 * Arc's native gas token IS USDC at 18 decimals, and the ERC-20 at 0x3600…
 * reports the same funds at 6 decimals (verified live: native / 10^12 equals
 * balanceOf exactly, the remainder being sub-micro dust). A payment and its
 * network fee therefore come out of ONE balance.
 */
export const NATIVE_PER_ATOMIC = 10n ** 12n;

/** 18-decimal native wei → USDC text with 6 decimals (floored). */
export function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = ((wei % 10n ** 18n) / NATIVE_PER_ATOMIC).toString().padStart(MAINNET.usdcDecimals, "0");
  return wei > 0n && whole === 0n && fraction === "000000" ? "< 0.000001" : `${whole}.${fraction}`;
}

/**
 * The wallet must hold the payment AND the network fee in the same balance.
 * `nativeWei` null means the native balance was not read, so nothing is claimed.
 */
export function feeBlocker(nativeWei: bigint | null | undefined, spendAtomic: bigint, feeWei: bigint | null | undefined): string | null {
  if (nativeWei === null || nativeWei === undefined) return null;
  const need = spendAtomic * NATIVE_PER_ATOMIC + (feeWei ?? 0n);
  if (nativeWei >= need) return null;
  const feePart = feeWei === null || feeWei === undefined ? "" : ` plus the network fee (about ${formatNative(feeWei)} USDC)`;
  return `Your wallet cannot cover ${formatUsdc(spendAtomic)} USDC${feePart}. Arc pays network fees in USDC from the same balance, and you have ${formatNative(nativeWei)} USDC.`;
}

export const shortAddress = (address: string): string => `${address.slice(0, 8)}…${address.slice(-6)}`;
export const explorerTx = (hash: string): string => `${MAINNET.explorer}/tx/${hash}`;

export type TxError = { kind: "rejected" | "insufficient-gas" | "reverted" | "rpc" | "other"; message: string };

/** Turn a wallet/RPC failure into an actionable, honest message. */
export function describeTxError(error: unknown, action = "transaction"): TxError {
  const e = error as any;
  const code = e?.code ?? e?.error?.code ?? e?.info?.error?.code;
  const text = String(e?.shortMessage || e?.reason || e?.message || e || "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user (rejected|denied|cancel)|rejected the request|denied transaction/i.test(text)) {
    return { kind: "rejected", message: `Wallet confirmation was rejected. No ${action} was sent and your entries are still here.` };
  }
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(text)) {
    return { kind: "insufficient-gas", message: "Your wallet does not have enough native balance to pay the network fee. Nothing was sent." };
  }
  if (code === "CALL_EXCEPTION" || /revert|execution reverted/i.test(text)) {
    const reason = e?.reason || e?.revert?.args?.[0];
    return { kind: "reverted", message: `The network rejected the ${action}${reason ? `: ${reason}` : ""}. Nothing was sent.` };
  }
  if (code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT" || /network|failed to fetch|timeout|could not coalesce|rpc/i.test(text)) {
    return { kind: "rpc", message: "Arc Mainnet's RPC is unavailable right now. Nothing was confirmed; check your wallet activity before retrying." };
  }
  return { kind: "other", message: text ? `The ${action} could not be completed: ${text}` : `The ${action} could not be completed.` };
}

/** ethers v6 rejects tx.wait() with a CALL_EXCEPTION carrying the receipt when a transaction reverts on chain. */
export function isRevertedReceiptError(error: unknown): boolean {
  const e = error as any;
  return Boolean(e && e.receipt && Number(e.receipt.status) === 0);
}
