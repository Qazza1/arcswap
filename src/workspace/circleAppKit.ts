import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { BrowserProvider, Contract } from "ethers";
import type { Eip1193Provider } from "../shared/wallet";
import { parseUsdcAmount } from "./mainnetPayments";
import { requireLocalBridgeProofEnabled, requireLocalSwapProofEnabled } from "./tradeExecutionGate";

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
  kitContracts?: { adapter?: string; bridge?: string } | null;
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
  bridgeSpenderAddress: string;
  /** Chain-defined Circle adapter approved by the local proof only after validation. */
  swapAdapterAddress: string;
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

function validAddress(value: unknown): string | null {
  const address = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
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
  const swapAdapterAddress = validAddress(all.kitContracts?.adapter);
  if (!swapAdapterAddress) throw new Error("Circle Arc Mainnet capability is missing its swap adapter address.");
  const bridgeSpenderAddress = validAddress(all.kitContracts?.bridge);
  if (lower(bridgeSpenderAddress) !== "0xb3fa262d0fb521cc93be83d87b322b8a23daf3f0") throw new Error("Circle Arc Mainnet bridge spender is missing or does not match the expected Mainnet bridge contract.");
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
    bridgeSpenderAddress,
    swapAdapterAddress,
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
  maxFee: string | null;
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
type AppKitLocalSwapSurface = AppKitEstimateSurface & { swap(params: any): Promise<any> };
type AppKitLocalBridgeSurface = AppKitEstimateSurface & { bridge(params: any): Promise<any> };
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
      const destination = input.sourceChain === "Arc" && input.destinationChain === "Base"
        ? { chain: "Base", recipientAddress: input.recipient, useForwarder: true }
        : { adapter, chain: input.destinationChain, recipientAddress: input.recipient };
      const result = await kit.estimateBridge({
        from: { adapter, chain: input.sourceChain },
        to: destination,
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
        maxFee: result.maxFee == null ? null : String(result.maxFee),
      };
    },
  });
}

const ERC20_ALLOWANCE_ABI = ["function allowance(address,address) view returns (uint256)"];
const PROOF_MAX_USDC_ATOMIC = 1_000_000n;
// Arc uses an 18-decimal native USDC representation for gas. This guard is a
// reserve, not a fee estimate; the wallet remains the final gas authority.
export const LOCAL_SWAP_PROOF_NATIVE_GAS_RESERVE = 10_000_000_000_000_000n; // 0.01 native USDC

export type LocalSwapProofReview = Readonly<{
  route: string; estimatedOutput: string; minimumReceived: string;
  fees: readonly NormalizedFee[];
}>;
export type LocalSwapProofResult = Readonly<{
  approvalTxHashes: readonly string[];
  swapTxHash: string;
  result: Readonly<{ txHash: string; explorerUrl: string | null; progress: unknown; amountOut: string | null }>;
}>;

function reviewEquals(left: LocalSwapProofReview, right: LocalSwapProofReview): boolean {
  return left.route === right.route && left.estimatedOutput === right.estimatedOutput
    && left.minimumReceived === right.minimumReceived && JSON.stringify(left.fees) === JSON.stringify(right.fees);
}

async function assertProofProviderBinding(provider: Eip1193Provider, expectedAccount: string): Promise<void> {
  const [accounts, chainId] = await Promise.all([
    provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
  ]);
  if (!Array.isArray(accounts) || String(accounts[0] || "").toLowerCase() !== expectedAccount.toLowerCase()
      || String(chainId).toLowerCase() !== "0x13b2") {
    throw new Error("The selected provider account or network changed. Request a fresh local proof review.");
  }
}

export type LocalSwapProofClient = Readonly<{
  capability: ArcCapability;
  executeExactUsdcToEurc(input: {
    account: string; amount: string; slippageBps: number; reviewed: LocalSwapProofReview;
  }): Promise<LocalSwapProofResult>;
}>;

const PROOF_MAX_BRIDGE_USDC_ATOMIC = 10_000n;
export type LocalBridgeProofReview = Readonly<{
  route: string; amount: string; sourceChain: string; destinationChain: string; recipient: string;
  maxFee: string | null; fees: readonly NormalizedFee[]; gasFees: readonly NormalizedFee[]; warnings: readonly string[];
}>;
export type LocalBridgeProofStep = Readonly<{
  name: string; state: string; attempted: boolean; txHash: string | null; explorerUrl: string | null; forwarded: boolean | null;
  errorCategory: string | null; errorCode: string | null; errorMessage: string | null;
}>;
export type LocalBridgeProofObservation = Readonly<{
  state: string; sourceTxHashes: readonly string[]; destinationTxHashes: readonly string[];
  provider: string; sourceChain: string; destinationChain: string;
  attestationState: string; destinationState: string; errorState: string | null; errorCode: string | null; errorMessage: string | null;
  originalError: Readonly<{
    name: string | null; code: string | null; message: string | null; shortMessage: string | null;
    reason: string | null; details: string | null; cause: readonly string[]; keys: readonly string[];
  }> | null;
  steps: readonly LocalBridgeProofStep[];
}>;
export type LocalBridgeProofResult = LocalBridgeProofObservation;

function bridgeReview(result: any, fallbackAmount: string, sourceChain: string, destinationChain: string, recipient: string): LocalBridgeProofReview {
  return {
    route: `${String(result.source?.chain || "Arc")} → ${String(result.destination?.chain || "Base")}`,
    amount: String(result.amount || fallbackAmount),
    sourceChain, destinationChain, recipient: recipient.toLowerCase(),
    maxFee: result.maxFee == null ? null : String(result.maxFee),
    fees: Array.isArray(result.fees) ? result.fees.map((fee: any) => ({ type: String(fee.type || "provider"), token: String(fee.token || ""), amount: fee.amount == null ? null : String(fee.amount), error: Boolean(fee.error) })) : [],
    gasFees: Array.isArray(result.gasFees) ? result.gasFees.map((fee: any) => ({ type: String(fee.name || "network"), token: String(fee.token || ""), amount: (fee.fees?.fee ?? fee.fees?.fees) == null ? null : String(fee.fees?.fee ?? fee.fees?.fees), network: String(fee.blockchain || ""), error: Boolean(fee.error) })) : [],
    warnings: Array.isArray(result.warnings) ? result.warnings.map((warning: any) => String(warning?.message || warning?.code || warning)) : [],
  };
}

const MAX_LOCAL_BRIDGE_SERVICE_FEE_ATOMIC = 100_000n; // 0.10 USDC at six decimals
const isBridgeServiceFee = (fee: NormalizedFee) => /provider|service|forwarder/i.test(fee.type);

function freshBridgeServiceFeeTotal(fees: readonly NormalizedFee[]): bigint | null {
  let total = 0n;
  for (const fee of fees.filter(isBridgeServiceFee)) {
    if (fee.error || fee.token !== "USDC" || fee.amount == null) return null;
    const parsed = parseUsdcAmount(fee.amount);
    if (!parsed.ok) return null;
    total += parsed.value;
  }
  return total;
}

function formatAtomicUsdc(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function parseNonNegativeUsdc(value: string | null): bigint | null {
  if (value == null) return null;
  const text = value.trim();
  if (/^0(?:\.0{1,6})?$/.test(text)) return 0n;
  const parsed = parseUsdcAmount(text);
  return parsed.ok && parsed.value !== undefined ? parsed.value : null;
}

export function bridgeAmountMaxFeeIssue(amount: string, maxFee: string | null): string | null {
  const parsedAmount = parseUsdcAmount(amount);
  const parsedMaxFee = parseNonNegativeUsdc(maxFee);
  if (!parsedAmount.ok || parsedAmount.value === undefined || parsedMaxFee == null) return "Bridge amount must be greater than the current maximum bridge fee. Current maximum bridge fee is unavailable or invalid.";
  if (parsedAmount.value <= parsedMaxFee) return `Bridge amount must be greater than the current maximum bridge fee. Bridge amount: ${formatAtomicUsdc(parsedAmount.value)} USDC. Current maximum bridge fee: ${formatAtomicUsdc(parsedMaxFee)} USDC.`;
  return null;
}

export function bridgeExistingAllowanceIssue(allowance: bigint): string | null {
  return allowance === 0n ? null : `Existing Circle bridge allowance must be cleared before starting a new bridge proof. Current allowance: ${formatAtomicUsdc(allowance)} USDC.`;
}

export function bridgeProofFreshEstimateIssue(fresh: LocalBridgeProofReview): string | null {
  const maxFeeIssue = bridgeAmountMaxFeeIssue(fresh.amount, fresh.maxFee);
  if (maxFeeIssue) return maxFeeIssue;
  const feeTotal = freshBridgeServiceFeeTotal(fresh.fees);
  if (feeTotal == null) return "Fresh provider/service/forwarder fee data is invalid.";
  if (feeTotal > MAX_LOCAL_BRIDGE_SERVICE_FEE_ATOMIC) return `Fresh provider/service/forwarder fees are ${formatAtomicUsdc(feeTotal)} USDC, above the 0.10 USDC local-proof cap.`;
  if (fresh.warnings.some(warning => /block|error|fail|reject|unsupported|unavailable/i.test(warning))) return "Fresh provider warning blocks this local bridge proof.";
  return null;
}

export function bridgeReviewEquals(left: LocalBridgeProofReview, right: LocalBridgeProofReview): boolean {
  return left.route === right.route && left.amount === right.amount
    && left.sourceChain === right.sourceChain && left.destinationChain === right.destinationChain
    && left.recipient.toLowerCase() === right.recipient.toLowerCase()
    && bridgeProofFreshEstimateIssue(right) === null
    && JSON.stringify(left.warnings) === JSON.stringify(right.warnings);
}

function safeDiagnosticMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{16,}/gi, "[redacted-hex]")
    .replace(/[A-Za-z0-9+/_=-]{96,}/g, "[redacted-payload]")
    .slice(0, 240);
}

function safeChainIdentifier(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const chain = value as { chain?: unknown; name?: unknown; title?: unknown };
    if (typeof chain.chain === "string") return chain.chain;
    if (typeof chain.name === "string") return chain.name;
    if (typeof chain.title === "string") return chain.title;
  }
  return "not returned";
}

function safeErrorPrimitive(value: unknown): string | null {
  if (typeof value === "string") return safeDiagnosticMessage(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function safeOriginalError(error: any): LocalBridgeProofObservation["originalError"] {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  const fromData = error.data && typeof error.data === "object" ? error.data : null;
  const cause: string[] = [];
  let current = error.cause;
  for (let depth = 0; depth < 2 && current && typeof current === "object"; depth += 1) {
    const parts = ["name", "code", "message", "shortMessage", "reason", "details"]
      .map(key => {
        const safe = safeErrorPrimitive(current[key]);
        return safe == null ? null : `${key}: ${safe}`;
      }).filter((part): part is string => part != null);
    if (parts.length) cause.push(parts.join("; "));
    current = current.cause;
  }
  const keys = Object.keys(error).slice(0, 32).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key));
  return Object.freeze({
    name: safeErrorPrimitive(error.name) ?? safeErrorPrimitive(fromData?.name),
    code: safeErrorPrimitive(error.code) ?? safeErrorPrimitive(fromData?.code),
    message: safeErrorPrimitive(error.message) ?? safeErrorPrimitive(fromData?.message),
    shortMessage: safeErrorPrimitive(error.shortMessage),
    reason: safeErrorPrimitive(error.reason) ?? safeErrorPrimitive(fromData?.reason),
    details: safeErrorPrimitive(error.details),
    cause: Object.freeze(cause), keys: Object.freeze(keys),
  });
}

export function localBridgeProofDiagnostic(value: any, fallbackError?: any): LocalBridgeProofObservation {
  const steps: LocalBridgeProofStep[] = Array.isArray(value?.steps) ? value.steps.map((step: any) => Object.freeze({
    name: String(step?.name || "unknown"), state: String(step?.state || "unknown"),
    attempted: step?.state !== "noop" && step?.state !== undefined,
    txHash: /^0x[0-9a-fA-F]{64}$/.test(String(step?.txHash || "")) ? String(step.txHash) : null,
    explorerUrl: typeof step?.explorerUrl === "string" ? step.explorerUrl : null,
    forwarded: typeof step?.forwarded === "boolean" ? step.forwarded : null,
    errorCategory: typeof step?.errorCategory === "string" ? step.errorCategory : null,
    errorCode: typeof step?.errorCode === "string" || typeof step?.code === "number" ? String(step.errorCode ?? step.code) : null,
    errorMessage: safeDiagnosticMessage(step?.errorMessage),
  })) : [];
  const sourceTxHashes = steps.filter(step => /approve|fee|transfer|burn/i.test(step.name) && step.txHash).map(step => step.txHash!);
  const destinationTxHashes = steps.filter(step => /forward|mint|destination/i.test(step.name) && step.txHash).map(step => step.txHash!);
  const attestation = steps.find(step => /attestation/i.test(step.name));
  const destination = steps.find(step => /forward|mint|destination/i.test(step.name));
  return Object.freeze({
    state: String(value?.state || fallbackError?.state || "uncertain"), sourceTxHashes: Object.freeze(sourceTxHashes), destinationTxHashes: Object.freeze(destinationTxHashes),
    provider: typeof value?.provider === "string" ? value.provider : "not returned",
    sourceChain: safeChainIdentifier(value?.source?.chain), destinationChain: safeChainIdentifier(value?.destination?.chain),
    // Preserve status only: attestation bytes and provider payloads are never
    // displayed, logged, persisted, or sent anywhere by this local proof.
    attestationState: String(value?.steps?.find((step: any) => /attestation/i.test(String(step?.name || "")))?.data?.status || attestation?.state || "not returned"),
    destinationState: String(value?.steps?.find((step: any) => /forward|mint|destination/i.test(String(step?.name || "")))?.data?.forwardState || destination?.state || "not returned"),
    errorState: typeof value?.errorCategory === "string" ? value.errorCategory : typeof value?.steps?.find((step: any) => step?.state === "error")?.errorCategory === "string" ? value.steps.find((step: any) => step?.state === "error").errorCategory : null,
    errorCode: typeof value?.code === "string" || typeof value?.code === "number" ? String(value.code) : typeof fallbackError?.code === "string" || typeof fallbackError?.code === "number" ? String(fallbackError.code) : null,
    errorMessage: safeDiagnosticMessage(value?.errorMessage ?? fallbackError?.message),
    originalError: fallbackError ? safeOriginalError(fallbackError) : null,
    steps: Object.freeze(steps),
  });
}

const ARC_MAINNET_CHAIN_ID_HEX = "0x13b2";

function canonicalChainId(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return null; }
}

/**
 * Circle's browser adapter calls switchChain before every write. For this proof
 * we acknowledge only its Arc-5042 preflight when the pinned raw provider is
 * already on Arc-5042. The wallet never receives a switch request; every other
 * switch and every add-chain request remains fail-closed.
 */
export function arcMainnetNoSwitchProvider(provider: Eip1193Provider): Eip1193Provider {
  return Object.freeze({ request: async (request: { method: string; params?: unknown[] }) => {
    if (request.method === "wallet_switchEthereumChain") {
      const target = canonicalChainId((request.params?.[0] as { chainId?: unknown } | undefined)?.chainId);
      const current = canonicalChainId(await provider.request({ method: "eth_chainId" }));
      if (target === ARC_MAINNET_CHAIN_ID_HEX && current === ARC_MAINNET_CHAIN_ID_HEX) return null;
      throw new Error("ArcFX local bridge proof never switches the wallet network automatically.");
    }
    if (request.method === "wallet_addEthereumChain") throw new Error("ArcFX local bridge proof never adds or switches the wallet network automatically.");
    return provider.request(request);
  } });
}

export type LocalBridgeProofClient = Readonly<{
  capability: ArcCapability;
  executeArcToBaseUsdc(input: {
    account: string; amount: string; reviewed: LocalBridgeProofReview; onSourceSubmissionStart?: () => void;
  }): Promise<LocalBridgeProofResult>;
}>;

/**
 * The sole Step 8D.2 mutation seam. It only accepts Arc -> Base USDC to the
 * same selected wallet, obtains a new identical estimate directly before one
 * bridge call, forces sequential transactions, and blocks wallet network
 * switching. It has no recovery, resume, re-attestation, or repeat-bridge API.
 */
export async function createLocalBridgeProofClient(
  provider: Eip1193Provider,
  dependencies: { kit?: AppKitLocalBridgeSurface; createAdapter?: AdapterFactory } = {},
): Promise<LocalBridgeProofClient> {
  requireLocalBridgeProofEnabled();
  if (!provider || typeof provider.request !== "function") throw new Error("The selected ArcFX wallet provider is unavailable.");
  const kit = dependencies.kit || new AppKit() as AppKitLocalBridgeSurface;
  const capability = discoverArcMainnetCapabilities(kit);
  if (!capability.bridge) throw new Error("Circle SDK does not currently advertise bridging from Arc Mainnet.");
  const sourceOnlyProvider = arcMainnetNoSwitchProvider(provider);
  const adapter = dependencies.createAdapter
    ? await dependencies.createAdapter({ provider: sourceOnlyProvider })
    : await createViemAdapterFromProvider({ provider: sourceOnlyProvider as any });
  return Object.freeze({
    capability,
    async executeArcToBaseUsdc(input) {
      const parsed = parseUsdcAmount(input.amount);
      if (!parsed.ok || parsed.value > PROOF_MAX_BRIDGE_USDC_ATOMIC) throw new Error("Local bridge proof amount must be greater than zero and no more than 0.01 USDC.");
      await assertProofProviderBinding(provider, input.account);
      const params = {
        from: { adapter, chain: capability.chainIdentifier },
        to: { chain: "Base", recipientAddress: input.account, useForwarder: true },
        amount: input.amount, token: "USDC", config: { batchTransactions: false },
      };
      const freshReview = bridgeReview(await kit.estimateBridge(params), input.amount, capability.chainIdentifier, "Base", input.account);
      const freshIssue = bridgeProofFreshEstimateIssue(freshReview);
      if (!bridgeReviewEquals(input.reviewed, freshReview)) throw new Error(freshIssue || "The local bridge route, amount, recipient, or warnings changed. Review the fresh estimate and explicitly confirm again.");
      const browser = new BrowserProvider(provider as any);
      const [nativeBalance, existingAllowance] = await Promise.all([
        browser.getBalance(input.account),
        new Contract(ARC_MAINNET_USDC, ERC20_ALLOWANCE_ABI, browser).allowance(input.account, capability.bridgeSpenderAddress) as Promise<bigint>,
      ]);
      const allowanceIssue = bridgeExistingAllowanceIssue(existingAllowance);
      if (allowanceIssue) throw new Error(allowanceIssue);
      if (nativeBalance < LOCAL_SWAP_PROOF_NATIVE_GAS_RESERVE) throw new Error("Native Arc gas reserve is below the local bridge proof minimum.");
      await assertProofProviderBinding(provider, input.account);
      input.onSourceSubmissionStart?.();
      try {
        const observation = localBridgeProofDiagnostic(await kit.bridge(params));
        if (!/^(success|complete)$/i.test(observation.state) && observation.sourceTxHashes.length === 0) {
          const stopped = new Error(`Bridge stopped before source submission: ${observation.state}${observation.errorState ? ` (${observation.errorState})` : ""}.`);
          Object.assign(stopped, { bridgeProofObservation: observation });
          throw stopped;
        }
        return observation;
      } catch (error: any) {
        // A soft BridgeResult is deliberately converted above into an ArcFX
        // stop error. It was not an exception from Circle, so do not relabel
        // that wrapper as the original Circle error.
        if (error?.bridgeProofObservation) throw error;
        const originalBridgeErrorDiagnostic = safeOriginalError(error);
        const observation = localBridgeProofDiagnostic(error?.result || error?.bridgeResult || error?.data?.result, error);
        const stopped = new Error(observation.sourceTxHashes.length
          ? "Bridge stopped after source activity. Verify the displayed source transaction(s); ArcFX will not retry or resume it."
          : "Bridge stopped before Circle returned a source transaction. ArcFX will not retry it.");
        Object.assign(stopped, { bridgeProofObservation: observation, originalBridgeErrorDiagnostic });
        throw stopped;
      }
    },
  });
}

/**
 * The sole Step 8D.1 mutation seam. Its own guards enforce the local-only
 * feature flag, one-USDC cap, exact selected-provider binding, fresh identical
 * quote, zero pre-existing adapter allowance, native reserve, sequential
 * standard approval, and a final provider check immediately before Circle's
 * wallet call. It never switches a network, discovers a provider, retries, or
 * accepts bridge inputs.
 */
export async function createLocalSwapProofClient(
  provider: Eip1193Provider,
  dependencies: { kit?: AppKitLocalSwapSurface; createAdapter?: AdapterFactory } = {},
): Promise<LocalSwapProofClient> {
  requireLocalSwapProofEnabled();
  if (!provider || typeof provider.request !== "function") throw new Error("The selected ArcFX wallet provider is unavailable.");
  const kit = dependencies.kit || new AppKit() as AppKitLocalSwapSurface;
  const capability = discoverArcMainnetCapabilities(kit);
  if (!capability.swap) throw new Error("Circle SDK does not currently advertise swaps on Arc Mainnet.");
  const adapter = dependencies.createAdapter
    ? await dependencies.createAdapter({ provider })
    : await createViemAdapterFromProvider({ provider: provider as any });
  return Object.freeze({
    capability,
    async executeExactUsdcToEurc(input) {
      const parsed = parseUsdcAmount(input.amount);
      if (!parsed.ok || parsed.value > PROOF_MAX_USDC_ATOMIC) throw new Error("Local proof amount must be greater than zero and no more than 1 USDC.");
      if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500) throw new Error("Local proof slippage is invalid.");
      await assertProofProviderBinding(provider, input.account);
      // Pull a new route immediately before the explicit execution click. Any
      // economic/routing change returns to review rather than submitting it.
      const fresh = await kit.estimateSwap({
        from: { adapter, chain: capability.chainIdentifier }, tokenIn: "USDC", tokenOut: "EURC", amountIn: input.amount,
        config: { slippageBps: input.slippageBps, allowanceStrategy: "approve", batchTransactions: false },
      });
      const freshReview: LocalSwapProofReview = {
        route: `${String(fresh.chainIn)} → ${String(fresh.chainOut)}`,
        estimatedOutput: String(fresh.estimatedOutput?.amount || ""), minimumReceived: String(fresh.stopLimit?.amount || ""),
        fees: Array.isArray(fresh.fees) ? fresh.fees.map((fee: any) => ({ type: String(fee.type || "provider"), token: String(fee.token || ""), amount: fee.amount == null ? null : String(fee.amount), error: Boolean(fee.error) })) : [],
      };
      if (!reviewEquals(input.reviewed, freshReview)) throw new Error("The local proof quote changed. Review the fresh quote and explicitly confirm again.");
      const browser = new BrowserProvider(provider as any);
      const [allowance, nativeBalance] = await Promise.all([
        new Contract(ARC_MAINNET_USDC, ERC20_ALLOWANCE_ABI, browser).allowance(input.account, capability.swapAdapterAddress) as Promise<bigint>,
        browser.getBalance(input.account),
      ]);
      // Circle Swap Kit's USDC path is increaseAllowance(amount). Require zero
      // existing allowance so the exact requested amount is also the final
      // allowance; do not silently stack a second approval.
      if (allowance !== 0n) throw new Error("Local proof requires zero existing Circle adapter allowance. Do not stack an approval; revoke it or stop.");
      if (nativeBalance < LOCAL_SWAP_PROOF_NATIVE_GAS_RESERVE) throw new Error("Native Arc gas reserve is below the local proof minimum.");
      await assertProofProviderBinding(provider, input.account);
      const result = await kit.swap({
        from: { adapter, chain: capability.chainIdentifier }, tokenIn: "USDC", tokenOut: "EURC", amountIn: input.amount,
        config: { slippageBps: input.slippageBps, allowanceStrategy: "approve", batchTransactions: false },
      });
      const executed = Array.isArray(result.executedTransactions) ? result.executedTransactions : [];
      const approvalTxHashes = executed
        .filter((item: any) => item?.type === "approval" && /^0x[0-9a-fA-F]{64}$/.test(String(item.txHash || "")))
        .map((item: any) => String(item.txHash));
      const swapTxHash = String(result.txHash || executed.find((item: any) => item?.type === "swap")?.txHash || "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(swapTxHash)) throw new Error("Circle did not return a valid swap transaction hash.");
      return Object.freeze({
        approvalTxHashes: Object.freeze(approvalTxHashes), swapTxHash,
        result: Object.freeze({ txHash: swapTxHash, explorerUrl: typeof result.explorerUrl === "string" ? result.explorerUrl : null, progress: result.progress ?? null, amountOut: result.amountOut == null ? null : String(result.amountOut) }),
      });
    },
  });
}
