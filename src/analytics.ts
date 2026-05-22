/**
 * analytics.ts — Live Arc Testnet data for ArcFX Analytics dashboard.
 * Read-only: uses JsonRpcProvider, no wallet required.
 */

import { JsonRpcProvider, Contract, formatUnits, id as keccak256id } from "ethers";

// ── Config ────────────────────────────────────────────────────────────────

const ARC_RPC = "https://rpc.testnet.arc.network";

const ADDR = {
  USDC:        "0x3600000000000000000000000000000000000000",
  EURC:        "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PAYMENTS:    "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
  MULTISENDER: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
};

// Event topics
const PAYMENT_TOPIC  = keccak256id("PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)");
const TRANSFER_TOPIC = keccak256id("Transfer(address,address,uint256)");

const ERC20_ABI = ["function totalSupply() view returns (uint256)"];

const provider = new JsonRpcProvider(ARC_RPC);

// Chunked getLogs — splits large block ranges into 5k chunks to avoid RPC limits
async function safeGetLogs(filter: {
  address?: string; topics?: any[]; fromBlock: number; toBlock: number;
}): Promise<any[]> {
  const results: any[] = [];
  const chunkSize = 5_000;
  for (let from = filter.fromBlock; from <= filter.toBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, filter.toBlock);
    try {
      const logs = await safeGetLogs({ ...filter, fromBlock: from, toBlock: to });
      results.push(...logs);
    } catch (e) {
      console.warn(`getLogs chunk ${from}-${to} failed:`, e);
    }
  }
  return results;
}

// ── DOM helpers ───────────────────────────────────────────────────────────

const el  = (id: string) => document.getElementById(id);
const txt = (id: string, val: string) => { const n = el(id); if (n) n.textContent = val; };

function fmtSupply(raw: bigint, dec = 6): string {
  const n = Number(formatUnits(raw, dec));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function short(addr: string): string   { return `${addr.slice(0,8)}…${addr.slice(-6)}`; }
function shortHash(h: string): string  { return `${h.slice(0,8)}…${h.slice(-4)}`; }

// ── Network stats ─────────────────────────────────────────────────────────

async function fetchNetwork(): Promise<void> {
  const latest = await provider.getBlockNumber();
  txt("stat-block", latest.toLocaleString());
  txt("stat-block-sub", "Arc Testnet");

  try {
    const [bNow, bOld] = await Promise.all([
      provider.getBlock(latest),
      provider.getBlock(Math.max(1, latest - 10)),
    ]);
    if (bNow?.timestamp && bOld?.timestamp) {
      const avg = (bNow.timestamp - bOld.timestamp) / 10;
      txt("stat-blocktime", `${avg.toFixed(1)}s`);
    }
  } catch { txt("stat-blocktime", "~1.0s"); }

  for (const [key, addr] of [["stat-usdc-supply", ADDR.USDC], ["stat-eurc-supply", ADDR.EURC]] as const) {
    try {
      const c = new Contract(addr, ERC20_ABI, provider);
      txt(key, fmtSupply(await c.totalSupply(), 6));
    } catch { txt(key, "—"); }
  }
}

// ── Protocol data ─────────────────────────────────────────────────────────

interface TxEntry {
  type:     "Pay" | "Multisend" | "Swap" | "Bridge";
  token:    string;
  amount:   bigint;
  from:     string;
  blockNum: number;
  txHash:   string;
}

async function fetchProtocol(): Promise<void> {
  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 20_000); // ~2.8hrs at 0.5s blocks
  const entries:  TxEntry[] = [];

  // ── 1. PaymentExecuted events from ArcFXPayments ──────────────────────
  try {
    const logs = await safeGetLogs({
      address: ADDR.PAYMENTS, topics: [PAYMENT_TOPIC], fromBlock, toBlock: latest,
    });
    for (const log of logs) {
      try {
        const payer = "0x" + log.topics[2].slice(26);
        const d     = log.data.slice(2);
        const token = "0x" + d.slice(24, 64);
        const gross = BigInt("0x" + d.slice(64, 128));
        entries.push({ type:"Pay", token, amount:gross, from:payer, blockNum:log.blockNumber, txHash:log.transactionHash });
      } catch { /* skip malformed */ }
    }
  } catch(e) { console.warn("PaymentExecuted getLogs failed:", e); }

  // ── 2. USDC/EURC transfers TO Multisender (= multisend transactions) ──
  const multisenderPadded = "0x000000000000000000000000" + ADDR.MULTISENDER.slice(2).toLowerCase();
  for (const tokenAddr of [ADDR.USDC, ADDR.EURC]) {
    try {
      const logs = await safeGetLogs({
        address: tokenAddr, topics: [TRANSFER_TOPIC, null, multisenderPadded], fromBlock, toBlock: latest,
      });
      for (const log of logs) {
        try {
          const from   = "0x" + log.topics[1].slice(26);
          const amount = BigInt(log.data);
          entries.push({ type:"Multisend", token:tokenAddr, amount, from, blockNum:log.blockNumber, txHash:log.transactionHash });
        } catch { /* skip */ }
      }
    } catch(e) { console.warn("Multisend getLogs failed:", e); }
  }

  // ── 3. USDC/EURC swap activity — detect by Circle App Kit router transfers
  // Swaps show as Transfer events where from = user, to = USDC/EURC contract or swap router
  // We track all USDC/EURC transfers NOT involving known contracts as "Swap/Other"
  const knownContracts = new Set([
    ADDR.PAYMENTS.toLowerCase(),
    ADDR.MULTISENDER.toLowerCase(),
    ADDR.USDC.toLowerCase(),
    ADDR.EURC.toLowerCase(),
  ]);

  for (const tokenAddr of [ADDR.USDC, ADDR.EURC]) {
    try {
      const logs = await safeGetLogs({
        address: tokenAddr, topics: [TRANSFER_TOPIC], fromBlock, toBlock: latest,
      });
      for (const log of logs) {
        try {
          // Skip if already captured (multisend, payment)
          const alreadyCaptured = entries.some(e => e.txHash === log.transactionHash);
          if (alreadyCaptured) continue;

          const from = "0x" + log.topics[1].slice(26);
          const to   = "0x" + log.topics[2].slice(26);

          // Skip contract-to-contract transfers and zero address
          if (from === "0x0000000000000000000000000000000000000000") continue;
          if (knownContracts.has(from.toLowerCase()) && knownContracts.has(to.toLowerCase())) continue;

          const amount = BigInt(log.data);
          if (amount === 0n) continue;

          entries.push({
            type: "Swap",
            token: tokenAddr,
            amount,
            from,
            blockNum: log.blockNumber,
            txHash:   log.transactionHash,
          });
        } catch { /* skip */ }
      }
    } catch(e) { console.warn("Transfer getLogs failed:", e); }
  }

  // ── Stats ─────────────────────────────────────────────────────────────
  const totalVol  = entries.reduce((s, e) => s + e.amount, 0n);
  const txCount = entries.length;
  const wallets   = new Set(entries.map(e => e.from.toLowerCase())).size;
  const count     = entries.length;
  const avgTrade  = count > 0 ? Number(formatUnits(totalVol / BigInt(count), 6)) : 0;

  txt("stat-volume",    count ? fmtUSD(Number(formatUnits(totalVol, 6))) : "$0.00");
  txt("stat-revenue",   txCount.toString());
  txt("stat-wallets",   wallets.toString() || "0");
  txt("stat-avg-trade", count ? fmtUSD(avgTrade) : "$0.00");

  // ── Live feed ─────────────────────────────────────────────────────────
  const feedBody = el("feed-body");
  if (!feedBody) return;

  if (!count) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No transactions found on Arc Testnet yet</td></tr>`;
    return;
  }

  // Deduplicate by txHash, sort newest first
  const seen    = new Set<string>();
  const unique  = entries.filter(e => { if (seen.has(e.txHash)) return false; seen.add(e.txHash); return true; });
  const sorted  = unique.sort((a, b) => b.blockNum - a.blockNum).slice(0, 20);

  const badgeClass: Record<string, string> = {
    Pay:       "badge-pay",
    Multisend: "badge-multisend",
    Swap:      "badge-swap",
    Bridge:    "badge-pay",
  };

  feedBody.innerHTML = sorted.map(tx => {
    const isUSDC = tx.token.toLowerCase() === ADDR.USDC.toLowerCase();
    const sym    = isUSDC ? "USDC" : "EURC";
    const amount = Number(formatUnits(tx.amount, 6)).toFixed(4);
    const url    = `https://testnet.arcscan.app/tx/${tx.txHash}`;
    return `
      <tr>
        <td><span class="type-badge ${badgeClass[tx.type] || 'badge-pay'}">${tx.type}</span></td>
        <td><span class="feed-amount">${amount} ${sym}</span></td>
        <td><span class="feed-addr">${short(tx.from)}</span></td>
        <td class="hide-sm"><span class="feed-block">${tx.blockNum.toLocaleString()}</span></td>
        <td><a href="${url}" target="_blank" rel="noopener" class="arcscan-link">${shortHash(tx.txHash)} ↗</a></td>
      </tr>`;
  }).join("");
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refreshAll(): Promise<void> {
  const btn = el("refresh-btn");
  if (btn) btn.classList.add("loading");

  try {
    await Promise.all([fetchNetwork(), fetchProtocol()]);
    txt("last-updated", new Date().toLocaleTimeString());
    const errBanner = el("fetch-error");
    if (errBanner) errBanner.style.display = "none";
  } catch (err: any) {
    console.error(err);
    const errBanner = el("fetch-error");
    if (errBanner) {
      errBanner.textContent = `RPC error: ${err.message || "Could not reach Arc Testnet"}`;
      errBanner.style.display = "block";
    }
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

(window as any).refreshAll = refreshAll;

// Init
refreshAll();
setInterval(refreshAll, 15_000);
