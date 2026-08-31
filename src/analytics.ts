/**
 * analytics.ts — ArcFX analytics, fully backend-powered.
 *  - Protocol stats        -> /v1/stats        (full history)
 *  - "Who you paid" bars    -> /v1/breakdown?payer=<wallet>
 *  - Recent transaction feed-> /v1/payments     (full history, newest first)
 */

import { arcfxWallet } from "./shared/wallet";
import { createWalletLoadGuard } from "./shared/walletLoadGuard";

const API_BASE = "https://arcfx-backend-production.up.railway.app";

// ── DOM helpers ───────────────────────────────────────────────────────────
const el  = (id: string) => document.getElementById(id);
const txt = (id: string, val: string) => { const n = el(id); if (n) n.textContent = val; };

// (Removed fmtUSD — volume is now reported per-token, never as a blended "$".)
function short(a: string): string  { return `${a.slice(0,8)}…${a.slice(-6)}`; }
function shortH(h: string): string { return `${h.slice(0,8)}…${h.slice(-4)}`; }

// ── Protocol stats (backend, full history) ─────────────────────────────────
async function fetchStats(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/v1/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const d = await res.json();
    const settlements = Number(d.settlements || 0);

    // Volume is split per token — USDC and EURC are different currencies and
    // must not be merged into one "$" figure (M18). Show each on its own.
    const byToken: Array<{ token: string; volume: number }> = Array.isArray(d.byToken) ? d.byToken : [];
    const fmtAmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

    if (byToken.length) {
      // Primary card: the largest-volume token; sublabel lists the rest.
      const sorted = byToken
        .map(t => ({ token: t.token, volume: Number(t.volume || 0) }))
        .sort((a, b) => b.volume - a.volume);
      const top = sorted[0];
      txt("stat-volume", `${fmtAmt(top.volume)} ${top.token}`);
      const subParts = sorted.map(t => `${fmtAmt(t.volume)} ${t.token}`);
      txt("stat-volume-sub", subParts.join(" · ") + " processed");
    } else {
      // Fallback if backend hasn't been deployed with byToken yet.
      txt("stat-volume", fmtAmt(Number(d.volume || 0)));
      txt("stat-volume-sub", "USDC + EURC combined");
    }

    txt("stat-revenue",   String(settlements));
    txt("stat-wallets",   String(d.uniquePayers || 0));

    // Avg payment: report it per the dominant token to avoid a cross-currency
    // average. (A blended USDC+EURC average isn't a meaningful figure.)
    if (byToken.length) {
      const sorted = byToken
        .map(t => ({ token: t.token, volume: Number(t.volume || 0), settlements: Number((t as any).settlements || 0) }))
        .sort((a, b) => b.volume - a.volume);
      const top = sorted[0];
      const avg = top.settlements > 0 ? top.volume / top.settlements : 0;
      txt("stat-avg-trade", `${fmtAmt(avg)} ${top.token}`);
    } else {
      const avg = settlements > 0 ? Number(d.volume || 0) / settlements : 0;
      txt("stat-avg-trade", fmtAmt(avg));
    }
  } catch {
    // Don't leave the headline cards pulsing forever on failure.
    txt("stat-volume", "—");
    txt("stat-revenue", "—");
    txt("stat-wallets", "—");
    txt("stat-avg-trade", "—");
  }
}

// ── "Who you paid" bars (backend, scoped to connected wallet) ──────────────
const breakdownLoads = createWalletLoadGuard();

function clearBreakdown(): void {
  const body = el("bars-body");
  const summary = el("spend-summary");
  if (summary) summary.style.display = "none";
  if (body) body.replaceChildren();
}

async function loadBreakdown(address: string | null): Promise<void> {
  const ticket = breakdownLoads.begin(address);
  const body    = el("bars-body");
  const summary = el("spend-summary");
  if (!body) return;

  const hideSummary = () => { if (summary) summary.style.display = "none"; };

  if (!address) {
    if (!breakdownLoads.isCurrent(ticket)) return;
    hideSummary();
    body.innerHTML = `<div class="bars-empty">Connect your wallet to see who you've paid.</div>`;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/v1/breakdown?payer=${encodeURIComponent(address)}&limit=50`);
    if (!res.ok) throw new Error(`breakdown ${res.status}`);
    const d = await res.json();
    if (!breakdownLoads.isCurrent(ticket)) return;
    const recipients: Array<{ recipient: string; count: number; total: string; token: string }> =
      d.recipients || [];

    if (!recipients.length) {
      hideSummary();
      body.innerHTML = `<div class="bars-empty">No payments from this wallet yet.</div>`;
      return;
    }

    const fmtAmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── Your total spend summary (sum across all recipients) ──────────────
    // Sum per token, since USDC and EURC must not be merged into one figure.
    if (summary) {
      const byToken: Record<string, number> = {};
      let totalPayments = 0;
      for (const r of recipients) {
        const tk = r.token || "USDC";
        byToken[tk] = (byToken[tk] || 0) + (Number(r.total) || 0);
        totalPayments += Number(r.count) || 0;
      }
      const totalStr = Object.entries(byToken)
        .map(([tk, v]) => `${fmtAmt(v)} ${tk}`)
        .join(" · ");
      const recipientWord = recipients.length === 1 ? "recipient" : "recipients";
      const paymentWord   = totalPayments === 1 ? "payment" : "payments";
      summary.innerHTML =
        `<span class="ss-label">Your total spend</span>` +
        `<span class="ss-val">${totalStr}</span>` +
        `<span class="ss-meta">across ${recipients.length} ${recipientWord} · ${totalPayments} ${paymentWord}</span>`;
      summary.style.display = "flex";
    }

    // ── Clickable / expandable per-recipient bars ─────────────────────────
    // Remember which recipients were expanded so the 15s auto-refresh doesn't
    // collapse a panel the user is reading.
    const openAddrs = new Set<string>();
    document.querySelectorAll(".bar-item.open").forEach(elm => {
      const a = (elm as HTMLElement).dataset.addr;
      if (a) openAddrs.add(a);
    });

    const max = Math.max(...recipients.map(r => Number(r.total) || 0), 0.000001);
    body.innerHTML = recipients.map((r, i) => {
      const total = Number(r.total) || 0;
      const pct   = Math.max(2, Math.round((total / max) * 100));
      const times = r.count === 1 ? "1 payment" : `${r.count} payments`;
      const tk    = r.token ? ` ${r.token}` : "";
      const avg   = r.count > 0 ? total / r.count : 0;
      const scanUrl = `https://testnet.arcscan.app/address/${r.recipient}`;
      const openCls = openAddrs.has(r.recipient) ? " open" : "";
      return `
        <div class="bar-item${openCls}" id="bar-item-${i}" data-addr="${r.recipient}">
          <div class="bar-row" onclick="toggleBar(${i})">
            <span class="bar-name" title="${r.recipient}">${short(r.recipient)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="bar-val">${fmtAmt(total)}${tk} <span class="bar-count">· ${times}</span><span class="bar-caret">▶</span></span>
          </div>
          <div class="bar-detail">
            <div class="bar-detail-row"><span class="bd-k">Total paid</span><span class="bd-v">${fmtAmt(total)}${tk}</span></div>
            <div class="bar-detail-row"><span class="bd-k">Payments</span><span class="bd-v">${r.count}</span></div>
            <div class="bar-detail-row"><span class="bd-k">Average</span><span class="bd-v">${fmtAmt(avg)}${tk}</span></div>
            <div class="bar-detail-row"><span class="bd-k">Address</span></div>
            <div class="bar-detail-addr">${r.recipient}</div>
            <a class="bar-detail-link" href="${scanUrl}" target="_blank" rel="noopener">View on ArcScan ↗</a>
          </div>
        </div>`;
    }).join("");
  } catch {
    if (!breakdownLoads.isCurrent(ticket)) return;
    hideSummary();
    body.innerHTML = `<div class="bars-empty">Could not load payment breakdown right now.</div>`;
  }
}

// Toggle the expanded detail for a recipient bar.
(window as any).toggleBar = function(i: number) {
  const item = document.getElementById(`bar-item-${i}`);
  if (item) item.classList.toggle("open");
};

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
      const t      = (p.type || "").toLowerCase();
      const badge  = t.includes("swap") ? "badge-swap"
                   : t.includes("multi") ? "badge-multisend"
                   : "badge-pay";
      return `
        <tr>
          <td><span class="type-badge ${badge}">${p.type}</span></td>
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
  await arcfxWallet.restore();
  return arcfxWallet.address;
}

// ── Refresh ────────────────────────────────────────────────────────────────
async function refreshAll(): Promise<void> {
  const btn = el("refresh-btn");
  if (btn) btn.classList.add("loading");
  try {
    const restoredAddress = await getConnectedAddress();
    if (currentAddr !== restoredAddress) {
      currentAddr = restoredAddress;
      breakdownLoads.transition(currentAddr);
      clearBreakdown();
    }
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
arcfxWallet.onChange((state) => {
  currentAddr = state.address;
  breakdownLoads.transition(currentAddr);
  clearBreakdown();
  loadBreakdown(currentAddr);
});

refreshAll();
setInterval(() => { if (!document.hidden) refreshAll(); }, 15_000);
