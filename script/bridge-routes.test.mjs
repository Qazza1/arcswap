/**
 * Step 8F: the CCTP bridge route matrix among Arc, Base and Ethereum.
 *
 * The matrix is checked against the REAL installed @circle-fin/app-kit registry. Execution paths are
 * driven with mocked wallets and a mocked kit (no network, no transactions). The local-proof gate is
 * opened for this process only, through Vite's dev environment, exactly as a local proof server would.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

process.env.VITE_ARCFX_LOCAL_BRIDGE_PROOF = "arcfx-local-bridge-proof-v1";

// Normalize line endings: these files may be checked out with CRLF (see .gitattributes / core.autocrlf).
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tradeSource = read("../src/workspace/trade.ts");
const kitSource = read("../src/workspace/circleAppKit.ts");

const OWNER = "0x4F81E3939232815e3C98B124A17BaC75304C82D8";
const SPENDER = "0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0";
const USDC = { Arc: "0x3600000000000000000000000000000000000000", Base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", Ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
const HEX = { Arc: "0x13b2", Base: "0x2105", Ethereum: "0x1" };

let server, routes, circle, AppKit;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent", mode: "development" });
  routes = await server.ssrLoadModule("/src/workspace/bridgeRoutes.ts");
  circle = await server.ssrLoadModule("/src/workspace/circleAppKit.ts");
  ({ AppKit } = await import("@circle-fin/app-kit"));
});
test.after(async () => { await server?.close(); });

// Runtime estimate shapes captured read-only from Circle for 0.5 USDC (Step 8F evidence).
const ESTIMATES = {
  "Arc->Base": { fees: [{ type: "forwarder", token: "USDC", amount: "0.061968" }], gasFees: [{ name: "Approve", token: "USDC", blockchain: "Arc", fees: { fee: "0.0031500000001575" } }, { name: "Burn", token: "USDC", blockchain: "Arc", fees: { fee: "0.010500000000525" } }] },
  "Arc->Ethereum": { fees: [{ type: "forwarder", token: "USDC", amount: "1.489842" }], gasFees: [{ name: "Approve", token: "USDC", blockchain: "Arc", fees: { fee: "0.0031500000001575" } }, { name: "Burn", token: "USDC", blockchain: "Arc", fees: { fee: "0.010500000000525" } }] },
  "Base->Arc": { fees: [{ type: "provider", token: "USDC", amount: "0.000018" }, { type: "forwarder", token: "USDC", amount: "0.0177" }], gasFees: [{ name: "Approve", token: "ETH", blockchain: "Base", fees: { fee: "0.000000945" } }, { name: "Burn", token: "ETH", blockchain: "Base", fees: { fee: "0.00000315" } }] },
  "Ethereum->Arc": { fees: [{ type: "provider", token: "USDC", amount: "0.000014" }, { type: "forwarder", token: "USDC", amount: "0.0177" }], gasFees: [{ name: "Approve", token: "ETH", blockchain: "Ethereum", fees: { fee: "0.0000138876681825" } }, { name: "Burn", token: "ETH", blockchain: "Ethereum", fees: { fee: "0.000046292227275" } }] },
};
const estimateFor = (source, destination, amount = "0.5") => ({ token: "USDC", amount, source: { chain: source, address: OWNER }, destination: { chain: destination, recipientAddress: OWNER }, ...ESTIMATES[`${source}->${destination}`], warnings: [] });

/** A mocked kit backed by the REAL installed registry. */
function mockKit({ bridgeResult, bridgeThrows } = {}) {
  const real = new AppKit();
  const calls = { estimate: [], bridge: [] };
  const kit = {
    getSupportedChains: (op) => real.getSupportedChains(op),
    estimateBridge: async (params) => { calls.estimate.push(params); return estimateFor(params.from.chain, params.to.chain, params.amount); },
    estimateSwap: async () => { throw new Error("no swaps here"); },
    bridge: async (params) => {
      calls.bridge.push(params);
      if (bridgeThrows) throw bridgeThrows;
      return bridgeResult ?? { state: "success", provider: "CCTPV2BridgingProvider", source: { chain: params.from.chain }, destination: { chain: params.to.chain },
        steps: [{ name: "approve", state: "success", txHash: "0x" + "a1".repeat(32) }, { name: "burn", state: "success", txHash: "0x" + "b2".repeat(32) }, { name: "mint", state: "success", txHash: "0x" + "c3".repeat(32), forwarded: true }] };
    },
  };
  return { kit, calls };
}

/** A mocked EIP-1193 wallet on one chain. Records every method; reads return fixed values. */
function mockWallet({ chain, allowance = 0n, native = 10n ** 18n, account = OWNER }) {
  const methods = []; const ethCalls = [];
  const provider = { request: async ({ method, params }) => {
    methods.push(method);
    if (method === "eth_accounts") return [account];
    if (method === "eth_chainId") return chain;
    if (method === "eth_getBalance") return "0x" + native.toString(16);
    if (method === "eth_call") { ethCalls.push(params[0]); return "0x" + allowance.toString(16).padStart(64, "0"); }
    if (method === "eth_blockNumber") return "0x1";
    throw new Error(`unexpected wallet request ${method}`);
  } };
  return { provider, methods, ethCalls };
}
const reviewed = (source, destination, amount = "0.5") => {
  const e = estimateFor(source, destination, amount);
  const fees = e.fees.map((f) => ({ type: f.type, token: f.token, amount: f.amount, error: false }));
  return { route: `${source} → ${destination}`, amount, sourceChain: source, destinationChain: destination, recipient: OWNER, maxFee: circle.bridgeQuotedMaxFee(fees), fees, gasFees: [], warnings: [] };
};
const input = (source, destination, patch = {}) => ({ source, destination, account: OWNER, amount: "0.5", expiresAt: Date.now() + 60_000, reviewed: reviewed(source, destination), ...patch });
let adapterProviders = [];
const createAdapter = async ({ provider }) => { adapterProviders.push(provider); return { provider }; };

// ── the matrix ───────────────────────────────────────────────────────────────

test("the exact route matrix: status, production execution and proof per direction", () => {
  const view = Object.fromEntries(routes.BRIDGE_ROUTES.map((r) => [`${r.source}->${r.destination}`, [r.status, r.productionExecution, r.proven]]));
  assert.deepEqual(view, {
    "Arc->Base": ["executable", true, true],
    "Base->Arc": ["executable", false, false],
    "Ethereum->Arc": ["executable", false, false],
    "Arc->Ethereum": ["quote-only", false, false],
    "Base->Ethereum": ["hidden", false, false],
    "Ethereum->Base": ["hidden", false, false],
  });
  assert.deepEqual(routes.destinationsFor("Arc"), ["Base", "Ethereum"]);
  assert.deepEqual(routes.destinationsFor("Base"), ["Arc"]);
  assert.deepEqual(routes.destinationsFor("Ethereum"), ["Arc"]);
  assert.deepEqual(routes.sourcesOffered(), ["Arc", "Base", "Ethereum"]);
  assert.equal(routes.bridgeRoute("Arc", "Arc"), null);
});

test("every offered route validates against the REAL installed SDK registry: canonical USDC, CCTP domain, spender, forwarder", () => {
  const chains = new AppKit().getSupportedChains("bridge");
  const expect = { "Arc->Base": [26, 6, USDC.Arc], "Arc->Ethereum": [26, 0, USDC.Arc], "Base->Arc": [6, 26, USDC.Base], "Ethereum->Arc": [0, 26, USDC.Ethereum] };
  for (const [key, [from, to, usdc]] of Object.entries(expect)) {
    const [s, d] = key.split("->");
    const r = routes.resolveSdkRoute(chains, s, d);
    assert.deepEqual([r.sourceDomain, r.destinationDomain, r.sourceUsdc, r.spender, r.sourceChainIdHex], [from, to, usdc, SPENDER, HEX[s]], key);
  }
  assert.throws(() => routes.resolveSdkRoute(chains, "Base", "Ethereum"), /does not offer/);
  assert.throws(() => routes.resolveSdkRoute(chains, "Ethereum", "Base"), /does not offer/);
});

test("a tampered or incomplete registry fails closed", () => {
  const chains = new AppKit().getSupportedChains("bridge");
  const patch = (chainId, change) => chains.map((c) => (c.chainId === chainId && c.isTestnet === false ? { ...c, ...change(c) } : c));
  assert.throws(() => routes.resolveSdkRoute(patch(8453, () => ({ usdcAddress: "0x0000000000000000000000000000000000000001" })), "Base", "Arc"), /USDC address/);
  assert.throws(() => routes.resolveSdkRoute(patch(1, (c) => ({ cctp: { ...c.cctp, domain: 7 } })), "Ethereum", "Arc"), /CCTP domain/);
  assert.throws(() => routes.resolveSdkRoute(patch(5042, () => ({ kitContracts: { bridge: "0x0000000000000000000000000000000000000002" } })), "Arc", "Base"), /bridge contract/);
  assert.throws(() => routes.resolveSdkRoute(patch(5042, (c) => ({ cctp: { ...c.cctp, forwarderSupported: { source: false, destination: false } } })), "Base", "Arc"), /forwarder does not support Arc/);
  assert.throws(() => routes.resolveSdkRoute(chains.filter((c) => c.chainId !== 8453), "Base", "Arc"), /unambiguous Base/);
});

test("execution eligibility per mode: only proven routes in production; quote-only and hidden never", () => {
  const issue = (s, d, mode) => routes.routeExecutionIssue(routes.bridgeRoute(s, d), mode);
  assert.equal(issue("Arc", "Base", "production"), null);
  assert.match(issue("Base", "Arc", "production"), /awaits a live proof/);
  assert.match(issue("Ethereum", "Arc", "production"), /awaits a live proof/);
  assert.equal(issue("Base", "Arc", "local"), null);
  assert.equal(issue("Ethereum", "Arc", "local"), null);
  for (const mode of ["production", "local"]) {
    assert.match(issue("Arc", "Ethereum", mode), /estimate-only.*1\.49 USDC.*0\.10 USDC/);
    assert.match(issue("Base", "Ethereum", mode), /does not offer/);
    assert.match(issue("Ethereum", "Base", mode), /does not offer/);
  }
});

test("switch instructions name the exact network and promise no automatic switching", () => {
  assert.equal(routes.switchWalletMessage("Base"), "Switch wallet to Base (Base, chain 8453) in your wallet, then request the estimate again. ArcFX never switches networks automatically.");
  assert.match(routes.switchWalletMessage("Ethereum"), /Switch wallet to Ethereum \(Ethereum, chain 1\)/);
  assert.match(routes.switchWalletMessage("Arc"), /Switch wallet to Arc \(Arc Mainnet, chain 5042\)/);
});

// ── root cause and fee math ──────────────────────────────────────────────────

test("root cause: Arc → Ethereum without the forwarder returns no fees, so maxFee was unavailable", () => {
  assert.equal(circle.bridgeQuotedMaxFee([]), null, "Arc source + no forwarder = empty fees[] = no maxFee");
  assert.match(circle.bridgeAmountMaxFeeIssue("0.5", null), /unavailable or invalid/);
  const withForwarder = [{ type: "forwarder", token: "USDC", amount: "1.489842" }];
  assert.equal(circle.bridgeQuotedMaxFee(withForwarder), "1.489842");
  assert.match(circle.bridgeAmountMaxFeeIssue("0.5", "1.489842"), /greater than the current maximum bridge fee/);
});

test("maxFee comes from the SDK fees[]; minimum delivered = amount − maxFee; destination mint text is truthful", () => {
  const baseToArc = [{ type: "provider", token: "USDC", amount: "0.000018" }, { type: "forwarder", token: "USDC", amount: "0.0177" }];
  assert.equal(circle.bridgeQuotedMaxFee(baseToArc), "0.017718");
  assert.equal(routes.minimumDelivered("0.5", "0.017718"), "0.482282");
  assert.equal(routes.minimumDelivered("0.5", "0.061968"), "0.438032");
  assert.equal(routes.minimumDelivered("0.5", "1.489842"), null, "not calculable when the fee exceeds the amount");
  assert.equal(routes.minimumDelivered("0.5", null), null);
  assert.match(routes.destinationMintText("Arc", []), /performed by Circle's forwarder.*no separate destination gas estimate/);
  assert.equal(routes.destinationMintText("Ethereum", [{ type: "Mint", token: "ETH", amount: "0.00003703378182", network: "Ethereum" }]), "Destination (Ethereum) mint gas: 0.00003703378182 ETH");
});

test("source gas: ETH estimates for Base/Ethereum sum exactly; missing, errored or wrong-token data yields no estimate", () => {
  const base = [{ type: "Approve", token: "ETH", amount: "0.000000945", network: "Base" }, { type: "Burn", token: "ETH", amount: "0.00000315", network: "Base" }];
  assert.equal(routes.sourceGasRequirement(base, "Base"), 4_095_000_000_000n);
  assert.equal(routes.sourceGasReserve(4_095_000_000_000n), 8_190_000_000_000n);
  assert.equal(routes.sourceGasRequirement([], "Base"), null);
  assert.equal(routes.sourceGasRequirement([{ ...base[0], error: true }], "Base"), null);
  assert.equal(routes.sourceGasRequirement([{ ...base[0], token: "USDC" }], "Base"), null);
  assert.equal(routes.sourceGasRequirement([{ ...base[0], amount: null }], "Base"), null);
  assert.equal(routes.sourceGasRequirement(base, "Ethereum"), null, "another chain's gas never counts");
  assert.equal(routes.parseNativeAmount("0.0000138876681825"), 13_887_668_182_500n);
  assert.equal(routes.parseNativeAmount("1e-9"), null);
});

// ── estimates ────────────────────────────────────────────────────────────────

test("estimates use Circle's forwarder on every route and never ask the wallet to switch", async () => {
  for (const [s, d] of [["Arc", "Base"], ["Arc", "Ethereum"], ["Base", "Arc"], ["Ethereum", "Arc"]]) {
    const { kit, calls } = mockKit(); const w = mockWallet({ chain: HEX[s] });
    const client = await circle.createReadonlyCircleClient(w.provider, { kit, createAdapter });
    const e = await client.estimateBridge({ sourceChain: s, destinationChain: d, recipient: OWNER, amount: "0.5" });
    assert.equal(calls.estimate[0].from.chain, s);
    assert.deepEqual(calls.estimate[0].to, { chain: d, recipientAddress: OWNER, useForwarder: true }, `${s}->${d}: no destination adapter, forwarder mints`);
    assert.equal(e.maxFee, circle.bridgeQuotedMaxFee(ESTIMATES[`${s}->${d}`].fees));
    assert.ok(!w.methods.some((m) => /^wallet_|eth_send|sign/i.test(m)), `${s}->${d}`);
  }
  const { kit } = mockKit();
  const client = await circle.createReadonlyCircleClient(mockWallet({ chain: HEX.Base }).provider, { kit, createAdapter });
  await assert.rejects(() => client.estimateBridge({ sourceChain: "Base", destinationChain: "Ethereum", recipient: OWNER, amount: "0.5" }), /does not offer/);
});

// ── execution ────────────────────────────────────────────────────────────────

test("Base → Arc executes (local proof mode) from the Base wallet: Base USDC allowance to Circle's spender, forwarder to Arc, one bridge call", async () => {
  adapterProviders = [];
  const { kit, calls } = mockKit(); const w = mockWallet({ chain: HEX.Base });
  const client = await circle.createLocalBridgeProofClient(w.provider, { kit, createAdapter });
  const events = [];
  const result = await client.executeBridgeUsdc(input("Base", "Arc", { onSourceSubmissionStart: () => events.push("start") }));
  assert.equal(calls.bridge.length, 1, "exactly one bridge call, no retry");
  assert.deepEqual(calls.bridge[0].from.chain, "Base");
  assert.deepEqual(calls.bridge[0].to, { chain: "Arc", recipientAddress: OWNER, useForwarder: true });
  assert.deepEqual(calls.bridge[0].config, { batchTransactions: false });
  assert.equal(calls.bridge[0].token, "USDC");
  assert.equal(w.ethCalls[0].to.toLowerCase(), USDC.Base.toLowerCase(), "allowance read on canonical Base USDC");
  assert.match(w.ethCalls[0].data, new RegExp(SPENDER.slice(2).toLowerCase()), "for Circle's bridge spender");
  assert.deepEqual(events, ["start"]);
  assert.equal(result.sourceTxHashes.length, 2);
  assert.ok(!w.methods.some((m) => /^wallet_/.test(m)), "the wallet never receives a switch/add request");
  // The adapter's provider acknowledges only a no-op switch to Base itself.
  const guarded = adapterProviders.at(-1);
  assert.equal(await guarded.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }), null);
  await assert.rejects(() => guarded.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x13b2" }] }), /never switches/);
  await assert.rejects(() => guarded.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x2105" }] }), /never adds/);
});

test("Ethereum → Arc executes (local proof mode) from the Ethereum wallet with Ethereum USDC", async () => {
  const { kit, calls } = mockKit(); const w = mockWallet({ chain: HEX.Ethereum });
  const client = await circle.createLocalBridgeProofClient(w.provider, { kit, createAdapter });
  await client.executeBridgeUsdc(input("Ethereum", "Arc"));
  assert.equal(calls.bridge.length, 1);
  assert.deepEqual([calls.bridge[0].from.chain, calls.bridge[0].to.chain, calls.bridge[0].to.useForwarder], ["Ethereum", "Arc", true]);
  assert.equal(w.ethCalls[0].to.toLowerCase(), USDC.Ethereum.toLowerCase());
});

test("source-chain safety: wrong wallet network, existing allowance, low ETH and missing gas estimates all stop before the wallet", async () => {
  const run = async (walletPatch, kitPatch = {}) => {
    const { kit, calls } = mockKit(kitPatch); const w = mockWallet(walletPatch);
    const client = await circle.createLocalBridgeProofClient(w.provider, { kit, createAdapter });
    try { await client.executeBridgeUsdc(input("Base", "Arc")); return { calls }; }
    catch (error) { assert.equal(calls.bridge.length, 0, "no source submission"); return { error, calls }; }
  };
  assert.match((await run({ chain: HEX.Arc })).error.message, /account or network changed/, "wallet still on Arc for a Base source");
  assert.match((await run({ chain: HEX.Base, allowance: 5n })).error.message, /allowance must be cleared/);
  assert.match((await run({ chain: HEX.Base, native: 8_189_999_999_999n })).error.message, /below twice Circle's approve \+ burn gas estimate/);
  assert.equal((await run({ chain: HEX.Base, native: 8_190_000_000_000n })).calls.bridge.length, 1, "exactly twice the estimate is enough");
  const saved = ESTIMATES["Base->Arc"].gasFees; ESTIMATES["Base->Arc"].gasFees = [];
  try { assert.match((await run({ chain: HEX.Base })).error.message, /no usable Base approve\/burn gas estimate/); }
  finally { ESTIMATES["Base->Arc"].gasFees = saved; }
});

test("production mode: Arc → Base only; unproven inbound routes and Arc → Ethereum are refused before any wallet request", async () => {
  for (const [s, d, pattern] of [["Base", "Arc", /awaits a live proof/], ["Ethereum", "Arc", /awaits a live proof/], ["Arc", "Ethereum", /estimate-only/]]) {
    const { kit, calls } = mockKit(); const w = mockWallet({ chain: HEX[s] });
    const client = await circle.createControlledBridgeClient(w.provider, { kit, createAdapter });
    await assert.rejects(() => client.executeBridgeUsdc(input(s, d)), pattern, `${s}->${d}`);
    assert.equal(calls.estimate.length + calls.bridge.length, 0);
    assert.deepEqual(w.methods, [], "the wallet was not touched");
  }
  const local = await circle.createLocalBridgeProofClient(mockWallet({ chain: HEX.Arc }).provider, { kit: mockKit().kit, createAdapter });
  await assert.rejects(() => local.executeBridgeUsdc(input("Arc", "Ethereum")), /estimate-only/, "not even as a local proof");
});

test("a failing bridge call is never retried", async () => {
  const { kit, calls } = mockKit({ bridgeThrows: Object.assign(new Error("user rejected"), { code: 4001 }) });
  const client = await circle.createLocalBridgeProofClient(mockWallet({ chain: HEX.Base }).provider, { kit, createAdapter });
  await assert.rejects(() => client.executeBridgeUsdc(input("Base", "Arc")), /ArcFX will not retry/);
  assert.equal(calls.bridge.length, 1);
});

// ── UI wiring ────────────────────────────────────────────────────────────────

test("the UI offers only matrix routes, asks for a manual switch, and never switches networks itself", () => {
  assert.match(tradeSource, /sourcesOffered\(\)\.map/);
  assert.match(tradeSource, /destinationsFor\(\$\(page, "#bridge-from"\)\.value as BridgeNetwork\)/);
  assert.match(tradeSource, /return \{ error: switchWalletMessage\(sourceChain as BridgeNetwork\) \}/);
  assert.match(tradeSource, /route\.status === "quote-only" \? routeExecutionIssue\(route, "local"\)/);
  assert.match(tradeSource, /routeExecutionIssue\(route, "production"\)/);
  assert.match(tradeSource, /proof\.executeBridgeUsdc\(\{\n\s+source, destination, account: binding\.account,/);
  assert.match(tradeSource, /destinationMintText\(form\.destination, result\.gasFees\)/);
  assert.match(tradeSource, /minimumDelivered\(result\.amount, result\.maxFee\)/);
  assert.doesNotMatch(tradeSource, /wallet_switchEthereumChain|wallet_addEthereumChain/);
  assert.doesNotMatch(tradeSource, /Controlled execution currently supports Arc → Base/);
  assert.doesNotMatch(kitSource, /MaxUint256|retryBridge|resumeBridge/);
  assert.match(tradeSource, /if \(localBridgeProofBusy\) return;/, "duplicate-click protection is unchanged");
});
