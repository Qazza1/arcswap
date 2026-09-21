/**
 * Deliberate product gate for Step 8C. This is defence in depth only: the
 * backend has no signer or relay, and all wallet calls remain user-owned. A
 * future release must change this reviewed constant alongside its execution
 * adapter policy; environment configuration alone is never an authorization.
 */
export const ARCFX_MAINNET_TRADE_EXECUTION_ENABLED = false as const;
export const TRADE_EXECUTION_DISABLED_REASON = "Mainnet trade execution is not enabled in this release.";

export function requireTradeExecutionEnabled(): void {
  if (!ARCFX_MAINNET_TRADE_EXECUTION_ENABLED) throw new Error(TRADE_EXECUTION_DISABLED_REASON);
}
