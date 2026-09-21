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
  assert.match(proof, /PROOF_MAX_BRIDGE_USDC_ATOMIC = 10_000n/);
  assert.match(proof, /to: \{ chain: "Base", recipientAddress: input\.account, useForwarder: true \}/);
  assert.match(proof, /\{ chain: "Base", recipientAddress: input\.recipient, useForwarder: true \}/);
  assert.match(proof, /token: "USDC", config: \{ batchTransactions: false \}/);
  assert.match(proof, /noAutoNetworkSwitchProvider/);
  assert.match(proof, /wallet_switchEthereumChain/);
  assert.match(proof, /wallet_addEthereumChain/);
  assert.match(proof, /bridgeReviewEquals\(input\.reviewed, freshReview\)/);
  assert.match(proof, /onSourceSubmissionStart/);
  assert.match(proof, /bridgeProofObservation/);
  assert.match(proof, /Bridge stopped before source submission/);
  assert.doesNotMatch(proof, /retryBridge|resumeBridge|reAttest/);
  assert.match(ui, /bridgeProofSourceStarted/);
  assert.match(ui, /consumeLocalBridgeReview\(\);/);
  assert.match(ui, /sourceTxHashes/);
  assert.match(ui, /destinationTxHashes/);
});

test("bridge comparison accepts fresh sub-cap service fees and blocks unsafe fresh estimates", () => {
  const review = { route: "Arc → Base", amount: "0.01", sourceChain: "Arc", destinationChain: "Base", recipient: binding.account, fees: [{ type: "forwarder", token: "USDC", amount: "0.056537", error: false }], gasFees: [{ type: "network", token: "USDC", amount: "0.0001" }], warnings: ["finality"] };
  assert.equal(circle.bridgeReviewEquals(review, { ...review, gasFees: [{ type: "network", token: "USDC", amount: "0.0002" }] }), true);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, fees: [{ type: "forwarder", token: "USDC", amount: "0.056281", error: false }] }), true);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, fees: [{ type: "forwarder", token: "USDC", amount: "0.100001", error: false }] }), false, "more than 0.10 USDC is blocked");
  assert.equal(circle.bridgeReviewEquals(review, { ...review, route: "Arc → Ethereum" }), false);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, amount: "0.009" }), false);
  assert.equal(circle.bridgeReviewEquals(review, { ...review, recipient: "0x0000000000000000000000000000000000000000" }), false);
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
