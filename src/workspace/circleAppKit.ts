import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import type { Eip1193Provider } from "../shared/wallet";

export const CIRCLE_SDK_ID = "@circle-fin/app-kit@1.15.2";
export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000";

export type CircleChain = {
  type?: string;
  chain?: string;
  name?: string;
  title?: string;
  chainId?: number;
  isTestnet?: boolean;
  explorerUrl?: string;
  rpcEndpoints?: readonly string[];
  usdcAddress?: string | null;
  eurcAddress?: string | null;
  cctp?: { domain?: number } | null;
};

export type CapabilitySource = {
  getSupportedChains(operation?: "swap" | "bridge"): CircleChain[];
};

export type ArcCapability = {
  sdk: typeof CIRCLE_SDK_ID;
  chainIdentifier: string;
  name: string;
  title: string;
  chainId: 5042;
  isTestnet: false;
  explorerUrl: string;
  rpcEndpoints: readonly string[];
  usdcAddress: string;
  eurcAddress: string | null;
  cctpDomain: number | null;
  swap: boolean;
  bridge: boolean;
};

const lower = (value: unknown): string => String(value || "").toLowerCase();
const isArcMainnet = (chain: CircleChain): boolean =>
  chain.type === "evm"
  && chain.chainId === ARC_MAINNET_CHAIN_ID
  && chain.isTestnet === false
  && lower(chain.usdcAddress) === ARC_MAINNET_USDC;

function uniqueArc(chains: CircleChain[], scope: string): CircleChain | null {
  const matches = chains.filter(isArcMainnet);
  if (matches.length > 1) throw new Error(`Circle SDK returned ambiguous Arc Mainnet ${scope} capability.`);
  return matches[0] || null;
}

function sameChain(a: CircleChain, b: CircleChain): boolean {
  return a.type === b.type
    && a.chainId === b.chainId
    && lower(a.usdcAddress) === lower(b.usdcAddress)
    && a.isTestnet === b.isTestnet;
}

/** Dynamic SDK data is the only source of truth for Arc Mainnet capability. */
export function discoverArcMainnetCapabilities(source: CapabilitySource): ArcCapability {
  const all = uniqueArc(source.getSupportedChains(), "chain");
  if (!all) throw new Error("Circle SDK does not expose an unambiguous Arc Mainnet chain definition.");
  const swap = uniqueArc(source.getSupportedChains("swap"), "swap");
  const bridge = uniqueArc(source.getSupportedChains("bridge"), "bridge");
  if (swap && !sameChain(all, swap)) throw new Error("Circle swap capability does not match the Arc Mainnet chain definition.");
  if (bridge && !sameChain(all, bridge)) throw new Error("Circle bridge capability does not match the Arc Mainnet chain definition.");
  const chainIdentifier = String(all.chain || "");
  if (!chainIdentifier) throw new Error("Circle Arc Mainnet capability is missing its chain identifier.");
  return {
    sdk: CIRCLE_SDK_ID,
    chainIdentifier,
    name: String(all.name || chainIdentifier),
    title: String(all.title || all.name || chainIdentifier),
    chainId: ARC_MAINNET_CHAIN_ID,
    isTestnet: false,
    explorerUrl: String(all.explorerUrl || ""),
    rpcEndpoints: Array.isArray(all.rpcEndpoints) ? all.rpcEndpoints : [],
    usdcAddress: String(all.usdcAddress),
    eurcAddress: all.eurcAddress ? String(all.eurcAddress) : null,
    cctpDomain: Number.isInteger(all.cctp?.domain) ? Number(all.cctp?.domain) : null,
    swap: Boolean(swap),
    bridge: Boolean(bridge),
  };
}

/** Static SDK registry probe. It has no wallet/provider and cannot request a signature. */
export function probeInstalledCircleCapabilities(): ArcCapability {
  return discoverArcMainnetCapabilities(new AppKit());
}

export type NormalizedFee = { type: string; token: string; amount: string | null; network?: string; error?: boolean };
export type SwapEstimateView = {
  route: string;
  amountIn: string;
  estimatedOutput: string;
  outputToken: string;
  minimumReceived: string;
  fees: NormalizedFee[];
  quoteId: null;
  approval: null;
};
export type BridgeEstimateView = {
  route: string;
  amount: string;
  sourceAddress: string;
  destinationAddress: string;
  fees: NormalizedFee[];
  gasFees: NormalizedFee[];
  warnings: string[];
  quoteId: string | null;
};

export type ReadonlyCircleClient = {
  readonly capability: ArcCapability;
  estimateSwap(input: { chain: string; tokenIn: "USDC" | "EURC"; tokenOut: "USDC" | "EURC"; amount: string; slippageBps: number }): Promise<SwapEstimateView>;
  estimateBridge(input: { sourceChain: string; destinationChain: string; recipient: string; amount: string }): Promise<BridgeEstimateView>;
};

type AppKitEstimateSurface = CapabilitySource & {
  estimateSwap(params: any): Promise<any>;
  estimateBridge(params: any): Promise<any>;
};
type AdapterFactory = (input: { provider: Eip1193Provider }) => Promise<any>;

/**
 * This is the Step 8B security boundary. The returned surface exposes discovery
 * and estimates only. AppKit swap/bridge/retry and adapter signing are not
 * reachable by the workspace controller.
 */
export async function createReadonlyCircleClient(
  provider: Eip1193Provider,
  dependencies: { kit?: AppKitEstimateSurface; createAdapter?: AdapterFactory } = {},
): Promise<ReadonlyCircleClient> {
  if (!provider || typeof provider.request !== "function") throw new Error("The selected ArcFX wallet provider is unavailable.");
  const kit = dependencies.kit || new AppKit() as AppKitEstimateSurface;
  const capability = discoverArcMainnetCapabilities(kit);
  const adapter = dependencies.createAdapter
    ? await dependencies.createAdapter({ provider })
    : await createViemAdapterFromProvider({ provider: provider as any });
  return Object.freeze({
    capability,
    async estimateSwap(input) {
      if (!capability.swap) throw new Error("Circle SDK does not currently advertise swaps on Arc Mainnet.");
      const result = await kit.estimateSwap({
        from: { adapter, chain: input.chain },
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amount,
        config: { slippageBps: input.slippageBps, allowanceStrategy: "approve" },
      });
      return {
        route: `${String(result.chainIn)} → ${String(result.chainOut)}`,
        amountIn: String(result.amountIn),
        estimatedOutput: String(result.estimatedOutput?.amount || ""),
        outputToken: String(result.estimatedOutput?.token || input.tokenOut),
        minimumReceived: String(result.stopLimit?.amount || ""),
        fees: Array.isArray(result.fees) ? result.fees.map((fee: any) => ({ type: String(fee.type || "provider"), token: String(fee.token || ""), amount: fee.amount == null ? null : String(fee.amount), error: Boolean(fee.error) })) : [],
        quoteId: null,
        approval: null,
      };
    },
    async estimateBridge(input) {
      if (!capability.bridge) throw new Error("Circle SDK does not currently advertise bridges on Arc Mainnet.");
      const result = await kit.estimateBridge({
        from: { adapter, chain: input.sourceChain },
        to: { adapter, chain: input.destinationChain, recipientAddress: input.recipient },
        amount: input.amount,
        token: "USDC",
      });
      return {
        route: `${String(result.source?.chain || input.sourceChain)} → ${String(result.destination?.chain || input.destinationChain)}`,
        amount: String(result.amount || input.amount),
        sourceAddress: String(result.source?.address || ""),
        destinationAddress: String(result.destination?.recipientAddress || result.destination?.address || input.recipient),
        fees: Array.isArray(result.fees) ? result.fees.map((fee: any) => ({ type: String(fee.type || "provider"), token: String(fee.token || ""), amount: fee.amount == null ? null : String(fee.amount), error: Boolean(fee.error) })) : [],
        gasFees: Array.isArray(result.gasFees) ? result.gasFees.map((fee: any) => ({ type: String(fee.name || "network"), token: String(fee.token || ""), amount: (fee.fees?.fee ?? fee.fees?.fees) == null ? null : String(fee.fees?.fee ?? fee.fees?.fees), network: String(fee.blockchain || ""), error: Boolean(fee.error) })) : [],
        warnings: Array.isArray(result.warnings) ? result.warnings.map((warning: any) => String(warning?.message || warning?.code || warning)) : [],
        // The SDK's optional `quote` is an opaque reusable payload, not a safe
        // display identifier. Step 8B neither reads, logs, persists nor exposes it.
        quoteId: null,
      };
    },
  });
}
