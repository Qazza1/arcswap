/**
 * fx-swap-widget — src/main.ts
 * Stablecoin FX swap widget on Arc Testnet. Swaps USDC <-> EURC.
 */

import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { BrowserProvider, Contract, formatUnits } from "ethers";

const ARC_TESTNET = {
  chainId: "0x4CEF52",
  chainName: "Arc Network Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const TOKENS = {
  USDC: { address: "0x3600000000000000000000000000000000000000", decimals: 6, flag: "🇺🇸" },
  EURC: { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6, flag: "🇪🇺" },
} as const;

type TokenSymbol = keyof typeof TOKENS;
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

let ethersProvider: BrowserProvider | null = null;
let userAddress: string | null = null;
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

// Status: writes to both elements so it works before and after wallet connect
function showStatus(msg: string, type: "success"|"error"|"info"|""): void {
  const html = msg ? `<div class="status ${type}">${msg}</div>` : "";
  setHTML("global-status", html);
  setHTML("swap-status", html);
}

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    showStatus("MetaMask not found — install it from metamask.io", "error");
    return;
  }
  const btn = el("connect-btn");
  try {
    if (btn) btn.textContent = "Connecting…";
    ethersProvider = new BrowserProvider(window.ethereum);
    const accounts: string[] = await ethersProvider.send("eth_requestAccounts", []);
    userAddress = accounts[0];

    try {
      await ethersProvider.send("wallet_switchEthereumChain", [{ chainId: ARC_TESTNET.chainId }]);
    } catch (e: any) {
      const code = e.code ?? e.error?.code ?? e.info?.error?.code;
      const msg  = e.message ?? "";
      const is4902 = code === 4902 || msg.includes("4902") || msg.includes("wallet_addEthereumChain");
      if (is4902) {
        try {
          await ethersProvider.send("wallet_addEthereumChain", [ARC_TESTNET]);
        } catch (addErr: any) {
          // If network already exists with same RPC, just switch to it
          const addMsg = addErr.message ?? "";
          if (addMsg.includes("already") || addMsg.includes("same RPC") || addMsg.includes("existing")) {
            await ethersProvider.send("wallet_switchEthereumChain", [{ chainId: ARC_TESTNET.chainId }]);
          } else throw addErr;
        }
      } else throw e;
    }

    const short = `${userAddress.slice(0, 6)}…${userAddress.slice(-4)}`;
    if (btn) { btn.textContent = short; btn.classList.add("connected"); }
    removeClass("swap-card", "hidden");
    addClass("connect-card", "hidden");
    showStatus("Connected to Arc Testnet ✓", "success");
    await loadBalances();

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
      setText(`balance-${sym}`, parseFloat(formatUnits(raw, token.decimals)).toFixed(4));
    } catch { setText(`balance-${sym}`, "—"); }
  }
  updateBalanceLabels();
}

function updateBalanceLabels(): void {
  setText("balance-in-label",  `Balance: ${el(`balance-${tokenIn}`)?.textContent  ?? "—"} ${tokenIn}`);
  setText("balance-out-label", `Balance: ${el(`balance-${tokenOut}`)?.textContent ?? "—"} ${tokenOut}`);
}

function flipTokens(): void {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  setText("token-in-symbol",  tokenIn);
  setText("token-out-symbol", tokenOut);
  setText("token-in-flag",    TOKENS[tokenIn].flag);
  setText("token-out-flag",   TOKENS[tokenOut].flag);
  updateBalanceLabels();
  const inp = el<HTMLInputElement>("amount-input");
  if (inp) inp.value = "";
  setText("estimate-output", "—");
  addClass("estimate-row", "hidden");
  showStatus("", "");
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
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum });
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
  } catch {
    setText("estimate-output", "Rate unavailable");
    setText("estimate-fee", "");
  }
}

async function executeSwap(): Promise<void> {
  if (isSwapping || !window.ethereum) return;
  const inp = el<HTMLInputElement>("amount-input");
  const amount = inp?.value.trim() ?? "";
  if (!amount || parseFloat(amount) <= 0) { showStatus("Enter an amount.", "error"); return; }

  isSwapping = true;
  const btn = el("swap-btn");
  if (btn) { btn.setAttribute("disabled","true"); btn.textContent = "Swapping…"; }
  showStatus("Confirm in MetaMask…", "info");

  try {
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum });
    const result = await kit.swap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn, tokenOut, amountIn: amount,
      config: { kitKey: import.meta.env.VITE_KIT_KEY as string },
    });
    const fee = result.fees?.[0];
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
    showStatus(err.code === 4001 ? "Transaction rejected." : `Swap failed: ${err.message ?? "Unknown error"}`, "error");
  } finally {
    isSwapping = false;
    if (btn) { btn.removeAttribute("disabled"); btn.textContent = "Swap"; }
  }
}

function setMaxAmount(): void {
  const bal = el(`balance-${tokenIn}`)?.textContent;
  const inp = el<HTMLInputElement>("amount-input");
  if (bal && bal !== "—" && inp) { inp.value = bal; estimateSwap(bal); }
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>;
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

document.addEventListener("DOMContentLoaded", () => {
  el("connect-btn")?.addEventListener("click", connectWallet);
  el("big-connect-btn")?.addEventListener("click", connectWallet);
  el("flip-btn")?.addEventListener("click", flipTokens);
  el("swap-btn")?.addEventListener("click", executeSwap);
  el("max-btn")?.addEventListener("click", setMaxAmount);
  el("amount-input")?.addEventListener("input", debounce(
    (e: Event) => estimateSwap((e.target as HTMLInputElement).value), 500
  ));
  window.ethereum?.on("accountsChanged", (a: string[]) => { userAddress = a[0] ?? null; if (userAddress) loadBalances(); });
  window.ethereum?.on("chainChanged", () => window.location.reload());
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
