import "./appShell.css";
import { arcfxWallet } from "./wallet";
import { appPath } from "./appOrigin";

export type AppPage = "dashboard" | "invoices" | "customers" | "invoice" | "entry" | "workspace";
type Status = "LIVE" | "TESTNET" | "NOT ENABLED" | "MAINNET READY" | "MAINNET";
type Link = { label: string; href: string; status: Status; external?: boolean };
const group: Array<{ title: string; links: Link[] }> = [
  { title: "Overview", links: [{ label: "Dashboard", href: "/dashboard", status: "LIVE" }] },
  { title: "Receivables", links: [
    { label: "Invoices", href: "/invoices", status: "LIVE" },
    { label: "Customers", href: "/customers", status: "LIVE" },
    { label: "Payment Links", href: "/workspace?view=payment-links", status: "TESTNET" },
  ] },
  { title: "Payments", links: [
    { label: "Send", href: "/workspace?view=send", status: "LIVE" },
    { label: "Multisend / Payouts", href: "/workspace?view=multisend", status: "LIVE" },
  ] },
  { title: "Treasury", links: [
    { label: "Activity", href: "/workspace?view=activity", status: "LIVE" },
    { label: "Analytics", href: "/workspace?view=analytics", status: "LIVE" },
    { label: "Swap & Bridge", href: "/workspace?view=trade", status: "TESTNET" },
  ] },
  { title: "Automation / Labs", links: [{ label: "Agent Payments", href: "/workspace?view=agent", status: "MAINNET" }] },
  { title: "Developers", links: [
    { label: "API", href: "https://www.arcfx.app/docs-api", status: "LIVE", external: true },
    { label: "Docs", href: "https://www.arcfx.app/docs", status: "LIVE", external: true },
  ] },
  { title: "Workspace", links: [
    { label: "Browser Contacts", href: "/workspace?view=contacts", status: "LIVE" },
    { label: "Settings", href: "/workspace?view=settings", status: "LIVE" },
  ] },
];
const titles: Record<AppPage, string> = { dashboard: "Dashboard", invoices: "Invoices", customers: "Customers", invoice: "Invoice", entry: "Secure entry", workspace: "Workspace" };
const short = (address: string | null) => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";
// A single invoice (new or existing) belongs to the Invoices section.
const activeHref = (href: string) => location.pathname + location.search === href || (location.pathname === href && !location.search) || (href === "/invoices" && location.pathname === "/invoice");

export function mountAppShell(page: AppPage, title = titles[page]): void {
  const renderNav = () => group.map(section => `<div class="app-nav-group"><p class="app-nav-label">${section.title}</p><nav class="app-nav" aria-label="${section.title}">${section.links.map(link => {
    const href = link.external ? link.href : appPath(link.href);
    return `<a href="${href}"${activeHref(link.href) ? ' aria-current="page"' : ""}${link.external ? ' target="_blank" rel="noopener noreferrer"' : ""}><span>${link.label}${link.external ? " ↗" : ""}</span><small class="app-status app-status--${link.status.toLowerCase().replace(" ", "-")}">${link.status}</small></a>`;
  }).join("")}</nav></div>`).join("");
  const root = document.createElement("div");
  root.className = "app-frame";
  root.innerHTML = `<aside class="app-sidebar" id="app-sidebar" aria-label="Application navigation">
    <div class="app-sidebar-head"><a href="${appPath("/dashboard")}" aria-label="ArcFX dashboard"><img class="app-logo" src="/arcfx-logo-transparent.png" alt="ArcFX" /></a><button id="app-menu-close" class="app-menu-close" type="button" aria-label="Close menu">×</button></div>
    <div class="app-nav-scroll">${renderNav()}</div>
    <section class="app-account" aria-label="Wallet session"><div class="app-account-label">Wallet session</div><div class="app-account-address" id="app-shell-address">Restoring…</div><div class="app-account-network" id="app-shell-network">Checking selected wallet</div><button class="app-account-action" id="app-shell-disconnect" type="button">Disconnect ArcFX</button></section>
    </aside><div class="app-drawer-backdrop" id="app-drawer-backdrop" hidden></div>
    <div class="app-main"><header class="app-topbar"><button class="app-menu-open" id="app-menu-open" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="app-sidebar">☰</button><div class="app-topbar-copy"><p class="app-topbar-title" id="app-shell-title"></p></div><span class="app-mainnet">Arc Mainnet</span><details class="app-account-menu"><summary id="app-account-summary">Wallet</summary><div class="app-account-popover"><strong id="app-menu-address">Restoring…</strong><p id="app-menu-network">Checking selected wallet</p><a href="${appPath("/workspace?view=settings")}">Settings</a><button id="app-menu-disconnect" type="button">Disconnect ArcFX</button></div></details></header><div class="app-content" id="app-content-slot"></div></div>`;
  const content = document.getElementById("receivables-root") || document.getElementById("dashboard-root") || document.getElementById("workspace-root");
  if (content) root.querySelector("#app-content-slot")?.append(content);
  document.body.append(root);
  const titleNode = document.getElementById("app-shell-title");
  if (titleNode) titleNode.textContent = title;
  const sidebar = document.getElementById("app-sidebar")!;
  const backdrop = document.getElementById("app-drawer-backdrop")!;
  const menuButton = document.getElementById("app-menu-open")!;
  const main = root.querySelector<HTMLElement>(".app-main")!;
  const closeMenu = () => { sidebar.classList.remove("app-sidebar--open"); backdrop.hidden = true; main.inert = false; menuButton.setAttribute("aria-expanded", "false"); menuButton.focus(); };
  menuButton.addEventListener("click", () => { sidebar.classList.add("app-sidebar--open"); backdrop.hidden = false; main.inert = true; menuButton.setAttribute("aria-expanded", "true"); document.getElementById("app-menu-close")?.focus(); });
  backdrop.addEventListener("click", closeMenu);
  document.getElementById("app-menu-close")?.addEventListener("click", closeMenu);
  document.addEventListener("keydown", event => {
    if (!sidebar.classList.contains("app-sidebar--open")) return;
    if (event.key === "Escape") { closeMenu(); return; }
    if (event.key !== "Tab") return;
    const focusable = Array.from(sidebar.querySelectorAll<HTMLElement>("a, button")).filter(item => item.getClientRects().length > 0);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const paint = () => {
    const restoring = !arcfxWallet.connected && Boolean(arcfxWallet.provider) && !arcfxWallet.isExplicitlySignedOut;
    const network = arcfxWallet.connected ? (arcfxWallet.chainId?.toLowerCase() === "0x13b2" ? "Connected · chain 5042" : "Wrong network") : restoring ? "Checking selected wallet" : "Wallet not connected";
    for (const id of ["app-shell-address", "app-menu-address"]) { const node = document.getElementById(id); if (node) node.textContent = restoring ? "Restoring…" : short(arcfxWallet.address); }
    for (const id of ["app-shell-network", "app-menu-network"]) { const node = document.getElementById(id); if (node) node.textContent = network; }
    const summary = document.getElementById("app-account-summary"); if (summary) summary.textContent = restoring ? "Restoring…" : arcfxWallet.address ? short(arcfxWallet.address) : "Wallet";
  };
  arcfxWallet.onChange(paint);
  const disconnect = () => { arcfxWallet.disconnect(); window.location.assign(appPath("/entry")); };
  document.getElementById("app-shell-disconnect")?.addEventListener("click", disconnect);
  document.getElementById("app-menu-disconnect")?.addEventListener("click", disconnect);
}
