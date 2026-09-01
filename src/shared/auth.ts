/**
 * ArcFX application authentication state.
 *
 * Wallet connection and ArcFX owner authentication are intentionally separate:
 * a connected address may exist without the narrow, opaque owner-read session.
 * This module owns the tab-scoped session lifecycle, while arcfxApi owns the
 * protocol-specific signed bootstrap request.
 */

import { arcfxWallet } from "./wallet";

export type AuthStatus = "DISCONNECTED" | "CONNECTED" | "AUTHENTICATED";

export interface OwnerSession {
  sessionToken: string;
  wallet: string;
  expiresAt: string;
}

export const OWNER_SESSION_STORAGE_KEY = "arcfx:owner-session:v1";

type Listener = (status: AuthStatus) => void;

const listeners = new Set<Listener>();
const readControllers = new Set<AbortController>();
let status: AuthStatus = "DISCONNECTED";
let readyPending: Promise<AuthStatus> | null = null;
let bootstrapPending: Promise<OwnerSession> | null = null;
let generation = 0;
let readyResolved = false;
let observedWallet: string | null = null;

function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

function emit(next: AuthStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) {
    try { listener(status); } catch (error) { console.error("[auth] listener failed:", error); }
  }
}

function connectedStatus(): AuthStatus {
  return arcfxWallet.connected && arcfxWallet.address && !arcfxWallet.isExplicitlySignedOut
    ? "CONNECTED"
    : "DISCONNECTED";
}

/**
 * A bearer is usable only after the selected provider has supplied a complete,
 * verified Arc snapshot. Connected alone is deliberately not enough: unknown
 * chain state and a known wrong network both fail closed.
 */
function hasTrustedOwnerWallet(): boolean {
  return Boolean(
    arcfxWallet.connected
    && arcfxWallet.address
    && arcfxWallet.chainId !== null
    && arcfxWallet.onArc
    && !arcfxWallet.isExplicitlySignedOut,
  );
}

function discardStoredSession(): void {
  try { storage()?.removeItem(OWNER_SESSION_STORAGE_KEY); } catch { /* private mode */ }
}

/** Read and locally validate the opaque short-lived authentication bearer without exposing it. */
function storedOwnerSession(): OwnerSession | null {
  const wallet = arcfxWallet.address?.toLowerCase();
  if (!wallet || !hasTrustedOwnerWallet()) return null;
  try {
    const raw = storage()?.getItem(OWNER_SESSION_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.sessionToken !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.sessionToken)
        || typeof value.wallet !== "string" || value.wallet.toLowerCase() !== wallet
        || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.now() >= Date.parse(value.expiresAt)) {
      discardStoredSession();
      return null;
    }
    return { sessionToken: value.sessionToken, wallet, expiresAt: value.expiresAt };
  } catch {
    discardStoredSession();
    return null;
  }
}

function invalidate(): void {
  generation++;
  bootstrapPending = null;
  for (const controller of readControllers) controller.abort();
  readControllers.clear();
  discardStoredSession();
  emit(connectedStatus());
}

/**
 * Resolve wallet discovery/restoration before any owner API decides whether it
 * needs to authenticate. It never calls personal_sign.
 */
async function ready(): Promise<AuthStatus> {
  if (readyPending) return readyPending;
  readyPending = (async () => {
    await arcfxWallet.restore();
    observedWallet = arcfxWallet.address?.toLowerCase() || null;
    readyResolved = true;
    emit(storedOwnerSession() ? "AUTHENTICATED" : connectedStatus());
    return status;
  })();
  try { return await readyPending; } finally { readyPending = null; }
}

function currentOwnerSession(): OwnerSession | null {
  const current = storedOwnerSession();
  emit(current ? "AUTHENTICATED" : connectedStatus());
  return current;
}

/** Share a single signed bootstrap when owner reads arrive concurrently. */
async function ensureOwnerSession(create: () => Promise<OwnerSession>): Promise<OwnerSession> {
  await ready();
  const existing = currentOwnerSession();
  if (existing) return existing;
  if (!hasTrustedOwnerWallet()) {
    throw new Error("Connect your wallet first.");
  }
  if (!bootstrapPending) {
    const expectedGeneration = generation;
    const expectedWallet = arcfxWallet.address?.toLowerCase();
    const pending = create().then((session) => {
      if (expectedGeneration !== generation || !expectedWallet
          || arcfxWallet.address?.toLowerCase() !== expectedWallet
          || !hasTrustedOwnerWallet()) {
        throw new Error("ArcFX authentication was cancelled because the wallet changed.");
      }
      try { storage()?.setItem(OWNER_SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { /* tab still works */ }
      emit("AUTHENTICATED");
      return session;
    });
    bootstrapPending = pending;
    pending.finally(() => { if (bootstrapPending === pending) bootstrapPending = null; }).catch(() => { /* caller receives it */ });
  }
  return bootstrapPending;
}

/** Start a read that will be aborted/ignored after logout or account change. */
function beginOwnerRead(): { signal: AbortSignal; generation: number; finish: () => void } {
  const controller = new AbortController();
  const expectedGeneration = generation;
  readControllers.add(controller);
  return {
    signal: controller.signal,
    generation: expectedGeneration,
    finish: () => readControllers.delete(controller),
  };
}

function isCurrentGeneration(expectedGeneration: number): boolean {
  return expectedGeneration === generation && hasTrustedOwnerWallet();
}

/** Explicit ArcFX sign-out. This never asks the wallet to revoke extension permission. */
function disconnect(): void {
  invalidate();
  arcfxWallet.disconnect();
  emit("DISCONNECTED");
}

function onChange(listener: Listener): () => void {
  listeners.add(listener);
  try { listener(status); } catch (error) { console.error("[auth] listener failed:", error); }
  return () => listeners.delete(listener);
}

arcfxWallet.onChange((walletState) => {
  if (!readyResolved) return;
  const nextWallet = walletState.address?.toLowerCase() || null;
  const accountChanged = nextWallet !== observedWallet;
  observedWallet = nextWallet;
  if (!nextWallet || accountChanged || !hasTrustedOwnerWallet()) {
    invalidate();
    return;
  }
  emit(storedOwnerSession() ? "AUTHENTICATED" : connectedStatus());
});

export const arcfxAuth = {
  get status(): AuthStatus { return status; },
  get isExplicitlySignedOut(): boolean { return arcfxWallet.isExplicitlySignedOut; },
  ready, currentOwnerSession, ensureOwnerSession, beginOwnerRead, isCurrentGeneration,
  clearAuthCache: invalidate, disconnect, onChange,
};
