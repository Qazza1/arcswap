/**
 * analytics.ts — Live Arc Testnet data.
 * Uses same getLogs approach as history tab (which works).
 */

import { JsonRpcProvider, Contract, formatUnits, id as keccak256id } from "ethers";

const ARC_RPC = "https://rpc.testnet.arc.network";

const ADDR = {
  USDC:        "0x3600000000000000000000000000000000000000",
  EURC:        "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PAYMENTS:    "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
  MULTISENDER: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
};

// Same Transfer topic as history tab (works confirmed)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYMENT_TOPIC  = keccak256id("PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)");

const ERC20_ABI = ["function totalSupply() view returns (uint256)"];
const provider  = new JsonRpcProvider(ARC_RPC);

// ── DOM helpers ───────────────────────────────────────────────────────────
const el  = (id: string) => document.getElementById(id);
const txt = (id: string, val: string) => { const n = el(id); if (n) n.textContent = val; };

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}
function short(a: string): string  { return `${a.slice(0,8)}…${a.slice(-6)}`; }
function shortH(h: string): string { return `${h.slice(0,8)}…${h.slice(-4)}`; }

// ── Chunked getLogs — exact same pattern as history tab ───────────────────
async function safeGetLogs(filter: {
  address?: string; topics?: any[]; fromBlock: number; toBlock: number;
}): Promise<any[]> {
  const results: any[] = [];
  const chunk = 5000;
  for (let from = filter.fromBlock; from <= filter.toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, filter.toBlock);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      results.push(...logs);
    } catch { /* skip failed chunk */ }
  }
  return results;
}

// pad address for topic filter
function pad(addr: string): string {
  return "0x000000000000000000000000" + addr.slice(2).toLowerCase();
}

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
      txt("stat-blocktime", `${((bNow.timestamp - bOld.timestamp) / 10).toFixed(1)}s`);
    }
  } catch { txt("stat-blocktime", "~0.5s"); }

  // Token supply
  for (const [id, addr] of [["stat-usdc-supply", ADDR.USDC], ["stat-eurc-supply", ADDR.EURC]] as const) {
    try {
      const c = new Contract(addr, ERC20_ABI, provider);
      const s = await c.totalSupply() as bigint;
      const n = Number(formatUnits(s, 6));
      txt(id, n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : n.toFixed(2));
    } catch { txt(id, "—"); }
  }
}

// ── Protocol data ─────────────────────────────────────────────────────────
interface TxEntry {
  type: "Pay" | "Multisend" | "Swap";
  token: string;
  amount: number;
  from: string;
  blockNum: number;
  txHash: string;
}

async function fetchProtocol(): Promise<void> {
  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 20_000); // ~2.8hrs at 0.5s
  const entries: TxEntry[] = [];

  // ── 1. PaymentExecuted from ArcFXPayments ─────────────────────────────
  try {
    const logs = await safeGetLogs({
      address: ADDR.PAYMENTS, topics: [PAYMENT_TOPIC],
      fromBlock, toBlock: latest,
    });
    for (const log of logs) {
      try {
        const payer = "0x" + log.topics[2].slice(26);
        const d     = log.data.slice(2);
        const token = "0x" + d.slice(24, 64);
        const gross = Number(formatUnits(BigInt("0x" + d.slice(64, 128)), 6));
        entries.push({ type:"Pay", token, amount:gross, from:payer,
          blockNum:log.blockNumber, txHash:log.transactionHash });
      } catch { /* skip */ }
    }
  } catch(e) { console.warn("PaymentExecuted:", e); }

  // ── 2. USDC/EURC transfers TO Multisender (= multisend batch payments) ─
  for (const tokenAddr of [ADDR.USDC, ADDR.EURC]) {
    try {
      const logs = await safeGetLogs({
        address: tokenAddr,
        topics: [TRANSFER_TOPIC, null, pad(ADDR.MULTISENDER)],
        fromBlock, toBlock: latest,
      });
      for (const log of logs) {
        try {
          const from   = "0x" + log.topics[1].slice(26);
          const amount = Number(formatUnits(BigInt(log.data), 6));
          if (amount <= 0) continue;
          entries.push({ type:"Multisend", token:tokenAddr, amount, from,
            blockNum:log.blockNumber, txHash:log.transactionHash });
        } catch { /* skip */ }
      }
    } catch(e) { console.warn("Multisend transfers:", e); }
  }

  // ── 3. EURC transfers (swaps produce EURC — USDC→EURC or EURC→USDC) ───
  // Filter: any EURC transfer not involving our contracts = swap activity
  const ourContracts = new Set([
    ADDR.PAYMENTS.toLowerCase(), ADDR.MULTISENDER.toLowerCase(),
    ADDR.USDC.toLowerCase(), ADDR.EURC.toLowerCase(),
    "0x0000000000000000000000000000000000000000",
  ]);

  try {
    const logs = await safeGetLogs({
      address: ADDR.EURC, topics: [TRANSFER_TOPIC],
      fromBlock, toBlock: latest,
    });
    for (const log of logs) {
      try {
        const alreadySeen = entries.some(e => e.txHash === log.transactionHash);
        if (alreadySeen) continue;
        const from   = "0x" + log.topics[1].slice(26);
        const to     = "0x" + log.topics[2].slice(26);
        if (ourContracts.has(from.toLowerCase())) continue;
        if (from === "0x0000000000000000000000000000000000000000") continue;
        const amount = Number(formatUnits(BigInt(log.data), 6));
        if (amount <= 0) continue;
        entries.push({ type:"Swap", token:ADDR.EURC, amount, from,
          blockNum:log.blockNumber, txHash:log.transactionHash });
      } catch { /* skip */ }
    }
  } catch(e) { console.warn("EURC transfers:", e); }

  // ── Stats ─────────────────────────────────────────────────────────────
  const totalVol = entries.reduce((s, e) => s + e.amount, 0);
  const wallets  = new Set(entries.map(e => e.from.toLowerCase()).filter(Boolean)).size;
  const count    = entries.length;
  const avg      = count > 0 ? totalVol / count : 0;

  txt("stat-volume",    count ? fmtUSD(totalVol) : "$0.00");
  txt("stat-revenue",   count.toString());
  txt("stat-wallets",   wallets.toString());
  txt("stat-avg-trade", count ? fmtUSD(avg) : "$0.00");

  // ── Feed ──────────────────────────────────────────────────────────────
  const feedBody = el("feed-body");
  if (!feedBody) return;

  if (!count) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No transactions found in last 20,000 blocks</td></tr>`;
    return;
  }

  const seen   = new Set<string>();
  const unique = entries
    .filter(e => e.txHash && !seen.has(e.txHash) && seen.add(e.txHash))
    .sort((a, b) => b.blockNum - a.blockNum)
    .slice(0, 20);

  const badgeClass: Record<string, string> = {
    Pay:"badge-pay", Multisend:"badge-multisend", Swap:"badge-swap",
  };

  feedBody.innerHTML = unique.map(tx => {
    const sym    = tx.token.toLowerCase() === ADDR.USDC.toLowerCase() ? "USDC" : "EURC";
    const amount = tx.amount > 0 ? tx.amount.toFixed(4) : "—";
    const url    = `https://testnet.arcscan.app/tx/${tx.txHash}`;
    return `
      <tr>
        <td><span class="type-badge ${badgeClass[tx.type]}">${tx.type}</span></td>
        <td><span class="feed-amount">${amount} ${sym}</span></td>
        <td><span class="feed-addr">${tx.from ? short(tx.from) : "—"}</span></td>
        <td class="hide-sm"><span class="feed-block">${tx.blockNum ? tx.blockNum.toLocaleString() : "—"}</span></td>
        <td><a href="${url}" target="_blank" rel="noopener" class="arcscan-link">${shortH(tx.txHash)} ↗</a></td>
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
    const eb = el("fetch-error");
    if (eb) eb.style.display = "none";
  } catch (err: any) {
    console.error(err);
    const eb = el("fetch-error");
    if (eb) { eb.textContent = `Error: ${err.message}`; eb.style.display = "block"; }
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

(window as any).refreshAll = refreshAll;
refreshAll();
setInterval(refreshAll, 15_000);
