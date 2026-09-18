import "./appShell.css";
import { arcfxWallet } from "./wallet";
import { arcfxApi } from "./arcfxApi";
import { appPath } from "./appOrigin";

type AppPage = "dashboard" | "invoices" | "customers" | "invoice" | "entry";
const labels: Record<AppPage, string> = { dashboard: "Dashboard", invoices: "Invoices", customers: "Customers", invoice: "Invoice", entry: "Secure entry" };
const short = (address: string | null) => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";

export function mountAppShell(page: AppPage): void {
  const nav = (key: AppPage, href: string, label: string) => `<a href="${appPath(href)}"${page === key ? ' aria-current="page"' : ""}><span aria-hidden="true">${key === "dashboard" ? "◫" : key === "invoices" ? "▤" : key === "customers" ? "◌" : "＋"}</span>${label}</a>`;
  const root = document.createElement("div");
  root.className = "app-frame";
  root.innerHTML = `<aside class="app-sidebar" aria-label="Application navigation">
      <a href="${appPath("/dashboard")}" aria-label="ArcFX dashboard"><img class="app-logo" src="/arcfx-logo-transparent.png" alt="ArcFX" /></a>
      <div><p class="app-nav-label">Workspace</p><nav class="app-nav">${nav("dashboard", "/dashboard", "Dashboard")}${nav("invoices", "/invoices", "Invoices")}${nav("customers", "/customers", "Customers")}${nav("invoice", "/invoice", "New invoice")}</nav></div>
      <div><p class="app-nav-label">Operations</p><nav class="app-nav"><button class="app-disabled" type="button" disabled>Send <small>Not enabled</small></button><button class="app-disabled" type="button" disabled>Payouts <small>Not enabled</small></button></nav></div>
      <div class="app-side-spacer"></div><section class="app-account" aria-label="Wallet session"><div class="app-account-label">Wallet session</div><div class="app-account-address" id="app-shell-address">Not connected</div><div class="app-account-network" id="app-shell-network">Arc Mainnet · 5042</div><button class="app-account-action" id="app-shell-disconnect" type="button">Disconnect ArcFX</button></section>
    </aside><div class="app-main"><header class="app-topbar"><div class="app-topbar-copy"><div class="app-topbar-kicker">ArcFX workspace</div><p class="app-topbar-title" id="app-shell-title">${labels[page]}</p></div><span class="app-mainnet">Arc Mainnet · 5042</span></header><div class="app-content" id="app-content-slot"></div></div>
    <nav class="app-mobilebar" aria-label="Application navigation">${nav("dashboard", "/dashboard", "Dashboard")}${nav("invoices", "/invoices", "Invoices")}${nav("customers", "/customers", "Customers")}${nav("invoice", "/invoice", "New invoice")}</nav>`;
  const content = document.getElementById("receivables-root") || document.getElementById("dashboard-root");
  const skip = document.querySelector(".workspace-skip, .app-skip");
  if (content) root.querySelector("#app-content-slot")?.append(content);
  document.body.append(root);
  const paint = () => {
    const address = document.getElementById("app-shell-address");
    const network = document.getElementById("app-shell-network");
    if (address) address.textContent = short(arcfxWallet.address);
    if (network) network.textContent = arcfxWallet.connected ? (arcfxWallet.chainId?.toLowerCase() === "0x13b2" ? "Arc Mainnet · 5042" : "Wrong network") : "Connect to continue";
  };
  arcfxWallet.onChange(paint); paint();
  document.getElementById("app-shell-disconnect")?.addEventListener("click", () => { arcfxWallet.disconnect(); window.location.assign(appPath("/entry")); });
  // This is a read-only session hint; it never triggers provider connection or a wallet signature.
  if (page !== "entry") void Promise.resolve(arcfxApi.hasReceivablesOwnerSession()).catch(() => undefined);
}
