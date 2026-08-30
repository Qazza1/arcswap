/**
 * Client for the wallet-authenticated ArcFX API.
 *
 * The backend has no accounts. A wallet proves it owns its records by signing a
 * message per request, binding the action, the wallet, a digest of the payload
 * and a timestamp. This module is the browser half of that contract.
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
  const eth = (window as any).ethereum;
  const address = arcfxWallet.address;
  if (!eth || !address) throw new Error("Connect your wallet first.");
  // personal_sign takes (message, address). MetaMask accepts a UTF-8 string and
  // applies the EIP-191 prefix, which is what verifyMessage expects server-side.
  return eth.request({ method: "personal_sign", params: [message, address] });
}

/** Sign the server-prepared Agent Mandate message; never a transaction. */
async function signMandate(message: string): Promise<string> {
  if (!String(message).startsWith("ArcFX Agent Mandate\nversion: arcfx.agent-mandate-signature.v1\n")) {
    throw new Error("The server returned an invalid Agent Mandate message.");
  }
  return sign(message);
}

/**
 * Read signatures are valid for 12 hours server-side, so one signature covers a
 * whole session per action. Without this cache the user would get a MetaMask
 * prompt on every list refresh, which is the kind of friction that makes people
 * stop using a tool.
 *
 * Cached in memory only: a signature is a credential, and localStorage is
 * readable by any script that manages to run on the page.
 */
const READ_TTL_MS = 11 * 60 * 60 * 1000;  // under the server's 12h, with margin
const readCache = new Map<string, { ts: number; signature: string; wallet: string }>();

async function readAuth(action: string): Promise<{ wallet: string; ts: number; signature: string }> {
  const wallet = arcfxWallet.address;
  if (!wallet) throw new Error("Connect your wallet first.");
  const key = `${action}|${wallet.toLowerCase()}`;
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.ts < READ_TTL_MS && hit.wallet === wallet.toLowerCase()) {
    return { wallet, ts: hit.ts, signature: hit.signature };
  }
  const ts = Date.now();
  const digest = await digestOf(null);
  const signature = await sign(messageFor(action, wallet, digest, ts));
  readCache.set(key, { ts, signature, wallet: wallet.toLowerCase() });
  return { wallet, ts, signature };
}

/** Drop cached read signatures — call when the account changes. */
export function clearAuthCache(): void { readCache.clear(); }

// Only an ACCOUNT change invalidates these. A signature is bound to the wallet
// and the clock, not the chain, so clearing on every emit — which includes
// chainChanged and the switch performed during connect — would force a fresh
// MetaMask prompt for no security benefit. Entries are keyed by address anyway;
// this clears them so one account's credential does not sit in memory while
// another is in use.
let lastSeenAddress: string | null =
  arcfxWallet.address ? arcfxWallet.address.toLowerCase() : null;
arcfxWallet.onChange((state) => {
  const now = state.address ? state.address.toLowerCase() : null;
  if (now !== lastSeenAddress) {
    lastSeenAddress = now;
    clearAuthCache();
  }
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

/** Authenticated GET. `params` are added to the query string. */
async function get(path: string, action: string, params: Record<string, string> = {}): Promise<any> {
  const auth = await readAuth(action);
  const qs = new URLSearchParams({
    wallet: auth.wallet, ts: String(auth.ts), signature: auth.signature, ...params,
  });
  return parse(await fetch(`${API_BASE}${path}?${qs}`));
}

/**
 * Authenticated POST. Each write is signed separately — a write is a distinct
 * authorisation and the server only allows a 10 minute window, so these are
 * never cached.
 */
async function post(path: string, action: string, payload: unknown): Promise<any> {
  const wallet = arcfxWallet.address;
  if (!wallet) throw new Error("Connect your wallet first.");
  const ts = Date.now();
  // Normalise once, then sign and send the SAME object — see stripUndefined.
  const clean = stripUndefined(payload ?? null);
  const digest = await digestOf(clean);
  const signature = await sign(messageFor(action, wallet, digest, ts));
  return parse(await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, ts, signature, payload: clean }),
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
    post("/v1/agent-mandates/prepare", "agent mandate prepare", { invoiceId }),
  submitAgentMandate: (preparationToken: string, mandateSignature: string) =>
    post("/v1/agent-mandates", "agent mandate submit", { preparationToken, mandateSignature }),
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
