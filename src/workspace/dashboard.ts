import "./dashboard.css";
import { mountAppShell } from "../shared/appShell";
import { appPath } from "../shared/appOrigin";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";

type Invoice = { id: string; number: string; status: string; customer: { name: string | null } | null; amount: string | null; token: string | null; createdAt: string | null; dueDate: string | null; network: string | null };
const USDC = "0x3600000000000000000000000000000000000000";
const root = document.getElementById("dashboard-root");
if (!root) throw new Error("Missing dashboard root.");
mountAppShell("dashboard");

const date = (v: string | null) => v ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(v)) : "—";
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
function card(label: string, value: string, note: string) { return `<article class="dashboard-metric"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`; }

async function usdcBalance(): Promise<string> {
  const address = arcfxWallet.address;
  if (!address || arcfxWallet.chainId?.toLowerCase() !== "0x13b2") return "—";
  const result = await arcfxWallet.request({ method: "eth_call", params: [{ to: USDC, data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}` }, "latest"] });
  const raw = BigInt(String(result || "0x0"));
  const whole = raw / 1_000_000n; const fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").slice(0, 2);
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} USDC`;
}

async function render() {
  const onMainnet = arcfxWallet.connected && arcfxWallet.chainId?.toLowerCase() === "0x13b2";
  if (!onMainnet || !arcfxApi.hasReceivablesOwnerSession()) {
    root.innerHTML = `<section class="dashboard-empty"><p class="dashboard-eyebrow">Arc Mainnet workspace</p><h1>Connect to see your workspace.</h1><p>Wallet ownership is verified on this app origin. No financial data is shown until that session is active.</p><a class="dashboard-primary" href="${appPath("/entry")}">Open secure entry</a></section>`;
    return;
  }
  root.innerHTML = `<section class="dashboard-head"><div><p class="dashboard-eyebrow">Arc Mainnet · eip155:5042</p><h1>Good to see you.</h1><p>Receivables and wallet balances are shown only for the active wallet.</p></div><div class="dashboard-actions"><a class="dashboard-primary" href="${appPath("/invoice")}">New invoice</a><a class="dashboard-secondary" href="${appPath("/customers")}">New customer</a><button class="dashboard-send" type="button" disabled>Send <span>Not enabled</span></button></div></section><section class="dashboard-grid" aria-label="Workspace metrics">${card("Available USDC", "Loading…", "Onchain wallet balance")}${card("Outstanding", "—", "Requires data aggregation")}${card("Paid this month", "—", "Requires data aggregation")}${card("Overdue", "—", "Requires data aggregation")}</section><section class="dashboard-panel"><div class="dashboard-panel-head"><div><p class="dashboard-eyebrow">Recent activity</p><h2>Invoice records</h2></div><a href="${appPath("/invoices")}">View invoices →</a></div><div id="dashboard-activity" class="dashboard-activity"><p>Loading wallet-owned records…</p></div></section>`;
  const metric = root.querySelector(".dashboard-metric strong");
  try { if (metric) metric.textContent = await usdcBalance(); } catch { if (metric) metric.textContent = "Unavailable"; }
  try {
    const data = await arcfxApi.listReceivablesInvoices();
    const invoices: Invoice[] = data.invoices || [];
    const outlet = document.getElementById("dashboard-activity");
    if (!outlet) return;
    if (!invoices.length) { outlet.innerHTML = `<div class="dashboard-empty compact"><h3>No activity yet</h3><p>Your wallet-owned invoice activity will appear here. Create a draft when you are ready.</p><a class="dashboard-secondary" href="${appPath("/invoice")}">Create invoice</a></div>`; return; }
    outlet.innerHTML = invoices.slice(0, 6).map(invoice => `<a class="dashboard-row" href="${appPath(`/invoice?id=${encodeURIComponent(invoice.id)}`)}"><div><strong>${escape(invoice.number)}</strong><span>${escape(invoice.customer?.name || "No customer")} · ${date(invoice.createdAt)}</span></div><div><b>${escape(invoice.status)}</b><span>${escape(invoice.amount || "—")} ${escape(invoice.token || "")}</span></div></a>`).join("");
  } catch (error) {
    const outlet = document.getElementById("dashboard-activity");
    if (outlet) outlet.innerHTML = `<div class="dashboard-empty compact"><h3>Records are unavailable</h3><p>${escape(error instanceof Error ? error.message : "Could not load the current workspace.")}</p></div>`;
  }
}

arcfxWallet.onChange(() => void render());
void render();
