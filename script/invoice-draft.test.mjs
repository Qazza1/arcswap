/**
 * Step 6H.1: Save draft. Draft validation is separate from issue validation,
 * a save is exactly one signed mutation, and every failure is explained.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x7564105e977516c53be337314c7e53838967bdac";
const USDC = "0x3600000000000000000000000000000000000000";
const receivablesSource = fs.readFileSync(new URL("../src/workspace/receivables.ts", import.meta.url), "utf8");

let server;
let draft;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  draft = await server.ssrLoadModule("/src/workspace/invoiceDraft.ts");
});
test.after(async () => { await server?.close(); });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the owner's exact case is a valid draft: number + amount, no customer, due date, or note", () => {
  assert.deepEqual(draft.validateDraft({ number: "123", amount: "0.01" }), {});
  assert.equal(draft.missingSummary({}), "");
});

test("truly required draft fields are explained, never silently blocked", () => {
  assert.equal(draft.validateDraft({ number: "  ", amount: "0.01" }).number, "Enter an invoice number.");
  assert.match(draft.validateDraft({ number: "123", amount: "" }).amount, /^Enter an amount greater than 0\. It can't be changed after the draft is saved\.$/);
  assert.equal(draft.missingSummary(draft.validateDraft({ number: "", amount: "" })), "To save a draft, add a valid invoice number and amount.");
  assert.match(draft.validateDraft({ number: "x".repeat(65), amount: "1" }).number, /64 characters/);
});

test("invalid or zero amounts cannot be saved", () => {
  for (const amount of ["0", "0.00", "0.000000"]) assert.equal(draft.validateDraft({ number: "1", amount }).amount, "Enter an amount greater than 0.", amount);
  assert.match(draft.validateDraft({ number: "1", amount: "-1" }).amount, /plain number/);
  assert.match(draft.validateDraft({ number: "1", amount: "abc" }).amount, /plain number/);
  assert.equal(draft.validateDraft({ number: "1", amount: "0,01" }).amount, "Use a dot for decimals, for example 0.01.");
  assert.match(draft.validateDraft({ number: "1", amount: "0.0000001" }).amount, /up to 6 decimal places/);
  assert.match(draft.validateDraft({ number: "1", amount: "9".repeat(61) }).amount, /too large/);
  assert.deepEqual(draft.validateDraft({ number: "1", amount: "0.000001" }), {});
});

test("an incomplete draft cannot be issued; a complete one can", () => {
  assert.match(draft.issueBlocker({ status: "draft", amount: null, token: "USDC" }), /no amount/);
  assert.match(draft.issueBlocker({ status: "draft", amount: "0.01", token: null, tokenAddress: null }), /no token/);
  assert.match(draft.issueBlocker({ status: "sent", amount: "0.01", token: "USDC" }), /Only a draft/);
  assert.equal(draft.issueBlocker({ status: "draft", amount: "0.01", token: "USDC" }), null);
});

test("double-click produces exactly one mutation and ends in 'saved'", async () => {
  let calls = 0; let release;
  const states = [];
  const submit = draft.createDraftSubmitter(() => { calls++; return new Promise((r) => { release = r; }); }, (s) => states.push(s.phase));
  const values = { number: "123", amount: "0.01" };
  const first = submit(values); void submit(values); void submit(values);
  await tick();
  assert.equal(calls, 1);
  release({ invoice: { id: "inv_1" } });
  await first;
  await submit(values);
  assert.equal(calls, 1, "a saved draft is never re-submitted from the same form");
  assert.deepEqual(states, ["saving", "saved"]);
});

test("invalid input never reaches the wallet or the API", async () => {
  let calls = 0; const states = [];
  const submit = draft.createDraftSubmitter(async () => { calls++; return { invoice: { id: "x" } }; }, (s) => states.push(s));
  await submit({ number: "", amount: "0" });
  assert.equal(calls, 0);
  assert.equal(states[0].phase, "invalid");
  assert.ok(states[0].errors.number && states[0].errors.amount);
});

test("rejected signature: actionable message, form can retry, nothing lost", async () => {
  let calls = 0; const states = [];
  const submit = draft.createDraftSubmitter(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    return { invoice: { id: "inv_2" } };
  }, (s) => states.push(s));
  const values = { number: "123", amount: "0.01" };
  await submit(values);
  assert.equal(states.at(-1).phase, "error");
  assert.match(states.at(-1).message, /Signature cancelled in your wallet\. Nothing was saved/);
  assert.deepEqual(values, { number: "123", amount: "0.01" }, "entries untouched");
  await submit(values);
  assert.equal(states.at(-1).phase, "saved", "the owner can retry after cancelling");
});

test("backend and transport failures map to explicit messages", () => {
  const api = (status, error) => Object.assign(new Error(error), { status, body: { error } });
  assert.equal(draft.describeWriteError(api(409, "invoice 123 already exists for this wallet")), "Invoice 123 already exists for this wallet. Choose a different invoice number.");
  assert.equal(draft.describeWriteError(api(400, "amount must be greater than zero")), "ArcFX rejected the draft: amount must be greater than zero.");
  assert.match(draft.describeWriteError(api(401, "signature timestamp is stale — re-sign and retry")), /could not verify the wallet signature/);
  assert.match(draft.describeWriteError(api(403, "signature does not match wallet")), /could not verify the wallet signature/);
  assert.match(draft.describeWriteError(api(502, "bad gateway")), /server error 502/);
  assert.match(draft.describeWriteError(Object.assign(new Error("slow"), { timedOut: true })), /did not respond in time\. The draft may still have been saved/);
  assert.match(draft.describeWriteError(new TypeError("Failed to fetch")), /Could not reach ArcFX/);
});

// ── Through the real signed write path ─────────────────────────────────────

class MemoryStorage { #v = new Map(); getItem(k) { return this.#v.has(k) ? this.#v.get(k) : null; } setItem(k, v) { this.#v.set(k, String(v)); } removeItem(k) { this.#v.delete(k); } }
class FakeWindow { #l = new Map(); constructor(e) { this.ethereum = e; } addEventListener(t, h) { this.#l.set(t, [...(this.#l.get(t) || []), h]); } dispatchEvent(ev) { for (const h of this.#l.get(ev.type) || []) h(ev); return true; } }

async function openWriter(t, { reject = false, status = 201 } = {}) {
  const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const wallet = { signatures: 0, sendTx: 0 };
  const provider = {
    request: async ({ method }) => {
      if (method === "eth_accounts") return [OWNER];
      if (method === "eth_chainId") return "0x13b2";
      if (method === "personal_sign") {
        wallet.signatures++;
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return "0x" + "11".repeat(65);
      }
      if (/^eth_send|approve/.test(method)) wallet.sendTx++;
      throw new Error(`unexpected ${method}`);
    },
    on() {}, removeListener() {},
  };
  const posts = [];
  globalThis.window = new FakeWindow(provider);
  globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init.body));
    posts.push({ path: new URL(String(input)).pathname, body });
    const payload = status === 201 ? { invoice: { id: "inv_new", number: body.payload.number, status: "draft" } } : { error: status === 409 ? "invoice 123 already exists for this wallet" : status === 401 ? "signature could not be verified" : "amount must be greater than zero" };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  const s = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  t.after(async () => { await s.close(); Object.assign(globalThis, saved); });
  const { arcfxApi } = await s.ssrLoadModule("/src/shared/arcfxApi.ts");
  const { arcfxWallet } = await s.ssrLoadModule("/src/shared/wallet.ts");
  await arcfxWallet.settled();
  return { arcfxApi, wallet, posts };
}

const minimum = { number: "123", amount: "0.01", token: USDC, dueDate: undefined, customerId: undefined, note: undefined, send: false };

test("minimum draft: one signature, one POST, optional fields omitted, no transaction", async (t) => {
  const w = await openWriter(t);
  const result = await w.arcfxApi.createReceivablesInvoice(minimum);
  assert.equal(result.invoice.id, "inv_new");
  assert.equal(w.wallet.signatures, 1);
  assert.equal(w.wallet.sendTx, 0);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].path, "/v1/invoice-records");
  assert.deepEqual(w.posts[0].body.payload, { number: "123", amount: "0.01", token: USDC, send: false });
  assert.equal(w.posts[0].body.wallet.toLowerCase(), OWNER);
});

test("rejected signature sends nothing to ArcFX", async (t) => {
  const w = await openWriter(t, { reject: true });
  await assert.rejects(() => w.arcfxApi.createReceivablesInvoice(minimum), (e) => e.code === 4001);
  assert.equal(w.posts.length, 0);
});

test("401 fails closed: surfaced once, no retry, no second signature", async (t) => {
  const w = await openWriter(t, { status: 401 });
  await assert.rejects(() => w.arcfxApi.createReceivablesInvoice(minimum), (e) => e.status === 401);
  assert.equal(w.posts.length, 1);
  assert.equal(w.wallet.signatures, 1);
});

test("backend 400 and duplicate 409 reach the UI with their reason", async (t) => {
  const bad = await openWriter(t, { status: 400 });
  const e400 = await bad.arcfxApi.createReceivablesInvoice(minimum).catch((e) => e);
  assert.equal(draft.describeWriteError(e400), "ArcFX rejected the draft: amount must be greater than zero.");
});

test("duplicate invoice number is explained", async (t) => {
  const dup = await openWriter(t, { status: 409 });
  const e409 = await dup.arcfxApi.createReceivablesInvoice(minimum).catch((e) => e);
  assert.equal(draft.describeWriteError(e409), "Invoice 123 already exists for this wallet. Choose a different invoice number.");
});

test("the editor submits through a real submit button and never requires customer, due date, or note", () => {
  assert.match(receivablesSource, /const save = submitButton\("Save draft"\)/);
  assert.match(receivablesSource, /b\.type = "submit"/);
  assert.doesNotMatch(receivablesSource, /const save = action\(/, "no form submit control may be a type=button action()");
  assert.match(receivablesSource, /form\.noValidate = true/);
  assert.match(receivablesSource, /createDraftSubmitter/);
  assert.match(receivablesSource, /dueDate: v\.dueDate \|\| undefined/);
  assert.match(receivablesSource, /customerId: v\.customerId \|\| undefined/);
  assert.match(receivablesSource, /send: false/);
});
