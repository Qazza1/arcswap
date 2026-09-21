import { parseUsdcAmount } from "./mainnetPayments";
import { ARCFX_MAINNET_TRADE_EXECUTION_ENABLED, requireTradeExecutionEnabled } from "./tradeExecutionGate";
import type { BridgeQuoteSnapshot } from "./bridgeCore";
import type { SwapQuoteSnapshot } from "./swapCore";

export const EXECUTION_STATES = [
  "REVIEW_READY", "APPROVAL_REQUESTED", "APPROVAL_SUBMITTED", "APPROVAL_CONFIRMED",
  "SWAP_SUBMITTED", "SWAP_CONFIRMED", "BURN_SUBMITTED", "BURN_CONFIRMED",
  "ATTESTATION_PENDING", "ATTESTATION_READY", "MINT_SUBMITTED", "MINT_CONFIRMED",
  "PENDING", "FAILED", "CANCELLED", "RECOVERY_REQUIRED",
] as const;
export type ExecutionState = typeof EXECUTION_STATES[number];
export type ExecutionKind = "swap" | "bridge";

/** `provider` is intentionally an object identity, never a rediscovered label. */
export type ExecutionBinding = Readonly<{ provider: object; providerId: string; account: string; chainId: string }>;
export type ExecutionIntent = Readonly<{
  idempotencyKey: string;
  kind: ExecutionKind;
  binding: ExecutionBinding;
  sourceNetwork: "arc-mainnet";
  sourceChainId: 5042;
  sourceToken: "USDC" | "EURC";
  destinationToken: "USDC" | "EURC";
  amountAtomic: string;
  minimumOutputAtomic: string | null;
  slippageBps: number | null;
  quoteSnapshot: Record<string, unknown>;
  quoteExpiresAt: number;
}>;

export type ExecutionOperation = Readonly<{ id: string; version: number; intent: ExecutionIntent; state: ExecutionState; txHashes: readonly string[] }>;
export type Journal = { createIntent(intent: ExecutionIntent): Promise<{ id: string; version: number }> };
export type ExplicitNetworkSwitch = (chainId: string) => Promise<void>;

const next: Partial<Record<ExecutionState, readonly ExecutionState[]>> = {
  REVIEW_READY: ["APPROVAL_REQUESTED", "SWAP_SUBMITTED", "BURN_SUBMITTED", "CANCELLED", "FAILED"],
  APPROVAL_REQUESTED: ["APPROVAL_SUBMITTED", "FAILED", "CANCELLED"],
  APPROVAL_SUBMITTED: ["APPROVAL_CONFIRMED", "FAILED", "RECOVERY_REQUIRED"],
  APPROVAL_CONFIRMED: ["SWAP_SUBMITTED", "BURN_SUBMITTED", "CANCELLED", "FAILED"],
  SWAP_SUBMITTED: ["SWAP_CONFIRMED", "FAILED", "RECOVERY_REQUIRED"],
  BURN_SUBMITTED: ["BURN_CONFIRMED", "FAILED", "RECOVERY_REQUIRED"],
  BURN_CONFIRMED: ["ATTESTATION_PENDING", "RECOVERY_REQUIRED"],
  ATTESTATION_PENDING: ["ATTESTATION_READY", "FAILED", "RECOVERY_REQUIRED"],
  ATTESTATION_READY: ["MINT_SUBMITTED", "RECOVERY_REQUIRED"],
  MINT_SUBMITTED: ["MINT_CONFIRMED", "FAILED", "RECOVERY_REQUIRED"],
  PENDING: ["RECOVERY_REQUIRED", "FAILED"],
};

function safeAtomic(value: bigint): string {
  if (value <= 0n) throw new Error("Operation amount must be a positive atomic amount.");
  return value.toString();
}

function sameBinding(left: ExecutionBinding, right: ExecutionBinding): boolean {
  return left.provider === right.provider && left.providerId === right.providerId
    && left.account.toLowerCase() === right.account.toLowerCase()
    && left.chainId.toLowerCase() === right.chainId.toLowerCase();
}

function boundedKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(value)) throw new Error("Operation idempotency key is invalid.");
  return value;
}

/** Converts a reviewed quote into a serializable, wallet-bound journal intent. */
export function intentFromReviewedSwap(quote: SwapQuoteSnapshot, providerId: string, idempotencyKey: string): ExecutionIntent {
  // Step 8C persists only a canonical-USDC input. EURC execution needs its own
  // canonical on-chain registry review before it can enter the durable journal.
  if (quote.form.tokenIn !== "USDC" || !quote.minimumReceived) throw new Error("This reviewed swap is not eligible for the canonical-USDC execution journal.");
  const minimum = parseUsdcAmount(quote.minimumReceived);
  if (!minimum.ok) throw new Error("The swap quote minimum is not an exact six-decimal amount.");
  return Object.freeze({
    idempotencyKey: boundedKey(idempotencyKey), kind: "swap",
    binding: Object.freeze({ provider: quote.binding.provider, providerId, account: quote.binding.account, chainId: quote.binding.chainId }),
    sourceNetwork: "arc-mainnet", sourceChainId: 5042, sourceToken: quote.form.tokenIn, destinationToken: quote.form.tokenOut,
    amountAtomic: safeAtomic(quote.amountAtomic), minimumOutputAtomic: minimum.value.toString(), slippageBps: quote.form.slippageBps,
    quoteSnapshot: Object.freeze({ route: quote.route, provider: quote.provider, estimatedOutput: quote.estimatedOutput, minimumReceived: quote.minimumReceived, fees: quote.fees, sdk: quote.sdk }),
    quoteExpiresAt: quote.validUntil,
  });
}

export function intentFromReviewedBridge(quote: BridgeQuoteSnapshot, providerId: string, idempotencyKey: string): ExecutionIntent {
  return Object.freeze({
    idempotencyKey: boundedKey(idempotencyKey), kind: "bridge",
    binding: Object.freeze({ provider: quote.binding.provider, providerId, account: quote.binding.account, chainId: quote.binding.chainId }),
    sourceNetwork: "arc-mainnet", sourceChainId: 5042, sourceToken: "USDC", destinationToken: "USDC",
    amountAtomic: safeAtomic(quote.amountAtomic), minimumOutputAtomic: null, slippageBps: null,
    quoteSnapshot: Object.freeze({ route: quote.route, provider: quote.provider, recipient: quote.form.recipient, warnings: quote.warnings, fees: quote.fees, sdk: quote.sdk }),
    quoteExpiresAt: quote.validUntil,
  });
}

export function reviewIsExecutable(intent: ExecutionIntent, current: ExecutionBinding, now = Date.now()): boolean {
  return now < intent.quoteExpiresAt && sameBinding(intent.binding, current);
}

/** A journal row is durably created before an execution adapter may be invoked. */
export async function persistReviewedIntent(intent: ExecutionIntent, current: ExecutionBinding, journal: Journal): Promise<ExecutionOperation> {
  if (!reviewIsExecutable(intent, current)) throw new Error("Review is stale or the selected wallet context changed. Request a fresh quote.");
  const saved = await journal.createIntent(intent);
  return Object.freeze({ id: saved.id, version: saved.version, intent, state: "REVIEW_READY", txHashes: Object.freeze([]) });
}

export function transition(operation: ExecutionOperation, state: ExecutionState, txHash?: string): ExecutionOperation {
  if (!next[operation.state]?.includes(state)) throw new Error(`Invalid wallet-operation transition: ${operation.state} → ${state}`);
  if (txHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Transaction hash is invalid.");
  return Object.freeze({ ...operation, version: operation.version + 1, state, txHashes: Object.freeze(txHash ? [...operation.txHashes, txHash.toLowerCase()] : [...operation.txHashes]) });
}

/** No 'Max' path exists: reserves must exceed the estimated requirement. */
export function hasGasReserve(nativeBalanceAtomic: bigint, estimatedRequirementAtomic: bigint, reserveAtomic: bigint): boolean {
  return nativeBalanceAtomic >= estimatedRequirementAtomic + reserveAtomic;
}

/**
 * This function can only be called by an explicit click handler supplied by the
 * UI. It cannot run during quote/load/restoration because no callback is held
 * or invoked anywhere else in this module.
 */
export async function requestExplicitSourceNetworkSwitch(expectedChainId: string, switchNetwork: ExplicitNetworkSwitch): Promise<void> {
  if (!/^0x[0-9a-f]+$/i.test(expectedChainId)) throw new Error("Unsupported source network.");
  await switchNetwork(expectedChainId);
}

export type BridgeRecovery = "WAIT_FOR_ATTESTATION" | "RESUME_DESTINATION_MINT" | "DO_NOT_RETRY_BURN" | "NO_RECOVERY";
/** A recorded burn is never re-submitted automatically, even after reload. */
export function bridgeRecovery(state: ExecutionState): BridgeRecovery {
  if (state === "BURN_CONFIRMED" || state === "ATTESTATION_PENDING") return "WAIT_FOR_ATTESTATION";
  if (state === "ATTESTATION_READY" || state === "MINT_SUBMITTED") return "RESUME_DESTINATION_MINT";
  if (state === "BURN_SUBMITTED" || state === "RECOVERY_REQUIRED") return "DO_NOT_RETRY_BURN";
  return "NO_RECOVERY";
}

/**
 * Circle's BridgeResult contains arbitrary `data`/`error` payloads and retry
 * requires the original result plus live adapters. Do not stringify it or
 * claim it can be reconstructed. Only these safe observation fields may enter
 * a journal later, after independent chain verification.
 */
export function sanitizeBridgeObservation(value: unknown): { state: string; steps: readonly { name: string; state: string; txHash: string | null }[] } {
  if (!value || typeof value !== "object") throw new Error("Bridge observation is invalid.");
  const result = value as any;
  if (!["pending", "success", "error"].includes(result.state) || !Array.isArray(result.steps)) throw new Error("Bridge observation is incomplete.");
  return Object.freeze({ state: result.state, steps: Object.freeze(result.steps.map((step: any) => {
    if (!step || typeof step.name !== "string" || typeof step.state !== "string") throw new Error("Bridge step is invalid.");
    if (step.txHash != null && !/^0x[0-9a-fA-F]{64}$/.test(step.txHash)) throw new Error("Bridge transaction hash is invalid.");
    return Object.freeze({ name: step.name, state: step.state, txHash: step.txHash?.toLowerCase() || null });
  })) });
}

/** Feature-gated execution seam. The present release cannot invoke Circle mutation APIs. */
export function assertExecutionRouteEnabled(): void {
  if (!ARCFX_MAINNET_TRADE_EXECUTION_ENABLED) requireTradeExecutionEnabled();
}
