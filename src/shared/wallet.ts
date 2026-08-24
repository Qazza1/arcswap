/**
 * arcfx wallet — src/shared/wallet.ts
 *
 * One owner of wallet state for the whole app.
 *
 * Every page used to implement connection itself, which is why the session
 * drifted: some pages silently restored an existing connection, others only
 * ever prompted. The shared header meanwhile printed the address on all of
 * them, so the nav could claim "connected" while the page underneath had no
 * signer and demanded a fresh click.
 *
 * Import this module and the page gets: silent restore on load, one address and
 * chain, chain guarding, and notifications when the user switches account or
 * network in their wallet.
 *
 *   import { arcfxWallet } from '/src/shared/wallet.ts';
 *   arcfxWallet.onChange(s => { if (s.connected && s.onArc) load(s.address); });
 *   await arcfxWallet.restore();          // silent — never prompts
 *   await arcfxWallet.connect();          // explicit — prompts
 *
 * Deliberately ethers-free: it owns the session, not the objects. Pages build
 * their own provider from window.ethereum with whichever ethers build they
 * already import, so a signer is never passed between two copies of the library.
 *
 * Also published as window.arcfxWallet for pages whose scripts are not modules.
 */

// Single definition of the network. This was previously copy-pasted into
// history, app, main and pay, and had already drifted between them.
export const ARC_TESTNET = {
  chainId: "0x4CEF52", // 5042002
  chainName: "Arc Network Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
} as const;

export const ARC_CHAIN_ID_HEX = ARC_TESTNET.chainId;
export const ARC_CHAIN_ID_DEC = 5042002;

export interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: string | null;   // hex, as the wallet reports it
  onArc: boolean;
}

type Listener = (state: WalletState) => void;

const eth = (): any => (typeof window !== "undefined" ? (window as any).ethereum : undefined);

let state: WalletState = {
  connected: false, address: null, chainId: null,
  onArc: false,
};

const listeners = new Set<Listener>();
let wired = false;
let restoring: Promise<WalletState> | null = null;

function snapshot(): WalletState { return { ...state }; }

function emit(): void {
  const s = snapshot();
  for (const fn of listeners) {
    // One page's failing handler must not stop the others from updating.
    try { fn(s); } catch (err) { console.error("[wallet] listener failed:", err); }
  }
  paintHeader();
}

/** Short form used in the nav button and page badges. */
export function shortAddress(a: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

// The header button is shared, so keeping it in sync belongs here rather than
// in every page that happens to remember to do it.
function paintHeader(): void {
  if (typeof document === "undefined") return;
  const btn = document.getElementById("connect-btn");
  if (btn) {
    if (state.connected && state.address) {
      btn.textContent = shortAddress(state.address);
      btn.classList.add("connected");
    } else {
      btn.textContent = "Connect wallet";
      btn.classList.remove("connected");
    }
  }
  const disp = document.getElementById("wallet-display");
  if (disp) {
    if (state.connected && state.address) {
      disp.textContent = shortAddress(state.address);
      (disp as HTMLElement).style.display = "block";
    } else {
      (disp as HTMLElement).style.display = "none";
    }
  }
}

async function hydrate(address: string | null): Promise<void> {
  if (!address || !eth()) {
    state = { connected: false, address: null, chainId: state.chainId, onArc: state.onArc };
    return;
  }
  let chainId: string | null = state.chainId;
  try { chainId = await eth().request({ method: "eth_chainId" }); } catch { /* keep last known */ }

  state = {
    connected: true,
    address,
    chainId,
    onArc: String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase(),
  };
}

// Wallet-initiated changes (user switches account or network in MetaMask) have
// to reach the page, or it keeps acting on a stale address.
function wireEvents(): void {
  const e = eth();
  if (!e || wired || typeof e.on !== "function") return;
  wired = true;

  e.on("accountsChanged", async (accounts: string[]) => {
    await hydrate(accounts && accounts.length ? accounts[0] : null);
    emit();
  });

  e.on("chainChanged", async (chainId: string) => {
    state.chainId = chainId;
    state.onArc = String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase();
    if (state.connected && state.address) await hydrate(state.address);
    emit();
  });
}

/**
 * Restore an existing authorisation without prompting.
 * Uses eth_accounts, which returns [] when the site was never authorised — so
 * this is safe to call on page load and will never pop a wallet dialog.
 */
async function restore(): Promise<WalletState> {
  if (restoring) return restoring;
  restoring = (async () => {
    const e = eth();
    if (!e) { paintHeader(); return snapshot(); }
    wireEvents();
    try {
      const accounts: string[] = await e.request({ method: "eth_accounts" });
      await hydrate(accounts && accounts.length ? accounts[0] : null);
    } catch {
      await hydrate(null);
    }
    emit();
    return snapshot();
  })();
  try { return await restoring; } finally { restoring = null; }
}

/** Ask the wallet to move to Arc, adding the network if it isn't known yet. */
async function ensureArc(): Promise<boolean> {
  const e = eth();
  if (!e) return false;
  try {
    await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN_ID_HEX }] });
  } catch (err: any) {
    const code = err?.code ?? err?.error?.code ?? err?.info?.error?.code;
    // 4902 = chain unknown to the wallet; adding it also switches to it.
    if (code === 4902 || String(err?.message || "").includes("4902")) {
      try {
        await e.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET] });
      } catch { return false; }
    } else {
      return false; // user rejected, or the wallet refused
    }
  }
  try {
    const chainId = await e.request({ method: "eth_chainId" });
    state.chainId = chainId;
    state.onArc = String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase();
  } catch { /* keep last known */ }
  emit();
  return state.onArc;
}

/**
 * Explicit connect. Prompts, then switches the wallet to Arc.
 *
 * Re-entrant callers share one in-flight request. A wallet rejects a second
 * concurrent eth_requestAccounts with "already processing", which surfaces to
 * the user as connect being broken — so two handlers racing must not be able
 * to cause it.
 */
let connecting: Promise<WalletState> | null = null;

async function connect(): Promise<WalletState> {
  if (connecting) return connecting;
  const e = eth();
  if (!e) throw new Error("No wallet detected. Install MetaMask to continue.");
  connecting = (async () => {
    wireEvents();
    const accounts: string[] = await e.request({ method: "eth_requestAccounts" });
    await ensureArc();
    await hydrate(accounts && accounts.length ? accounts[0] : null);
    emit();
    return snapshot();
  })();
  try { return await connecting; } finally { connecting = null; }
}

/**
 * Forget the session locally. A dapp cannot revoke its own permission in the
 * wallet, so this clears our state and the UI; the wallet still lists the site.
 */
function disconnect(): void {
  state = { connected: false, address: null, chainId: state.chainId, onArc: state.onArc };
  emit();
}

/** Subscribe to changes. Fires immediately with the current state. */
function onChange(fn: Listener): () => void {
  listeners.add(fn);
  try { fn(snapshot()); } catch (err) { console.error("[wallet] listener failed:", err); }
  return () => listeners.delete(fn);
}

export const arcfxWallet = {
  get state(): WalletState { return snapshot(); },
  get address(): string | null { return state.address; },
  get connected(): boolean { return state.connected; },
  get onArc(): boolean { return state.onArc; },
  restore, connect, disconnect, ensureArc, onChange, shortAddress,
  ARC_TESTNET, ARC_CHAIN_ID_HEX, ARC_CHAIN_ID_DEC,
};

if (typeof window !== "undefined") {
  (window as any).arcfxWallet = arcfxWallet;
  // The shared header's Connect button calls window.connectWallet() when a page
  // defines one. Provide the default so every page gets working connect, while
  // a page that defines its own still wins.
  if (!(window as any).connectWallet) {
    (window as any).connectWallet = () => connect().catch((err: any) => {
      console.error("[wallet] connect failed:", err);
      alert(err?.message || "Could not connect wallet.");
    });
  }
  // Restore as soon as the module loads, so a page that only subscribes still
  // receives the connected state without asking for it.
  restore().catch(() => { /* no wallet, or the user has not authorised us */ });
}
