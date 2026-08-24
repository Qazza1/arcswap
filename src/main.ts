/**
 * fx-swap-widget — src/main.ts
 * Stablecoin FX swap widget on Arc Testnet. Swaps USDC <-> EURC.
 */

import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { BrowserProvider, Contract, formatUnits } from "ethers";
import { arcfxWallet, type WalletState } from "./shared/wallet";

const ARC_TESTNET = {
  chainId: "0x4CEF52",
  chainName: "Arc Network Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const TOKENS = {
  USDC:   { address: "0x3600000000000000000000000000000000000000", decimals: 6, flag: "$" },
  EURC:   { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6, flag: "€" },
  cirBTC: { address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF", decimals: 8, flag: "₿" },
} as const;

type TokenSymbol = keyof typeof TOKENS;
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

let ethersProvider: BrowserProvider | null = null;
let ethersSigner: any = null;
let userAddress: string | null = null;
const rawBalances: Record<string, string> = {}; // full-precision balances for MAX (L1)
let tokenIn: TokenSymbol = "USDC";
let tokenOut: TokenSymbol = "EURC";
let isSwapping = false;

const kit = new AppKit();

// Safe DOM helpers — never throw if element missing
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
function setText(id: string, text: string): void { const n = el(id); if (n) n.textContent = text; }
function setHTML(id: string, html: string): void  { const n = el(id); if (n) n.innerHTML = html; }
function addClass(id: string, cls: string): void    { el(id)?.classList.add(cls); }
function removeClass(id: string, cls: string): void { el(id)?.classList.remove(cls); }

// Status: writes to both targets so errors are visible before AND after connect.
// Pre-connect, the swap card (and its #swap-status) is hidden, so we also write
// to #global-status — which sits above the connect card — and toggle its
// visibility so connect errors ("MetaMask not found", "Connection rejected")
// aren't swallowed by a hidden element.
function showStatus(msg: string, type: "success"|"error"|"info"|""): void {
  const html = msg ? `<div class="status ${type}">${msg}</div>` : "";
  setHTML("swap-status", html);
  setHTML("global-status", html);
  const gs = el("global-status");
  if (gs) gs.style.display = msg ? "block" : "none";
}

// Clear the pre-connect global status banner. Used by flows (swap/bridge) that
// write their final success/result HTML directly to their own status element,
// so the transient "Confirm in MetaMask…" line in #global-status doesn't linger.
function clearGlobalStatus(): void {
  setHTML("global-status", "");
  const gs = el("global-status");
  if (gs) gs.style.display = "none";
}

/**
 * Reflect the shared wallet session into the swap UI.
 *
 * The session itself lives in src/shared/wallet.ts — this page used to run its
 * own eth_requestAccounts and its own chain switch, which is why the nav could
 * show an address while Trade still displayed the connect card.
 */
async function adoptSession(state: WalletState): Promise<void> {
  const btn = el("connect-btn");
  if (!state.connected || !state.address) {
    ethersProvider = null; ethersSigner = null; userAddress = null;
    el("swap-card")?.classList.add("hidden");
    el("connect-card")?.classList.remove("hidden");
    return;
  }
  if (!state.onArc) {
    // Authorized but on the wrong network — surface it instead of a swap card
    // whose balances read "—" and whose actions fail with opaque kit errors.
    ethersProvider = new BrowserProvider(window.ethereum!);
    userAddress    = state.address;
    if (btn) btn.textContent = "Wrong network";
    el("swap-card")?.classList.add("hidden");
    el("connect-card")?.classList.remove("hidden");
    showStatus("You're connected but not on Arc Testnet. Click Connect to switch networks.", "error");
    return;
  }
  ethersProvider = new BrowserProvider(window.ethereum!);
  userAddress    = state.address;
  removeClass("swap-card", "hidden");
  addClass("connect-card", "hidden");
  const execBtn = el("execute-swap-btn");
  if (execBtn) execBtn.textContent = `Swap ${tokenIn} → ${tokenOut}`;
  await loadBalances();
}

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    showStatus("MetaMask not found — install it from metamask.io", "error");
    return;
  }
  const btn = el("connect-btn");
  try {
    if (btn) btn.textContent = "Connecting…";
    const state = await arcfxWallet.connect();
    await adoptSession(state);
    if (state.onArc) showStatus("Connected to Arc Testnet ✓", "success");
  } catch (err: any) {
    if (btn) btn.textContent = "Connect wallet";
    if (err.code === 4001) {
      showStatus("Connection rejected.", "error");
    } else {
      showStatus(`Connection failed: ${err.message ?? "Unknown error"}`, "error");
    }
  }
}

async function loadBalances(): Promise<void> {
  if (!ethersProvider || !userAddress) return;
  for (const [sym, token] of Object.entries(TOKENS) as [TokenSymbol, typeof TOKENS[TokenSymbol]][]) {
    try {
      const c = new Contract(token.address, ERC20_ABI, ethersProvider);
      const raw: bigint = await c.balanceOf(userAddress);
      // Read decimals live (Arc docs recommend this); fall back to the literal.
      let dec: number = token.decimals;
      try { dec = Number(await c.decimals()); } catch { /* use literal */ }
      // Keep the FULL-PRECISION value for MAX (the displayed value is rounded to
      // 4dp and can exceed the real balance, making the swap revert — L1).
      rawBalances[sym] = formatUnits(raw, dec);
      setText(`balance-${sym}`, parseFloat(formatUnits(raw, dec)).toFixed(4));
    } catch { setText(`balance-${sym}`, "—"); rawBalances[sym] = ""; }
  }
  updateBalanceLabels();
}

function updateBalanceLabels(): void {
  setText("balance-in-label",  `Balance: ${el(`balance-${tokenIn}`)?.textContent  ?? "—"} ${tokenIn}`);
  if (el("balance-out-label")) {
    setText("balance-out-label", `Balance: ${el(`balance-${tokenOut}`)?.textContent ?? "—"} ${tokenOut}`);
  }
}

const TOKEN_LOGO_COLORS: Record<string, string> = { USDC: "#2775ca", EURC: "#1a3ca8", cirBTC: "#f7931a" };

// Populate hidden selects (source of truth) + build the custom dropdown menus.
function initSwapSelectors(): void {
  const inSel  = el<HTMLSelectElement>("token-in-select");
  const outSel = el<HTMLSelectElement>("token-out-select");
  if (!inSel || !outSel) return;

  const opts = (Object.keys(TOKENS) as TokenSymbol[])
    .map(sym => `<option value="${sym}">${sym}</option>`).join("");
  inSel.innerHTML = opts;
  outSel.innerHTML = opts;
  inSel.value = tokenIn;
  outSel.value = tokenOut;

  inSel.addEventListener("change", () => {
    tokenIn = inSel.value as TokenSymbol;
    if (tokenOut === tokenIn) {
      tokenOut = (Object.keys(TOKENS) as TokenSymbol[]).find(s => s !== tokenIn) ?? tokenOut;
    }
    onTokenPairChanged();
  });
  outSel.addEventListener("change", () => {
    tokenOut = outSel.value as TokenSymbol;
    if (tokenIn === tokenOut) {
      tokenIn = (Object.keys(TOKENS) as TokenSymbol[]).find(s => s !== tokenOut) ?? tokenIn;
    }
    onTokenPairChanged();
  });

  buildTokenMenu("in");
  buildTokenMenu("out");

  // Close any open menu when clicking outside the pickers.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".token-picker")) closeAllTokenMenus();
  });
}

// Render the option rows for one side's custom menu.
function buildTokenMenu(side: "in" | "out"): void {
  const menu = el(`token-${side}-menu`);
  if (!menu) return;
  const current = side === "in" ? tokenIn : tokenOut;
  menu.innerHTML = (Object.keys(TOKENS) as TokenSymbol[]).map(sym => {
    const color = TOKEN_LOGO_COLORS[sym] ?? "#2775ca";
    const sel = sym === current ? " selected" : "";
    return `<div class="token-menu-item${sel}" data-side="${side}" data-sym="${sym}">
      <span class="tm-logo" style="background:${color};">${TOKENS[sym].flag}</span>
      <span class="tm-sym">${sym}</span>
      <svg class="tm-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>`;
  }).join("");
  // Wire each row.
  menu.querySelectorAll(".token-menu-item").forEach(item => {
    item.addEventListener("click", () => {
      const sym = (item as HTMLElement).dataset.sym as TokenSymbol;
      selectToken(side, sym);
    });
  });
}

function toggleTokenMenu(side: "in" | "out"): void {
  const menu = el(`token-${side}-menu`);
  const pill = el(`token-${side}-pill`);
  if (!menu || !pill) return;
  const isOpen = menu.style.display !== "none";
  closeAllTokenMenus();
  if (!isOpen) { menu.style.display = "block"; pill.classList.add("open"); }
}

function closeAllTokenMenus(): void {
  (["in", "out"] as const).forEach(s => {
    const m = el(`token-${s}-menu`); const p = el(`token-${s}-pill`);
    if (m) m.style.display = "none";
    if (p) p.classList.remove("open");
  });
}

// User picked a token from the custom menu → drive the hidden select (which runs all existing logic).
function selectToken(side: "in" | "out", sym: TokenSymbol): void {
  closeAllTokenMenus();
  const sel = el<HTMLSelectElement>(`token-${side}-select`);
  if (!sel) return;
  if (sel.value === sym) return; // no change
  sel.value = sym;
  sel.dispatchEvent(new Event("change"));
}

// Reflect the current tokenIn/tokenOut everywhere in the swap UI.
function renderSwapTokens(): void {
  // Header pill (small summary)
  setText("token-in-symbol",  tokenIn);
  setText("token-out-symbol", tokenOut);
  setText("token-in-flag",    TOKENS[tokenIn].flag);
  setText("token-out-flag",   TOKENS[tokenOut].flag);
  const inFlag  = el("token-in-flag");
  const outFlag = el("token-out-flag");
  if (inFlag)  inFlag.style.background  = TOKEN_LOGO_COLORS[tokenIn]  ?? "#2775ca";
  if (outFlag) outFlag.style.background = TOKEN_LOGO_COLORS[tokenOut] ?? "#1a3ca8";

  // You Pay / You Receive logos
  const inLogo  = el("pay-in-logo");
  const outLogo = el("pay-out-logo");
  if (inLogo)  { inLogo.textContent  = TOKENS[tokenIn].flag;  inLogo.style.background  = TOKEN_LOGO_COLORS[tokenIn]  ?? "#2775ca"; }
  if (outLogo) { outLogo.textContent = TOKENS[tokenOut].flag; outLogo.style.background = TOKEN_LOGO_COLORS[tokenOut] ?? "#1a3ca8"; }

  // Keep the hidden selects in sync (e.g. after a flip or auto-bump)
  const inSel  = el<HTMLSelectElement>("token-in-select");
  const outSel = el<HTMLSelectElement>("token-out-select");
  if (inSel)  inSel.value  = tokenIn;
  if (outSel) outSel.value = tokenOut;

  // Update the custom pill names + rebuild menu selection highlight
  setText("pay-in-name",  tokenIn);
  setText("pay-out-name", tokenOut);
  if (el("token-in-menu"))  buildTokenMenu("in");
  if (el("token-out-menu")) buildTokenMenu("out");

  // Execute button label
  const execBtn = el("execute-swap-btn");
  if (execBtn && !execBtn.hasAttribute("disabled")) {
    execBtn.textContent = `Swap ${tokenIn} → ${tokenOut}`;
  }
  updateBalanceLabels();
}

// Shared reset when the pair changes (via dropdown or flip).
function onTokenPairChanged(): void {
  renderSwapTokens();
  const inp = el<HTMLInputElement>("amount-input");
  if (inp) inp.value = "";
  setText("estimate-output", "—");
  addClass("estimate-row", "hidden");
  showStatus("", "");
}

function flipTokens(): void {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  onTokenPairChanged();
}

async function estimateSwap(amountIn: string): Promise<void> {
  const amount = amountIn;
  if (!amount || parseFloat(amount) <= 0 || !window.ethereum) {
    setText("estimate-output", "—");
    addClass("estimate-row", "hidden");
    return;
  }
  setText("estimate-output", "loading…");
  removeClass("estimate-row", "hidden");
  try {
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum as any });
    const est = await kit.estimateSwap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn, tokenOut, amountIn: amount,
      config: { kitKey: import.meta.env.VITE_KIT_KEY as string },
    });
    const outAmt = est.estimatedOutput?.amount;
    setText("estimate-output", `≈ ${outAmt ?? "—"} ${tokenOut}`);
    const fee = est.fees?.[0];
    setText("estimate-fee", fee ? `Fee: ${fee.amount} ${fee.token}` : "");

    // Update compare table with live rate
    if (outAmt && amountIn) {
      const liveRate = parseFloat(outAmt) / parseFloat(amountIn);
      if (liveRate > 0 && typeof (window as any).updateCompareRate === "function") {
        (window as any).updateCompareRate(liveRate);
      }
    }
  } catch (e: any) {
    const noRoute = /no route|route or resource not found|route not found/i.test(String(e?.message ?? e ?? ""));
    setText("estimate-output", noRoute ? "No route on testnet" : "Rate unavailable");
    setText("estimate-fee", "");
  }
}

async function executeSwap(): Promise<void> {
  if (isSwapping || !window.ethereum) return;
  const inp = el<HTMLInputElement>("amount-input");
  const amount = inp?.value.trim() ?? "";
  if (!amount || parseFloat(amount) <= 0) { showStatus("Enter an amount.", "error"); return; }

  isSwapping = true;
  const btn     = el("swap-btn");        // hidden compat button
  const execBtn = el("execute-swap-btn"); // visible enterprise button
  if (btn)     { btn.setAttribute("disabled","true"); btn.textContent = "Swapping…"; }
  if (execBtn) { execBtn.setAttribute("disabled","true"); execBtn.textContent = "Swapping…"; }
  showStatus("Confirm in MetaMask…", "info");

  try {
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum as any });
    const result = await kit.swap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn, tokenOut, amountIn: amount,
      config: { kitKey: import.meta.env.VITE_KIT_KEY as string },
    });
    const fee = result.fees?.[0];
    clearGlobalStatus();
    setHTML("swap-status", `
      <div class="status success">
        <div class="status-title">✅ Swap complete</div>
        <div class="status-row">
          <span>${amount} ${tokenIn}</span><span class="arrow">→</span>
          <strong>${result.amountOut} ${tokenOut}</strong>
        </div>
        ${fee ? `<div class="status-fee">Fee: ${fee.amount} ${fee.token}</div>` : ""}
        <a class="explorer-link" href="${result.explorerUrl}" target="_blank" rel="noopener">View on ArcScan ↗</a>
      </div>`);
    if (inp) inp.value = "";
    setText("estimate-output", "—");
    addClass("estimate-row", "hidden");
    await loadBalances();
  } catch (err: any) {
    console.error("ARCFX SWAP ERROR:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    const msg = String(err?.message ?? "");
    if (err?.code === 4001) {
      showStatus("Transaction rejected.", "error");
    } else if (/no route|route or resource not found|route not found/i.test(msg)) {
      showStatus(`${tokenIn} \u2192 ${tokenOut} isn't routable on Arc Testnet right now \u2014 Circle hasn't provisioned this swap direction. Try the reverse direction, a different token pair, or the Bridge tab.`, "error");
    } else if (err?.code === 5002 || err?.name === "ONCHAIN_SIMULATION_FAILED") {
      showStatus("This swap couldn't be completed right now \u2014 the FX route may be temporarily unavailable on testnet. Try a smaller amount, the reverse direction, or check back shortly.", "error");
    } else {
      showStatus(`Swap failed: ${msg || "Unknown error"}`, "error");
    }
  } finally {
    isSwapping = false;
    const execBtn = el("execute-swap-btn");
    if (btn)     { btn.removeAttribute("disabled"); btn.textContent = "Swap"; }
    if (execBtn) { execBtn.removeAttribute("disabled"); execBtn.textContent = "Swap " + tokenIn + " \u2192 " + tokenOut; }
  }
}

function setMaxAmount(): void {
  const inp = el<HTMLInputElement>("amount-input");
  if (!inp) return;
  // Use the full-precision balance, not the 4dp display text (which can round
  // UP and exceed the real balance, causing the swap to revert — L1).
  const raw = rawBalances[tokenIn];
  if (raw && raw !== "") { inp.value = raw; estimateSwap(raw); return; }
  const bal = el(`balance-${tokenIn}`)?.textContent;
  if (bal && bal !== "—") { inp.value = bal; estimateSwap(bal); }
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>;
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}


// ─── Bridge Config (multi-chain) ──────────────────────────────────────────────
// Arc Testnet is the hub. Users bridge USDC between Arc and any external chain
// below. Chain identifiers must match Circle App Kit's BridgeChain enum
// (name with spaces -> underscores, case-sensitive). Bridge supports USDC only.

interface BridgeChainDef {
  bridgeId: string;            // App Kit BridgeChain identifier
  chainId: string;            // hex chain id for wallet_switchEthereumChain
  chainName: string;          // wallet display name
  label: string;              // UI label
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
  dot: string;                // UI dot color
}

const ARC_CHAIN: BridgeChainDef = {
  bridgeId: "Arc_Testnet",
  chainId: "0x4CEF52",
  chainName: "Arc Network Testnet",
  label: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
  dot: "#4e8ef7",
};

// External chains the user can bridge to/from (Arc is always the other side).
const EXTERNAL_CHAINS: Record<string, BridgeChainDef> = {
  Ethereum_Sepolia: {
    bridgeId: "Ethereum_Sepolia",
    chainId: "0xaa36a7",
    chainName: "Ethereum Sepolia",
    label: "Ethereum Sepolia",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
    dot: "#627eea",
  },
  Base_Sepolia: {
    bridgeId: "Base_Sepolia",
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    label: "Base Sepolia",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
    dot: "#0052ff",
  },
  Arbitrum_Sepolia: {
    bridgeId: "Arbitrum_Sepolia",
    chainId: "0x66eee",
    chainName: "Arbitrum Sepolia",
    label: "Arbitrum Sepolia",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
    dot: "#28a0f0",
  },
  Optimism_Sepolia: {
    bridgeId: "Optimism_Sepolia",
    chainId: "0xaa37dc",
    chainName: "OP Sepolia",
    label: "OP Sepolia",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.optimism.io"],
    blockExplorerUrls: ["https://sepolia-optimism.etherscan.io"],
    dot: "#ff0420",
  },
};

let isBridging = false;
// The currently selected external chain (the non-Arc side).
let selectedExternal: string = "Ethereum_Sepolia";
// Direction: into Arc (external -> Arc) or out of Arc (Arc -> external).
let bridgeToArc: boolean = true;

function setBridgeStep(id: string, state: "active"|"done"|"reset"): void {
  const s = el(id);
  if (!s) return;
  s.classList.remove("active","done");
  if (state !== "reset") s.classList.add(state);

  const dot  = s.querySelector(".bridge-step-dot") as HTMLElement | null;
  const span = s.querySelector("span") as HTMLElement | null;
  if (state === "done") {
    if (dot)  { dot.style.background = "#10b981"; dot.style.boxShadow = "0 0 5px rgba(16,185,129,0.6)"; }
    if (span) span.style.color = "#10b981";
    s.style.color = "#10b981";
  } else if (state === "active") {
    if (dot)  { dot.style.background = "#2563eb"; dot.style.boxShadow = "0 0 5px rgba(37,99,235,0.6)"; }
    if (span) span.style.color = "#f1f5f9";
    s.style.color = "#f1f5f9";
  } else {
    if (dot)  { dot.style.background = "#1e293b"; dot.style.boxShadow = "none"; }
    if (span) span.style.color = "#475569";
    s.style.color = "#475569";
  }
}

function showBridgeStatus(msg: string, type: "success"|"error"|"info"|""): void {
  const html = msg ? `<div class="status ${type}">${msg}</div>` : "";
  setHTML("bridge-status", html);
}

// Build the external-chain dropdown once.
function initBridgeChainSelector(): void {
  const sel = el<HTMLSelectElement>("bridge-external-select");
  if (!sel) return;
  sel.innerHTML = Object.values(EXTERNAL_CHAINS)
    .map(c => `<option value="${c.bridgeId}">${c.label}</option>`)
    .join("");
  sel.value = selectedExternal;
  sel.addEventListener("change", () => {
    selectedExternal = sel.value;
    renderBridgeChains();
  });
}

// Reflect current direction + selected chain in the UI.
function renderBridgeChains(): void {
  const ext = EXTERNAL_CHAINS[selectedExternal] || EXTERNAL_CHAINS.Ethereum_Sepolia;
  const from = bridgeToArc ? ext : ARC_CHAIN;
  const to   = bridgeToArc ? ARC_CHAIN : ext;

  setText("bridge-from-label", from.label);
  setText("bridge-to-label", to.label);
  setText("bridge-from-chainid", `Chain ${parseInt(from.chainId, 16)}`);
  setText("bridge-to-chainid", `Chain ${parseInt(to.chainId, 16)}`);

  const fromDot = document.querySelector("#bridge-from-name .chain-dot") as HTMLElement | null;
  const toDot   = el("bridge-to-dot");
  if (fromDot) fromDot.style.background = from.dot;
  if (toDot)   { toDot.style.background = to.dot; toDot.style.boxShadow = `0 0 6px ${to.dot}`; }

  // Keep the dropdown in sync with the selected external chain.
  const sel = el<HTMLSelectElement>("bridge-external-select");
  if (sel) sel.value = selectedExternal;

  setText("bstep-burn-label", `Burn USDC on ${from.label}`);
  setText("bstep-mint-label", `Mint USDC on ${to.label}`);
  setText("bridge-receive-label", `You receive on ${to.label}`);

  const bridgeBtn = el("bridge-btn");
  if (bridgeBtn) bridgeBtn.textContent = `Bridge to ${to.label} →`;
}

function flipBridgeDirection(): void {
  bridgeToArc = !bridgeToArc;
  renderBridgeChains();

  const amtInput = el<HTMLInputElement>("bridge-amount-input");
  if (amtInput) amtInput.value = "";
  setText("bridge-receive-amt","—");
  setHTML("bridge-status","");

  const flipBtn = el("bridge-flip-btn");
  if (flipBtn) {
    flipBtn.style.transform = bridgeToArc ? "rotate(0deg)" : "rotate(180deg)";
    flipBtn.style.borderColor = "var(--blue)";
    flipBtn.style.color = "var(--blue)";
    setTimeout(() => { if (flipBtn) { flipBtn.style.borderColor = ""; flipBtn.style.color = ""; } }, 400);
  }
}

async function executeBridge(): Promise<void> {
  if (isBridging) return;
  if (!window.ethereum) {
    showBridgeStatus("No wallet detected. Install MetaMask to bridge.", "error");
    return;
  }
  if (!ethersProvider || !userAddress) {
    showBridgeStatus("Connect your wallet first to bridge.", "error");
    return;
  }
  const amtInput = el<HTMLInputElement>("bridge-amount-input");
  const amount = amtInput?.value?.trim() ?? "";
  if (!amount || parseFloat(amount) <= 0) { showBridgeStatus("Enter an amount to bridge.","error"); return; }

  const ext = EXTERNAL_CHAINS[selectedExternal] || EXTERNAL_CHAINS.Ethereum_Sepolia;
  const fromDef = bridgeToArc ? ext : ARC_CHAIN;
  const toDef   = bridgeToArc ? ARC_CHAIN : ext;
  const fromChain = fromDef.bridgeId;
  const toChain   = toDef.bridgeId;
  const destName  = toDef.label;

  isBridging = true;
  const btn = el("bridge-btn");
  if (btn) { btn.setAttribute("disabled","true"); btn.textContent = "Bridging…"; }
  const stepsEl = el("bridge-steps");
  if (stepsEl) stepsEl.classList.add("visible");
  ["bstep-approve","bstep-burn","bstep-attest","bstep-mint"].forEach(id => setBridgeStep(id,"reset"));
  showBridgeStatus(`Switching to ${fromDef.label}…`,"info");

  try {
    // Switch wallet to source chain (add it if the wallet doesn't have it).
    try {
      await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:fromDef.chainId}] });
    } catch (e: any) {
      const code = e.code ?? e.error?.code ?? e.info?.error?.code;
      const msg  = e.message ?? "";
      if (code===4902||msg.includes("4902")||msg.includes("wallet_addEthereumChain")) {
        await window.ethereum.request({ method:"wallet_addEthereumChain", params:[{
          chainId: fromDef.chainId,
          chainName: fromDef.chainName,
          nativeCurrency: fromDef.nativeCurrency,
          rpcUrls: fromDef.rpcUrls,
          blockExplorerUrls: fromDef.blockExplorerUrls,
        }] });
      } else throw e;
    }

    showBridgeStatus("Confirm the transaction in MetaMask…","info");
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum as any });
    setBridgeStep("bstep-approve","active");

    const result = await (kit as any).bridge({
      from: { adapter, chain: fromChain },
      to:   { adapter, chain: toChain },
      amount,
      config: { kitKey: import.meta.env.VITE_KIT_KEY as string },
      onStatusChange: (status: any) => {
        const name = status?.currentStep?.name ?? "";
        if (name==="approve") { setBridgeStep("bstep-approve","active"); showBridgeStatus("Approve USDC spending…","info"); }
        if (name==="burn")    { setBridgeStep("bstep-approve","done"); setBridgeStep("bstep-burn","active"); showBridgeStatus("Burning USDC…","info"); }
        if (name==="attest")  { setBridgeStep("bstep-burn","done"); setBridgeStep("bstep-attest","active"); showBridgeStatus("Waiting for Circle attestation…","info"); }
        if (name==="mint")    { setBridgeStep("bstep-attest","done"); setBridgeStep("bstep-mint","active"); showBridgeStatus(`Minting USDC on ${destName}…`,"info"); }
      },
    });

    ["bstep-approve","bstep-burn","bstep-attest","bstep-mint"].forEach(id => setBridgeStep(id,"done"));
    const steps    = (result as any)?.steps ?? [];
    const lastStep = steps[steps.length - 1];
    const txHash   = lastStep?.data?.txHash
                  ?? lastStep?.txHash
                  ?? lastStep?.data?.transactionHash
                  ?? (result as any)?.txHash
                  ?? null;

    const baseUrl  = toDef.blockExplorerUrls[0];
    const explorerUrl = lastStep?.data?.explorerUrl
                     ?? (txHash ? `${baseUrl}/tx/${txHash}` : `${baseUrl}/address/${userAddress}`);

    setHTML("bridge-status",`<div class="status success"><div class="status-title">✅ Bridge complete</div><div class="status-row"><span>${amount} USDC</span><span class="arrow">→</span><strong>${amount} USDC on ${destName}</strong></div><a class="explorer-link" href="${explorerUrl}" target="_blank" rel="noopener">View on explorer ↗</a></div>`);
    if (amtInput) amtInput.value = "";

    // Switch back to Arc and reinitialize provider so the wallet stays on Arc.
    try {
      await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:ARC_CHAIN.chainId}] });
      await new Promise(r => setTimeout(r, 500));
      ethersProvider = new BrowserProvider(window.ethereum!);
      ethersSigner   = await ethersProvider.getSigner();
      await loadBalances();
    } catch { /* non-critical */ }

  } catch (err: any) {
    ["bstep-approve","bstep-burn","bstep-attest","bstep-mint"].forEach(id => setBridgeStep(id,"reset"));
    if (stepsEl) stepsEl.classList.remove("visible");
    showBridgeStatus(err.code===4001||err.message?.includes("rejected") ? "Transaction rejected." : `Bridge failed: ${err.message??"Unknown error"}`,"error");
  } finally {
    isBridging = false;
    if (btn) {
      btn.removeAttribute("disabled");
      const toDef2 = bridgeToArc ? ARC_CHAIN : (EXTERNAL_CHAINS[selectedExternal] || EXTERNAL_CHAINS.Ethereum_Sepolia);
      btn.textContent = `Bridge to ${toDef2.label} →`;
    }
  }
}

function updateBridgeReceiveAmt(e: Event): void {
  const val = (e.target as HTMLInputElement).value;
  setText("bridge-receive-amt", parseFloat(val)>0 ? `${parseFloat(val).toFixed(2)} USDC` : "—");
}


// ─── Transaction History ──────────────────────────────────────────────────────

const ARCSCAN_API = "https://testnet.arcscan.app/api/v2";
const USDC_ADDR   = "0x3600000000000000000000000000000000000000";
const EURC_ADDR   = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

function timeAgo(dateStr: string): string {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)   return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function formatAmount(value: string, decimals: string): string {
  const dec = parseInt(decimals) || 6;
  const amt = parseFloat(value) / Math.pow(10, dec);
  return amt.toFixed(amt < 1 ? 4 : 2);
}

function tokenSymbol(addr: string): string {
  if (addr.toLowerCase() === USDC_ADDR.toLowerCase()) return "USDC";
  if (addr.toLowerCase() === EURC_ADDR.toLowerCase()) return "EURC";
  return "TOKEN";
}

async function loadHistory(): Promise<void> {
  const historyEl = el("history-content");
  if (!historyEl) return;

  if (!userAddress || !ethersProvider) {
    historyEl.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--muted);font-size:13px;">Connect your wallet to view transaction history</div>`;
    return;
  }

  historyEl.innerHTML = `<div class="history-loading">Loading transactions</div>`;

  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const paddedAddr = "0x000000000000000000000000" + userAddress.slice(2).toLowerCase();

  try {
    const latestBlock = await ethersProvider.getBlockNumber();
    // Use 20k blocks (~2.8 hours at 0.5s blocks) — stays within RPC limits
    const fromBlock = Math.max(0, latestBlock - 20000);

    // Chunked getLogs — split into 5k block chunks to avoid RPC limits
    const safeGetLogs = async (filter: any) => {
      const results: any[] = [];
      const chunkSize = 5000;
      for (let from = filter.fromBlock; from <= filter.toBlock; from += chunkSize) {
        const to = Math.min(from + chunkSize - 1, filter.toBlock);
        try {
          const logs = await ethersProvider!.getLogs({ ...filter, fromBlock: from, toBlock: to });
          results.push(...logs);
        } catch { /* skip failed chunk */ }
      }
      return results;
    };

    const [usdcOut, usdcIn, eurcOut, eurcIn] = await Promise.all([
      safeGetLogs({ fromBlock, toBlock: latestBlock, address: USDC_ADDR, topics: [TRANSFER_TOPIC, paddedAddr, null] }),
      safeGetLogs({ fromBlock, toBlock: latestBlock, address: USDC_ADDR, topics: [TRANSFER_TOPIC, null, paddedAddr] }),
      safeGetLogs({ fromBlock, toBlock: latestBlock, address: EURC_ADDR, topics: [TRANSFER_TOPIC, paddedAddr, null] }),
      safeGetLogs({ fromBlock, toBlock: latestBlock, address: EURC_ADDR, topics: [TRANSFER_TOPIC, null, paddedAddr] }),
    ]);

    // Combine and tag each log
    type TaggedLog = { log: any; sym: string; direction: "out"|"in" };
    const tagged: TaggedLog[] = [
      ...usdcOut.map(l => ({ log: l, sym: "USDC", direction: "out" as const })),
      ...usdcIn.map(l  => ({ log: l, sym: "USDC", direction: "in"  as const })),
      ...eurcOut.map(l => ({ log: l, sym: "EURC", direction: "out" as const })),
      ...eurcIn.map(l  => ({ log: l, sym: "EURC", direction: "in"  as const })),
    ];

    // Deduplicate by txHash + direction (swaps appear in both in and out)
    const seen = new Set<string>();
    const deduped = tagged.filter(t => {
      const key = t.log.transactionHash + t.direction;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (deduped.length === 0) {
      historyEl.innerHTML = `
        <div style="text-align:center;padding:32px 0;color:var(--muted);font-size:13px;">
          No transactions found yet.<br>
          <span style="font-size:11px;margin-top:6px;display:block;">Make your first swap above to see history here!</span>
          <a href="https://testnet.arcscan.app/address/${userAddress}" target="_blank" rel="noopener" style="color:var(--blue);font-size:11px;margin-top:8px;display:block;">View on ArcScan ↗</a>
        </div>`;
      return;
    }

    // Sort by block number descending (newest first)
    deduped.sort((a, b) => b.log.blockNumber - a.log.blockNumber);

    // Group by txHash to detect swaps (tx has both USDC out and EURC in, or vice versa)
    const txGroups = new Map<string, TaggedLog[]>();
    deduped.forEach(t => {
      const hash = t.log.transactionHash;
      if (!txGroups.has(hash)) txGroups.set(hash, []);
      txGroups.get(hash)!.push(t);
    });

    // Build rows — one row per unique tx
    const rows: string[] = [];
    const processedTx = new Set<string>();

    for (const t of deduped) {
      const hash = t.log.transactionHash;
      if (processedTx.has(hash)) continue;
      processedTx.add(hash);

      const group  = txGroups.get(hash) ?? [t];
      const isSwap = group.some(g => g.sym === "USDC") && group.some(g => g.sym === "EURC");
      const isBridge = group.some(g => g.direction === "in") && group.length === 1 && group[0].sym === "USDC";
      const blockNum = t.log.blockNumber;
      const short  = `${hash.slice(0,6)}...${hash.slice(-4)}`;
      const url    = `https://testnet.arcscan.app/tx/${hash}`;

      let typeLabel: string;
      let icon: string;
      let iconClass: string;
      let amtDisplay: string;
      let amtClass: string;

      if (isSwap) {
        // Find what went out and what came in
        const outItem  = group.find(g => g.direction === "out");
        const inItem   = group.find(g => g.direction === "in");
        const outAmt   = outItem ? (Number(BigInt(outItem.log.data ?? "0x0")) / 1e6).toFixed(4) : "?";
        const inAmt    = inItem  ? (Number(BigInt(inItem.log.data  ?? "0x0")) / 1e6).toFixed(4) : "?";
        const outSym   = outItem?.sym ?? "USDC";
        const inSym    = inItem?.sym  ?? "EURC";
        typeLabel  = `Swap ${outSym} → ${inSym}`;
        icon       = "⇄";
        iconClass  = "tx-icon-swap";
        amtDisplay = `${outAmt} → ${inAmt}`;
        amtClass   = "";
      } else {
        const amt = t.log.data ? (Number(BigInt(t.log.data)) / 1e6).toFixed(4) : "0.00";
        if (t.direction === "out") {
          typeLabel = `Sent ${t.sym}`;
          icon = "↑";
          iconClass = "tx-icon-out";
          amtDisplay = `−${amt}`;
          amtClass = "tx-out";
        } else {
          typeLabel = `Received ${t.sym}`;
          icon = "↓";
          iconClass = "tx-icon-in";
          amtDisplay = `+${amt}`;
          amtClass = "tx-in";
        }
      }

      rows.push(`
        <div class="tx-row">
          <div class="tx-icon ${iconClass}">${icon}</div>
          <div class="tx-info">
            <div class="tx-type">${typeLabel}</div>
            <div class="tx-time">Block ${blockNum.toLocaleString()}</div>
          </div>
          <div class="tx-amount">
            <div class="tx-amount-val ${amtClass}" style="font-size:12px;">${amtDisplay}</div>
            <div class="tx-amount-token">${isSwap ? "USDC/EURC" : t.sym}</div>
          </div>
          <a class="tx-link" href="${url}" target="_blank" rel="noopener">${short} ↗</a>
        </div>`);

      if (rows.length >= 15) break;
    }

    historyEl.innerHTML = rows.join("") + `
      <div style="text-align:center;padding:14px 0 4px;font-size:11px;color:var(--muted);">
        <a href="https://testnet.arcscan.app/address/${userAddress}" target="_blank" rel="noopener" style="color:var(--blue);">View full history on ArcScan ↗</a>
      </div>`;

  } catch (err: any) {
    historyEl.innerHTML = `
      <div style="text-align:center;padding:28px 0;color:var(--muted);font-size:13px;">
        Could not load history.<br>
        <a href="https://testnet.arcscan.app/address/${userAddress}" target="_blank" rel="noopener" style="color:var(--blue);margin-top:8px;display:block;">View on ArcScan ↗</a>
      </div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // The nav's connect button is rendered by the shared header, which calls
  // window.connectWallet on click — expose it here (avoids a duplicate listener).
  (window as any).connectWallet = connectWallet;
  // The big connect button in the swap card is page-local — wire it directly.
  el("big-connect-btn")?.addEventListener("click", connectWallet);

  // Swap widget controls
  el("flip-btn")?.addEventListener("click", flipTokens);
  initSwapSelectors();
  renderSwapTokens();
  el("swap-btn")?.addEventListener("click", executeSwap);         // hidden compat button
  el("execute-swap-btn")?.addEventListener("click", executeSwap); // new visible button
  el("max-btn")?.addEventListener("click", setMaxAmount);
  el("amount-input")?.addEventListener("input", debounce(
    (e: Event) => estimateSwap((e.target as HTMLInputElement).value), 500
  ));
  // Account and chain changes arrive through the shared session, which also
  // performs the silent restore on load — so Trade never asks for a connection
  // the nav already holds.
  arcfxWallet.onChange(state => {
    if (isBridging) return; // the bridge switches chains on purpose
    adoptSession(state).catch(err => {
      console.error("[trade] could not adopt wallet session:", err);
      showStatus("Wallet session could not be restored. Click connect to retry.", "error");
    });
  });

  // Bridge events
  el("bridge-btn")?.addEventListener("click", executeBridge);
  el("bridge-amount-input")?.addEventListener("input", updateBridgeReceiveAmt);
  initBridgeChainSelector();
  renderBridgeChains();

  // Expose functions globally so inline HTML onclick can reach them
  (window as any).executeBridge = executeBridge;
  (window as any).updateBridgeReceiveAmt = updateBridgeReceiveAmt;
  (window as any).flipBridgeDirection = flipBridgeDirection;
  (window as any).toggleTokenMenu = toggleTokenMenu;
  (window as any).loadHistory = loadHistory;

});

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}
