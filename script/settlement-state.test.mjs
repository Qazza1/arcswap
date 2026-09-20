/**
 * Step 6H.3: invoice actions follow authoritative settlement state. A settled
 * invoice is never offered Reconcile; an open one is; one run at a time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x7564105e977516c53be337314c7e53838967bdac";
const receivablesSource = fs.readFileSync(new URL("../src/workspace/receivables.ts", import.meta.url), "utf8");
let server, s;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  s = await server.ssrLoadModule("/src/workspace/settlementState.ts");
});
test.after(async () => { await server?.close(); });

const inv = (patch = {}) => ({ id: "inv_1", status: "sent", amount: "0.010000", paid: "0.000000", outstanding: "0.010000", token: "USDC", ...patch });
const tret = inv({ status: "overpaid", paid: "0.010001", outstanding: "0.000000" });

test("open invoices keep Reconcile: sent, partial, overdue with an outstanding balance", () => {
  for (const status of ["sent", "partial", "overdue"]) {
    const patch = status === "partial" ? { paid: "0.004000", outstanding: "0.006000" } : {};
    assert.equal(s.settlementView(inv({ status, ...patch })).kind, "reconcilable", status);
  }
});

test("paid with nothing outstanding hides Reconcile and says paid in full", () => {
  const view = s.settlementView(inv({ status: "paid", paid: "0.010000", outstanding: "0.000000" }));
  assert.deepEqual(view, { kind: "settled", excess: null });
  assert.deepEqual(s.settledCopy(inv({ status: "paid", paid: "0.010000" }), view), { title: "✓ Reconciled", detail: "Paid in full." });
});

test("overpaid with nothing outstanding hides Reconcile and shows the excess (tret)", () => {
  const view = s.settlementView(tret);
  assert.deepEqual(view, { kind: "settled", excess: "0.000001" });
  const copy = s.settledCopy(tret, view);
  assert.equal(copy.title, "✓ Reconciled");
  assert.match(copy.detail, /^Overpaid by 0\.000001 USDC\./);
  assert.match(copy.detail, /0\.010001 USDC received is recorded/);
});

test("draft and cancelled invoices are not reconcilable", () => {
  assert.deepEqual(s.settlementView(inv({ status: "draft" })), { kind: "not-applicable", reason: "draft" });
  assert.deepEqual(s.settlementView(inv({ status: "cancelled" })), { kind: "not-applicable", reason: "cancelled" });
});

test("an unreadable or amount-less record fails open to the action, never to a false 'settled'", () => {
  assert.equal(s.settlementView(inv({ amount: null, outstanding: null })).kind, "reconcilable");
  assert.equal(s.settlementView(inv({ paid: "x", outstanding: "0" })).kind, "reconcilable");
  assert.equal(s.settlementView(inv({ paid: "0.000000", outstanding: "0.000000" })).kind, "reconcilable", "zero outstanding with nothing paid is not 'reconciled'");
});

function runner(state, { failWith = null, gate = null } = {}) {
  const calls = { reconcile: 0, refresh: 0 };
  const states = [];
  let current = state;
  const run = s.createReconcileRunner({
    current: () => current,
    reconcile: async () => { calls.reconcile++; if (gate) await gate.promise; if (failWith) throw failWith; return { results: [{ allocated: 1 }] }; },
    refresh: async () => { calls.refresh++; current = tret; return current; },
    onState: (x) => states.push(x),
  });
  return { run, calls, states, get current() { return current; } };
}

test("success refreshes authoritative state and replaces the action with the settled view", async () => {
  const r = runner(inv({ status: "sent" }));
  await r.run();
  assert.deepEqual(r.states.map((x) => x.phase), ["running", "done"]);
  const done = r.states.at(-1);
  assert.equal(done.allocated, 1);
  assert.equal(done.view.kind, "settled");
  assert.equal(done.view.excess, "0.000001");
  assert.equal(r.calls.refresh, 1);
});

test("double-click sends one reconciliation request", async () => {
  let release; const gate = { promise: new Promise((res) => { release = res; }) };
  const r = runner(inv(), { gate });
  const first = r.run(); void r.run(); void r.run();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.calls.reconcile, 1);
  release(); await first;
  assert.equal(r.calls.reconcile, 1);
});

test("once settled, a stale click sends nothing and asks for no signature", async () => {
  const r = runner(inv());
  await r.run();
  await r.run(); await r.run();
  assert.equal(r.calls.reconcile, 1, "no second request after success");
  const settledRun = runner(tret);
  await settledRun.run();
  assert.equal(settledRun.calls.reconcile, 0, "an already-settled invoice never reconciles");
  assert.deepEqual(settledRun.states, []);
});

test("401 fails closed and backend failure restores the action with an explanation", async () => {
  const e401 = Object.assign(new Error("owner session is invalid or expired"), { status: 401, body: { error: "signature could not be verified" } });
  const a = runner(inv(), { failWith: e401 });
  await a.run();
  assert.equal(a.states.at(-1).phase, "error");
  assert.match(a.states.at(-1).message, /could not verify the wallet signature/);
  assert.equal(a.calls.refresh, 0, "no state change on failure");
  assert.equal(s.settlementView(a.current).kind, "reconcilable", "the action is still available to retry");

  const e500 = Object.assign(new Error("boom"), { status: 500, body: { error: "boom" } });
  const b = runner(inv(), { failWith: e500 });
  await b.run();
  assert.match(b.states.at(-1).message, /server error 500/);
  await b.run();
  assert.equal(b.calls.reconcile, 2, "a failed run releases the lock so it can be retried");
});

// ── Through the real signed API path ───────────────────────────────────────

class MemoryStorage { #v = new Map(); getItem(k) { return this.#v.has(k) ? this.#v.get(k) : null; } setItem(k, v) { this.#v.set(k, String(v)); } removeItem(k) { this.#v.delete(k); } }
class FakeWindow { #l = new Map(); constructor(e) { this.ethereum = e; } addEventListener(t, h) { this.#l.set(t, [...(this.#l.get(t) || []), h]); } dispatchEvent(ev) { for (const h of this.#l.get(ev.type) || []) h(ev); return true; } }

test("real API path: one signature and one POST for the reconcile, none after it settles", async (t) => {
  const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const wallet = { signatures: 0 };
  const provider = {
    request: async ({ method }) => {
      if (method === "eth_accounts") return [OWNER];
      if (method === "eth_chainId") return "0x13b2";
      if (method === "personal_sign") { wallet.signatures++; return "0x" + "11".repeat(65); }
      throw new Error(`unexpected ${method}`);
    },
    on() {}, removeListener() {},
  };
  const store = new MemoryStorage();
  store.setItem("arcfx:mainnet-receivables-owner-session:v1", JSON.stringify({ sessionToken: "v1.settle.iv.ct.tag", wallet: OWNER, chainId: "0x13b2", expiresAt: "2099-01-01T00:00:00.000Z" }));
  const requests = [];
  globalThis.window = new FakeWindow(provider);
  globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
  globalThis.sessionStorage = store; globalThis.localStorage = new MemoryStorage();
  let reconciled = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method || "GET"} ${url.pathname}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/invoice-records/reconcile") { reconciled = true; return json({ reconciled: 1, results: [{ allocated: 1, paidAtomic: "10001", status: "overpaid" }] }); }
    if (url.pathname === "/v1/invoice-records") return json({ invoices: [reconciled ? { ...tret } : inv({ status: "sent" })] });
    return json({ error: "unexpected" }, 404);
  };
  const s2 = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  t.after(async () => { await s2.close(); Object.assign(globalThis, saved); });
  const { arcfxApi } = await s2.ssrLoadModule("/src/shared/arcfxApi.ts");
  const { arcfxWallet } = await s2.ssrLoadModule("/src/shared/wallet.ts");
  await arcfxWallet.settled();
  let current = (await arcfxApi.listReceivablesInvoices()).invoices[0];
  const run = s.createReconcileRunner({
    current: () => current,
    reconcile: () => arcfxApi.reconcileReceivables(current.id),
    refresh: async () => (current = (await arcfxApi.listReceivablesInvoices()).invoices[0]),
    onState: () => {},
  });
  await Promise.all([run(), run()]);
  await run(); await run();
  assert.equal(wallet.signatures, 1, "exactly one owner signature");
  assert.equal(requests.filter((r) => r === "POST /v1/invoice-records/reconcile").length, 1, "exactly one reconcile POST");
  assert.equal(s.settlementView(current).kind, "settled");
});

test("the detail page renders the action from settlementView, not unconditionally", () => {
  const detail = receivablesSource.slice(receivablesSource.indexOf("async function invoiceDetail"), receivablesSource.indexOf("async function invoicePage"));
  assert.match(detail, /const view = settlementView\(invoice\)/);
  assert.match(detail, /view\.kind === "settled"/);
  assert.match(detail, /view\.kind === "reconcilable"/);
  assert.equal((detail.match(/"Reconcile invoice"/g) || []).length, 2, "label appears only on the button and its error restore");
  assert.doesNotMatch(detail, /arcfxApi\.reconcileReceivables\(invoice!\.id\);\s*content\.prepend/, "the inline unguarded handler is gone");
  assert.match(detail, /No unreconciled payments found/);
  assert.match(detail, /"Reconciling"/);
});
