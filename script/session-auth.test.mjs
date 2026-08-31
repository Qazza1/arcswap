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

class FakeWindow {
  #listeners = new Map();
  constructor(ethereum) { this.ethereum = ethereum; }
  addEventListener(type, handler) {
    const handlers = this.#listeners.get(type) || [];
    handlers.push(handler);
    this.#listeners.set(type, handlers);
  }
  dispatchEvent(event) {
    for (const handler of this.#listeners.get(event.type) || []) handler(event);
    return true;
  }
}

function announcedWindow(fallback, announced) {
  const win = new FakeWindow(fallback);
  win.addEventListener("eip6963:requestProvider", () => {
    for (const detail of announced) win.dispatchEvent({ type: "eip6963:announceProvider", detail });
  });
  return win;
}

function mockProvider(address, prompts) {
  const handlers = new Map();
  return {
    request: async ({ method, params }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x4CEF52";
      if (method === "personal_sign") {
        prompts.push({ address: params[1].toLowerCase(), message: params[0] });
        const signer = params[1].toLowerCase() === owner.address.toLowerCase() ? owner : other;
        return signer.signMessage(params[0]);
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
    on: (event, handler) => {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeListener: (event, handler) => {
      handlers.set(event, (handlers.get(event) || []).filter((candidate) => candidate !== handler));
    },
    emit: async (event, value) => {
      for (const handler of handlers.get(event) || []) await handler(value);
    },
  };
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

  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
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

test("EIP-6963 keeps the selected provider across full document navigation despite window.ethereum races", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const local = new MemoryStorage();
  const providerPrompts = [];
  const providerA = mockProvider(owner.address, providerPrompts);
  const providerB = mockProvider(other.address, providerPrompts);
  const A = { info: { uuid: "a-1", name: "MetaMask", rdns: "io.metamask" }, provider: providerA };
  const B = { info: { uuid: "b-1", name: "Backpack", rdns: "app.backpack" }, provider: providerB };
  let sessionSerial = 0;

  globalThis.sessionStorage = storage;
  globalThis.localStorage = local;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/session") {
      return response({
        sessionToken: `v1.iv_${++sessionSerial}.ciphertext.tag`,
        wallet: owner.address.toLowerCase(),
        expiresAt: "2099-08-30T18:00:00.000Z",
      }, 201);
    }
    assert.match(header(init, "authorization"), /^Bearer v1\./);
    return response({ invoices: [], outstandingByToken: {}, categories: {} });
  };

  async function documentNavigation(path, fallback, order) {
    globalThis.window = announcedWindow(fallback, order);
    globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
    const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
    try {
      // New dev server = new Vite module graph, which models a fresh document
      // rather than re-importing arcfxApi in the old JavaScript context.
      const api = await server.ssrLoadModule("/src/shared/arcfxApi.ts");
      const walletModule = await server.ssrLoadModule("/src/shared/wallet.ts");
      await walletModule.arcfxWallet.restore();
      assert.equal(walletModule.arcfxWallet.provider, providerA, "the owner-matching selected provider wins over window.ethereum");
      await api.arcfxApi.get(path, "owner read");
      return { api, walletModule };
    } finally {
      await server.close();
    }
  }

  try {
    // This non-secret preference represents the explicit choice made through
    // the small wallet picker before the fresh tab starts.
    local.setItem("arcfx:wallet-provider-preference:v1", JSON.stringify({ rdns: "io.metamask", name: "MetaMask" }));

    const first = await documentNavigation("/v1/invoice-records", providerB, [A, B]);
    assert.equal(providerPrompts.length, 1);
    assert.match(providerPrompts[0].message, /^ArcFX session create\n/);
    assert.equal(providerPrompts[0].address, owner.address.toLowerCase());
    assert.ok(storage.getItem("arcfx:owner-session:v1"), "the opaque bearer is present after the first document");

    // An unrelated extension cannot mutate the selected-provider state or
    // delete the owner bearer merely by emitting its own event.
    await providerB.emit("accountsChanged", [other.address]);
    assert.ok(storage.getItem("arcfx:owner-session:v1"), "non-selected provider events do not clear the session");
    assert.equal(first.walletModule.arcfxWallet.address, owner.address);

    await documentNavigation("/v1/attribution", providerA, [B, A]);
    await documentNavigation("/v1/categories", providerB, [B, A]);
    await documentNavigation("/v1/invoice-records", providerB, [A, B]);
    assert.equal(providerPrompts.length, 1, "Invoices → History/Attribution → Invoices creates one session signature total");

    // A confirmed selected-provider account change remains a real security
    // transition and therefore clears the bearer and requires re-authentication.
    await providerA.emit("accountsChanged", [other.address]);
    assert.equal(storage.getItem("arcfx:owner-session:v1"), null, "selected wallet account changes clear the owner session");
  } finally {
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
  }
});

test("universal owner auth survives navigation, supports real ArcFX disconnect, and re-authenticates only after reconnect", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const local = new MemoryStorage();
  const prompts = [];
  const calls = [];
  let selectedAddress = owner.address;
  let serial = 0;
  let documentSerial = 0;
  const provider = mockProvider(owner.address, prompts);
  const originalRequest = provider.request;
  provider.request = async (args) => {
    calls.push(args.method);
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return [selectedAddress];
    if (args.method === "personal_sign") {
      prompts.push({ address: args.params[1].toLowerCase(), message: args.params[0] });
      const signer = args.params[1].toLowerCase() === owner.address.toLowerCase() ? owner : other;
      return signer.signMessage(args.params[0]);
    }
    return originalRequest(args);
  };
  const announcement = { info: { uuid: "owner", name: "Owner wallet", rdns: "io.owner" }, provider };

  globalThis.sessionStorage = storage;
  globalThis.localStorage = local;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === "/v1/auth/session") {
      assert.equal(body.payload, null);
      return response({
        sessionToken: `v1.iv_${++serial}.ciphertext.tag`,
        wallet: selectedAddress.toLowerCase(),
        expiresAt: "2099-08-30T18:00:00.000Z",
      }, 201);
    }
    if (url.pathname === "/v1/agent-mandates/prepare") {
      assert.match(header(init, "authorization"), /^Bearer v1\./);
      return response({
        preparationToken: "prepared-token",
        signingMessage: `ArcFX Agent Mandate\nversion: arcfx.agent-mandate-signature.v1\nprincipal: ${selectedAddress.toLowerCase()}\nmandate_id: mandate_test\ndigest: sha256:test`,
      });
    }
    if (url.pathname === "/v1/agent-mandates") {
      assert.equal(header(init, "authorization"), undefined);
      return response({ run: { execution: "NOT_SUBMITTED", decision: { outcome: "REQUIRE_APPROVAL" }, bundle: { verificationState: "VALID" } } }, 201);
    }
    assert.match(header(init, "authorization"), /^Bearer v1\./);
    return response({ wallet: selectedAddress.toLowerCase(), invoices: [], categories: {}, customers: [] });
  };

  async function newDocument() {
    globalThis.window = announcedWindow(provider, [announcement]);
    globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
    const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const api = await server.ssrLoadModule(`/src/shared/arcfxApi.ts?navigation=universal-${++documentSerial}`);
    const auth = await server.ssrLoadModule("/src/shared/auth.ts");
    const walletModule = await server.ssrLoadModule("/src/shared/wallet.ts");
    return { server, api, auth, walletModule };
  }

  try {
    const first = await newDocument();
    await first.api.arcfxApi.connectOwner();
    assert.equal(first.auth.arcfxAuth.status, "AUTHENTICATED");
    assert.equal(prompts.filter((p) => /^ArcFX session create\n/.test(p.message)).length, 1);
    await first.api.arcfxApi.get("/v1/invoice-records", "invoice read");
    await first.api.arcfxApi.get("/v1/attribution", "attribution read");
    await first.api.arcfxApi.get("/v1/customers", "customer read");
    await first.api.arcfxApi.get("/v1/categories", "category read");
    assert.equal(prompts.length, 1, "all normal owner reads reuse one opaque bearer");
    await first.server.close();

    const second = await newDocument();
    await second.api.arcfxApi.get("/v1/invoice-records", "invoice read");
    await second.api.arcfxApi.get("/v1/attribution", "attribution read");
    assert.equal(prompts.length, 1, "refresh/navigation with a valid session signs nothing");

    second.auth.arcfxAuth.disconnect();
    assert.equal(storage.getItem("arcfx:owner-session:v1"), null, "disconnect clears the bearer");
    assert.equal(storage.getItem("arcfx:owner-signed-out:v1"), "1", "disconnect records only a non-secret signed-out marker");
    assert.equal(second.walletModule.arcfxWallet.connected, false, "disconnect resets the visible wallet state");
    await second.server.close();

    calls.length = 0;
    const signedOut = await newDocument();
    await signedOut.auth.arcfxAuth.ready();
    assert.equal(signedOut.auth.arcfxAuth.status, "DISCONNECTED");
    assert.equal(calls.includes("eth_accounts"), false, "an explicit sign-out prevents silent wallet restoration on the next document");
    await assert.rejects(() => signedOut.api.arcfxApi.get("/v1/invoice-records", "invoice read"), /Connect your wallet first/);
    assert.equal(prompts.length, 1, "signed-out navigation cannot create a login signature");

    await signedOut.api.arcfxApi.connectOwner();
    assert.equal(storage.getItem("arcfx:owner-signed-out:v1"), null, "an explicit reconnect clears the local marker");
    assert.equal(prompts.filter((p) => /^ArcFX session create\n/.test(p.message)).length, 2, "reconnect creates exactly one fresh owner session");

    selectedAddress = other.address;
    await provider.emit("accountsChanged", [other.address]);
    assert.equal(storage.getItem("arcfx:owner-session:v1"), null, "account A → B invalidates A's bearer");
    await signedOut.api.arcfxApi.get("/v1/customers", "customer read");
    assert.equal(prompts.filter((p) => /^ArcFX session create\n/.test(p.message)).length, 3, "account B gets one fresh owner session when it needs owner data");
    assert.equal(prompts.at(-1).address, other.address.toLowerCase());

    const prepared = await signedOut.api.arcfxApi.prepareAgentMandate("inv_test");
    await signedOut.api.arcfxApi.submitAgentMandate(prepared.preparationToken, await signedOut.api.arcfxApi.signAgentMandate(prepared.signingMessage));
    const mandatePrompts = prompts.filter((p) => /^ArcFX Agent Mandate\n/.test(p.message));
    assert.equal(mandatePrompts.length, 1, "Agent Evidence adds exactly the separate Agent Mandate signature");
    assert.equal(prompts.filter((p) => /^ArcFX session create\n/.test(p.message)).length, 3, "Agent Evidence does not reauthenticate a valid owner session");

    const headerSource = fs.readFileSync(new URL("../src/shared/header.ts", import.meta.url), "utf8");
    assert.match(headerSource, /arcfx-account-menu/);
    assert.match(headerSource, /arcfx-disconnect-btn/);
    assert.match(headerSource, /arcfxAuth\.disconnect\(\)/);
    await signedOut.server.close();
  } finally {
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
  }
});

test("late EIP-6963 announcements cannot replace a pinned provider or affect its wallet state", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const storage = new MemoryStorage();
  const local = new MemoryStorage();
  const prompts = [];
  const ownerSession = JSON.stringify({
    sessionToken: "session-owner",
    wallet: owner.address.toLowerCase(),
    expiresAt: "2099-08-30T18:00:00.000Z",
  });
  storage.setItem("arcfx:owner-session:v1", ownerSession);
  const fallback = mockProvider(owner.address, prompts);
  const late = mockProvider(other.address, prompts);
  const win = new FakeWindow(fallback);
  win.ARCFX_API_BASE = "https://arcfx.test";

  globalThis.window = win;
  globalThis.sessionStorage = storage;
  globalThis.localStorage = local;
  globalThis.document = undefined;
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const walletModule = await server.ssrLoadModule("/src/shared/wallet.ts?late-provider=1");
    await walletModule.arcfxWallet.restore();
    assert.equal(walletModule.arcfxWallet.provider, fallback, "the fallback provider is initially selected");

    win.dispatchEvent({
      type: "eip6963:announceProvider",
      detail: { info: { uuid: "late", name: "Late wallet", rdns: "io.late" }, provider: late },
    });
    await walletModule.arcfxWallet.restore();
    assert.equal(walletModule.arcfxWallet.provider, fallback, "late provider cannot replace the exact pinned fallback object");

    await walletModule.arcfxWallet.signMessage("ArcFX provider pin regression");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].address, owner.address.toLowerCase(), "personal_sign remains on the selected fallback");

    await late.emit("accountsChanged", [other.address]);
    await late.emit("chainChanged", "0x1");
    assert.equal(walletModule.arcfxWallet.provider, fallback, "late non-selected provider events are ignored");
    assert.equal(walletModule.arcfxWallet.address, owner.address, "late non-selected provider events cannot change wallet state");
    assert.equal(storage.getItem("arcfx:owner-session:v1"), ownerSession, "late non-selected provider events cannot disturb the owner session");
  } finally {
    await server.close();
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.localStorage = originalLocalStorage;
    globalThis.document = originalDocument;
  }
});

test("a late restore cannot revive a wallet after explicit ArcFX Disconnect", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const prompts = [];
  const provider = mockProvider(owner.address, prompts);
  let releaseAccounts;
  const accountsStarted = new Promise((resolve) => { releaseAccounts = resolve; });
  const delayedProvider = {
    ...provider,
    request: async (args) => {
      if (args.method === "eth_accounts") {
        releaseAccounts();
        return new Promise((resolve) => { delayedProvider.resolveAccounts = resolve; });
      }
      return provider.request(args);
    },
  };
  const storage = new MemoryStorage();
  const local = new MemoryStorage();
  const win = new FakeWindow(delayedProvider);
  win.ARCFX_API_BASE = "https://arcfx.test";

  globalThis.window = win;
  globalThis.sessionStorage = storage;
  globalThis.localStorage = local;
  globalThis.document = undefined;
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const walletModule = await server.ssrLoadModule("/src/shared/wallet.ts?restore-disconnect-race=1");
    const restoring = walletModule.arcfxWallet.restore();
    await accountsStarted;
    walletModule.arcfxWallet.disconnect();
    delayedProvider.resolveAccounts([owner.address]);
    await restoring;
    assert.equal(walletModule.arcfxWallet.connected, false, "an older restore cannot repaint the disconnected wallet");
    assert.equal(walletModule.arcfxWallet.address, null);
    assert.equal(walletModule.arcfxWallet.provider, null, "Disconnect remains the selected-provider boundary");
  } finally {
    await server.close();
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.localStorage = originalLocalStorage;
    globalThis.document = originalDocument;
  }
});

test("ambiguous provider identity requires an explicit wallet choice", async (t) => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;

  async function assertAmbiguous({ announcements, preference, label }) {
    const storage = new MemoryStorage();
    const local = new MemoryStorage();
    storage.setItem("arcfx:owner-session:v1", JSON.stringify({
      sessionToken: "v1.iv.test.tag",
      wallet: owner.address.toLowerCase(),
      expiresAt: "2099-08-30T18:00:00.000Z",
    }));
    if (preference) local.setItem("arcfx:wallet-provider-preference:v1", JSON.stringify(preference));
    globalThis.window = announcedWindow(null, announcements);
    globalThis.window.ARCFX_API_BASE = "https://arcfx.test";
    globalThis.sessionStorage = storage;
    globalThis.localStorage = local;
    globalThis.document = undefined;
    const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
    try {
      const walletModule = await server.ssrLoadModule(`/src/shared/wallet.ts?ambiguous=${label}`);
      await walletModule.arcfxWallet.restore();
      assert.equal(walletModule.arcfxWallet.provider, null, `${label}: no announcement-order provider is silently selected`);
      await assert.rejects(
        () => walletModule.arcfxWallet.connect(),
        /Choose a wallet in a browser/,
        `${label}: an explicit wallet picker is required before connection`,
      );
    } finally {
      await server.close();
    }
  }

  try {
    await t.test("duplicate rdns does not break a same-wallet tie", async () => {
      const prompts = [];
      await assertAmbiguous({
        label: "duplicate-rdns",
        preference: { rdns: "io.same", name: "Same wallet" },
        announcements: [
          { info: { uuid: "same-a", name: "Same wallet", rdns: "io.same" }, provider: mockProvider(owner.address, prompts) },
          { info: { uuid: "same-b", name: "Same wallet", rdns: "io.same" }, provider: mockProvider(owner.address, prompts) },
        ],
      });
    });

    await t.test("two providers claiming the stored account do not use announcement order", async () => {
      const prompts = [];
      await assertAmbiguous({
        label: "spoofed-accounts",
        announcements: [
          { info: { uuid: "wallet-a", name: "Wallet A", rdns: "io.wallet-a" }, provider: mockProvider(owner.address, prompts) },
          { info: { uuid: "wallet-b", name: "Wallet B", rdns: "io.wallet-b" }, provider: mockProvider(owner.address, prompts) },
        ],
      });
    });
  } finally {
    globalThis.window = originalWindow;
    globalThis.sessionStorage = originalStorage;
    globalThis.localStorage = originalLocalStorage;
    globalThis.document = originalDocument;
  }
});

test("wallet freshness guards discard delayed dashboard and analytics results after a transition", async () => {
  const originalWindow = globalThis.window;
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { createWalletLoadGuard } = await server.ssrLoadModule("/src/shared/walletLoadGuard.ts");
    const walletA = owner.address;
    const walletB = other.address;

    const dashboard = createWalletLoadGuard();
    dashboard.transition(walletA);
    const dashboardA = dashboard.begin(walletA);
    dashboard.transition(walletB);
    assert.equal(dashboard.isCurrent(dashboardA), false, "dashboard A response is discarded after A → B");
    const dashboardB = dashboard.begin(walletB);
    assert.equal(dashboard.isCurrent(dashboardB), true, "dashboard B response may render");

    const analytics = createWalletLoadGuard();
    analytics.transition(walletA);
    const analyticsA = analytics.begin(walletA);
    analytics.transition(null);
    assert.equal(analytics.isCurrent(analyticsA), false, "analytics A response is discarded after disconnect");
    analytics.transition(walletB);
    const analyticsB = analytics.begin(walletB);
    assert.equal(analytics.isCurrent(analyticsB), true, "analytics B response may render after a new load");

    const dashboardSource = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8");
    const analyticsSource = fs.readFileSync(new URL("../src/analytics.ts", import.meta.url), "utf8");
    assert.match(dashboardSource, /dashboardLoads\.isCurrent\(ticket\)/);
    assert.match(analyticsSource, /breakdownLoads\.isCurrent\(ticket\)/);
  } finally {
    await server.close();
    globalThis.window = originalWindow;
  }
});
