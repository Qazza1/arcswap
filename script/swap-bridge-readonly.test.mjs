import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const OWNER = "0x4F81E3939232815e3C98B124A17BaC75304C82D8";
const ARC_SWAP_ADAPTER = "0x7FB8c7260b63934d8da38aF902f87ae6e284a845";
const ARC_BRIDGE_SPENDER = "0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0";
const arc = (patch = {}) => ({ type: "evm", chain: "Arc", name: "Arc", title: "Arc Mainnet", chainId: 5042, isTestnet: false, explorerUrl: "https://explorer.arc.io/tx/{hash}", rpcEndpoints: ["https://rpc.mainnet.arc.io/"], usdcAddress: ARC_USDC, eurcAddress: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", cctp: { domain: 26, forwarderSupported: { source: false, destination: true } }, kitContracts: { adapter: ARC_SWAP_ADAPTER, bridge: ARC_BRIDGE_SPENDER }, ...patch });
// The installed SDK registry also lists Base and Ethereum with the same Circle bridge contract.
const base = () => ({ type: "evm", chain: "Base", chainId: 8453, isTestnet: false, usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", cctp: { domain: 6, forwarderSupported: { source: false, destination: true } }, kitContracts: { adapter: ARC_SWAP_ADAPTER, bridge: ARC_BRIDGE_SPENDER } });
const ethereum = () => ({ type: "evm", chain: "Ethereum", chainId: 1, isTestnet: false, usdcAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", cctp: { domain: 0, forwarderSupported: { source: false, destination: true } }, kitContracts: { adapter: ARC_SWAP_ADAPTER, bridge: ARC_BRIDGE_SPENDER } });
const arcTestnet = () => arc({ chain: "Arc_Testnet", title: "Arc Testnet", chainId: 5042002, isTestnet: true, usdcAddress: "0x3600000000000000000000000000000000000000" });
const source = ({ all = [arc()], swap = [arc()], bridge = [arc()] } = {}) => ({ getSupportedChains: operation => operation === "swap" ? swap : operation === "bridge" ? bridge : all });

const files = Object.fromEntries(["circleAppKit.ts", "swapCore.ts", "bridgeCore.ts", "trade.ts", "trade.css", "tools.ts"].map(name => [name, fs.readFileSync(new URL(`../src/workspace/${name}`, import.meta.url), "utf8")]));
const circleSource = files["circleAppKit.ts"], swapSource = files["swapCore.ts"], bridgeSource = files["bridgeCore.ts"], tradeSource = files["trade.ts"], tradeCss = files["trade.css"], toolsSource = files["tools.ts"];
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
let server, circle, swap, bridge, payments;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  circle = await server.ssrLoadModule("/src/workspace/circleAppKit.ts");
  swap = await server.ssrLoadModule("/src/workspace/swapCore.ts");
  bridge = await server.ssrLoadModule("/src/workspace/bridgeCore.ts");
  payments = await server.ssrLoadModule("/src/workspace/mainnetPayments.ts");
});
test.after(async () => { await server?.close(); });

test("Circle packages are exact, mutually installed versions and viem satisfies the adapter peer", () => {
  assert.equal(pkg.dependencies["@circle-fin/app-kit"], "1.15.2");
  assert.equal(pkg.dependencies["@circle-fin/adapter-viem-v2"], "1.18.0");
  assert.equal(pkg.dependencies.viem, "2.55.19");
  assert.equal(lock.packages["node_modules/@circle-fin/bridge-kit"].version, "1.15.1");
  assert.equal(lock.packages["node_modules/@circle-fin/swap-kit"].version, "1.7.0");
  assert.match(lock.packages["node_modules/@circle-fin/adapter-viem-v2"].peerDependencies.viem, /2\.30\.0/);
});

test("installed SDK dynamically identifies Arc Mainnet and independent swap/bridge capability", () => {
  const found = circle.probeInstalledCircleCapabilities();
  assert.equal(found.chainIdentifier, "Arc"); assert.equal(found.chainId, 5042); assert.equal(found.isTestnet, false);
  assert.equal(found.usdcAddress.toLowerCase(), ARC_USDC); assert.equal(found.cctpDomain, 26);
  assert.equal(found.swap, true); assert.equal(found.bridge, true);
});

test("Arc Testnet can never pass Arc Mainnet discovery and missing Mainnet fails closed", () => {
  assert.throws(() => circle.discoverArcMainnetCapabilities(source({ all: [arcTestnet()], swap: [arcTestnet()], bridge: [arcTestnet()] })), /does not expose/);
  assert.throws(() => circle.discoverArcMainnetCapabilities(source({ all: [], swap: [], bridge: [] })), /does not expose/);
});

test("ambiguous Arc definitions fail closed", () => {
  assert.throws(() => circle.discoverArcMainnetCapabilities(source({ all: [arc(), arc()] })), /ambiguous/);
});

test("swap and bridge capabilities are independent and dynamic SDK data wins", () => {
  const bridgeOnly = circle.discoverArcMainnetCapabilities(source({ swap: [], bridge: [arc()] }));
  assert.equal(bridgeOnly.swap, false); assert.equal(bridgeOnly.bridge, true);
  const swapOnly = circle.discoverArcMainnetCapabilities(source({ swap: [arc()], bridge: [] }));
  assert.equal(swapOnly.swap, true); assert.equal(swapOnly.bridge, false);
  const wrongUsdc = arc({ usdcAddress: "0x1111111111111111111111111111111111111111" });
  assert.throws(() => circle.discoverArcMainnetCapabilities(source({ all: [wrongUsdc], swap: [arc()], bridge: [arc()] })), /does not expose/);
  assert.throws(() => circle.discoverArcMainnetCapabilities(source({ all: [arc({ kitContracts: null })] })), /swap adapter address/);
});

function readOnlyHarness() {
  const requests = [];
  const provider = { request: async ({ method }) => { requests.push(method); if (method === "eth_accounts") return [OWNER]; if (method === "eth_chainId") return "0x13b2"; throw new Error(`unexpected ${method}`); } };
  let adapterInput;
  const adapter = { provider };
  const kit = {
    ...source({ bridge: [arc(), base(), ethereum()] }),
    estimateSwap: async params => { await params.from.adapter.provider.request({ method: "eth_accounts" }); return { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, chainIn: "Arc", chainOut: "Arc", estimatedOutput: { token: params.tokenOut, amount: "9.95" }, stopLimit: { token: params.tokenOut, amount: "9.90" }, fees: [{ type: "provider", token: "USDC", amount: "0.05" }] }; },
    estimateBridge: async params => { await params.from.adapter.provider.request({ method: "eth_chainId" }); return { token: "USDC", amount: params.amount, source: { address: OWNER, chain: params.from.chain }, destination: { address: OWNER, recipientAddress: params.to.recipientAddress, chain: params.to.chain }, fees: [], gasFees: [] }; },
  };
  return { provider, requests, kit, createAdapter: async input => { adapterInput = input; return adapter; }, adapterInput: () => adapterInput };
}

test("the exact existing provider is passed to the adapter and only read-only methods are exposed", async () => {
  const h = readOnlyHarness(); const client = await circle.createReadonlyCircleClient(h.provider, { kit: h.kit, createAdapter: h.createAdapter });
  assert.equal(h.adapterInput().provider, h.provider);
  assert.deepEqual(Object.keys(client).sort(), ["capability", "estimateBridge", "estimateSwap"]);
  assert.equal(h.requests.length, 0, "discovery and adapter injection do not call the provider in this harness");
});

test("swap and bridge estimates are keyless and cause zero signing/mutation RPC calls", async () => {
  const h = readOnlyHarness(); const client = await circle.createReadonlyCircleClient(h.provider, { kit: h.kit, createAdapter: h.createAdapter });
  const sw = await client.estimateSwap({ chain: "Arc", tokenIn: "USDC", tokenOut: "EURC", amount: "10", slippageBps: 50 });
  const br = await client.estimateBridge({ sourceChain: "Arc", destinationChain: "Base", recipient: OWNER, amount: "10" });
  assert.equal(sw.estimatedOutput, "9.95"); assert.equal(br.route, "Arc → Base");
  assert.deepEqual(h.requests, ["eth_accounts", "eth_chainId"]);
  assert.ok(h.requests.every(method => !/send|sign|personal|wallet_/i.test(method)));
});

test("six-decimal parsing is exact and rejects scientific, NaN, Infinity, over-precision and giant input", () => {
  assert.equal(payments.parseUsdcAmount("123456789.123456").value, 123456789123456n);
  for (const value of ["1.0000001", "1e3", "NaN", "Infinity", "-1", "9".repeat(31)]) assert.equal(payments.parseUsdcAmount(value).ok, false, value);
  assert.doesNotMatch(swapSource + bridgeSource + tradeSource, /parseFloat|toFixed/);
});

const binding = (patch = {}) => ({ provider: {}, account: OWNER, chainId: "0x13b2", ...patch });
const swapForm = (patch = {}) => ({ tokenIn: "USDC", tokenOut: "EURC", amount: "1.25", slippageBps: 50, ...patch });
const swapSnapshot = (patch = {}) => swap.createSwapSnapshot({ binding: binding(), form: swapForm(), amountAtomic: 1_250_000n, route: "Arc → Arc", quoteId: null, estimatedOutput: "1.24", minimumReceived: "1.23", fees: [], sdk: "test", now: 1000, ...patch });

test("swap quote binds provider/account/network/form and expires", () => {
  const q = swapSnapshot(); assert.equal(swap.swapSnapshotIsCurrent(q, swapForm(), q.binding, 2000), true);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm({ amount: "2" }), q.binding, 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm({ tokenOut: "USDC" }), q.binding, 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm({ slippageBps: 100 }), q.binding, 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm(), binding({ provider: {} }), 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm(), binding({ account: "0x9999999999999999999999999999999999999999" }), 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm(), binding({ chainId: "0x1" }), 2000), false);
  assert.equal(swap.swapSnapshotIsCurrent(q, swapForm(), q.binding, 61_001), false);
});

test("native Arc gas and ERC-20 USDC stay explicitly separate", () => {
  assert.equal(payments.MAINNET.usdcDecimals, 6); assert.equal(payments.NATIVE_PER_ATOMIC, 10n ** 12n);
  assert.equal(5042, 5042); assert.equal(bridge.BRIDGE_CHAINS.Arc.cctpDomain, 26);
  assert.notEqual(bridge.BRIDGE_CHAINS.Arc.chainId, bridge.BRIDGE_CHAINS.Arc.cctpDomain);
  assert.match(tradeSource, /Max is intentionally unavailable/);
});

const bridgeForm = (patch = {}) => ({ source: "Arc", destination: "Base", amount: "2", recipient: OWNER, ...patch });
const bridgeSnapshot = (patch = {}) => bridge.createBridgeSnapshot({ binding: binding(), form: bridgeForm(), amountAtomic: 2_000_000n, route: "Arc → Base", quoteId: null, estimatedReceive: "2", fees: [], warnings: [], sdk: "test", now: 1000, ...patch });

test("bridge refuses same-chain/invalid-recipient forms and snapshots never have submitted/pending states", () => {
  assert.match(bridge.validateBridgeForm(bridgeForm({ destination: "Arc" })).error, /different/);
  assert.match(bridge.validateBridgeForm(bridgeForm({ recipient: "0x123" })).error, /40 hexadecimal/);
  assert.equal(bridge.validateBridgeForm(bridgeForm()).amountAtomic, 2_000_000n);
  const q = bridgeSnapshot(); assert.equal(q.state, "review-ready");
  assert.doesNotMatch(bridgeSource, /state:\s*["'](?:submitted|pending)/);
});

test("bridge route, amount, recipient, provider, account, network and expiry invalidate review", () => {
  const q = bridgeSnapshot(); assert.equal(bridge.bridgeSnapshotIsCurrent(q, bridgeForm(), q.binding, 2000), true);
  for (const changed of [bridgeForm({ destination: "Ethereum" }), bridgeForm({ amount: "3" }), bridgeForm({ recipient: "0x9999999999999999999999999999999999999999" })]) assert.equal(bridge.bridgeSnapshotIsCurrent(q, changed, q.binding, 2000), false);
  assert.equal(bridge.bridgeSnapshotIsCurrent(q, bridgeForm(), binding({ provider: {} }), 2000), false);
  assert.equal(bridge.bridgeSnapshotIsCurrent(q, bridgeForm(), binding({ chainId: "0x1" }), 2000), false);
  assert.equal(bridge.bridgeSnapshotIsCurrent(q, bridgeForm(), q.binding, 61_001), false);
});

test("read-only Circle paths remain isolated from the local-only mutation seam", () => {
  const joined = circleSource.slice(0, circleSource.indexOf("const ERC20_ALLOWANCE_ABI")) + swapSource + bridgeSource + tradeSource;
  for (const forbidden of [/window\.ethereum/, /PRIVATE_KEY/, /VITE_KIT_KEY/, /MaxUint256/, /eth_sendTransaction/, /wallet_sendCalls/, /personal_sign/, /eth_sign(?:TypedData)?/]) assert.doesNotMatch(joined, forbidden);
  assert.doesNotMatch(circleSource, /retryBridge|resumeBridge|reAttest/);
  assert.doesNotMatch(circleSource, /result\.quote|opaqueQuote/, "opaque reusable quote payloads are not read or exposed as display IDs");
  assert.match(circleSource, /createViemAdapterFromProvider\(\{ provider: provider as any \}\)/);
  assert.match(circleSource, /createLocalSwapProofClient/);
  assert.match(circleSource, /createLocalBridgeProofClient/);
  assert.match(circleSource, /allowanceStrategy: "approve", batchTransactions: false/);
  assert.match(circleSource, /config: \{ batchTransactions: false \}/);
  assert.match(circleSource, /allowance !== 0n/);
});

test("read-only quote remains separate from explicit reviewed wallet confirmation", () => {
  assert.match(tradeSource, /Review swap/); assert.match(tradeSource, /Review bridge/);
  assert.match(tradeSource, /Confirm swap in wallet/); assert.match(tradeSource, /Confirm bridge in wallet/);
  assert.match(tradeSource, /LOCAL_BRIDGE_PROOF_ENABLED/);
  assert.match(tradeSource, /bridgeProofSourceStarted/);
  assert.match(tradeSource, /swapSnapshotIsCurrent/); assert.match(tradeSource, /bridgeSnapshotIsCurrent/);
  assert.doesNotMatch(tradeSource.slice(tradeSource.indexOf('"#swap-review"'), tradeSource.indexOf('"#bridge-quote"')), /\.request\(/);
});

test("workspace mounts new surface, navigation badge remains MAINNET, and legacy implementation is untouched", () => {
  assert.match(toolsSource, /view === "trade"[\s\S]*import\("\.\/trade"\)[\s\S]*mountTrade\(root\)/);
  const shell = fs.readFileSync(new URL("../src/shared/appShell.ts", import.meta.url), "utf8");
  assert.match(shell, /Swap & Bridge"[^\n]+status: "MAINNET"/);
  assert.equal(fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").includes("Arc Network Testnet"), true);
});

test("production CSP permits Circle Mainnet swap and bridge estimate requests", () => {
  const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const csp = vercel.headers.flatMap(entry => entry.headers).find(header => header.key === "Content-Security-Policy")?.value;
  assert.ok(csp, "production CSP must be configured");
  const connect = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/)?.[1].trim().split(/\s+/);
  assert.ok(connect?.includes("https://api.circle.com"), "swap quote endpoint must be reachable");
  assert.ok(connect?.includes("https://iris-api.circle.com"), "CCTP fee endpoint must be reachable");
});

test("workspace Circle client installs the existing same-origin swap proxy without changing bridge hosts", () => {
  assert.match(circleSource, /^import "\.\.\/shared\/circle-proxy";/m);
  const proxy = fs.readFileSync(new URL("../src/shared/circle-proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /https:\/\/api\.circle\.com/, "the Stablecoin Service endpoint must use the existing proxy");
  assert.match(proxy, /\/circle-proxy/, "the rewrite target must remain same-origin");
  assert.doesNotMatch(proxy, /iris-api\.circle\.com/, "Bridge estimate endpoints keep their own read-only host");
});

test("mobile layout is explicit and existing Send, Multisend and Invoices routes remain wired", () => {
  assert.match(tradeCss, /@media\(max-width:520px\)/); assert.match(tradeCss, /grid-template-columns:1fr/);
  assert.match(tradeCss, /\.trade-panel\[hidden\][^{]*\{display:none!important\}/, "inactive tabs stay hidden despite the grid display rule");
  assert.match(toolsSource, /mountSend\(root\)/); assert.match(toolsSource, /mountMultisend\(root\)/);
  const shell = fs.readFileSync(new URL("../src/shared/appShell.ts", import.meta.url), "utf8"); assert.match(shell, /label: "Invoices"/);
});
