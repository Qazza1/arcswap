import { formatUsdc, parseUsdcAmount } from "./mainnetPayments";

export type SwapToken = "USDC" | "EURC";
export type SwapForm = { tokenIn: SwapToken; tokenOut: SwapToken; amount: string; slippageBps: number };
export type WalletBinding = { provider: object; account: string; chainId: string };
export type SwapQuoteSnapshot = {
  kind: "swap";
  binding: WalletBinding;
  form: Readonly<SwapForm>;
  amountAtomic: bigint;
  route: string;
  provider: "Circle App Kit";
  quoteId: string | null;
  estimatedOutput: string;
  minimumReceived: string;
  fees: readonly { type: string; token: string; amount: string | null }[];
  approval: null;
  createdAt: number;
  validUntil: number;
  sdk: string;
};

export function validateSwapForm(form: SwapForm): { amountAtomic?: bigint; error?: string } {
  if (form.tokenIn === form.tokenOut) return { error: "Choose two different treasury assets." };
  if (!Number.isInteger(form.slippageBps) || form.slippageBps < 1 || form.slippageBps > 500) return { error: "Choose slippage between 0.01% and 5%." };
  const parsed = parseUsdcAmount(form.amount);
  return parsed.ok ? { amountAtomic: parsed.value } : { error: parsed.error };
}

export const exactSixDecimalAmount = (atomic: bigint): string => formatUsdc(atomic);
export const swapFingerprint = (form: SwapForm): string => `${form.tokenIn}|${form.tokenOut}|${form.amount.trim()}|${form.slippageBps}`;

export function createSwapSnapshot(input: {
  binding: WalletBinding; form: SwapForm; amountAtomic: bigint; route: string; quoteId: string | null;
  estimatedOutput: string; minimumReceived: string; fees: SwapQuoteSnapshot["fees"]; sdk: string; now?: number;
}): SwapQuoteSnapshot {
  const now = input.now ?? Date.now();
  return Object.freeze({ kind: "swap", binding: input.binding, form: Object.freeze({ ...input.form }), amountAtomic: input.amountAtomic, route: input.route, provider: "Circle App Kit", quoteId: input.quoteId, estimatedOutput: input.estimatedOutput, minimumReceived: input.minimumReceived, fees: Object.freeze([...input.fees]), approval: null, createdAt: now, validUntil: now + 60_000, sdk: input.sdk });
}

export function swapSnapshotIsCurrent(snapshot: SwapQuoteSnapshot | null, form: SwapForm, binding: WalletBinding | null, now = Date.now()): boolean {
  return Boolean(snapshot && binding
    && snapshot.binding.provider === binding.provider
    && snapshot.binding.account.toLowerCase() === binding.account.toLowerCase()
    && snapshot.binding.chainId.toLowerCase() === binding.chainId.toLowerCase()
    && swapFingerprint(snapshot.form) === swapFingerprint(form)
    && now < snapshot.validUntil);
}

