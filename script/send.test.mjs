/**
 * Step 7: direct Arc Mainnet USDC Send. Validation is exact (bigint), the
 * reviewed snapshot cannot silently change, and one review produces at most one
 * transaction. No wallet, network, or chain access: every dependency is a fake.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x4F81E3939232815e3C98B124A17BaC75304C82D8";
const OTHER_ACCOUNT = "0x9999999999999999999999999999999999999999";
const BOB = "0x2222222222222222222222222222222222222222";
const MAINNET = "0x13b2";
const TESTNET = "0x4cef52";
const sendSource = fs.readFileSync(new URL("../src/workspace/payments.ts", import.meta.url), "utf8");
const coreSource = fs.readFileSync(new URL("../src/workspace/sendCore.ts", import.meta.url), "utf8");

let server, core, pay;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  core = await server.ssrLoadModule("/src/workspace/sendCore.ts");
  pay = await server.ssrLoadModule("/src/workspace/mainnetPayments.ts");
});
test.after(async () => { await server?.close(); });

const wallet = (patch = {}) => ({ account: OWNER, chainIdHex: MAINNET, balanceAtomic: 5_000_000n, ...patch });
const input = (patch = {}) => ({ recipient: BOB, amount: "1.25", ...patch });

test("a valid send builds an exact review: checksummed recipient, atomic amount, canonical USDC", () => {
  const built = core.buildSendReview(input({ recipient: BOB.toLowerCase() }), wallet());
  assert.equal(built.blocker, null);
  assert.deepEqual(built.errors, {});
  assert.equal(built.review.recipient, BOB);
  assert.equal(built.review.amountAtomic, 1_250_000n);
  assert.equal(typeof built.review.amountAtomic, "bigint");
  assert.equal(built.review.token, "0x3600000000000000000000000000000000000000");
  assert.equal(built.review.chainIdHex, MAINNET);
});

test("invalid recipients are refused with a reason", () => {
  const bad = (recipient) => core.validateSend(input({ recipient }), OWNER).errors.recipient;
  assert.match(bad(""), /Enter a recipient/);
  assert.match(bad("0x123"), /40 hexadecimal/);
  assert.match(bad("not-an-address"), /40 hexadecimal/);
  assert.match(bad("0x4F81E3939232815e3C98B124A17BaC75304C82d8"), /invalid checksum/, "a mixed-case typo fails the checksum");
  assert.match(bad("0x0000000000000000000000000000000000000000"), /zero address/);
  assert.match(bad("0x0000000000000000000000000000000000000001"), /reserved system address/);
  assert.match(bad(pay.MAINNET.usdc), /USDC token contract/);
  assert.match(bad(pay.MAINNET.multisender), /Multisender contract/);
  assert.match(bad(pay.MAINNET.payments), /Payments contract/);
  assert.match(bad(OWNER), /your own wallet/);
});

test("zero, negative, malformed and over-precise amounts are refused", () => {
  const bad = (amount) => core.validateSend(input({ amount }), OWNER).errors.amount;
  for (const a of ["0", "0.0", "0.000000"]) assert.match(bad(a), /greater than 0/, a);
  assert.match(bad(""), /greater than 0/);
  assert.match(bad("-1"), /plain number/);
  assert.match(bad("1e3"), /plain number/);
  assert.match(bad("abc"), /plain number/);
  assert.equal(bad("1,5"), "Use a dot for decimals, for example 1.5.");
  assert.match(bad("0.0000001"), /up to 6 decimal places/);
  assert.match(bad("9".repeat(31)), /too large/);
  assert.equal(core.validateSend(input({ amount: "0.000001" }), OWNER).amountAtomic, 1n, "the smallest unit is valid");
});

test("atomic conversion is exact at 6 decimals (no float rounding)", () => {
  const atomic = (a) => pay.parseUsdcAmount(a).value;
  assert.equal(atomic("0.1"), 100_000n);
  assert.equal(atomic("0.3"), 300_000n, "0.1 + 0.2 style float errors cannot occur");
  assert.equal(atomic("19.999999"), 19_999_999n);
  assert.equal(atomic("123456789.123456"), 123_456_789_123_456n);
  assert.equal(pay.formatUsdc(1n), "0.000001");
  assert.equal(pay.formatUsdc(10_000n), "0.01");
  assert.equal(pay.formatUsdc(1_250_000n), "1.25");
});

test("insufficient balance, wrong network, no wallet and RPC failure each block review", () => {
  assert.match(core.buildSendReview(input({ amount: "6" }), wallet()).blocker, /Insufficient USDC balance: you have 5\.00 USDC and this payment needs 6\.00 USDC/);
  assert.equal(core.buildSendReview(input({ amount: "5" }), wallet()).blocker, null, "spending the exact balance is allowed by the token check");
  assert.match(core.buildSendReview(input(), wallet({ chainIdHex: TESTNET })).blocker, /not on Arc Mainnet \(chain 5042\)/);
  assert.match(core.buildSendReview(input(), wallet({ account: null })).blocker, /Connect your wallet/);
  assert.match(core.buildSendReview(input(), wallet({ balanceAtomic: null })).blocker, /RPC is unavailable/);
});

function harness({ wait, submitError, wallets, live, receipt } = {}) {
  const calls = { submit: 0, reads: 0 };
  const states = [];
  const review = core.buildSendReview(input(), wallet()).review;
  const queue = wallets ? [...wallets] : null;
  const exec = core.createSendExecutor({
    readWallet: async () => { calls.reads++; return queue ? (queue.length > 1 ? queue.shift() : queue[0]) : wallet(); },
    live: live ?? (() => ({ recipient: BOB, amountAtomic: 1_250_000n })),
    submit: async () => {
      calls.submit++;
      if (submitError) throw submitError;
      return { hash: "0x" + "ab".repeat(32), wait: wait ?? (async () => receipt ?? { status: 1, blockNumber: 42 }) };
    },
    onState: (s) => states.push(s),
    now: () => 1_700_000_000_000,
  });
  return { exec, review, calls, states };
}

test("successful receipt: submitted then confirmed with hash, block and time", async () => {
  const h = harness();
  await h.exec(h.review);
  assert.deepEqual(h.states.map((s) => s.phase), ["checking", "awaiting-wallet", "submitted", "confirmed"]);
  assert.deepEqual(h.states.at(-1), { phase: "confirmed", hash: "0x" + "ab".repeat(32), blockNumber: 42, at: 1_700_000_000_000 });
  assert.equal(h.calls.submit, 1);
});

test("nothing is called confirmed until receipt status is success: reverted receipt (status 0 or thrown)", async () => {
  const a = harness({ receipt: { status: 0, blockNumber: 1 } });
  await a.exec(a.review);
  assert.equal(a.states.at(-1).phase, "reverted");
  assert.ok(!a.states.some((s) => s.phase === "confirmed"));

  const b = harness({ wait: async () => { throw Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt: { status: 0 } }); } });
  await b.exec(b.review);
  assert.equal(b.states.at(-1).phase, "reverted", "ethers rejects wait() on a reverted receipt");

  const c = harness({ wait: async () => null });
  await c.exec(c.review);
  assert.equal(c.states.at(-1).phase, "error", "a missing receipt is not success");
  assert.match(c.states.at(-1).message, /could not be confirmed/);
});

test("wallet rejection: a distinct 'rejected' state, no transaction, entries retained", async () => {
  const h = harness({ submitError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
  await h.exec(h.review);
  assert.equal(h.states.at(-1).phase, "rejected");
  assert.match(h.states.at(-1).message, /rejected\. No payment was sent and your entries are still here/);
  assert.ok(!h.states.some((s) => s.phase === "submitted"));
});

test("other submit failures are explained: insufficient gas, RPC unavailable, revert on simulation", async () => {
  const gas = harness({ submitError: Object.assign(new Error("insufficient funds for gas"), { code: "INSUFFICIENT_FUNDS" }) });
  await gas.exec(gas.review);
  assert.match(gas.states.at(-1).message, /native balance to pay the network fee/);
  const rpc = harness({ submitError: Object.assign(new Error("could not coalesce error"), { code: "UNKNOWN_ERROR" }) });
  await rpc.exec(rpc.review);
  assert.match(rpc.states.at(-1).message, /RPC is unavailable/);
  const rev = harness({ submitError: Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", reason: "ERC20: transfer amount exceeds balance" }) });
  await rev.exec(rev.review);
  assert.match(rev.states.at(-1).message, /transfer amount exceeds balance/);
});

test("account or network changes before submission stop the send: nothing reaches the wallet", async () => {
  const account = harness({ wallets: [wallet({ account: OTHER_ACCOUNT })] });
  await account.exec(account.review);
  assert.equal(account.calls.submit, 0);
  assert.match(account.states.at(-1).reason, /account changed\. Review the payment again\. Nothing was sent/);

  const chain = harness({ wallets: [wallet({ chainIdHex: TESTNET })] });
  await chain.exec(chain.review);
  assert.equal(chain.calls.submit, 0);
  assert.match(chain.states.at(-1).reason, /network changed/);

  const disconnected = harness({ wallets: [wallet({ account: null })] });
  await disconnected.exec(disconnected.review);
  assert.equal(disconnected.calls.submit, 0);
  assert.equal(disconnected.states.at(-1).phase, "blocked");
});

test("balance that drops below the amount before submission blocks; a balance that only moves is fine", async () => {
  const low = harness({ wallets: [wallet({ balanceAtomic: 1_000_000n })] });
  await low.exec(low.review);
  assert.equal(low.calls.submit, 0);
  assert.match(low.states.at(-1).reason, /Insufficient USDC balance/);
  const moved = harness({ wallets: [wallet({ balanceAtomic: 9_000_000n })] });
  await moved.exec(moved.review);
  assert.equal(moved.calls.submit, 1);
});

test("the review snapshot cannot silently change: a different recipient or amount stops the send", async () => {
  const recipient = harness({ live: () => ({ recipient: "0x3333333333333333333333333333333333333333", amountAtomic: 1_250_000n }) });
  await recipient.exec(recipient.review);
  assert.equal(recipient.calls.submit, 0);
  assert.match(recipient.states.at(-1).reason, /recipient changed/);
  const amount = harness({ live: () => ({ recipient: BOB, amountAtomic: 9_000_000n }) });
  await amount.exec(amount.review);
  assert.equal(amount.calls.submit, 0);
  assert.match(amount.states.at(-1).reason, /amount changed/);
  const invalid = harness({ live: () => ({ recipient: BOB, amountAtomic: null }) });
  await invalid.exec(invalid.review);
  assert.equal(invalid.calls.submit, 0);
});

test("double-click submits exactly once, and one review never broadcasts twice", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = harness({ wait: async () => { await gate; return { status: 1, blockNumber: 7 }; } });
  const first = h.exec(h.review);
  void h.exec(h.review); void h.exec(h.review);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.submit, 1);
  release(); await first;
  await h.exec(h.review);
  assert.equal(h.calls.submit, 1, "no second transaction after confirmation");

  const unknown = harness({ wait: async () => { throw Object.assign(new Error("network"), { code: "NETWORK_ERROR" }); } });
  await unknown.exec(unknown.review);
  await unknown.exec(unknown.review);
  assert.equal(unknown.calls.submit, 1, "an unknown outcome is never answered by sending again");
  assert.match(unknown.states.at(-1).message, /may still confirm; check the explorer/);
});

test("Send source: pinned provider only, no load-time request, no hidden transformation, no float math", () => {
  assert.doesNotMatch(sendSource, /window\.ethereum/);
  assert.doesNotMatch(sendSource + coreSource, /parseFloat|Number\(|toFixed|parseUnits/, "financial math is bigint only");
  const send = sendSource.slice(sendSource.indexOf("export function mountSend"), sendSource.indexOf("export function mountMultisend"));
  assert.doesNotMatch(send, /eth_requestAccounts|connectCurrentNetwork|wallet_switchEthereumChain|personal_sign/, "the page never prompts by itself");
  assert.match(send, /\.transfer\(r\.recipient, r\.amountAtomic\)/, "the reviewed values are the transferred values");
  const gate = sendSource.slice(sendSource.indexOf("function gatePanel"), sendSource.indexOf("function statusRegion"));
  assert.match(gate, /switchButton\.addEventListener\("click", async \(\) => \{[\s\S]*switchToArcMainnet\(\)/, "network switching only happens in the explicit button's click handler");
  assert.equal((sendSource.match(/switchToArcMainnet\(\)/g) || []).length, 1, "and nowhere else");
  assert.match(send, /Send USDC/);
  assert.match(send, /Review payment/);
  assert.doesNotMatch(send, /Testnet|testnet/, "no Testnet copy in the Mainnet form");
});
