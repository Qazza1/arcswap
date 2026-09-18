import "./dashboard.css";
import { mountAppShell } from "../shared/appShell";
import { appPath } from "../shared/appOrigin";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";

interface Activity {
  id: string;
  type: "invoice_created" | "invoice_issued" | "invoice_cancelled" | "payment_received" | "payment_partial" | "invoice_paid" | "reconciliation";
  timestamp: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customerName: string | null;
  counterparty: string | null;
  amountAtomic: string | null;
  token: "USDC" | null;
  status: string | null;
  transactionHash: string | null;
}

interface DashboardData {
  network: string;
  token: string;
  tokenAddress: string;
  generatedAt: string;
  outstandingReceivablesAtomic: string;
  overdueReceivablesAtomic: string;
  receivedThisMonthAtomic: string;
  openInvoiceCount: number;
  overdueInvoiceCount: number;
  paidInvoiceCount: number;
  recentActivity: Activity[];
}

const USDC = "0x3600000000000000000000000000000000000000";
const root = document.getElementById("dashboard-root");
if (!root) throw new Error("Missing dashboard root.");
mountAppShell("dashboard");

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
};

function usdc(atomic: string): string {
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString()}.${fraction} USDC`;
}

function card(id: string, label: string, note: string): string {
  return `<article class="dashboard-metric"><p>${label}</p><strong id="${id}" aria-live="polite">Loading…</strong><small id="${id}-note">${note}</small></article>`;
}

function setMetric(id: string, value: string, note: string): void {
  const target = document.getElementById(id);
  const description = document.getElementById(`${id}-note`);
  if (target) target.textContent = value;
  if (description) description.textContent = note;
}

async function usdcBalance(): Promise<string> {
  const address = arcfxWallet.address;
  if (!address || arcfxWallet.chainId?.toLowerCase() !== "0x13b2") throw new Error("Arc Mainnet wallet unavailable");
  const result = await arcfxWallet.request({ method: "eth_call", params: [{ to: USDC, data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}` }, "latest"] });
  return usdc(BigInt(String(result || "0x0")).toString());
}

const names: Record<Activity["type"], string> = {
  invoice_created: "Invoice created",
  invoice_issued: "Invoice issued",
  invoice_cancelled: "Invoice cancelled",
  payment_received: "Payment received",
  payment_partial: "Partial payment received",
  invoice_paid: "Invoice paid",
  reconciliation: "Payment reconciled",
};

function activityRow(item: Activity): string {
  const detail = item.invoiceId ? appPath(`/invoice?id=${encodeURIComponent(item.invoiceId)}`) : null;
  const label = escape(names[item.type] || item.type);
  const counterparty = item.counterparty && /^0x[a-fA-F0-9]{40}$/.test(item.counterparty)
    ? `Wallet ${item.counterparty.slice(0, 6)}…${item.counterparty.slice(-4)}` : null;
  const context = escape(item.customerName || counterparty || "Invoice activity");
  const number = escape(item.invoiceNumber || "Direct payment");
  const amount = item.amountAtomic !== null && item.token === "USDC" ? usdc(item.amountAtomic) : "";
  const hash = item.transactionHash && /^0x[a-fA-F0-9]{64}$/.test(item.transactionHash) ? item.transactionHash : null;
  return `<li class="dashboard-row"><div class="dashboard-row-main"><span class="dashboard-event">${label}</span><strong>${context}</strong><span>${number} · ${escape(time(item.timestamp))}</span></div><div class="dashboard-row-end">${amount ? `<strong class="dashboard-amount">${item.type === "reconciliation" ? "" : "+"}${escape(amount)}</strong>` : ""}<span>${escape(item.status || "")}</span><div class="dashboard-row-links">${detail ? `<a href="${detail}">Details</a>` : ""}${hash ? `<a href="https://explorer.arc.io/tx/${hash}" target="_blank" rel="noopener noreferrer">Explorer ↗</a>` : ""}</div></div></li>`;
}

let renderVersion = 0;
async function render(): Promise<void> {
  const version = ++renderVersion;
  // Wait for the exact selected provider's silent restore before deciding this
  // page is unauthenticated. Remove prior private metrics immediately while
  // the selected-provider snapshot is untrusted.
  root.innerHTML = `<section class="dashboard-empty" aria-live="polite"><p class="dashboard-eyebrow">Arc Mainnet workspace</p><h1>Restoring secure workspace…</h1><p>Verifying the selected wallet before loading financial data.</p></section>`;
  const hasSession = await arcfxApi.hasReceivablesOwnerSession();
  if (version !== renderVersion) return;
  const wallet = arcfxWallet.address?.toLowerCase();
  const ready = arcfxWallet.connected && arcfxWallet.chainId?.toLowerCase() === "0x13b2" && hasSession;
  if (!ready || !wallet) {
    root.innerHTML = `<section class="dashboard-empty"><p class="dashboard-eyebrow">Arc Mainnet workspace</p><h1>Connect to see your workspace.</h1><p>Verify wallet ownership to view your private financial data.</p><a class="dashboard-primary" href="${appPath("/entry")}">Open secure entry</a></section>`;
    return;
  }

  root.innerHTML = `<section class="dashboard-head"><div><p class="dashboard-eyebrow">Arc Mainnet · eip155:5042</p><h1>Overview</h1><p>Receivables, settlement, and the connected wallet.</p></div><div class="dashboard-actions"><a class="dashboard-primary" href="${appPath("/invoice")}">New invoice</a><a class="dashboard-secondary" href="${appPath("/customers")}">New customer</a><button class="dashboard-send" type="button" disabled>Send <span>Not enabled</span></button></div></section><section class="dashboard-grid" aria-label="Workspace metrics">${card("wallet-balance", "Available USDC", "Onchain wallet balance")}${card("outstanding", "Outstanding receivables", "Issued invoices with an unpaid amount")}${card("overdue", "Overdue receivables", "Past due date · UTC")}${card("received", "Received this month", "Confirmed payments · UTC month")}</section><p class="dashboard-freshness">Invoice totals reflect reconciled payments. Confirmed receipts appear when indexed.</p><section class="dashboard-panel"><div class="dashboard-panel-head"><div><p class="dashboard-eyebrow">Recent activity</p><h2>Business activity</h2></div><a href="${appPath("/invoices")}">View invoices →</a></div><div id="dashboard-activity" class="dashboard-activity" aria-live="polite"><p class="dashboard-loading">Loading recent activity…</p></div></section>`;

  const current = () => version === renderVersion && arcfxWallet.address?.toLowerCase() === wallet && arcfxWallet.chainId?.toLowerCase() === "0x13b2";
  const [balance, dashboard] = await Promise.allSettled([usdcBalance(), arcfxApi.getReceivablesDashboard() as Promise<DashboardData>]);
  if (!current()) return;
  if (balance.status === "fulfilled") setMetric("wallet-balance", balance.value, "Onchain wallet balance");
  else setMetric("wallet-balance", "Unavailable", "Could not read the connected wallet balance");

  const outlet = document.getElementById("dashboard-activity");
  if (dashboard.status === "rejected") {
    for (const id of ["outstanding", "overdue", "received"]) setMetric(id, "Unavailable", "Dashboard data could not be loaded");
    if (outlet) outlet.innerHTML = `<div class="dashboard-empty compact"><h3>Business data is unavailable</h3><p>Refresh this page to retry the owner-authenticated dashboard read.</p></div>`;
    return;
  }

  const data = dashboard.value;
  if (data.network !== "arc-mainnet" || data.token !== "USDC" || data.tokenAddress.toLowerCase() !== USDC || !Array.isArray(data.recentActivity)) {
    for (const id of ["outstanding", "overdue", "received"]) setMetric(id, "Unavailable", "Dashboard response did not match Arc Mainnet USDC");
    if (outlet) outlet.innerHTML = `<div class="dashboard-empty compact"><h3>Business data is unavailable</h3><p>The dashboard response could not be verified.</p></div>`;
    return;
  }
  try {
    setMetric("outstanding", usdc(data.outstandingReceivablesAtomic), `${data.openInvoiceCount} open invoice${data.openInvoiceCount === 1 ? "" : "s"}`);
    setMetric("overdue", usdc(data.overdueReceivablesAtomic), `${data.overdueInvoiceCount} overdue invoice${data.overdueInvoiceCount === 1 ? "" : "s"}`);
    setMetric("received", usdc(data.receivedThisMonthAtomic), "Confirmed payments · UTC month");
    if (outlet) outlet.innerHTML = data.recentActivity.length
      ? `<ol class="dashboard-activity-list">${data.recentActivity.map(activityRow).join("")}</ol>`
      : `<div class="dashboard-empty compact"><h3>No activity yet</h3><p>Create your first invoice to start tracking receivables and settlement.</p><a class="dashboard-secondary" href="${appPath("/invoice")}">New invoice</a></div>`;
  } catch {
    for (const id of ["outstanding", "overdue", "received"]) setMetric(id, "Unavailable", "Dashboard data could not be displayed");
    if (outlet) outlet.innerHTML = `<div class="dashboard-empty compact"><h3>Business data is unavailable</h3><p>Refresh this page to try again.</p></div>`;
  }
}

arcfxWallet.onChange(() => void render());
void render();
