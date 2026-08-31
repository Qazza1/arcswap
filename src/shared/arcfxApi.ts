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

/**
 * Backend origin. Production by default; `window.ARCFX_API_BASE` overrides it so
 * the static frontend can be pointed at a locally running backend without a
 * build flag. Read once at module load, so it cannot be swapped mid-session.
 */
export const API_BASE: string =
  (typeof window !== "undefined" && (window as any).ARCFX_API_BASE) ||
  "https://arcfx-backend-production.up.railway.app";

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

const OWNER_SESSION_STORAGE_KEY = "arcfx:owner-session:v1";

interface OwnerSession {
  sessionToken: string;
  wallet: string;
  expiresAt: string;
}

function browserStorage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

/** Never persist a wallet signature. Only this opaque server-issued bearer is tab-scoped. */
function storedOwnerSession(): OwnerSession | null {
  const wallet = arcfxWallet.address?.toLowerCase();
  if (!wallet) return null;
  try {
    const raw = browserStorage()?.getItem(OWNER_SESSION_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.sessionToken !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.sessionToken)
        || typeof value.wallet !== "string" || value.wallet.toLowerCase() !== wallet
        || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.now() >= Date.parse(value.expiresAt)) {
      clearAuthCache();
      return null;
    }
    return { sessionToken: value.sessionToken, wallet, expiresAt: value.expiresAt };
  } catch {
    clearAuthCache();
    return null;
  }
}

/** Drop the opaque owner session on account, chain, expiry, or authentication failure. */
export function clearAuthCache(): void {
  try { browserStorage()?.removeItem(OWNER_SESSION_STORAGE_KEY); } catch { /* private mode */ }
}

let ownerSessionPending: Promise<OwnerSession> | null = null;

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
  const session: OwnerSession = { sessionToken: result.sessionToken, wallet, expiresAt: result.expiresAt };
  try { browserStorage()?.setItem(OWNER_SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { /* tab still works */ }
  return session;
}

async function ownerSession(): Promise<OwnerSession> {
  const existing = storedOwnerSession();
  if (existing) return existing;
  if (!ownerSessionPending) {
    ownerSessionPending = bootstrapOwnerSession().finally(() => { ownerSessionPending = null; });
  }
  return ownerSessionPending;
}

// Do not discard a valid tab session during the initial silent wallet restore.
// After an address was observed, disconnects and account changes clear it. A
// known non-Arc chain also clears it so a token cannot survive a context switch.
let lastSeenAddress: string | null = arcfxWallet.address?.toLowerCase() || null;
arcfxWallet.onChange((state) => {
  const nextAddress = state.address?.toLowerCase() || null;
  if (nextAddress !== lastSeenAddress) {
    const saved = (() => { try { return browserStorage()?.getItem(OWNER_SESSION_STORAGE_KEY); } catch { return null; } })();
    if (lastSeenAddress !== null || (nextAddress !== null && !saved)) clearAuthCache();
    lastSeenAddress = nextAddress;
  }
  if (state.chainId && !state.onArc) clearAuthCache();
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
  try {
    return await parse(await fetch(`${API_BASE}${path}?${qs}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }));
  } catch (error) {
    if (retry && error instanceof ApiError && error.status === 401) {
      clearAuthCache();
      return get(path, _action, params, false);
    }
    throw error;
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
  get, post, publicGet, digestOf, messageFor, clearAuthCache,

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
};

if (typeof window !== "undefined") (window as any).arcfxApi = arcfxApi;
