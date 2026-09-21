/**
 * Deliberate product gate for Step 8C. This is defence in depth only: the
 * backend has no signer or relay, and all wallet calls remain user-owned. A
 * future release must change this reviewed constant alongside its execution
 * adapter policy; environment configuration alone is never an authorization.
 */
export const ARCFX_MAINNET_TRADE_EXECUTION_ENABLED = false as const;
export const TRADE_EXECUTION_DISABLED_REASON = "Mainnet trade execution is not enabled in this release.";

/**
 * A deliberately local-only escape hatch for the Step 8D.1 owner proof. Vite
 * replaces `DEV` at build time, so this stays false in every production build
 * even if a deployment accidentally supplies the local flag.
 */
export const LOCAL_SWAP_PROOF_FLAG = "arcfx-local-swap-proof-v1";
export const LOCAL_SWAP_PROOF_ENABLED = Boolean(
  import.meta.env.DEV && import.meta.env.VITE_ARCFX_LOCAL_SWAP_PROOF === LOCAL_SWAP_PROOF_FLAG,
);
export const LOCAL_SWAP_PROOF_DISABLED_REASON = "Local swap proof is disabled. Start a local Vite server with the reviewed proof flag.";

export function requireLocalSwapProofEnabled(): void {
  if (!LOCAL_SWAP_PROOF_ENABLED) throw new Error(LOCAL_SWAP_PROOF_DISABLED_REASON);
}

/**
 * Separate local-only opt-in for the Step 8D.2 Arc-to-Base bridge proof. It
 * shares the production-safe DEV guard but cannot enable the general trade
 * execution gate or any deployed build.
 */
export const LOCAL_BRIDGE_PROOF_FLAG = "arcfx-local-bridge-proof-v1";
export const LOCAL_BRIDGE_PROOF_ENABLED = Boolean(
  import.meta.env.DEV && import.meta.env.VITE_ARCFX_LOCAL_BRIDGE_PROOF === LOCAL_BRIDGE_PROOF_FLAG,
);
export const LOCAL_BRIDGE_PROOF_DISABLED_REASON = "Local bridge proof is disabled. Start a local Vite server with the reviewed bridge proof flag.";

export function requireLocalBridgeProofEnabled(): void {
  if (!LOCAL_BRIDGE_PROOF_ENABLED) throw new Error(LOCAL_BRIDGE_PROOF_DISABLED_REASON);
}

export function requireTradeExecutionEnabled(): void {
  if (!ARCFX_MAINNET_TRADE_EXECUTION_ENABLED) throw new Error(TRADE_EXECUTION_DISABLED_REASON);
}
