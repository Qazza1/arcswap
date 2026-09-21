import { parseUsdcAmount } from "./mainnetPayments";
import type { WalletBinding } from "./swapCore";

export const BRIDGE_CHAINS = {
  Arc: { sdk: "Arc", chainId: 5042, chainIdHex: "0x13b2", cctpDomain: 26 },
  Ethereum: { sdk: "Ethereum", chainId: 1, chainIdHex: "0x1", cctpDomain: 0 },
  Base: { sdk: "Base", chainId: 8453, chainIdHex: "0x2105", cctpDomain: 6 },
} as const;
export type BridgeChain = keyof typeof BRIDGE_CHAINS;
export type BridgeForm = { source: BridgeChain; destination: BridgeChain; amount: string; recipient: string };
export type BridgeQuoteSnapshot = {
  kind: "bridge"; binding: WalletBinding; form: Readonly<BridgeForm>; amountAtomic: bigint;
  route: string; provider: "Circle App Kit"; quoteId: string | null; estimatedReceive: string;
  fees: readonly { type: string; token: string; amount: string | null; network?: string }[];
  warnings: readonly string[]; createdAt: number; validUntil: number; sdk: string; state: "review-ready";
};

export function validateBridgeForm(form: BridgeForm): { amountAtomic?: bigint; error?: string } {
  if (form.source === form.destination) return { error: "Source and destination networks must be different." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(form.recipient.trim())) return { error: "Enter a 0x destination wallet address with 40 hexadecimal characters." };
  const parsed = parseUsdcAmount(form.amount);
  return parsed.ok ? { amountAtomic: parsed.value } : { error: parsed.error };
}
export const bridgeFingerprint = (form: BridgeForm): string => `${form.source}|${form.destination}|USDC|${form.amount.trim()}|${form.recipient.trim().toLowerCase()}`;
export function createBridgeSnapshot(input: {
  binding: WalletBinding; form: BridgeForm; amountAtomic: bigint; route: string; quoteId: string | null;
  estimatedReceive: string; fees: BridgeQuoteSnapshot["fees"]; warnings: string[]; sdk: string; now?: number;
}): BridgeQuoteSnapshot {
  const now = input.now ?? Date.now();
  return Object.freeze({ kind: "bridge", binding: input.binding, form: Object.freeze({ ...input.form }), amountAtomic: input.amountAtomic, route: input.route, provider: "Circle App Kit", quoteId: input.quoteId, estimatedReceive: input.estimatedReceive, fees: Object.freeze([...input.fees]), warnings: Object.freeze([...input.warnings]), createdAt: now, validUntil: now + 60_000, sdk: input.sdk, state: "review-ready" });
}
export function bridgeSnapshotIsCurrent(snapshot: BridgeQuoteSnapshot | null, form: BridgeForm, binding: WalletBinding | null, now = Date.now()): boolean {
  return Boolean(snapshot && binding
    && snapshot.binding.provider === binding.provider
    && snapshot.binding.account.toLowerCase() === binding.account.toLowerCase()
    && snapshot.binding.chainId.toLowerCase() === binding.chainId.toLowerCase()
    && bridgeFingerprint(snapshot.form) === bridgeFingerprint(form)
    && now < snapshot.validUntil);
}

