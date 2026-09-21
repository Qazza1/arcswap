import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const source = Object.fromEntries(["tradeExecutionCore.ts", "tradeExecutionGate.ts", "tradeOperationApi.ts", "trade.ts"].map((file) => [file, fs.readFileSync(new URL(`../src/workspace/${file}`, import.meta.url), "utf8")]));
let server, core, gate;
test.before(async () => {
  server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  core = await server.ssrLoadModule("/src/workspace/tradeExecutionCore.ts");
  gate = await server.ssrLoadModule("/src/workspace/tradeExecutionGate.ts");
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
