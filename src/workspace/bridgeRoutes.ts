/**
 * Step 8F: the ArcFX CCTP bridge route matrix among Arc, Base and Ethereum.
 *
 * Evidence (installed @circle-fin/app-kit 1.15.2 registry + read-only runtime estimates, 0.5 USDC):
 *  - All three chains are bridge-supported, CCTP v2, with the same Circle bridge contract
 *    0xB3FA…F3F0, and support Circle's forwarder as DESTINATION (never as source).
 *  - With the forwarder, Circle mints on the destination for the user, so the wallet never has to
 *    switch networks mid-bridge. Without it, the destination mint needs the wallet on the
 *    destination chain, which ArcFX never does. Every ArcFX route therefore uses the forwarder.
 *  - Forwarder fee to Base ≈ 0.062 USDC, to Arc ≈ 0.0177 USDC, to Ethereum ≈ 1.49 USDC.
 *
 * Pure: no SDK, wallet or network access.
 */

export const BRIDGE_NETWORKS = {
  Arc: { sdk: "Arc", label: "Arc Mainnet", chainId: 5042, chainIdHex: "0x13b2", cctpDomain: 26, usdc: "0x3600000000000000000000000000000000000000", nativeSymbol: "USDC", explorerTx: "https://explorer.arc.io/tx/" },
  Base: { sdk: "Base", label: "Base", chainId: 8453, chainIdHex: "0x2105", cctpDomain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", nativeSymbol: "ETH", explorerTx: "https://basescan.org/tx/" },
  Ethereum: { sdk: "Ethereum", label: "Ethereum", chainId: 1, chainIdHex: "0x1", cctpDomain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", nativeSymbol: "ETH", explorerTx: "https://etherscan.io/tx/" },
} as const;
export type BridgeNetwork = keyof typeof BRIDGE_NETWORKS;
export const BRIDGE_NETWORK_NAMES = Object.keys(BRIDGE_NETWORKS) as BridgeNetwork[];

/** Circle's bridge contract (the USDC spender) on every supported chain. */
export const CIRCLE_BRIDGE_SPENDER = "0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0";

/**
 * executable:  quote, review and wallet execution (production only once `productionExecution`).
 * quote-only:  an honest estimate is shown, but review/execution is blocked with the stated reason.
 * hidden:      not offered by ArcFX.
 */
export type RouteStatus = "executable" | "quote-only" | "hidden";
export type BridgeRoute = Readonly<{
  source: BridgeNetwork; destination: BridgeNetwork; status: RouteStatus;
  /** Production "Confirm bridge in wallet" is allowed. False until the route has a live proof. */
  productionExecution: boolean;
  proven: boolean;
  note: string;
}>;

export const BRIDGE_ROUTES: readonly BridgeRoute[] = Object.freeze([
  { source: "Arc", destination: "Base", status: "executable", productionExecution: true, proven: true,
    note: "Proven on Arc Mainnet. Circle's forwarder mints on Base." },
  { source: "Base", destination: "Arc", status: "executable", productionExecution: false, proven: false,
    note: "Implemented with Circle's forwarder minting on Arc. Production confirmation opens after a live proof." },
  { source: "Ethereum", destination: "Arc", status: "executable", productionExecution: false, proven: false,
    note: "Implemented with Circle's forwarder minting on Arc. Production confirmation opens after a live proof." },
  { source: "Arc", destination: "Ethereum", status: "quote-only", productionExecution: false, proven: false,
    note: "Circle's forwarder fee for Ethereum delivery (about 1.49 USDC at the time of review) is far above ArcFX's 0.10 USDC controlled fee cap and the 0.5 USDC bridge limit. Without the forwarder the Ethereum mint would need your wallet on Ethereum mid-bridge, which ArcFX never does." },
  { source: "Base", destination: "Ethereum", status: "hidden", productionExecution: false, proven: false, note: "Outside the Arc treasury scope." },
  { source: "Ethereum", destination: "Base", status: "hidden", productionExecution: false, proven: false, note: "Outside the Arc treasury scope." },
].map((route) => Object.freeze(route as BridgeRoute)));

export function bridgeRoute(source: string, destination: string): BridgeRoute | null {
  return BRIDGE_ROUTES.find((route) => route.source === source && route.destination === destination) ?? null;
}

/** Destinations offered for a source (hidden routes are never listed). */
export function destinationsFor(source: BridgeNetwork): BridgeNetwork[] {
  return BRIDGE_ROUTES.filter((route) => route.source === source && route.status !== "hidden").map((route) => route.destination);
}
export const sourcesOffered = (): BridgeNetwork[] => BRIDGE_NETWORK_NAMES.filter((name) => destinationsFor(name).length > 0);

/** Why this route cannot be executed in the given mode, or null when it can. */
export function routeExecutionIssue(route: BridgeRoute | null, mode: "production" | "local"): string | null {
  if (!route || route.status === "hidden") return "ArcFX does not offer this bridge route.";
  if (route.status === "quote-only") return `${route.source} → ${route.destination} is estimate-only. ${route.note}`;
  if (mode === "production" && !route.productionExecution) return `${route.source} → ${route.destination} is implemented but awaits a live proof before production confirmation is enabled.`;
  return null;
}

export function switchWalletMessage(source: BridgeNetwork): string {
  const network = BRIDGE_NETWORKS[source];
  return `Switch wallet to ${source} (${network.label}, chain ${network.chainId}) in your wallet, then request the estimate again. ArcFX never switches networks automatically.`;
}

// ── SDK registry validation ──────────────────────────────────────────────────

export type SdkChain = {
  type?: string; chain?: string; chainId?: number; isTestnet?: boolean; usdcAddress?: string | null;
  cctp?: { domain?: number; forwarderSupported?: { source?: boolean; destination?: boolean } } | null;
  kitContracts?: { bridge?: string } | null;
};
export type ResolvedRoute = Readonly<{
  route: BridgeRoute; sourceUsdc: string; spender: string; sourceDomain: number; destinationDomain: number; sourceChainIdHex: string;
}>;

const lower = (value: unknown) => String(value ?? "").toLowerCase();

function registryChain(chains: readonly SdkChain[], network: BridgeNetwork): SdkChain {
  const expected = BRIDGE_NETWORKS[network];
  const matches = chains.filter((chain) => chain.chainId === expected.chainId && chain.isTestnet === false);
  if (matches.length !== 1) throw new Error(`Circle SDK does not expose an unambiguous ${expected.label} Mainnet bridge chain.`);
  const chain = matches[0];
  if (chain.type !== "evm" || chain.chain !== expected.sdk) throw new Error(`Circle SDK ${expected.label} chain definition is unexpected.`);
  if (lower(chain.usdcAddress) !== lower(expected.usdc)) throw new Error(`Circle SDK ${expected.label} USDC address does not match canonical USDC.`);
  if (chain.cctp?.domain !== expected.cctpDomain) throw new Error(`Circle SDK ${expected.label} CCTP domain does not match ${expected.cctpDomain}.`);
  if (lower(chain.kitContracts?.bridge) !== lower(CIRCLE_BRIDGE_SPENDER)) throw new Error(`Circle SDK ${expected.label} bridge contract does not match the expected Circle bridge.`);
  return chain;
}

/** Validates a route against the installed SDK's bridge registry. Throws on any mismatch. */
export function resolveSdkRoute(chains: readonly SdkChain[], source: string, destination: string): ResolvedRoute {
  const route = bridgeRoute(source, destination);
  if (!route || route.status === "hidden") throw new Error("ArcFX does not offer this bridge route.");
  const from = registryChain(chains, route.source);
  const to = registryChain(chains, route.destination);
  if (to.cctp?.forwarderSupported?.destination !== true) throw new Error(`Circle's forwarder does not support ${route.destination} as a destination in this SDK.`);
  void from;
  return Object.freeze({
    route, sourceUsdc: BRIDGE_NETWORKS[route.source].usdc, spender: CIRCLE_BRIDGE_SPENDER,
    sourceDomain: BRIDGE_NETWORKS[route.source].cctpDomain, destinationDomain: BRIDGE_NETWORKS[route.destination].cctpDomain,
    sourceChainIdHex: BRIDGE_NETWORKS[route.source].chainIdHex,
  });
}

// ── amounts ──────────────────────────────────────────────────────────────────

/** Decimal native amount (e.g. "0.000000945" ETH, 18 decimals) → wei. Null when malformed. */
export function parseNativeAmount(value: string | null | undefined, decimals = 18): bigint | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export type GasFeeView = { type: string; token: string; amount: string | null; network?: string; error?: boolean };

/**
 * Total source-chain gas (approve + burn) from Circle's gasFees, in wei of the source's native token.
 * Null if any source entry is missing, errored, in an unexpected token, or none are returned.
 */
export function sourceGasRequirement(gasFees: readonly GasFeeView[], source: BridgeNetwork): bigint | null {
  const entries = gasFees.filter((fee) => fee.network === BRIDGE_NETWORKS[source].sdk);
  if (!entries.length) return null;
  let total = 0n;
  for (const fee of entries) {
    if (fee.error || fee.token !== BRIDGE_NETWORKS[source].nativeSymbol) return null;
    const wei = parseNativeAmount(fee.amount);
    if (wei == null) return null;
    total += wei;
  }
  return total;
}

/** Required native balance on a non-Arc source: twice Circle's approve+burn estimate. */
export const sourceGasReserve = (estimateWei: bigint): bigint => estimateWei * 2n;

const USDC_SCALE = 1_000_000n;
function usdcAtomic(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0") || "0");
}
function formatUsdc(atomic: bigint): string {
  const fraction = (atomic % USDC_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${atomic / USDC_SCALE}${fraction ? `.${fraction}` : ""}`;
}

/** Amount − maximum bridge fee: the least USDC the recipient receives. Null when not calculable. */
export function minimumDelivered(amount: string, maxFee: string | null): string | null {
  const a = usdcAtomic(amount); const f = usdcAtomic(maxFee);
  if (a == null || f == null || a <= f) return null;
  return formatUsdc(a - f);
}

/** Honest destination description: the forwarder mints; Circle returns no separate destination gas figure. */
export function destinationMintText(destination: BridgeNetwork, gasFees: readonly GasFeeView[]): string {
  const destinationGas = gasFees.filter((fee) => fee.network === BRIDGE_NETWORKS[destination].sdk);
  if (destinationGas.length) return `Destination (${destination}) mint gas: ${destinationGas.map((fee) => `${fee.amount ?? "unavailable"} ${fee.token}`).join(", ")}`;
  return `Destination (${destination}) mint: performed by Circle's forwarder and paid from the forwarder fee; Circle returned no separate destination gas estimate.`;
}
