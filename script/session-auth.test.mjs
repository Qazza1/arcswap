import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createServer } from "vite";
import { Wallet } from "ethers";

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

const owner = new Wallet("0x" + "31".repeat(32));
const other = new Wallet("0x" + "32".repeat(32));
const storage = new MemoryStorage();
const prompts = [];
const events = new Map();
let activeAddress = owner.address;
let sessionSerial = 0;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function header(init, name) {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

test("tab-scoped owner session survives navigation and leaves Generate Agent Evidence with only mandate signing", async (t) => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalFetch = globalThis.fetch;
  const ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_accounts") return activeAddress ? [activeAddress] : [];
      if (method === "eth_chainId") return "0x4CEF52";
      if (method === "personal_sign") {
        const [message, address] = params;
        prompts.push(message);
        const wallet = address.toLowerCase() === owner.address.toLowerCase() ? owner : other;
        return wallet.signMessage(message);
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
    on: (event, handler) => events.set(event, handler),
  };
  // Node 22 already exposes Web Crypto as a read-only global; older Node
  // releases need the test-local fallback.
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  globalThis.sessionStorage = storage;
  globalThis.window = { ethereum, ARCFX_API_BASE: "https://arcfx.test" };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === "/v1/auth/session") {
      assert.equal(body.payload, null);
      assert.equal(typeof body.signature, "string");
      return response({ sessionToken: `session-${++sessionSerial}`, wallet: activeAddress.toLowerCase(), expiresAt: "2099-08-30T18:00:00.000Z" }, 201);
    }
    if (url.pathname === "/v1/agent-mandates/prepare") {
      assert.match(header(init, "authorization"), /^Bearer session-/);
      return response({ preparationToken: "prepared-token", signingMessage: `ArcFX Agent Mandate\nversion: arcfx.agent-mandate-signature.v1\nprincipal: ${activeAddress.toLowerCase()}\nmandate_id: mandate_test\ndigest: sha256:test` });
    }
    if (url.pathname === "/v1/agent-mandates") {
      assert.equal(header(init, "authorization"), undefined, "the submit request does not carry a generic owner credential");
      assert.deepEqual(Object.keys(body.payload).sort(), ["mandateSignature", "preparationToken"]);
      return response({ mandate: { mandateId: "mandate_test", status: "ACTIVE" }, run: { runId: "run_test", execution: "NOT_SUBMITTED", decision: { outcome: "REQUIRE_APPROVAL", authorizedToExecute: false }, bundle: { bundleId: "sha256:test", verificationState: "VALID" } } }, 201);
    }
    assert.match(header(init, "authorization"), /^Bearer session-/);
    return response({ count: 0, categories: {}, wallet: activeAddress.toLowerCase() });
  };

  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: "custom" });
  try {
    const walletModule = await server.ssrLoadModule("/src/shared/wallet.ts");
    await walletModule.arcfxWallet.restore();
    const first = await server.ssrLoadModule("/src/shared/arcfxApi.ts");
    await first.arcfxApi.get("/v1/customers", "customer read");
    assert.equal(prompts.length, 1, "first authenticated read bootstraps one owner session");
    assert.match(prompts[0], /^ArcFX session create\n/);

    prompts.length = 0;
    const navigated = await server.ssrLoadModule("/src/shared/arcfxApi.ts?navigation=1");
    await navigated.arcfxApi.get("/v1/attribution", "attribution read");
    assert.equal(prompts.length, 0, "the opaque session survives a multi-page navigation");

    const prepared = await first.arcfxApi.prepareAgentMandate("inv_test");
    const mandateSignature = await first.arcfxApi.signAgentMandate(prepared.signingMessage);
    const completed = await first.arcfxApi.submitAgentMandate(prepared.preparationToken, mandateSignature);
    assert.equal(completed.run.execution, "NOT_SUBMITTED");
    assert.equal(prompts.length, 1, "existing owner session leaves one wallet prompt");
    assert.match(prompts[0], /^ArcFX Agent Mandate\nversion: arcfx\.agent-mandate-signature\.v1\n/);

    first.arcfxApi.clearAuthCache();
    prompts.length = 0;
    const freshPrepared = await first.arcfxApi.prepareAgentMandate("inv_test");
    await first.arcfxApi.submitAgentMandate(freshPrepared.preparationToken, await first.arcfxApi.signAgentMandate(freshPrepared.signingMessage));
    assert.equal(prompts.length, 2, "fresh session is bootstrap plus the meaningful mandate signature");
    assert.match(prompts[0], /^ArcFX session create\n/);
    assert.match(prompts[1], /^ArcFX Agent Mandate\n/);

    const persisted = storage.getItem("arcfx:owner-session:v1");
    assert.ok(persisted);
    assert.equal(persisted.includes(prompts[0]), false, "no raw wallet signature is persisted");
    assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ["expiresAt", "sessionToken", "wallet"]);

    await events.get("accountsChanged")([other.address]);
    assert.equal(storage.getItem("arcfx:owner-session:v1"), null, "account changes clear the owner session");
    await events.get("accountsChanged")([owner.address]);
    await first.arcfxApi.get("/v1/customers", "customer read");
    assert.ok(storage.getItem("arcfx:owner-session:v1"));
    await events.get("accountsChanged")([]);
    assert.equal(storage.getItem("arcfx:owner-session:v1"), null, "disconnect clears the owner session");

    activeAddress = owner.address;
    await events.get("accountsChanged")([owner.address]);
    storage.setItem("arcfx:owner-session:v1", JSON.stringify({ sessionToken: "expired", wallet: owner.address.toLowerCase(), expiresAt: "2000-08-30T11:59:59.000Z" }));
    prompts.length = 0;
    await first.arcfxApi.get("/v1/customers", "customer read");
    assert.equal(prompts.length, 1, "expired session is cleared and re-bootstrapped");

    const invoicePage = fs.readFileSync(new URL("../invoices.html", import.meta.url), "utf8");
    assert.match(invoicePage, /const result = submitted\.run;/);
    assert.doesNotMatch(invoicePage, /createAgentRun\(id, submitted\.mandate\.mandateId\)/);
  } finally {
    await server.close();
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.fetch = originalFetch;
  }
});
