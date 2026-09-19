/**
 * Step 6G.1 regression: a hard load of a Mainnet workspace page must not turn
 * wallet notifications into a restore → emit → render → read cycle.
 *
 * Each scenario loads fresh wallet/API modules in a new "document" and drives
 * them the way a page does (watch → readiness → owner read), counting wallet
 * RPCs, wallet notifications, readiness evaluations, API requests, and
 * signatures while the tab is otherwise idle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x7564105e977516c53be337314c7e53838967bdac";
const OTHER = "0x1111111111111111111111111111111111111111";
const KEY = "arcfx:mainnet-receivables-owner-session:v1";
const idle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

class FakeWindow {
  #listeners = new Map();
  constructor(ethereum) { this.ethereum = ethereum; }
  addEventListener(type, handler) { this.#listeners.set(type, [...(this.#listeners.get(type) || []), handler]); }
  dispatchEvent(event) { for (const handler of this.#listeners.get(event.type) || []) handler(event); return true; }
}

function provider({ chainId = "0x13b2", latencyMs = 2 } = {}) {
  const handlers = new Map();
  const control = { accounts: [OWNER], chainId, rpc: {}, signatures: 0, switches: 0 };
  const answer = (method) => {
    control.rpc[method] = (control.rpc[method] || 0) + 1;
    if (method === "eth_accounts") return [...control.accounts];
    if (method === "eth_chainId") return control.chainId;
    if (method === "eth_call") return "0x0";
    if (method === "personal_sign") { control.signatures++; throw new Error("no signing in this test"); }
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") { control.switches++; return null; }
    throw new Error(`unexpected wallet method ${method}`);
  };
  return {
    control,
    request: ({ method }) => latencyMs
      ? new Promise((resolve, reject) => setTimeout(() => { try { resolve(answer(method)); } catch (e) { reject(e); } }, latencyMs))
      : (() => { try { return Promise.resolve(answer(method)); } catch (e) { return Promise.reject(e); } })(),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]),
    removeListener: (event, handler) => handlers.set(event, (handlers.get(event) || []).filter((h) => h !== handler)),
    fire: async (event, value) => { for (const handler of handlers.get(event) || []) await handler(value); },
  };
}

const session = (wallet = OWNER, expiresAt = "2099-01-01T00:00:00.000Z") =>
  JSON.stringify({ sessionToken: "v1.loop.iv.ciphertext.tag", wallet, chainId: "0x13b2", expiresAt });

/** One browser document with a page that renders like receivables.ts / dashboard.ts. */
async function openDocument(t, { wallet = provider(), stored = session(), status = 200 } = {}) {
  const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const storage = new MemoryStorage();
  if (stored) storage.setItem(KEY, stored);
  const api = { requests: 0, byPath: {}, status };
  globalThis.window = new FakeWindow(wallet);
  globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
  globalThis.sessionStorage = storage;
  globalThis.localStorage = new MemoryStorage();
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    api.requests++;
    api.byPath[path] = (api.byPath[path] || 0) + 1;
    await idle(5);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const body = api.status === 200 ? { wallet: OWNER, count: 0, customers: [], invoices: [], outstandingByToken: {} } : { error: `status ${api.status}` };
    return new Response(JSON.stringify(body), { status: api.status, headers: { "content-type": "application/json" } });
  };
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  t.after(async () => {
    await server.close();
    Object.assign(globalThis, saved);
  });
  const { arcfxApi } = await server.ssrLoadModule("/src/shared/arcfxApi.ts");
  const { arcfxWallet } = await server.ssrLoadModule("/src/shared/wallet.ts");
  const counters = { emits: 0, renders: 0, readiness: [], errors: [] };
  arcfxWallet.onChange(() => { counters.emits++; });
  // The page: the same shape as mountReceivables' render.
  let version = 0;
  arcfxWallet.watch(async () => {
    const current = ++version;
    counters.renders++;
    const readiness = await arcfxApi.receivablesReadiness();
    counters.readiness.push(readiness);
    if (current !== version || readiness !== "AUTHENTICATED") return;
    try { await arcfxApi.listReceivablesCustomers(); }
    catch (error) { counters.errors.push(String(error?.message || error)); }
  });
  return { arcfxApi, arcfxWallet, wallet, storage, api, counters };
}

test("authenticated hard load: one readiness, one owner read, no signature, then idle", async (t) => {
  const doc = await openDocument(t);
  await idle(300);
  const rpcAfterLoad = { ...doc.wallet.control.rpc };
  assert.equal(doc.api.requests, 1, "exactly one GET /v1/customers");
  assert.equal(doc.counters.renders, 1, "one render for the settled wallet");
  assert.deepEqual(doc.counters.readiness, ["AUTHENTICATED"]);
  assert.ok(doc.counters.emits <= 2, `bounded wallet notifications (got ${doc.counters.emits})`);
  assert.equal(doc.wallet.control.signatures, 0);
  await idle(300);
  assert.equal(doc.api.requests, 1, "no further requests while idle");
  assert.deepEqual(doc.wallet.control.rpc, rpcAfterLoad, "no wallet RPC while idle");
});

test("readiness after bootstrap is pure: repeated evaluation never re-reads the wallet or notifies", async (t) => {
  const doc = await openDocument(t);
  await idle(200);
  const rpc = { ...doc.wallet.control.rpc };
  const emits = doc.counters.emits;
  for (let i = 0; i < 50; i++) assert.equal(await doc.arcfxApi.receivablesReadiness(), "AUTHENTICATED");
  assert.deepEqual(doc.wallet.control.rpc, rpc, "no provider reads");
  assert.equal(doc.counters.emits, emits, "no wallet notifications");
  // An explicit silent restore of identical state re-reads but does not notify.
  await doc.arcfxWallet.restore();
  await doc.arcfxWallet.restore();
  await idle(100);
  assert.equal(doc.counters.emits, emits, "an unchanged restore does not notify listeners");
  assert.equal(doc.api.requests, 1);
});

test("a synchronously answering wallet cannot spin the page (no microtask loop)", async (t) => {
  const doc = await openDocument(t, { wallet: provider({ latencyMs: 0 }) });
  await idle(300);
  assert.equal(doc.api.requests, 1);
  assert.equal(doc.counters.renders, 1);
});

test("account change: one re-render, bearer cleared, no automatic signature or read storm", async (t) => {
  const doc = await openDocument(t);
  await idle(200);
  doc.wallet.control.accounts = [OTHER];
  await doc.wallet.fire("accountsChanged", [OTHER]);
  await idle(300);
  assert.equal(doc.storage.getItem(KEY), null, "the prior owner's bearer is cleared");
  assert.equal(doc.counters.readiness.at(-1), "CONNECTED_NOT_AUTHENTICATED");
  assert.equal(doc.api.requests, 1, "no read for the new, unauthenticated wallet");
  assert.equal(doc.wallet.control.signatures, 0, "no signature without an explicit action");
  assert.ok(doc.counters.renders <= 3, `bounded renders (got ${doc.counters.renders})`);
});

test("spurious chainChanged for the same chain keeps the bearer and costs at most one re-read", async (t) => {
  const doc = await openDocument(t);
  await idle(200);
  await doc.wallet.fire("chainChanged", "0x13b2");
  await idle(300);
  assert.ok(doc.storage.getItem(KEY), "bearer retained");
  assert.equal(doc.counters.readiness.at(-1), "AUTHENTICATED");
  assert.ok(doc.api.requests <= 2, `at most one re-read (got ${doc.api.requests})`);
});

test("wrong network: explicit WRONG_NETWORK, no read, no automatic switch", async (t) => {
  const doc = await openDocument(t, { wallet: provider({ chainId: "0x1" }) });
  await idle(300);
  assert.deepEqual(doc.counters.readiness, ["WRONG_NETWORK"]);
  assert.equal(doc.api.requests, 0);
  assert.equal(doc.wallet.control.switches, 0, "ArcFX never switches the network by itself");
  assert.equal(doc.storage.getItem(KEY), null, "wrong-chain bearer cleared");
});

test("expired session: CONNECTED_NOT_AUTHENTICATED, no read, no signature", async (t) => {
  const doc = await openDocument(t, { stored: session(OWNER, "2000-01-01T00:00:00.000Z") });
  await idle(300);
  assert.deepEqual(doc.counters.readiness, ["CONNECTED_NOT_AUTHENTICATED"]);
  assert.equal(doc.api.requests, 0);
  assert.equal(doc.wallet.control.signatures, 0);
});

test("401: bearer cleared once, surfaced as an error, no retry storm or signature", async (t) => {
  const doc = await openDocument(t, { status: 401 });
  await idle(300);
  assert.equal(doc.api.requests, 1);
  assert.equal(doc.counters.errors.length, 1);
  assert.equal(doc.storage.getItem(KEY), null);
  assert.equal(await doc.arcfxApi.receivablesReadiness(), "CONNECTED_NOT_AUTHENTICATED");
  assert.equal(doc.wallet.control.signatures, 0);
});

test("backend failure: one failed read surfaced to the page, then idle", async (t) => {
  const doc = await openDocument(t, { status: 500 });
  await idle(400);
  assert.equal(doc.api.requests, 1);
  assert.equal(doc.counters.errors.length, 1);
  assert.ok(doc.storage.getItem(KEY), "a server error is not an authentication failure");
});

test("explicit Disconnect: DISCONNECTED, bearer cleared, no read", async (t) => {
  const doc = await openDocument(t);
  await idle(200);
  doc.arcfxWallet.disconnect();
  await idle(200);
  assert.equal(doc.counters.readiness.at(-1), "DISCONNECTED");
  assert.equal(doc.storage.getItem(KEY), null);
  assert.equal(doc.api.requests, 1);
});
