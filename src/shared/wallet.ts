/**
 * ArcFX wallet session and EIP-6963 provider selection.
 *
 * A browser may have several injected EIP-1193 wallets. `window.ethereum` is
 * only a compatibility fallback: when EIP-6963 providers announce themselves,
 * ArcFX selects one and keeps that exact provider for restoration, signing,
 * chain switching and change events.
 *
 * Provider labels are UI hints only. The security identity is always the
 * account returned by the selected provider and the server-verified wallet in
 * the opaque owner-session token.
 */

export const ARC_TESTNET = {
  chainId: "0x4CEF52", // 5042002
  chainName: "Arc Network Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
} as const;

export const ARC_CHAIN_ID_HEX = ARC_TESTNET.chainId;
export const ARC_CHAIN_ID_DEC = 5042002;

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
}

interface Eip6963Info {
  uuid?: string;
  name?: string;
  rdns?: string;
}

interface ProviderEntry {
  provider: Eip1193Provider;
  info: Eip6963Info | null;
  fallback: boolean;
}

interface ProviderPreference {
  rdns: string;
  name: string;
}

export interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: string | null;
  onArc: boolean;
}

type Listener = (state: WalletState) => void;

const OWNER_SESSION_STORAGE_KEY = "arcfx:owner-session:v1";
const PROVIDER_PREFERENCE_STORAGE_KEY = "arcfx:wallet-provider-preference:v1";
const PROVIDER_DISCOVERY_WAIT_MS = 60;

let state: WalletState = { connected: false, address: null, chainId: null, onArc: false };
const listeners = new Set<Listener>();
const announcedProviders: ProviderEntry[] = [];
let discoveryInstalled = false;
let selectedProvider: ProviderEntry | null = null;
let wiredProvider: Eip1193Provider | null = null;
let restoring: Promise<WalletState> | null = null;
let connecting: Promise<WalletState> | null = null;
let selectedAccountsChanged: ((accounts: string[]) => Promise<void>) | null = null;
let selectedChainChanged: ((chainId: string) => Promise<void>) | null = null;

function snapshot(): WalletState { return { ...state }; }

function emit(): void {
  const s = snapshot();
  for (const fn of listeners) {
    try { fn(s); } catch (err) { console.error("[wallet] listener failed:", err); }
  }
  paintHeader();
}

export function shortAddress(address: string | null): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

function paintHeader(): void {
  if (typeof document === "undefined") return;
  const button = document.getElementById("connect-btn");
  if (button) {
    if (state.connected && state.address) {
      button.textContent = shortAddress(state.address);
      button.classList.add("connected");
    } else {
      button.textContent = "Connect wallet";
      button.classList.remove("connected");
    }
  }
  const display = document.getElementById("wallet-display");
  if (display) {
    if (state.connected && state.address) {
      display.textContent = shortAddress(state.address);
      (display as HTMLElement).style.display = "block";
    } else {
      (display as HTMLElement).style.display = "none";
    }
  }
}

function windowEthereum(): Eip1193Provider | null {
  const candidate = typeof window === "undefined" ? null : (window as any).ethereum;
  return candidate && typeof candidate.request === "function" ? candidate as Eip1193Provider : null;
}

function addAnnouncement(detail: any): void {
  const provider = detail?.provider;
  if (!provider || typeof provider.request !== "function") return;
  if (announcedProviders.some((entry) => entry.provider === provider)) return;
  announcedProviders.push({
    provider,
    info: {
      uuid: typeof detail?.info?.uuid === "string" ? detail.info.uuid : undefined,
      name: typeof detail?.info?.name === "string" ? detail.info.name : undefined,
      rdns: typeof detail?.info?.rdns === "string" ? detail.info.rdns : undefined,
    },
    fallback: false,
  });
}

function installDiscovery(): void {
  if (discoveryInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  discoveryInstalled = true;
  window.addEventListener("eip6963:announceProvider", ((event: Event) => {
    addAnnouncement((event as CustomEvent).detail);
  }) as EventListener);
}

async function discoverProviders(): Promise<ProviderEntry[]> {
  installDiscovery();
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* legacy browser */ }
    // Give every installed extension one bounded turn to announce. Returning on
    // the first announcement would reintroduce an injection-order race.
    await new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_DISCOVERY_WAIT_MS));
  }
  if (announcedProviders.length) return [...announcedProviders];
  const fallback = windowEthereum();
  return fallback ? [{ provider: fallback, info: null, fallback: true }] : [];
}

function storedProviderPreference(): ProviderPreference | null {
  try {
    const raw = localStorage.getItem(PROVIDER_PREFERENCE_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.rdns !== "string" || !value.rdns || typeof value.name !== "string") return null;
    return { rdns: value.rdns, name: value.name };
  } catch { return null; }
}

function persistProviderPreference(entry: ProviderEntry): void {
  if (!entry.info?.rdns) return;
  try {
    localStorage.setItem(PROVIDER_PREFERENCE_STORAGE_KEY, JSON.stringify({
      rdns: entry.info.rdns,
      name: entry.info.name || entry.info.rdns,
    }));
  } catch { /* preferences are optional */ }
}

/** Non-secret UX hint; the opaque bearer is never read or copied here. */
function storedSessionWallet(): string | null {
  try {
    const raw = sessionStorage.getItem(OWNER_SESSION_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    const wallet = typeof value?.wallet === "string" ? value.wallet.toLowerCase() : "";
    return /^0x[a-f0-9]{40}$/.test(wallet) ? wallet : null;
  } catch { return null; }
}

function preferred(entries: ProviderEntry[]): ProviderEntry | null {
  const preference = storedProviderPreference();
  if (!preference) return null;
  return entries.find((entry) => entry.info?.rdns === preference.rdns) || null;
}

function detachSelectedEvents(): void {
  if (!wiredProvider) return;
  if (selectedAccountsChanged && wiredProvider.removeListener) wiredProvider.removeListener("accountsChanged", selectedAccountsChanged);
  if (selectedChainChanged && wiredProvider.removeListener) wiredProvider.removeListener("chainChanged", selectedChainChanged);
  wiredProvider = null;
  selectedAccountsChanged = null;
  selectedChainChanged = null;
}

async function hydrate(provider: Eip1193Provider, address: string | null): Promise<void> {
  if (!address) {
    state = { connected: false, address: null, chainId: state.chainId, onArc: state.onArc };
    return;
  }
  let chainId: string | null = state.chainId;
  try { chainId = await provider.request({ method: "eth_chainId" }); } catch { /* keep last known */ }
  state = {
    connected: true,
    address,
    chainId,
    onArc: String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase(),
  };
}

function wireSelectedEvents(entry: ProviderEntry): void {
  if (wiredProvider === entry.provider || !entry.provider.on) return;
  detachSelectedEvents();
  const provider = entry.provider;
  selectedAccountsChanged = async (accounts: string[]) => {
    if (selectedProvider?.provider !== provider) return;
    await hydrate(provider, accounts && accounts.length ? accounts[0] : null);
    if (selectedProvider?.provider === provider) emit();
  };
  selectedChainChanged = async (chainId: string) => {
    if (selectedProvider?.provider !== provider) return;
    state.chainId = chainId;
    state.onArc = String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase();
    if (state.connected && state.address) await hydrate(provider, state.address);
    if (selectedProvider?.provider === provider) emit();
  };
  provider.on("accountsChanged", selectedAccountsChanged);
  provider.on("chainChanged", selectedChainChanged);
  wiredProvider = provider;
}

function selectProvider(entry: ProviderEntry, persist = false): void {
  if (selectedProvider?.provider !== entry.provider) {
    detachSelectedEvents();
    selectedProvider = entry;
  }
  wireSelectedEvents(entry);
  if (persist) persistProviderPreference(entry);
}

async function accountsFor(entry: ProviderEntry): Promise<string[]> {
  try {
    const accounts = await entry.provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) ? accounts.filter((account): account is string => typeof account === "string") : [];
  } catch { return []; }
}

async function selectForRestore(entries: ProviderEntry[]): Promise<ProviderEntry | null> {
  const sessionWallet = storedSessionWallet();
  if (sessionWallet) {
    const accountLists = await Promise.all(entries.map(accountsFor));
    const matching = entries.filter((_, index) => accountLists[index].some((account) => account.toLowerCase() === sessionWallet));
    if (matching.length) return preferred(matching) || matching[0];
  }
  return preferred(entries) || (entries.length === 1 ? entries[0] : null);
}

async function chooseProvider(entries: ProviderEntry[]): Promise<ProviderEntry> {
  if (entries.length === 1) return entries[0];
  if (typeof document === "undefined") throw new Error("Choose a wallet in a browser to continue.");
  return new Promise<ProviderEntry>((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Choose wallet");
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "10000", display: "grid", placeItems: "center", background: "rgba(2, 6, 23, .72)", padding: "20px" });
    const panel = document.createElement("div");
    Object.assign(panel.style, { width: "min(100%, 360px)", borderRadius: "12px", padding: "20px", background: "#0f172a", border: "1px solid #334155", boxShadow: "0 24px 56px rgba(0,0,0,.45)", color: "#f8fafc", fontFamily: "system-ui, sans-serif" });
    const title = document.createElement("h2");
    title.textContent = "Choose wallet";
    Object.assign(title.style, { margin: "0 0 6px", fontSize: "18px" });
    const copy = document.createElement("p");
    copy.textContent = "ArcFX will use this wallet for this browser session.";
    Object.assign(copy.style, { margin: "0 0 14px", color: "#94a3b8", fontSize: "13px" });
    panel.append(title, copy);
    const close = () => overlay.remove();
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.info?.name || entry.info?.rdns || "Browser wallet";
      Object.assign(button.style, { width: "100%", marginTop: "8px", padding: "11px 12px", textAlign: "left", cursor: "pointer", borderRadius: "8px", border: "1px solid #334155", background: "#111c31", color: "#f8fafc", font: "inherit" });
      button.addEventListener("click", () => { close(); resolve(entry); }, { once: true });
      panel.append(button);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    Object.assign(cancel.style, { marginTop: "14px", border: "0", background: "transparent", color: "#94a3b8", cursor: "pointer", font: "inherit" });
    cancel.addEventListener("click", () => { close(); reject(new Error("Wallet selection cancelled.")); }, { once: true });
    panel.append(cancel);
    overlay.append(panel);
    document.body.append(overlay);
    panel.querySelector("button")?.focus();
  });
}

/** Restore a prior selected wallet silently; it never creates a wallet popup. */
async function restore(): Promise<WalletState> {
  if (restoring) return restoring;
  restoring = (async () => {
    const entries = await discoverProviders();
    const entry = await selectForRestore(entries);
    if (!entry) {
      state = { connected: false, address: null, chainId: state.chainId, onArc: state.onArc };
      emit();
      return snapshot();
    }
    selectProvider(entry);
    const accounts = await accountsFor(entry);
    await hydrate(entry.provider, accounts[0] || null);
    emit();
    return snapshot();
  })();
  try { return await restoring; } finally { restoring = null; }
}

async function ensureArc(): Promise<boolean> {
  const provider = selectedProvider?.provider;
  if (!provider) return false;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN_ID_HEX }] });
  } catch (error: any) {
    const code = error?.code ?? error?.error?.code ?? error?.info?.error?.code;
    if (code === 4902 || String(error?.message || "").includes("4902")) {
      try { await provider.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET as any] }); }
      catch { return false; }
    } else return false;
  }
  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    state.chainId = chainId;
    state.onArc = String(chainId).toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase();
  } catch { /* keep last known */ }
  emit();
  return state.onArc;
}

/** Explicit connect. When wallets compete, show the small provider selector. */
async function connect(): Promise<WalletState> {
  if (connecting) return connecting;
  connecting = (async () => {
    let entry = selectedProvider;
    if (!entry) {
      const entries = await discoverProviders();
      if (!entries.length) throw new Error("No wallet detected. Install MetaMask, Backpack, Rabby, or another EVM wallet.");
      entry = await chooseProvider(entries);
      selectProvider(entry, true);
    }
    wireSelectedEvents(entry);
    const accounts = await entry.provider.request({ method: "eth_requestAccounts" });
    await ensureArc();
    await hydrate(entry.provider, Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null);
    emit();
    return snapshot();
  })();
  try { return await connecting; } finally { connecting = null; }
}

function disconnect(): void {
  state = { connected: false, address: null, chainId: state.chainId, onArc: state.onArc };
  emit();
}

/** Send every ArcFX signing request through the selected provider. */
async function request(args: { method: string; params?: unknown[] }): Promise<any> {
  const provider = selectedProvider?.provider;
  if (!provider) throw new Error("Connect your wallet first.");
  return provider.request(args);
}

async function signMessage(message: string): Promise<string> {
  const address = state.address;
  if (!address) throw new Error("Connect your wallet first.");
  return request({ method: "personal_sign", params: [message, address] });
}

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
  get provider(): Eip1193Provider | null { return selectedProvider?.provider || null; },
  get providerInfo(): Readonly<Eip6963Info> | null { return selectedProvider?.info || null; },
  restore, connect, disconnect, ensureArc, request, signMessage, onChange, shortAddress,
  ARC_TESTNET, ARC_CHAIN_ID_HEX, ARC_CHAIN_ID_DEC,
};

if (typeof window !== "undefined") {
  (window as any).arcfxWallet = arcfxWallet;
  if (!(window as any).connectWallet) {
    (window as any).connectWallet = () => connect().catch((error: any) => {
      console.error("[wallet] connect failed:", error);
      alert(error?.message || "Could not connect wallet.");
    });
  }
  restore().catch(() => { /* no wallet, or silent restoration was unavailable */ });
}
