/**
 * Step 7: Arc Mainnet Multisend / Payouts. Fee math duplicates the deployed
 * ArcFXMultisender's integer arithmetic exactly; CSV parsing never skips a bad
 * row; approvals are exact; every reviewed value must match at execution.
 * Fake wallet/tx dependencies only: nothing here can touch a chain.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x4F81E3939232815e3C98B124A17BaC75304C82D8";
const OTHER_ACCOUNT = "0x9999999999999999999999999999999999999999";
const MAINNET = "0x13b2";
const TESTNET = "0x4cef52";
const USDC = "0x3600000000000000000000000000000000000000";
const MULTISENDER = "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3";
const TESTNET_MULTISENDER = "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398"; // Arc Mainnet's ArcFXPayments
const source = fs.readFileSync(new URL("../src/workspace/payments.ts", import.meta.url), "utf8");
const coreSource = fs.readFileSync(new URL("../src/workspace/multisendCore.ts", import.meta.url), "utf8");
const constantsSource = fs.readFileSync(new URL("../src/workspace/mainnetPayments.ts", import.meta.url), "utf8");

let server, m, pay;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  m = await server.ssrLoadModule("/src/workspace/multisendCore.ts");
  pay = await server.ssrLoadModule("/src/workspace/mainnetPayments.ts");
});
test.after(async () => { await server?.close(); });

/** Recipient address number i (always valid: lowercase hex above the reserved range). */
const addr = (i) => "0x" + (0x1000 + i).toString(16).padStart(40, "0");
const rowsOf = (n, amount = "1") => Array.from({ length: n }, (_, i) => ({ line: i + 1, recipient: addr(i), amount }));
const batchOf = (rows, opts = {}) => m.buildBatch(rows, { sender: OWNER, ...opts });
const wallet = (patch = {}) => ({ account: OWNER, chainIdHex: MAINNET, balanceAtomic: 10_000_000_000n, allowanceAtomic: 0n, ...patch });

// ── The deployed contract's arithmetic, re-stated independently ───────────────

const solidityFee = (total, isPro) => (isPro ? (total * 10n) / 10_000n : 0n); // FEE_BPS = 10, BPS_DENOM = 10_000

test("fee math equals the deployed contract: floor(total*10/10000), pro only; sweep every fee step", () => {
  for (let total = 0n; total <= 60_000n; total++) {
    assert.equal(m.contractBatchFee(total, true), solidityFee(total, true), `fee(${total})`);
    assert.equal(m.contractBatchPull(total, true), total + solidityFee(total, true));
    assert.equal(m.contractBatchFee(total, false), 0n);
  }
  // Boundaries around the fee increments (the fee steps up every 1000 atomic units).
  for (const [total, fee] of [[999n, 0n], [1000n, 1n], [1001n, 1n], [1999n, 1n], [2000n, 2n], [10_000n, 10n], [999_999n, 999n], [1_000_000n, 1000n], [1_000_001n, 1000n]]) {
    assert.equal(m.contractBatchFee(total, true), fee, `total ${total}`);
  }
  assert.equal(m.contractBatchFee(10n ** 40n, true), 10n ** 37n, "large totals stay exact");
  // Values read from the live Arc Mainnet contract's quoteTotal on 2026-09-20.
  assert.deepEqual([m.contractBatchFee(10_000n, true), m.contractBatchPull(10_000n, true)], [10n, 10_010n]);
  assert.deepEqual([m.contractBatchFee(999n, true), m.contractBatchPull(999n, true)], [0n, 999n]);
  assert.deepEqual([m.contractBatchFee(10_000_000n, true), m.contractBatchPull(10_000_000n, true)], [10_000n, 10_010_000n]);
});

test("contract limits: ≤5 recipients use the fee-free function, 6..500 the Pro function, >500 is refused", () => {
  assert.equal(m.functionFor(1), "multisendFree");
  assert.equal(m.functionFor(5), "multisendFree");
  assert.equal(m.functionFor(6), "multisend");
  assert.equal(m.functionFor(500), "multisend");
  const one = batchOf(rowsOf(1, "0.5"));
  assert.ok(one.valid); assert.equal(one.fn, "multisendFree"); assert.equal(one.feeAtomic, 0n); assert.equal(one.pullAtomic, 500_000n);
  const five = batchOf(rowsOf(5, "2"));
  assert.equal(five.fn, "multisendFree"); assert.equal(five.feeAtomic, 0n);
  const six = batchOf(rowsOf(6, "2"));
  assert.equal(six.fn, "multisend"); assert.equal(six.totalAtomic, 12_000_000n); assert.equal(six.feeAtomic, 12_000n); assert.equal(six.pullAtomic, 12_012_000n);
  const max = batchOf(rowsOf(500, "1"));
  assert.ok(max.valid, "the maximum supported batch is valid"); assert.equal(max.count, 500); assert.equal(max.feeAtomic, 500_000n);
  const tooMany = batchOf(rowsOf(501, "1"));
  assert.equal(tooMany.valid, false);
  assert.match(tooMany.batchErrors[0], /Too many recipients: 501\. One batch holds at most 500/);
  assert.equal(batchOf([]).valid, false);
  assert.match(batchOf([]).batchErrors[0], /at least one recipient/);
});

test("totals are exact bigint sums; fee is shown separately from recipient total", () => {
  const b = batchOf([{ line: 1, recipient: addr(1), amount: "0.1" }, { line: 2, recipient: addr(2), amount: "0.2" }, { line: 3, recipient: addr(3), amount: "0.000001" }, { line: 4, recipient: addr(4), amount: "1000000" }, { line: 5, recipient: addr(5), amount: "0.3" }, { line: 6, recipient: addr(6), amount: "0.000001" }]);
  assert.equal(b.totalAtomic, 100_000n + 200_000n + 1n + 1_000_000_000_000n + 300_000n + 1n);
  assert.equal(b.feeAtomic, (b.totalAtomic * 10n) / 10_000n);
  assert.equal(b.pullAtomic, b.totalAtomic + b.feeAtomic);
  assert.equal(typeof b.totalAtomic, "bigint");
});

test("row validation: invalid address, zero amount, >6 decimals, malformed amount are per-row errors", () => {
  const b = batchOf([
    { line: 1, recipient: addr(1), amount: "1" },
    { line: 2, recipient: "0x123", amount: "1" },
    { line: 3, recipient: addr(3), amount: "0" },
    { line: 4, recipient: addr(4), amount: "0.0000001" },
    { line: 5, recipient: addr(5), amount: "1,5" },
    { line: 6, recipient: MULTISENDER, amount: "1" },
    { line: 7, recipient: OWNER, amount: "1" },
    { line: 8, recipient: "0x0000000000000000000000000000000000000000", amount: "1" },
  ]);
  assert.equal(b.valid, false);
  const at = (line, field) => b.rowErrors.find((e) => e.line === line && e.field === field)?.message;
  assert.match(at(2, "recipient"), /40 hexadecimal/);
  assert.match(at(3, "amount"), /greater than 0/);
  assert.match(at(4, "amount"), /up to 6 decimal places/);
  assert.equal(at(5, "amount"), "Use a dot for decimals, for example 1.5.");
  assert.match(at(6, "recipient"), /Multisender contract/);
  assert.match(at(7, "recipient"), /your own wallet/);
  assert.match(at(8, "recipient"), /zero address/);
  assert.equal(b.entries.length, 1, "only the one good row became an entry; the rest were not silently dropped");
});

test("duplicates are blocked until explicitly allowed", () => {
  const rows = [{ line: 1, recipient: addr(1), amount: "1" }, { line: 2, recipient: addr(2), amount: "1" }, { line: 3, recipient: addr(1).toUpperCase().replace("0X", "0x"), amount: "2" }];
  const blocked = batchOf(rows);
  assert.equal(blocked.valid, false);
  assert.equal(blocked.duplicates.length, 1);
  assert.match(blocked.rowErrors.find((e) => e.line === 1).message, /also appears on line 3/);
  const allowed = batchOf(rows, { allowDuplicates: true });
  assert.equal(allowed.valid, true);
  assert.equal(allowed.totalAtomic, 4_000_000n);
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test("CSV: valid file with and without a header, reference column, quotes, other delimiters, CRLF", () => {
  const withHeader = m.parseCsv(`recipient,amount,reference\r\n${addr(1)},1.50,Invoice 1\r\n${addr(2)},2,\r\n\r\n${addr(3)},0.000001,"Smith, J"\r\n`);
  assert.deepEqual(withHeader.errors, []);
  assert.equal(withHeader.hadHeader, true);
  assert.deepEqual(withHeader.rows.map((r) => [r.line, r.amount, r.reference]), [[2, "1.50", "Invoice 1"], [3, "2", ""], [5, "0.000001", "Smith, J"]]);
  const bare = m.parseCsv(`${addr(1)},5\n${addr(2)},6`);
  assert.equal(bare.hadHeader, false); assert.equal(bare.rows.length, 2); assert.equal(bare.rows[0].line, 1);
  const semi = m.parseCsv(`address;amount\n${addr(1)};7.5`);
  assert.equal(semi.rows[0].amount, "7.5");
  const tsv = m.parseCsv(`${addr(1)}\t9`);
  assert.equal(tsv.rows[0].amount, "9");
  assert.equal(m.parseCsv("﻿recipient,amount\n" + addr(1) + ",1").rows.length, 1, "a BOM does not break the header");
});

test("CSV: malformed rows are reported with their line numbers, never skipped", () => {
  const parsed = m.parseCsv(`recipient,amount\n${addr(1)},1\n${addr(2)}\n${addr(3)},1,ref,extra\n"${addr(4)},1\n${addr(5)},1`);
  assert.deepEqual(parsed.errors.map((e) => e.line), [3, 4, 5]);
  assert.match(parsed.errors[0].message, /Expected recipient and amount/);
  assert.match(parsed.errors[1].message, /at most 3 columns/);
  assert.match(parsed.errors[2].message, /missing its closing quote/);
  assert.equal(parsed.rows.length, 2, "well-formed rows parse, and the caller must reject the file because errors exist");
  assert.match(m.parseCsv("").errors[0].message, /empty/);
  assert.match(m.parseCsv("   \n \n").errors[0].message, /empty/);
  assert.match(m.parseCsv("x".repeat(600 * 1024)).errors[0].message, /larger than 512 KB/);
  assert.match(m.parseCsv(Array(5001).fill("a,1").join("\n")).errors[0].message, /more than 5000 lines/);
  assert.equal(m.parseCsv(`${addr(1)},1,${"r".repeat(81)}`).errors[0].line, 1);
});

test("CSV: a thousands separator in an amount is a visible error, not a silently wrong number", () => {
  const parsed = m.parseCsv(`${addr(1)},1,000.50`);
  assert.equal(parsed.rows.length, 1, "three columns parse as recipient, amount '1', reference '000.50'");
  const b = batchOf(m.parseCsv(`${addr(1)},"1,000.50"`).rows.map((r) => ({ ...r })));
  assert.equal(b.valid, false);
  assert.match(b.rowErrors[0].message, /plain number|Use a dot/);
});

test("CSV template can never move funds if imported unedited", () => {
  const parsed = m.parseCsv(m.CSV_TEMPLATE);
  assert.equal(parsed.rows.length, 1);
  const b = batchOf(parsed.rows);
  assert.equal(b.valid, false);
  assert.match(b.rowErrors[0].message, /40 hexadecimal/);
});

// ── Review snapshot and wallet checks ─────────────────────────────────────────

test("balance requirement covers total plus fee; insufficient balance blocks review", () => {
  const b = batchOf(rowsOf(6, "2")); // pull 12.012 USDC
  assert.match(m.buildBatchReview(b, wallet({ balanceAtomic: 12_011_999n })).blocker, /Insufficient USDC balance: this batch debits 12\.012 USDC \(recipients plus fee\) and you have 12\.011999 USDC/);
  assert.equal(m.buildBatchReview(b, wallet({ balanceAtomic: 12_012_000n })).blocker, null);
  assert.match(m.buildBatchReview(b, wallet({ chainIdHex: TESTNET })).blocker, /not on Arc Mainnet/);
  assert.match(m.buildBatchReview(b, wallet({ account: null })).blocker, /Connect your wallet/);
  assert.match(m.buildBatchReview(b, wallet({ balanceAtomic: null })).blocker, /RPC is unavailable/);
});

test("an invalid batch never produces a review", () => {
  assert.equal(m.buildBatchReview(batchOf(rowsOf(2, "0")), wallet()).review, undefined);
});

test("review pins contract, token, function, list hash and amounts", () => {
  const { review } = m.buildBatchReview(batchOf(rowsOf(6, "2")), wallet());
  assert.equal(review.contract, MULTISENDER);
  assert.equal(review.token, USDC);
  assert.equal(review.fn, "multisend");
  assert.equal(review.recipients.length, 6);
  assert.equal(review.amounts.every((a) => a === 2_000_000n), true);
  assert.match(review.listHash, /^0x[0-9a-f]{64}$/);
  const reordered = m.hashList([...review.recipients].reverse(), [...review.amounts].reverse());
  assert.notEqual(reordered, review.listHash, "even a pure reordering of the reviewed rows is detected");
  assert.notEqual(m.hashList(review.recipients, [3_000_000n, ...review.amounts.slice(1)]), review.listHash, "any amount change alters the hash");
  assert.notEqual(m.hashList([addr(999), ...review.recipients.slice(1)], review.amounts), review.listHash, "and so does any address change");
});

// ── Executor ──────────────────────────────────────────────────────────────────

function run({ allowance = 0n, wallets, liveRows, approveError, approveWait, executeError, executeWait, syncAttempts = 3, rows = rowsOf(6, "2") } = {}) {
  const calls = { approve: [], execute: 0, reads: 0 };
  const states = [];
  let currentAllowance = allowance;
  const first = wallet({ allowanceAtomic: allowance });
  const { review } = m.buildBatchReview(batchOf(rows), first);
  const queue = wallets ? [...wallets] : null;
  const exec = m.createBatchExecutor({
    readWallet: async () => { calls.reads++; if (queue) return queue.length > 1 ? queue.shift() : queue[0]; return wallet({ allowanceAtomic: currentAllowance }); },
    live: () => batchOf(liveRows ?? rows),
    approve: async (amount) => {
      calls.approve.push(amount);
      if (approveError) throw approveError;
      return { hash: "0x" + "aa".repeat(32), wait: approveWait ?? (async () => { currentAllowance = amount; return { status: 1, blockNumber: 10 }; }) };
    },
    execute: async () => {
      calls.execute++;
      if (executeError) throw executeError;
      return { hash: "0x" + "bb".repeat(32), wait: executeWait ?? (async () => ({ status: 1, blockNumber: 11 })) };
    },
    onState: (s) => states.push(s),
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    syncAttempts,
  });
  return { exec, review, calls, states, setAllowance: (v) => { currentAllowance = v; } };
}
const phases = (h) => h.states.map((s) => s.phase);

test("insufficient allowance: approves exactly total + fee, then reports 'approved' without executing", async () => {
  const h = run();
  await h.exec.approve(h.review);
  assert.deepEqual(h.calls.approve, [12_012_000n], "exactly the wallet debit, never unlimited");
  assert.equal(h.calls.execute, 0, "approval never executes the batch");
  assert.equal(h.states.at(-1).phase, "approved");
  assert.ok(phases(h).includes("approval-awaiting-wallet") && phases(h).includes("approval-submitted"));
  assert.ok(h.calls.approve[0] < 2n ** 200n);
});

test("the approve amount for a free-tier batch has no fee", async () => {
  const h = run({ rows: rowsOf(3, "1.5") });
  await h.exec.approve(h.review);
  assert.deepEqual(h.calls.approve, [4_500_000n]);
});

test("sufficient allowance: no approval is requested", async () => {
  const h = run({ allowance: 12_012_000n });
  await h.exec.approve(h.review);
  assert.equal(h.calls.approve.length, 0);
  assert.equal(h.states.at(-1).phase, "not-needed");
  assert.match(h.states.at(-1).message, /already covers this batch/);
  await h.exec.execute(h.review);
  assert.equal(h.calls.execute, 1);
});

test("execution requires sufficient allowance at the moment of execution", async () => {
  const h = run({ allowance: 5n });
  await h.exec.execute(h.review);
  assert.equal(h.calls.execute, 0);
  assert.match(h.states.at(-1).reason, /allowance no longer covers this batch/);
});

test("approval then execute: separate steps, one batch, confirmed only on receipt success", async () => {
  const h = run();
  await h.exec.approve(h.review);
  await h.exec.execute(h.review);
  assert.equal(h.calls.execute, 1);
  const done = h.states.at(-1);
  assert.deepEqual(done, { phase: "confirmed", hash: "0x" + "bb".repeat(32), blockNumber: 11, at: 1_700_000_000_000 });
});

test("approval rejected in the wallet: explained, allowance untouched, nothing else sent", async () => {
  const h = run({ approveError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
  await h.exec.approve(h.review);
  assert.equal(h.states.at(-1).phase, "rejected");
  assert.match(h.states.at(-1).message, /No approval was sent/);
  assert.equal(h.calls.execute, 0);
});

test("approval receipt failure (status 0, thrown revert, or missing) never proceeds to a batch", async () => {
  for (const approveWait of [async () => ({ status: 0 }), async () => { throw Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION", receipt: { status: 0 } }); }, async () => null]) {
    const h = run({ approveWait });
    await h.exec.approve(h.review);
    assert.equal(h.states.at(-1).phase, "error");
    assert.match(h.states.at(-1).message, /approval transaction (did not succeed|reverted)|No batch was sent/);
    assert.equal(h.calls.execute, 0);
    assert.ok(!h.states.some((s) => s.phase === "approved"));
  }
});

test("the expected allowance increase after our own approval is not an error", async () => {
  const stale = wallet({ allowanceAtomic: 0n });
  const fresh = wallet({ allowanceAtomic: 12_012_000n });
  // guard read, then two stale re-reads (lagging RPC), then the fresh allowance.
  const h = run({ wallets: [stale, stale, stale, fresh, fresh, fresh, fresh], syncAttempts: 5 });
  await h.exec.approve(h.review);
  assert.equal(h.states.at(-1).phase, "approved");
  assert.ok(!h.states.some((s) => s.phase === "blocked" || s.phase === "error"));
  assert.equal(h.calls.approve.length, 1, "a lagging RPC never causes a second approval");
});

test("if the wallet never reports the new allowance, say so and stop (no second approval)", async () => {
  const stale = wallet({ allowanceAtomic: 0n });
  const h = run({ wallets: [stale], syncAttempts: 2 });
  await h.exec.approve(h.review);
  assert.equal(h.states.at(-1).phase, "approval-unsynced");
  assert.equal(h.calls.approve.length, 1);
  assert.equal(h.calls.execute, 0);
});

test("account or network change after approval fails closed at execution", async () => {
  const account = run({ allowance: 12_012_000n, wallets: [wallet({ account: OTHER_ACCOUNT, allowanceAtomic: 12_012_000n })] });
  await account.exec.execute(account.review);
  assert.equal(account.calls.execute, 0);
  assert.match(account.states.at(-1).reason, /account changed\. Review the batch again\. Nothing was sent/);
  const chain = run({ allowance: 12_012_000n, wallets: [wallet({ chainIdHex: TESTNET, allowanceAtomic: 12_012_000n })] });
  await chain.exec.execute(chain.review);
  assert.equal(chain.calls.execute, 0);
  assert.match(chain.states.at(-1).reason, /network changed/);
  // …and between approval submission and the post-approval re-check.
  const stale = wallet({ allowanceAtomic: 0n });
  const afterApproval = run({ wallets: [stale, wallet({ chainIdHex: TESTNET, allowanceAtomic: 12_012_000n })], syncAttempts: 2 });
  await afterApproval.exec.approve(afterApproval.review);
  assert.equal(afterApproval.calls.approve.length, 1);
  assert.notEqual(afterApproval.states.at(-1).phase, "approved", "a changed network after approval is never reported as approved");
});

test("reviewed batch mutations fail closed: amount, recipient, count, function, total", async () => {
  const base = rowsOf(6, "2");
  const cases = {
    amount: base.map((r, i) => (i === 2 ? { ...r, amount: "2.000001" } : r)),
    recipient: base.map((r, i) => (i === 4 ? { ...r, recipient: addr(900) } : r)),
    removedRow: base.slice(0, 5),
    addedRow: [...base, { line: 7, recipient: addr(7), amount: "2" }],
    invalidNow: base.map((r, i) => (i === 0 ? { ...r, amount: "0" } : r)),
  };
  for (const [name, liveRows] of Object.entries(cases)) {
    const h = run({ allowance: 99_000_000n, liveRows });
    await h.exec.execute(h.review);
    assert.equal(h.calls.execute, 0, name);
    assert.equal(h.states.at(-1).phase, "blocked", name);
    assert.match(h.states.at(-1).reason, /Review the batch again\. Nothing was sent/, name);
  }
});

test("wrong token/contract in a snapshot can never be executed", () => {
  const { review } = m.buildBatchReview(batchOf(rowsOf(6, "2")), wallet());
  const live = batchOf(rowsOf(6, "2"));
  assert.match(m.batchReviewChange({ ...review, contract: TESTNET_MULTISENDER }, live, wallet()), /token or contract does not match/);
  assert.match(m.batchReviewChange({ ...review, token: "0x2222222222222222222222222222222222222222" }, live, wallet()), /token or contract does not match/);
  assert.equal(m.batchReviewChange(review, live, wallet({ allowanceAtomic: 0n })), null);
});

test("one batch submission only: double-click, then again after confirmation", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = run({ allowance: 99_000_000n, executeWait: async () => { await gate; return { status: 1, blockNumber: 3 }; } });
  const first = h.exec.execute(h.review);
  void h.exec.execute(h.review); void h.exec.execute(h.review); void h.exec.approve(h.review);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.execute, 1);
  assert.equal(h.calls.approve.length, 0, "no approval can start while a mutation is in flight");
  release(); await first;
  await h.exec.execute(h.review);
  assert.equal(h.calls.execute, 1);
  const unknown = run({ allowance: 99_000_000n, executeWait: async () => { throw Object.assign(new Error("network"), { code: "NETWORK_ERROR" }); } });
  await unknown.exec.execute(unknown.review); await unknown.exec.execute(unknown.review);
  assert.equal(unknown.calls.execute, 1, "an unknown outcome never triggers a second batch");
});

test("contract revert: reported as reverted (thrown or status 0), never as confirmed; simulation revert explained", async () => {
  const thrown = run({ allowance: 99_000_000n, executeWait: async () => { throw Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION", receipt: { status: 0 } }); } });
  await thrown.exec.execute(thrown.review);
  assert.equal(thrown.states.at(-1).phase, "reverted");
  const status0 = run({ allowance: 99_000_000n, executeWait: async () => ({ status: 0 }) });
  await status0.exec.execute(status0.review);
  assert.equal(status0.states.at(-1).phase, "reverted");
  const sim = run({ allowance: 99_000_000n, executeError: Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", reason: "Transfer to recipient failed" }) });
  await sim.exec.execute(sim.review);
  assert.equal(sim.states.at(-1).phase, "error");
  assert.match(sim.states.at(-1).message, /Transfer to recipient failed/);
  for (const h of [thrown, status0, sim]) assert.ok(!h.states.some((s) => s.phase === "confirmed"));
});

test("execution rejected in the wallet retains the form and sends nothing", async () => {
  const h = run({ allowance: 99_000_000n, executeError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
  await h.exec.execute(h.review);
  assert.equal(h.states.at(-1).phase, "rejected");
  assert.match(h.states.at(-1).message, /No batch was sent and your entries are still here/);
});

// ── Source-level invariants ───────────────────────────────────────────────────

test("addresses: Mainnet multisender only; the Testnet multisender (Mainnet ArcFXPayments) is never a target", () => {
  assert.equal(pay.MAINNET.multisender, MULTISENDER);
  assert.notEqual(pay.MAINNET.multisender.toLowerCase(), pay.MAINNET.payments.toLowerCase());
  assert.equal(pay.MAINNET.payments, TESTNET_MULTISENDER, "the swapped address is recognised as ArcFXPayments and protected as a recipient");
  const ui = source.slice(source.indexOf("export function mountMultisend"));
  assert.match(ui, /new Contract\(MAINNET\.multisender, MULTISENDER_ABI, signer\)/);
  assert.match(ui, /approve\(MAINNET\.multisender, amount\)/, "approves the Mainnet multisender only");
  assert.doesNotMatch(source + coreSource, new RegExp(TESTNET_MULTISENDER, "i"), "the swapped address never appears as a call target");
  assert.doesNotMatch(source + coreSource, /0x4CEF52|4CEF52|5042002|testnet/i, "no Testnet chain or copy");
});

test("multisend source: bigint only, no unlimited approval, pinned provider, no prompts on load", () => {
  const all = source + coreSource + constantsSource;
  assert.doesNotMatch(all, /parseFloat|toFixed|parseUnits/, "no floating-point money math");
  const numberCalls = all.match(/Number\(/g) || [];
  assert.equal(numberCalls.length, 1, "the only Number() is the receipt-status check in isRevertedReceiptError, never an amount");
  assert.match(constantsSource, /Number\(e\.receipt\.status\) === 0/);
  assert.doesNotMatch(all, /MaxUint256|2n \*\* 256n|ffffffffffffffff/i, "never an unlimited approval");
  assert.doesNotMatch(source, /window\.ethereum/);
  assert.doesNotMatch(source, /papaparse|sheetjs|xlsx|cdnjs|<script/i, "no third-party parser or CDN");
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|sendBeacon/, "CSV contents are never uploaded");
  const ui = source.slice(source.indexOf("export function mountMultisend"));
  assert.doesNotMatch(ui, /eth_requestAccounts|connectCurrentNetwork|wallet_switchEthereumChain|personal_sign/, "the page never prompts by itself");
  assert.match(ui, /Approve exactly/);
  assert.match(ui, /Execute batch/);
  assert.match(ui, /ArcFX fee/);
  assert.match(ui, /Total wallet debit/);
  assert.match(ui, /nothing is uploaded/i);
});
