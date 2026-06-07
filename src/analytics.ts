/**
 * analytics.ts — ArcFX analytics, fully backend-powered.
 *  - Protocol stats        -> /v1/stats        (full history)
 *  - "Who you paid" bars    -> /v1/breakdown?payer=<wallet>
 *  - Recent transaction feed-> /v1/payments     (full history, newest first)
 */

const API_BASE = "https://arcfx-backend-production.up.railway.app";

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

// ── Protocol stats (backend, full history) ─────────────────────────────────
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

// ── "Who you paid" bars (backend, scoped to connected wallet) ──────────────
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
  } catch {
    body.innerHTML = `<div class="bars-empty">Could not load payment breakdown right now.</div>`;
  }
}

// ── Recent transaction feed (backend, full history, newest first) ──────────
interface FeedPayment {
  type: string;
  txHash: string;
  payer: string;
  recipient: string;
  token: string;
  gross: string;
  blockNumber: number;
}

async function fetchFeed(): Promise<void> {
  const feedBody = el("feed-body");
  if (!feedBody) return;

  try {
    const res = await fetch(`${API_BASE}/v1/payments?limit=20`);
    if (!res.ok) throw new Error(`payments ${res.status}`);
    const d = await res.json();
    const payments: FeedPayment[] = d.payments || [];

    if (!payments.length) {
      feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No transactions yet</td></tr>`;
      return;
    }

    feedBody.innerHTML = payments.map(p => {
      const amount = Number(p.gross) > 0 ? Number(p.gross).toFixed(4) : "—";
      const url    = `https://testnet.arcscan.app/tx/${p.txHash}`;
      return `
        <tr>
          <td><span class="type-badge badge-pay">${p.type}</span></td>
          <td><span class="feed-amount">${amount} ${p.token}</span></td>
          <td><span class="feed-addr">${p.payer ? short(p.payer) : "—"}</span></td>
          <td class="hide-sm"><span class="feed-block">${p.blockNumber ? p.blockNumber.toLocaleString() : "—"}</span></td>
          <td><a href="${url}" target="_blank" rel="noopener" class="arcscan-link">${shortH(p.txHash)} ↗</a></td>
        </tr>`;
    }).join("");
  } catch (e) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">Could not load transactions right now</td></tr>`;
  }
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

// React to wallet changes without a full reload
const eth = (window as any).ethereum;
if (eth && eth.on) {
  eth.on("accountsChanged", (accts: string[]) => {
    currentAddr = accts && accts.length ? accts[0] : null;
    loadBreakdown(currentAddr);
  });
}

refreshAll();
setInterval(refreshAll, 15_000);
