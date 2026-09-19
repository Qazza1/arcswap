/**
 * Client for the wallet-authenticated ArcFX API.
 *
 * The backend has no accounts. A wallet first proves it owns its records with a
 * short-lived signed bootstrap request. The opaque, server-authenticated owner
 * session then covers approved reads in this browser tab; ordinary writes still
 * require a distinct signed request.
 *
 * The canonical form below MUST stay byte-identical to `canonical()` in the
 * backend's src/walletauth.ts — a digest that disagrees produces a 403 that
 * looks like a signing bug and is miserable to trace. There is a test that
 * compares the two implementations directly.
 *
 *   import { arcfxApi } from '/src/shared/arcfxApi.ts';
 *   const { invoices } = await arcfxApi.get('/v1/invoice-records', 'invoice read');
 *   await arcfxApi.post('/v1/invoice-records', 'invoice write', { number: 'INV-001' });
 */

import { arcfxWallet } from "./wallet";
import { arcfxAuth, type OwnerSession } from "./auth";

/**
 * Backend origin. Production by default; `window.ARCFX_API_BASE` overrides it so
 * the static frontend can be pointed at a locally running backend without a
 * build flag. Read once at module load, so it cannot be swapped mid-session.
 */
export const API_BASE: string =
  (typeof window !== "undefined" && (window as any).ARCFX_API_BASE) ||
  "https://arcfx-backend-production.up.railway.app";

// The established ArcFX session helper is deliberately Testnet-gated because
// legacy payer surfaces still use the Testnet wallet/transaction layer. The
// Mainnet receivables workspace has a separate, exact-chain owner-read session
// so enabling server-authorized records cannot make those payer paths Mainnet
// capable.
const ARCFX_MAINNET_CHAIN_ID_HEX = "0x13b2";
const RECEIVABLES_OWNER_SESSION_STORAGE_KEY = "arcfx:mainnet-receivables-owner-session:v1";

/** Sorted-key rendering. Mirrors canonical() in the backend's walletauth.ts. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort()
    .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
    .join(",") + "}";
}

/**
 * Drop keys whose value is undefined, recursively.
 *
 * This has to happen BEFORE both the digest and the request body, because the
 * two disagree about undefined: canonical() sees the key via Object.keys and
 * encodes it as null, while JSON.stringify omits it entirely. The client then
 * signs `{a, b, c:null}` and the server receives `{a, b}` — different digests,
 * and a 403 that reads like a wallet fault.
 *
 * It is a natural thing for a caller to write: `customerId: id || undefined`.
 * Normalising here means no caller has to know.
 */
function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as unknown as T;
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    out[k] = stripUndefined(val);
  }
  return out as T;
}

export async function digestOf(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(payload));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function messageFor(action: string, wallet: string, digest: string, ts: number): string {
  return [
    `ArcFX ${action}`,
    `wallet: ${wallet.toLowerCase()}`,
    `digest: ${digest}`,
    `ts: ${ts}`,
  ].join("\n");
}

async function sign(message: string): Promise<string> {
  // `arcfxWallet` owns provider selection. Reading window.ethereum here could
  // sign with a different extension after an EIP-6963 injection race.
  return arcfxWallet.signMessage(message);
}

/** Sign the server-prepared Agent Mandate message; never a transaction. */
async function signMandate(message: string): Promise<string> {
  if (!String(message).startsWith("ArcFX Agent Mandate\nversion: arcfx.agent-mandate-signature.v1\n")) {
    throw new Error("The server returned an invalid Agent Mandate message.");
  }
  return sign(message);
}

/** Drop the opaque owner session on account, chain, expiry, or authentication failure. */
export function clearAuthCache(): void { arcfxAuth.clearAuthCache(); }

async function signedPost(path: string, action: string, payload: unknown): Promise<any> {
  const wallet = arcfxWallet.address;
  if (!wallet) throw new Error("Connect your wallet first.");
  const ts = Date.now();
  const clean = stripUndefined(payload ?? null);
  const digest = await digestOf(clean);
  const signature = await sign(messageFor(action, wallet, digest, ts));
  return parse(await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, ts, signature, payload: clean }),
  }));
}

async function bootstrapOwnerSession(): Promise<OwnerSession> {
  const wallet = arcfxWallet.address?.toLowerCase();
  if (!wallet) throw new Error("Connect your wallet first.");
  const result = await signedPost("/v1/auth/session", "session create", null);
  if (!result || typeof result.sessionToken !== "string" || typeof result.wallet !== "string"
      || result.wallet.toLowerCase() !== wallet || typeof result.expiresAt !== "string"
      || !Number.isFinite(Date.parse(result.expiresAt)) || Date.now() >= Date.parse(result.expiresAt)) {
    throw new Error("The server returned an invalid owner session.");
  }
  return { sessionToken: result.sessionToken, wallet, expiresAt: result.expiresAt };
}

async function ownerSession(): Promise<OwnerSession> {
  // This gates all protected reads behind silent provider restoration and
  // shares a single session-create signature when a page starts several reads.
  return arcfxAuth.ensureOwnerSession(bootstrapOwnerSession);
}

type ReceivablesOwnerSession = OwnerSession & { chainId: string };
let receivablesBootstrapPending: Promise<ReceivablesOwnerSession> | null = null;
let receivablesReadyPending: Promise<boolean> | null = null;
let receivablesReadyResolved = false;
let receivablesReconciliationPending: Promise<void> | null = null;

function mainnetReceivablesWallet(): { wallet: string; chainId: string } {
  const wallet = arcfxWallet.address?.toLowerCase();
  const chainId = arcfxWallet.chainId?.toLowerCase();
  if (!arcfxWallet.connected || !wallet || chainId !== ARCFX_MAINNET_CHAIN_ID_HEX || arcfxWallet.isExplicitlySignedOut) {
    throw new Error("Connect the selected wallet on Arc Mainnet (chain 5042) first.");
  }
  return { wallet, chainId };
}

function clearReceivablesAuthCache(): void {
  receivablesBootstrapPending = null;
  try { sessionStorage.removeItem(RECEIVABLES_OWNER_SESSION_STORAGE_KEY); } catch { /* private mode */ }
}

function storedReceivablesOwnerSession(): ReceivablesOwnerSession | null {
  try {
    const expected = mainnetReceivablesWallet();
    const raw = sessionStorage.getItem(RECEIVABLES_OWNER_SESSION_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.sessionToken !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.sessionToken)
        || typeof value.wallet !== "string" || value.wallet.toLowerCase() !== expected.wallet
        || value.chainId !== ARCFX_MAINNET_CHAIN_ID_HEX || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.expiresAt)) || Date.now() >= Date.parse(value.expiresAt)) {
      clearReceivablesAuthCache();
      return null;
    }
    return { sessionToken: value.sessionToken, wallet: expected.wallet, chainId: expected.chainId, expiresAt: value.expiresAt };
  } catch {
    clearReceivablesAuthCache();
    return null;
  }
}

/**
 * A new app-origin document starts with an intentionally untrusted wallet
 * snapshot while its pinned EIP-6963 provider is restored. Do not compare or
 * delete the tab-scoped bearer until that silent restore has settled. This is
 * the Mainnet receivables equivalent of arcfxAuth.ready().
 */
async function receivablesSessionReady(): Promise<boolean> {
  if (receivablesReadyPending) return receivablesReadyPending;
  const pending = (async () => {
    await arcfxWallet.restore();
    receivablesReadyResolved = true;
    return Boolean(storedReceivablesOwnerSession());
  })();
  receivablesReadyPending = pending;
  try { return await pending; }
  finally { if (receivablesReadyPending === pending) receivablesReadyPending = null; }
}

/** Reconcile only a settled selected-provider snapshot; restore joins an in-flight event refresh. */
function reconcileReceivablesSessionAfterWalletChange(): void {
  if (!receivablesReadyResolved || receivablesReconciliationPending) return;
  // Defer the restore by one microtask so an explicit Disconnect's synchronous
  // wallet emit sees this pending guard before it can re-enter reconciliation.
  const pending = Promise.resolve().then(async () => {
    await arcfxWallet.restore();
    if (receivablesReadyResolved) storedReceivablesOwnerSession();
  });
  receivablesReconciliationPending = pending;
  pending.finally(() => {
    if (receivablesReconciliationPending === pending) receivablesReconciliationPending = null;
  }).catch(() => { clearReceivablesAuthCache(); });
}

async function receivablesOwnerSession(): Promise<ReceivablesOwnerSession> {
  await receivablesSessionReady();
  const existing = storedReceivablesOwnerSession();
  if (existing) return existing;
  if (!receivablesBootstrapPending) {
    const expected = mainnetReceivablesWallet();
    const pending = bootstrapOwnerSession().then((session) => {
      const current = mainnetReceivablesWallet();
      if (current.wallet !== expected.wallet || current.chainId !== expected.chainId || session.wallet.toLowerCase() !== expected.wallet) {
        throw new Error("ArcFX authentication was cancelled because the wallet or network changed.");
      }
      const result: ReceivablesOwnerSession = { ...session, wallet: expected.wallet, chainId: expected.chainId };
      try { sessionStorage.setItem(RECEIVABLES_OWNER_SESSION_STORAGE_KEY, JSON.stringify(result)); } catch { /* tab still works */ }
      return result;
    });
    receivablesBootstrapPending = pending;
    pending.finally(() => { if (receivablesBootstrapPending === pending) receivablesBootstrapPending = null; }).catch(() => { /* caller receives it */ });
  }
  return receivablesBootstrapPending;
}

function assertSameReceivablesWallet(expected: { wallet: string; chainId: string }): void {
  const current = mainnetReceivablesWallet();
  if (current.wallet !== expected.wallet || current.chainId !== expected.chainId) {
    throw new Error("Wallet or network changed while processing the request.");
  }
}

async function receivablesGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const session = await receivablesOwnerSession();
  const expected = { wallet: session.wallet, chainId: session.chainId };
  const qs = new URLSearchParams(params);
  try {
    const result = await parse(await fetch(`${API_BASE}${path}?${qs}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }));
    assertSameReceivablesWallet(expected);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearReceivablesAuthCache();
    }
    throw error;
  }
}

async function receivablesPost(path: string, action: string, payload: unknown): Promise<any> {
  const expected = mainnetReceivablesWallet();
  const result = await signedPost(path, action, payload);
  assertSameReceivablesWallet(expected);
  return result;
}

async function connectReceivablesOwner(): Promise<void> {
  await arcfxWallet.connectCurrentNetwork();
  await receivablesOwnerSession();
}

/** Read-only UI hint; it waits for a silent restore and never exposes the bearer. */
  async function hasReceivablesOwnerSession(): Promise<boolean> {
    try { return await receivablesSessionReady(); }
    catch { return false; }
  }

  /** Settled, signature-free readiness shared by every Mainnet workspace page. */
  async function receivablesReadiness(): Promise<"AUTHENTICATED" | "DISCONNECTED" | "WRONG_NETWORK" | "CONNECTED_NOT_AUTHENTICATED" | "API_ERROR"> {
    try {
      const authenticated = await receivablesSessionReady();
      if (arcfxWallet.isExplicitlySignedOut || !arcfxWallet.connected || !arcfxWallet.address) return "DISCONNECTED";
      if (arcfxWallet.chainId?.toLowerCase() !== ARCFX_MAINNET_CHAIN_ID_HEX) return "WRONG_NETWORK";
      return authenticated ? "AUTHENTICATED" : "CONNECTED_NOT_AUTHENTICATED";
    } catch {
      return "API_ERROR";
    }
  }

arcfxWallet.onChange(() => {
  reconcileReceivablesSessionAfterWalletChange();
});

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

/** Authenticated owner GET. The action is retained for page-call compatibility. */
async function get(path: string, _action: string, params: Record<string, string> = {}, retry = true): Promise<any> {
  const session = await ownerSession();
  const qs = new URLSearchParams(params);
  const read = arcfxAuth.beginOwnerRead();
  try {
    const result = await parse(await fetch(`${API_BASE}${path}?${qs}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
      signal: read.signal,
    }));
    if (!arcfxAuth.isCurrentGeneration(read.generation)) {
      throw new Error("Owner session changed while loading data.");
    }
    return result;
  } catch (error) {
    if (retry && error instanceof ApiError && error.status === 401) {
      clearAuthCache();
      return get(path, _action, params, false);
    }
    throw error;
  } finally {
    read.finish();
  }
}

/**
 * Authenticated POST. Each write is signed separately — a write is a distinct
 * authorisation and the server only allows a 10 minute window, so these are
 * never cached.
 */
async function post(path: string, action: string, payload: unknown): Promise<any> {
  return signedPost(path, action, payload);
}

/** Narrow session-authorized POST for endpoints that explicitly opt in server-side. */
async function sessionPost(path: string, payload: unknown, retry = true): Promise<any> {
  const session = await ownerSession();
  const clean = stripUndefined(payload ?? null);
  try {
    return await parse(await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ payload: clean }),
    }));
  } catch (error) {
    if (retry && error instanceof ApiError && error.status === 401) {
      clearAuthCache();
      return sessionPost(path, payload, false);
    }
    throw error;
  }
}

/** Explicit owner connection: one wallet connect followed by one shared owner session. */
async function connectOwner(): Promise<void> {
  await arcfxWallet.connect();
  await ownerSession();
}

/** The mandate itself is the authorization; this sends no generic wallet credential. */
async function mandatePost(path: string, payload: unknown): Promise<any> {
  const clean = stripUndefined(payload ?? null);
  return parse(await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: clean }),
  }));
}

/** Unauthenticated GET, for the payer-facing endpoints. */
async function publicGet(path: string): Promise<any> {
  return parse(await fetch(`${API_BASE}${path}`));
}

export const arcfxApi = {
  base: API_BASE,
  get, post, publicGet, digestOf, messageFor, clearAuthCache, connectOwner, connectReceivablesOwner, hasReceivablesOwnerSession, receivablesReadiness,

  // ── Convenience wrappers, so pages do not repeat action strings ──────────
  listCustomers: (opts: { archived?: boolean } = {}) =>
    get("/v1/customers", "customer read", opts.archived ? { archived: "true" } : {}),
  saveCustomer: (customer: unknown) => post("/v1/customers", "customer write", customer),
  archiveCustomer: (id: string, archived = true) =>
    post("/v1/customers/archive", "customer archive", { id, archived }),
  customerByAddress: (address: string) =>
    get("/v1/customers/by-address", "customer read", { address }),

  listInvoices: (status?: string) =>
    get("/v1/invoice-records", "invoice read", status ? { status } : {}),
  createInvoice: (invoice: unknown) => post("/v1/invoice-records", "invoice write", invoice),
  updateInvoice: (payload: unknown) => post("/v1/invoice-records/update", "invoice update", payload),
  reconcile: (id?: string) => post("/v1/invoice-records/reconcile", "invoice reconcile", id ? { id } : {}),
  publicInvoice: (id: string) => publicGet(`/v1/invoice-records/public/${encodeURIComponent(id)}`),

  prepareAgentMandate: (invoiceId: string) =>
    sessionPost("/v1/agent-mandates/prepare", { invoiceId }),
  submitAgentMandate: (preparationToken: string, mandateSignature: string) =>
    mandatePost("/v1/agent-mandates", { preparationToken, mandateSignature }),
  createAgentRun: (invoiceId: string, mandateId: string) =>
    post("/v1/agent-runs", "agent run create", { invoiceId, mandateId }),
  // This remains owner-scoped on the backend. The sealed proof is retrieved
  // only after the run exists and is never placed in a URL or public endpoint.
  sealedAgentEvidenceBundle: (runId: string) =>
    get(`/v1/agent-evidence/${encodeURIComponent(runId)}/bundle/sealed`, "agent evidence read"),
  signAgentMandate: signMandate,

  /**
   * Every settlement against an invoice number, with transaction hashes.
   * The record endpoints report totals; this one lists the individual payments,
   * which is what a receipt has to cite.
   */
  invoiceSettlements: (number: string, recipient: string, expected?: string | null) => {
    const q = new URLSearchParams({ number, recipient });
    if (expected) q.set("expected", expected);
    return publicGet(`/v1/invoices/status?${q.toString()}`);
  },

  // Mainnet receivables: exact-chain owner reads reuse a tab-scoped bearer;
  // every mutation remains an individual EIP-191 personal_sign authorization.
  listReceivablesCustomers: (opts: { archived?: boolean } = {}) =>
    receivablesGet("/v1/customers", opts.archived ? { archived: "true" } : {}),
  saveReceivablesCustomer: (customer: unknown) => receivablesPost("/v1/customers", "customer write", customer),
  archiveReceivablesCustomer: (id: string, archived = true) =>
    receivablesPost("/v1/customers/archive", "customer archive", { id, archived }),
  listReceivablesInvoices: (status?: string) =>
    receivablesGet("/v1/invoice-records", status ? { status } : {}),
  getReceivablesDashboard: () => receivablesGet("/v1/dashboard"),
  createReceivablesInvoice: (invoice: unknown) =>
    receivablesPost("/v1/invoice-records", "invoice write", invoice),
  updateReceivablesInvoice: (payload: unknown) =>
    receivablesPost("/v1/invoice-records/update", "invoice update", payload),
  reconcileReceivables: (id?: string) =>
    receivablesPost("/v1/invoice-records/reconcile", "invoice reconcile", id ? { id } : {}),
};

if (typeof window !== "undefined") (window as any).arcfxApi = arcfxApi;
