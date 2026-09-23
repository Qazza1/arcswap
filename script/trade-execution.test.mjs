import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const source = Object.fromEntries(["tradeExecutionCore.ts", "tradeExecutionGate.ts", "tradeOperationApi.ts", "circleAppKit.ts", "trade.ts"].map((file) => [file, fs.readFileSync(new URL(`../src/workspace/${file}`, import.meta.url), "utf8")]));
let server, core, gate, circle;
test.before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  core = await server.ssrLoadModule("/src/workspace/tradeExecutionCore.ts");
  gate = await server.ssrLoadModule("/src/workspace/tradeExecutionGate.ts");
  circle = await server.ssrLoadModule("/src/workspace/circleAppKit.ts");
});
test.after(async () => { await server?.close(); });

const binding = { provider: {}, providerId: "eip6963.arcfx-pinned", account: "0x4F81E3939232815e3C98B124A17BaC75304C82D8", chainId: "0x13b2" };
const intent = () => ({ idempotencyKey: "trade-execution-idempotency-key", kind: "swap", binding, sourceNetwork: "arc-mainnet", sourceChainId: 5042, sourceToken: "USDC", destinationToken: "EURC", amountAtomic: "1000000", minimumOutputAtomic: "990000", slippageBps: 50, quoteSnapshot: { route: "Arc" }, quoteExpiresAt: Date.now() + 60_000 });

test("Step 8C execution gate remains off and no UI execution method is reachable", () => {
  assert.equal(gate.ARCFX_MAINNET_TRADE_EXECUTION_ENABLED, false);
  assert.throws(() => core.assertExecutionRouteEnabled(), /not enabled/);
  assert.match(source["trade.ts"], /Execution gated off/);
  assert.doesNotMatch(source["trade.ts"], />\s*(Approve|Swap now|Bridge now|Execute swap|Execute bridge)\s*</i);
  assert.doesNotMatch(source["tradeExecutionCore.ts"] + source["tradeOperationApi.ts"], /\.swap\(|\.bridge\(|retryBridge|eth_sendTransaction|wallet_sendCalls|window\.ethereum/);
});

test("Step 8D.1 proof is a dev-only opt-in and cannot enable the production execution gate", () => {
  assert.equal(gate.ARCFX_MAINNET_TRADE_EXECUTION_ENABLED, false);
  assert.equal(gate.LOCAL_SWAP_PROOF_ENABLED, false);
  assert.throws(() => gate.requireLocalSwapProofEnabled(), /local Vite server/);
  assert.match(source["tradeExecutionGate.ts"], /import\.meta\.env\.DEV/);
  assert.match(source["tradeExecutionGate.ts"], /VITE_ARCFX_LOCAL_SWAP_PROOF/);
});

test("Step 8D.2 bridge proof is independently dev-only and cannot enable the production execution gate", () => {
  assert.equal(gate.ARCFX_MAINNET_TRADE_EXECUTION_ENABLED, false);
  assert.equal(gate.LOCAL_BRIDGE_PROOF_ENABLED, false);
  assert.throws(() => gate.requireLocalBridgeProofEnabled(), /local Vite server/);
  assert.match(source["tradeExecutionGate.ts"], /VITE_ARCFX_LOCAL_BRIDGE_PROOF/);
  assert.match(source["tradeExecutionGate.ts"], /import\.meta\.env\.DEV/);
});

test("the local proof seam is strictly pinned, capped, freshly quoted, and never bridges or retries", () => {
  const proof = source["circleAppKit.ts"];
  const ui = source["trade.ts"];
  assert.match(proof, /PROOF_MAX_USDC_ATOMIC = 1_000_000n/);
  assert.match(proof, /tokenIn: "USDC", tokenOut: "EURC"/);
  assert.match(proof, /allowanceStrategy: "approve", batchTransactions: false/);
  assert.match(proof, /allowance !== 0n/);
  assert.match(proof, /LOCAL_SWAP_PROOF_NATIVE_GAS_RESERVE/);
  assert.match(proof, /assertProofProviderBinding\(provider, input\.account\)/);
  assert.match(proof, /reviewEquals\(input\.reviewed, freshReview\)/);
  const swapOnlyProof = proof.slice(0, proof.indexOf("const PROOF_MAX_BRIDGE_USDC_ATOMIC"));
  assert.doesNotMatch(swapOnlyProof, /\.bridge\(|retryBridge|window\.ethereum|MaxUint256/);
  assert.match(ui, /binding\.provider !== swapQuote\.binding\.provider/);
  assert.match(ui, /consumeLocalProofReview\(\);/);
  assert.match(ui, /approvalTxHashes/);
  assert.match(ui, /swapTxHash/);
});

test("the local bridge seam allows one Arc-to-Base attempt only and fails closed on uncertainty", () => {
  const proof = source["circleAppKit.ts"];
  const ui = source["trade.ts"];
  assert.equal(circle.PROOF_MAX_BRIDGE_USDC_ATOMIC, 500_000n);
  assert.match(ui, /Run local ≤0\.5 USDC bridge proof/);
  assert.match(ui, /`Bridge amount \$\{result\.amount\} USDC`/);
  assert.match(ui, /bridgeQuote!\.amountAtomic <= PROOF_MAX_BRIDGE_USDC_ATOMIC/);
  assert.match(ui, /bridgeQuote\.amountAtomic > PROOF_MAX_BRIDGE_USDC_ATOMIC/);
  assert.match(proof, /to: \{ chain: "Base", recipientAddress: input\.account, useForwarder: true \}/);
  assert.match(proof, /\{ chain: "Base", recipientAddress: input\.recipient, useForwarder: true \}/);
  assert.match(proof, /token: "USDC", config: \{ batchTransactions: false \}/);
  assert.match(proof, /arcMainnetNoSwitchProvider/);
  assert.match(proof, /wallet_switchEthereumChain/);
  assert.match(proof, /wallet_addEthereumChain/);
  assert.match(proof, /bridgeReviewEquals\(input\.reviewed, freshReview\)/);
  assert.match(proof, /bridgeAmountMaxFeeIssue\(fresh\.amount, fresh\.maxFee\)/);
  assert.match(proof, /bridgeExistingAllowanceIssue\(existingAllowance\)/);
  assert.match(proof, /bridgeSpenderAddress/);
  assert.match(proof, /onSourceSubmissionStart/);
  assert.match(proof, /bridgeProofObservation/);
  assert.match(proof, /Bridge stopped before source submission/);
  assert.doesNotMatch(proof, /retryBridge|resumeBridge|reAttest/);
  assert.match(ui, /bridgeProofSourceStarted/);
  assert.match(ui, /consumeLocalBridgeReview\(\);/);
  assert.match(ui, /sourceTxHashes/);
  assert.match(ui, /destinationTxHashes/);
});

test("Circle's Arc preflight is acknowledged only as a verified no-op", async () => {
  const calls = [];
  const raw = { request: async (request) => {
    calls.push(request.method);
    if (request.method === "eth_chainId") return "0x13b2";
    throw new Error(`unexpected raw request: ${request.method}`);
  } };
  const guarded = circle.arcMainnetNoSwitchProvider(raw);
  assert.equal(await guarded.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x13b2" }] }), null);
  assert.deepEqual(calls, ["eth_chainId"], "the raw wallet never receives a switch request");
  await assert.rejects(() => guarded.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }), /never switches/);
  await assert.rejects(() => guarded.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2" }] }), /never adds/);
});

test("bridge comparison accepts fresh sub-cap service fees and blocks unsafe fresh estimates", () => {
  const fees = [{ type: "forwarder", token: "USDC", amount: "0.056537", error: false }];
  const review = { route: "Arc → Base", amount: "0.5", sourceChain: "Arc", destinationChain: "Base", recipient: binding.account, maxFee: circle.bridgeQuotedMaxFee(fees), fees, gasFees: [{ type: "network", token: "USDC", amount: "0.0001" }], warnings: ["finality"] };
  assert.equal(circle.bridgeReviewEquals(review, { ...review, gasFees: [{ type: "network", token: "USDC", amount: "0.0002" }] }), true);
  const changedFees = [{ type: "forwarder", token: "USDC", amount: "0.056281", error: false }];
  assert.equal(circle.bridgeReviewEquals(review, { ...review, fees: changedFees, maxFee: circle.bridgeQuotedMaxFee(changedFees) }), true);
  const highFees = [{ type: "forwarder", token: "USDC", amount: "0.100001", error: false }];
  assert.equal(circle.bridgeReviewEquals(review, { ...review, fees: highFees, maxFee: circle.bridgeQuotedMaxFee(highFees) }), false, "more than 0.10 USDC is blocked");
  assert.equal(circle.bridgeReviewEquals(review, { ...review, route: "Arc → Ethereum" }), false);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, amount: "0.49" }), false);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, recipient: "0x0000000000000000000000000000000000000000" }), false);
});

test("Circle runtime bridge estimate fees become the exact six-decimal CCTP maxFee", async () => {
  const runtimeFees = [{ type: "provider", token: "USDC", amount: "0.000227" }, { type: "forwarder", token: "USDC", amount: "0.054774" }];
  assert.equal(circle.bridgeQuotedMaxFee(runtimeFees), "0.055001");
  assert.equal(circle.bridgeQuotedMaxFee(runtimeFees.slice(1)), "0.054774", "the provider entry is absent when its fee is zero");
  assert.equal(circle.bridgeAmountMaxFeeIssue("0.5", circle.bridgeQuotedMaxFee(runtimeFees)), null);
  assert.match(circle.bridgeAmountMaxFeeIssue("0.01", circle.bridgeQuotedMaxFee(runtimeFees)) || "", /greater than/);
  assert.equal(circle.bridgeQuotedMaxFee([{ type: "provider", token: "USDC", amount: null, error: true }]), null);
  assert.equal(circle.bridgeQuotedMaxFee([{ type: "forwarder", token: "USDC", amount: "not-a-fee" }]), null);
  assert.equal(circle.bridgeQuotedMaxFee([{ type: "forwarder", token: "EURC", amount: "0.05" }]), null);
  const arc = { type: "evm", chain: "Arc", name: "Arc", title: "Arc Mainnet", chainId: 5042, isTestnet: false, usdcAddress: circle.ARC_MAINNET_USDC, kitContracts: { adapter: "0x7FB8c7260b63934d8da38aF902f87ae6e284a845", bridge: "0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0" } };
  const kit = { getSupportedChains: () => [arc], estimateBridge: async () => ({ token: "USDC", amount: "0.5", source: { address: binding.account, chain: "Arc" }, destination: { address: binding.account, chain: "Base" }, fees: runtimeFees, gasFees: [] }) };
  const client = await circle.createReadonlyCircleClient({ request: async () => { throw new Error("wallet request is forbidden in this test"); } }, { kit, createAdapter: async () => ({}) });
  const estimate = await client.estimateBridge({ sourceChain: "Arc", destinationChain: "Base", recipient: binding.account, amount: "0.5" });
  assert.equal(estimate.maxFee, "0.055001", "installed SDK result has no top-level maxFee");
});

test("local bridge proof blocks unsafe maximum fees and existing allowances before a wallet write", () => {
  assert.match(circle.bridgeAmountMaxFeeIssue("0.01", null) || "", /maximum bridge fee/);
  assert.match(circle.bridgeAmountMaxFeeIssue("0.01", "not-a-number") || "", /maximum bridge fee/);
  assert.match(circle.bridgeAmountMaxFeeIssue("0.01", "0.01") || "", /greater than/);
  assert.match(circle.bridgeAmountMaxFeeIssue("0.01", "0.02") || "", /greater than/);
  assert.equal(circle.bridgeAmountMaxFeeIssue("0.01", "0"), null);
  assert.match(circle.bridgeExistingAllowanceIssue(10_000n) || "", /Existing Circle bridge allowance must be cleared/);
  assert.equal(circle.bridgeExistingAllowanceIssue(0n), null);
  const proof = source["circleAppKit.ts"];
  assert.ok(proof.indexOf("bridgeAmountMaxFeeIssue(fresh.amount, fresh.maxFee)") < proof.indexOf("input.onSourceSubmissionStart?.()"));
  assert.ok(proof.indexOf("bridgeExistingAllowanceIssue(existingAllowance)") < proof.indexOf("input.onSourceSubmissionStart?.()"));
});

test("Arc capability fails closed if Circle returns a bridge spender other than the approved Mainnet contract", () => {
  const wrong = { type: "evm", chain: "Arc", name: "Arc", title: "Arc Mainnet", chainId: 5042, isTestnet: false, usdcAddress: circle.ARC_MAINNET_USDC, kitContracts: { adapter: "0x7FB8c7260b63934d8da38aF902f87ae6e284a845", bridge: "0x0000000000000000000000000000000000000001" } };
  assert.throws(() => circle.discoverArcMainnetCapabilities({ getSupportedChains: () => [wrong] }), /bridge spender/);
});

test("local bridge diagnostics retain safe result states but redact payload-shaped data", () => {
  const payload = "a".repeat(120);
  const diagnostic = circle.localBridgeProofDiagnostic({ state: "error", provider: "CCTPV2BridgingProvider", source: { chain: "Arc" }, destination: { chain: "Base" }, steps: [{ name: "approve", state: "error", errorCategory: "user_rejected", errorCode: 4001, errorMessage: `provider failed ${payload}` }] });
  assert.equal(diagnostic.state, "error"); assert.equal(diagnostic.provider, "CCTPV2BridgingProvider");
  assert.equal(diagnostic.sourceChain, "Arc"); assert.equal(diagnostic.destinationChain, "Base");
  assert.equal(diagnostic.steps[0].attempted, true); assert.equal(diagnostic.steps[0].errorCategory, "user_rejected");
  assert.doesNotMatch(diagnostic.steps[0].errorMessage || "", new RegExp(payload));
});

test("local bridge diagnostics preserve only safe original Circle error primitives", () => {
  const payload = "a".repeat(120);
  const diagnostic = circle.localBridgeProofDiagnostic(undefined, {
    name: "CircleBridgeError", code: "FORWARDER_UNAVAILABLE", message: `bridge failed ${payload}`,
    shortMessage: "Forwarder unavailable", reason: "No route", details: "Retry later",
    data: { code: 42, message: "safe data message", nested: { calldata: "0x" + "12".repeat(300) } },
    cause: { name: "ProviderError", code: 4001, message: "safe cause", adapter: { request: () => {} }, cause: { reason: "second cause", data: "ignored" } },
  });
  assert.equal(diagnostic.originalError.name, "CircleBridgeError");
  assert.equal(diagnostic.originalError.code, "FORWARDER_UNAVAILABLE");
  assert.equal(diagnostic.originalError.shortMessage, "Forwarder unavailable");
  assert.match(diagnostic.originalError.cause.join(" "), /ProviderError/);
  assert.match(diagnostic.originalError.cause.join(" "), /second cause/);
  assert.doesNotMatch(JSON.stringify(diagnostic.originalError), new RegExp(payload));
  assert.doesNotMatch(JSON.stringify(diagnostic.originalError), /calldata|adapter|nested/);
});

test("a wrapped local bridge stop keeps the original SDK error separately", () => {
  const proof = source["circleAppKit.ts"];
  const ui = source["trade.ts"];
  assert.match(proof, /if \(error\?\.bridgeProofObservation\) throw error/);
  assert.match(proof, /const originalBridgeErrorDiagnostic = safeOriginalError\(error\)/);
  assert.match(proof, /bridgeProofObservation: observation, originalBridgeErrorDiagnostic/);
  assert.match(ui, /error\?\.originalBridgeErrorDiagnostic/);
  assert.doesNotMatch(proof, /JSON\.stringify\(error\)|error\.stack/);
});

test("reviewed intent is exact, bound to the pinned provider/account/chain, and persists before any mutation seam", async () => {
  const value = intent();
  assert.equal(core.reviewIsExecutable(value, binding), true);
  assert.equal(core.reviewIsExecutable(value, { ...binding, providerId: "other" }), false);
  assert.equal(core.reviewIsExecutable(value, { ...binding, provider: {} }), false);
  assert.equal(core.reviewIsExecutable(value, { ...binding, account: "0x0000000000000000000000000000000000000000" }), false);
  assert.equal(core.reviewIsExecutable({ ...value, quoteExpiresAt: Date.now() - 1 }, binding), false);
  const calls = [];
  const persisted = await core.persistReviewedIntent(value, binding, { createIntent: async (entry) => { calls.push(entry); return { id: "wop_test", version: 1 }; } });
  assert.equal(calls.length, 1); assert.equal(persisted.state, "REVIEW_READY"); assert.equal(persisted.intent.amountAtomic, "1000000");
});

test("operation transitions are explicit, concurrent stale versions are detectable, and gas keeps a reserve", () => {
  const operation = { id: "wop_test", version: 1, intent: intent(), state: "REVIEW_READY", txHashes: [] };
  const approval = core.transition(operation, "APPROVAL_REQUESTED");
  const submitted = core.transition(approval, "APPROVAL_SUBMITTED", "0x" + "12".repeat(32));
  assert.equal(submitted.txHashes.length, 1);
  assert.throws(() => core.transition(operation, "MINT_CONFIRMED"), /Invalid/);
  assert.equal(core.hasGasReserve(120n, 100n, 20n), true);
  assert.equal(core.hasGasReserve(119n, 100n, 20n), false);
});

test("source switching is explicit, and bridge recovery never retries a recorded burn", async () => {
  const calls = [];
  await core.requestExplicitSourceNetworkSwitch("0x1", async (chainId) => { calls.push(chainId); });
  assert.deepEqual(calls, ["0x1"]);
  assert.equal(core.bridgeRecovery("BURN_SUBMITTED"), "DO_NOT_RETRY_BURN");
  assert.equal(core.bridgeRecovery("BURN_CONFIRMED"), "WAIT_FOR_ATTESTATION");
  assert.equal(core.bridgeRecovery("ATTESTATION_READY"), "RESUME_DESTINATION_MINT");
  const safe = core.sanitizeBridgeObservation({ state: "pending", steps: [{ name: "burn", state: "success", txHash: "0x" + "34".repeat(32), data: { never: "persisted" } }] });
  assert.deepEqual(Object.keys(safe.steps[0]).sort(), ["name", "state", "txHash"]);
});

test("no unlimited approval, secrets, or direct transaction authority enter Step 8C", () => {
  const joined = Object.values(source).join("\n");
  for (const forbidden of [/MaxUint256/, /PRIVATE_KEY/, /RELAYER/, /CIRCLE_API_KEY/, /sendTransaction\(/, /broadcastTransaction\(/]) assert.doesNotMatch(joined, forbidden);
  assert.match(source["tradeExecutionCore.ts"], /No 'Max' path exists/, "the operation model leaves no unlimited-approval path");
});
