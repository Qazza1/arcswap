/**
 * fx-swap-widget — src/main.ts
 * Stablecoin FX swap widget on Arc Testnet. Swaps USDC <-> EURC.
 */

import "./styles/globals.css";
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
    await loadHistory();

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


// ─── Bridge Config ────────────────────────────────────────────────────────────
const ETHEREUM_SEPOLIA = {
  chainId: "0xaa36a7",
  chainName: "Ethereum Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.sepolia.org"],
  blockExplorerUrls: ["https://sepolia.etherscan.io"],
};

let isBridging = false;
let bridgeDirection: "to-arc" | "to-sepolia" = "to-arc";

function setBridgeStep(id: string, state: "active"|"done"|"reset"): void {
  const s = el(id);
  if (!s) return;
  s.classList.remove("active","done");
  if (state !== "reset") s.classList.add(state);
}

function showBridgeStatus(msg: string, type: "success"|"error"|"info"|""): void {
  const html = msg ? `<div class="status ${type}">${msg}</div>` : "";
  setHTML("bridge-status", html);
  setHTML("bridge-global-status", html);
}

function flipBridgeDirection(): void {
  bridgeDirection = bridgeDirection === "to-arc" ? "to-sepolia" : "to-arc";
  const toArc = bridgeDirection === "to-arc";

  // Update from/to labels
  const fromLabel = document.getElementById("bridge-from-label");
  const toLabel   = document.getElementById("bridge-to-label");
  const toDot     = document.getElementById("bridge-to-dot");
  const fromDot   = document.querySelector("#bridge-from-name .chain-dot") as HTMLElement;
  const recvLabel = document.getElementById("bridge-receive-label");
  const burnLabel = document.getElementById("bstep-burn-label");
  const mintLabel = document.getElementById("bstep-mint-label");
  const bridgeBtn = el("bridge-btn");

  if (toArc) {
    if (fromLabel) fromLabel.textContent = "Ethereum Sepolia";
    if (toLabel)   toLabel.textContent   = "Arc Testnet";
    if (fromDot)   fromDot.style.background = "#627eea";
    if (toDot)   { toDot.style.background = "#4e8ef7"; toDot.style.boxShadow = "0 0 6px #4e8ef7"; }
    if (recvLabel) recvLabel.textContent = "You receive on Arc";
    if (burnLabel) burnLabel.textContent = "Burn USDC on Ethereum Sepolia";
    if (mintLabel) mintLabel.textContent = "Mint USDC on Arc Testnet";
    if (bridgeBtn) bridgeBtn.textContent = "Bridge to Arc →";
  } else {
    if (fromLabel) fromLabel.textContent = "Arc Testnet";
    if (toLabel)   toLabel.textContent   = "Ethereum Sepolia";
    if (fromDot)   fromDot.style.background = "#4e8ef7";
    if (toDot)   { toDot.style.background = "#627eea"; toDot.style.boxShadow = "none"; }
    if (recvLabel) recvLabel.textContent = "You receive on Sepolia";
    if (burnLabel) burnLabel.textContent = "Burn USDC on Arc Testnet";
    if (mintLabel) mintLabel.textContent = "Mint USDC on Ethereum Sepolia";
    if (bridgeBtn) bridgeBtn.textContent = "Bridge to Sepolia →";
  }

  // Reset amount and status
  const amtInput = el<HTMLInputElement>("bridge-amount-input");
  if (amtInput) amtInput.value = "";
  setText("bridge-receive-amt","—");
  setHTML("bridge-status","");

  // Rotate the flip button
  const flipBtn = el("bridge-flip-btn");
  if (flipBtn) {
    flipBtn.style.transform = toArc ? "rotate(0deg)" : "rotate(180deg)";
    flipBtn.style.borderColor = "var(--blue)";
    flipBtn.style.color = "var(--blue)";
    setTimeout(() => {
      if (flipBtn) { flipBtn.style.borderColor = ""; flipBtn.style.color = ""; }
    }, 400);
  }
}

async function executeBridge(): Promise<void> {
  if (isBridging || !window.ethereum) return;
  const amtInput = el<HTMLInputElement>("bridge-amount-input");
  const amount   = amtInput?.value.trim() ?? "";
  if (!amount || parseFloat(amount) <= 0) { showBridgeStatus("Enter an amount to bridge.","error"); return; }

  const toArc     = bridgeDirection === "to-arc";
  const fromChain = toArc ? "Ethereum_Sepolia" : "Arc_Testnet";
  const toChain   = toArc ? "Arc_Testnet"       : "Ethereum_Sepolia";
  const switchTo  = toArc ? ETHEREUM_SEPOLIA     : ARC_TESTNET;
  const destName  = toArc ? "Arc Testnet"        : "Ethereum Sepolia";

  isBridging = true;
  const btn = el("bridge-btn");
  if (btn) { btn.setAttribute("disabled","true"); btn.textContent = "Bridging…"; }
  const stepsEl = el("bridge-steps");
  if (stepsEl) stepsEl.classList.add("visible");
  ["bstep-approve","bstep-burn","bstep-attest","bstep-mint"].forEach(id => setBridgeStep(id,"reset"));
  showBridgeStatus(`Switching to ${toArc ? "Ethereum Sepolia" : "Arc Testnet"}…`,"info");

  try {
    // Switch wallet to source chain
    try {
      await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:switchTo.chainId}] });
    } catch (e: any) {
      const code = e.code ?? e.error?.code ?? e.info?.error?.code;
      const msg  = e.message ?? "";
      if (code===4902||msg.includes("4902")||msg.includes("wallet_addEthereumChain")) {
        await window.ethereum.request({ method:"wallet_addEthereumChain", params:[switchTo] });
      } else throw e;
    }

    showBridgeStatus("Confirm the transaction in MetaMask…","info");
    const adapter = await createViemAdapterFromProvider({ provider: window.ethereum });
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
    const last = (result as any)?.steps?.[(result as any).steps.length-1];
    const explorerUrl = last?.data?.explorerUrl ?? (toArc ? "https://testnet.arcscan.app" : "https://sepolia.etherscan.io");

    setHTML("bridge-status",`<div class="status success"><div class="status-title">✅ Bridge complete</div><div class="status-row"><span>${amount} USDC</span><span class="arrow">→</span><strong>${amount} USDC on ${destName}</strong></div><a class="explorer-link" href="${explorerUrl}" target="_blank" rel="noopener">View on explorer ↗</a></div>`);
    if (amtInput) amtInput.value = "";

    // Switch back to Arc and refresh balances
    try {
      await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:ARC_TESTNET.chainId}] });
      await loadBalances();
    } catch { /* non-critical */ }

  } catch (err: any) {
    ["bstep-approve","bstep-burn","bstep-attest","bstep-mint"].forEach(id => setBridgeStep(id,"reset"));
    if (stepsEl) stepsEl.classList.remove("visible");
    showBridgeStatus(err.code===4001||err.message?.includes("rejected") ? "Transaction rejected." : `Bridge failed: ${err.message??"Unknown error"}`,"error");
  } finally {
    // Set isBridging false BEFORE switching back so chainChanged doesn't reload
    isBridging = false;
    if (btn) {
      btn.removeAttribute("disabled");
      btn.textContent = bridgeDirection === "to-arc" ? "Bridge to Arc →" : "Bridge to Sepolia →";
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
    // Use 50k block range — enough for testnet history without timing out
    const fromBlock = Math.max(0, latestBlock - 50000);

    // Fetch each combination individually so one failure doesn't kill all
    const safeGetLogs = async (filter: any) => {
      try { return await ethersProvider!.getLogs(filter); } catch { return []; }
    };

    const [usdcOut, usdcIn, eurcOut, eurcIn] = await Promise.all([
      safeGetLogs({ fromBlock, address: USDC_ADDR, topics: [TRANSFER_TOPIC, paddedAddr, null] }),
      safeGetLogs({ fromBlock, address: USDC_ADDR, topics: [TRANSFER_TOPIC, null, paddedAddr] }),
      safeGetLogs({ fromBlock, address: EURC_ADDR, topics: [TRANSFER_TOPIC, paddedAddr, null] }),
      safeGetLogs({ fromBlock, address: EURC_ADDR, topics: [TRANSFER_TOPIC, null, paddedAddr] }),
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
  el("connect-btn")?.addEventListener("click", connectWallet);
  el("big-connect-btn")?.addEventListener("click", connectWallet);
  el("flip-btn")?.addEventListener("click", flipTokens);
  el("swap-btn")?.addEventListener("click", executeSwap);
  el("max-btn")?.addEventListener("click", setMaxAmount);
  el("amount-input")?.addEventListener("input", debounce(
    (e: Event) => estimateSwap((e.target as HTMLInputElement).value), 500
  ));
  window.ethereum?.on("accountsChanged", (a: string[]) => { userAddress = a[0] ?? null; if (userAddress) loadBalances(); });
  window.ethereum?.on("chainChanged", () => {
    // Don't reload during bridge — it switches chains intentionally
    if (!isBridging) window.location.reload();
  });

  // Bridge events
  el("bridge-btn")?.addEventListener("click", executeBridge);
  el("bridge-amount-input")?.addEventListener("input", updateBridgeReceiveAmt);

  // Expose functions globally so inline HTML onclick can reach them
  (window as any).executeBridge = executeBridge;
  (window as any).updateBridgeReceiveAmt = updateBridgeReceiveAmt;
  (window as any).flipBridgeDirection = flipBridgeDirection;
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
import "preline";
