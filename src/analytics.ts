/**
 * analytics.ts — ArcFX analytics.
 *  - Protocol stats come from the ArcFX backend (/v1/stats), full history.
 *  - "Who you paid" bars come from the backend (/v1/breakdown?payer=<wallet>).
 *  - Live feed is read directly from Arc Testnet (recent window), chunked safely.
 */

import { JsonRpcProvider, formatUnits, id as keccak256id } from "ethers";

const API_BASE = "https://arcfx-backend-production.up.railway.app";
const ARC_RPC  = "https://rpc.testnet.arc.network";

const ADDR = {
  USDC:        "0x3600000000000000000000000000000000000000",
  EURC:        "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PAYMENTS:    "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
  MULTISENDER: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYMENT_TOPIC  = keccak256id("PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)");

const provider = new JsonRpcProvider(ARC_RPC);

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

// ── Chunked getLogs — 1,000-block windows (Arc RPC silently caps wide ranges) ─
async function safeGetLogs(filter: {
  address?: string; topics?: any[]; fromBlock: number; toBlock: number;
}): Promise<any[]> {
  const results: any[] = [];
  const chunk = 1000;
  for (let from = filter.fromBlock; from <= filter.toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, filter.toBlock);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      results.push(...logs);
    } catch { /* skip failed chunk */ }
  }
  return results;
}

function pad(addr: string): string {
  return "0x000000000000000000000000" + addr.slice(2).toLowerCase();
}

// ── Protocol stats (from backend — full history, payments) ─────────────────
async function fetchStats(): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/stats`);
  if (!res.ok) throw new Error(`stats ${res.status}`);
  const d = await res.json();
  const volume      = Number(d.volume || 0);
  const settlements = Number(d.settlements || 0);
  const avg         = settlements > 0 ? volume / settlements : 0;

  txt("stat-volume",    fmtUSD(volume));
  txt("stat-revenue",   String(settlements));
  txt("stat-wallets",   String(d.uniquePayers || 0));
  txt("stat-avg-trade", fmtUSD(avg));
}

// ── "Who you paid" bars (from backend, scoped to connected wallet) ─────────
async function loadBreakdown(address: string | null): Promise<void> {
  const body = el("bars-body");
  if (!body) return;

  if (!address) {
    body.innerHTML = `<div class="bars-empty">Connect your wallet to see who you've paid.</div>`;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/v1/breakdown?payer=${encodeURIComponent(address)}&limit=10`);
    if (!res.ok) throw new Error(`breakdown ${res.status}`);
    const d = await res.json();
    const recipients: Array<{ recipient: string; count: number; total: string; token: string }> =
      d.recipients || [];

    if (!recipients.length) {
      body.innerHTML = `<div class="bars-empty">No payments from this wallet yet.</div>`;
      return;
    }

    const max = Math.max(...recipients.map(r => Number(r.total) || 0), 0.000001);
    body.innerHTML = recipients.map(r => {
      const total = Number(r.total) || 0;
      const pct   = Math.max(2, Math.round((total / max) * 100));
      const times = r.count === 1 ? "1 payment" : `${r.count} payments`;
      return `
        <div class="bar-row">
          <span class="bar-name" title="${r.recipient}">${short(r.recipient)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <span class="bar-val">$${total.toFixed(2)} <span class="bar-count">· ${times}</span></span>
        </div>`;
    }).join("");
  } catch (e) {
    body.innerHTML = `<div class="bars-empty">Could not load payment breakdown right now.</div>`;
  }
}

// ── Live transaction feed (on-chain, recent window) ────────────────────────
interface TxEntry {
  type: "Pay" | "Multisend";
  token: string;
  amount: number;
  from: string;
  blockNum: number;
  txHash: string;
}

async function fetchFeed(): Promise<void> {
  const feedBody = el("feed-body");
  if (!feedBody) return;

  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 20_000); // recent window (~feed of latest activity)
  const entries: TxEntry[] = [];

  // PaymentExecuted from ArcFXPayments
  try {
    const logs = await safeGetLogs({ address: ADDR.PAYMENTS, topics: [PAYMENT_TOPIC], fromBlock, toBlock: latest });
    for (const log of logs) {
      try {
        const payer = "0x" + log.topics[2].slice(26);
        const dd    = log.data.slice(2);
        const token = "0x" + dd.slice(24, 64);
        const gross = Number(formatUnits(BigInt("0x" + dd.slice(64, 128)), 6));
        entries.push({ type:"Pay", token, amount:gross, from:payer, blockNum:log.blockNumber, txHash:log.transactionHash });
      } catch { /* skip */ }
    }
  } catch (e) { console.warn("PaymentExecuted:", e); }

  // USDC/EURC transfers TO the multisender (= batch payouts)
  for (const tokenAddr of [ADDR.USDC, ADDR.EURC]) {
    try {
      const logs = await safeGetLogs({ address: tokenAddr, topics: [TRANSFER_TOPIC, null, pad(ADDR.MULTISENDER)], fromBlock, toBlock: latest });
      for (const log of logs) {
        try {
          const from   = "0x" + log.topics[1].slice(26);
          const amount = Number(formatUnits(BigInt(log.data), 6));
          if (amount <= 0) continue;
          entries.push({ type:"Multisend", token:tokenAddr, amount, from, blockNum:log.blockNumber, txHash:log.transactionHash });
        } catch { /* skip */ }
      }
    } catch (e) { console.warn("Multisend transfers:", e); }
  }

  if (!entries.length) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No recent transactions found</td></tr>`;
    return;
  }

  const seen = new Set<string>();
  const unique = entries
    .filter(e => e.txHash && !seen.has(e.txHash) && seen.add(e.txHash))
    .sort((a, b) => b.blockNum - a.blockNum)
    .slice(0, 20);

  const badgeClass: Record<string, string> = { Pay:"badge-pay", Multisend:"badge-multisend" };

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

// ── Wallet (read already-connected account; never forces a popup) ──────────
let currentAddr: string | null = null;
async function getConnectedAddress(): Promise<string | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  try {
    const accts: string[] = await eth.request({ method: "eth_accounts" });
    return accts && accts.length ? accts[0] : null;
  } catch { return null; }
}

// ── Refresh ────────────────────────────────────────────────────────────────
async function refreshAll(): Promise<void> {
  const btn = el("refresh-btn");
  if (btn) btn.classList.add("loading");
  try {
    currentAddr = await getConnectedAddress();
    await Promise.all([fetchStats(), fetchFeed(), loadBreakdown(currentAddr)]);
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

// React to wallet changes (connect/disconnect/switch) without a full reload
const eth = (window as any).ethereum;
if (eth && eth.on) {
  eth.on("accountsChanged", async (accts: string[]) => {
    currentAddr = accts && accts.length ? accts[0] : null;
    loadBreakdown(currentAddr);
  });
}

refreshAll();
setInterval(refreshAll, 15_000);
