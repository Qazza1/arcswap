import "./tools.css";
import { mountAppShell } from "../shared/appShell";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";
import { appPath } from "../shared/appOrigin";

type View = "payment-links" | "send" | "multisend" | "activity" | "analytics" | "trade" | "agent" | "contacts" | "settings";
const requested = new URLSearchParams(location.search).get("view");
const views: View[] = ["payment-links", "send", "multisend", "activity", "analytics", "trade", "agent", "contacts", "settings"];
const view: View = views.includes(requested as View) ? requested as View : "activity";
const title: Record<View, string> = { "payment-links": "Payment Links", send: "Send", multisend: "Multisend / Payouts", activity: "Activity", analytics: "Analytics", trade: "Swap & Bridge", agent: "Agent Payments", contacts: "Browser Contacts", settings: "Settings" };
const root = document.getElementById("workspace-root")!;
mountAppShell("workspace", title[view]);
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
const link = (text: string, href: string, external = false) => { const n = node("a", text, "tool-link"); n.href = external ? href : appPath(href); if (external) { n.target = "_blank"; n.rel = "noopener noreferrer"; } return n; };
const shell = (intro: string, state: "LIVE" | "TESTNET" | "NOT ENABLED") => { const p = node("div", undefined, "tool-page"); p.append(node("p", "ArcFX workspace", "tool-kicker"), node("h1", title[view]), node("p", intro, "tool-intro"), node("span", state, `tool-status tool-status--${state.toLowerCase().replace(" ", "-")}`)); root.replaceChildren(p); return p; };
const card = (target: HTMLElement, heading: string, copy: string) => { const c = node("section", undefined, "tool-card"); c.append(node("h2", heading), node("p", copy)); target.append(c); return c; };
const legacy: Partial<Record<View, { intro: string; heading: string; copy: string; href: string; action: string }>> = {
  "payment-links": { intro: "A legacy Arc Testnet payment-link generator, distinct from managed Mainnet invoices and the public invoice payer.", heading: "Generic Testnet payment links", copy: "This tool creates a reference-based payment URL and uses the legacy Arc Testnet payment contract. It does not create a server-backed customer or managed invoice. Do not use it for Mainnet receivables.", href: "/pay", action: "Open Testnet Payment Links ↗" },
  multisend: { intro: "Batch transfers are available only in the legacy Arc Testnet tool. Mainnet Payouts execution is not enabled.", heading: "Testnet batch transfers", copy: "The existing manual and CSV recipient entry, amount validation, review, fees, and wallet safeguards remain in the legacy tool. ArcFX does not enable its Mainnet contract from this workspace.", href: "/multisend", action: "Open Testnet Multisend ↗" },
  trade: { intro: "The legacy Swap & Bridge surface is Arc Testnet-scoped. Arc Mainnet swap, bridge, and CCTP execution are not enabled.", heading: "Testnet Swap & Bridge", copy: "Open the existing Circle/App Kit experimental surface only when you deliberately intend to use Arc Testnet. It is not a Mainnet treasury action.", href: "/trade", action: "Open Testnet Swap & Bridge ↗" },
  agent: { intro: "x402 Agent Payments and Agent Evidence remain Arc Testnet-only. Mainnet automation is not enabled.", heading: "Testnet Agent Payments", copy: "The existing x402/EIP-3009 demonstration remains separate from Mainnet receivables and cannot submit a Mainnet payment from this destination.", href: "/agent", action: "Open Testnet Agent Payments ↗" },
};
if (view in legacy) {
  const item = legacy[view]!; const p = shell(item.intro, "TESTNET"); const c = card(p, item.heading, item.copy); c.append(link(item.action, item.href, true));
} else if (view === "send") {
  const p = shell("Direct Mainnet sending is not available in the ArcFX workspace.", "NOT ENABLED"); card(p, "No transaction path", "This destination does not request an approval, sign a transaction, or move funds. Mainnet sending requires a separate implementation and release review.");
} else if (view === "contacts") {
  const p = shell("A local wallet address book in this browser. Customers are separate server-backed business records.", "LIVE");
  const c = card(p, "Saved addresses", "Contacts stay in this browser. They do not create or edit a Customer record.");
  const list = node("ul", undefined, "tool-list"); c.append(list);
  const load = (): Array<{ name: string; address: string }> => { try { const value = JSON.parse(localStorage.getItem("arcfx_address_book") || "[]"); return Array.isArray(value) ? value.filter(x => typeof x?.name === "string" && /^0x[0-9a-fA-F]{40}$/.test(x?.address)) : []; } catch { return []; } };
  const render = () => { list.replaceChildren(); const entries = load(); if (!entries.length) list.append(node("li", "No browser contacts yet.")); entries.forEach(item => { const row = node("li"); const details = node("span"); details.append(node("strong", item.name), node("small", ` · ${item.address}`)); const copy = node("button", "Copy address", "tool-button"); copy.type = "button"; copy.addEventListener("click", () => void navigator.clipboard.writeText(item.address)); row.append(details, copy); list.append(row); }); };
  const form = node("form", undefined, "tool-form");
  const nameLabel = node("label", "Name"); const name = node("input"); name.required = true; name.maxLength = 80; nameLabel.append(name);
  const addressLabel = node("label", "Wallet address"); const address = node("input"); address.required = true; address.pattern = "0x[0-9a-fA-F]{40}"; addressLabel.append(address);
  const save = node("button", "Save contact", "tool-button"); save.type = "submit"; form.append(nameLabel, addressLabel, save); c.append(form);
  form.addEventListener("submit", event => { event.preventDefault(); const entries = load(); const value = address.value.trim(); if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return; if (!entries.some(e => e.address.toLowerCase() === value.toLowerCase())) { entries.push({ name: name.value.trim(), address: value }); localStorage.setItem("arcfx_address_book", JSON.stringify(entries)); } form.reset(); render(); }); render();
} else if (view === "settings") {
  const p = shell("Selected wallet and local ArcFX session state. No session token is displayed here.", "LIVE"); const c = card(p, "Connection", "ArcFX Disconnect is local to this app; it does not disconnect your browser wallet globally.");
  const detail = node("p", "Restoring selected wallet…", "tool-note"); c.append(detail);
  const render = async () => { detail.textContent = "Restoring selected wallet…"; const readiness = await arcfxApi.receivablesReadiness(); detail.textContent = `Wallet: ${arcfxWallet.address || "Not connected"} · Provider: ${arcfxWallet.providerInfo?.name || "Selected browser provider"} · Chain: ${arcfxWallet.chainId || "Unknown"} · Session: ${readiness}`; };
  arcfxWallet.onChange(() => void render());
  const disconnect = node("button", "Disconnect ArcFX", "tool-button"); disconnect.type = "button"; disconnect.addEventListener("click", () => { arcfxWallet.disconnect(); location.assign(appPath("/entry")); }); c.append(disconnect, link("Public ArcFX website ↗", "https://www.arcfx.app", true));
} else {
  const p = shell(view === "activity" ? "Owner-scoped Arc Mainnet business events from the authoritative dashboard." : "Owner-scoped Arc Mainnet metrics, distinct from public protocol statistics.", "LIVE");
  const c = card(p, view === "activity" ? "Recent business activity" : "Business analytics", "Restoring the selected wallet and owner session…");
  let version = 0;
  const render = async () => {
    const current = ++version; c.replaceChildren(node("h2", view === "activity" ? "Recent business activity" : "Business analytics"), node("p", "Restoring secure workspace…"));
    const readiness = await arcfxApi.receivablesReadiness(); if (current !== version) return;
    if (readiness !== "AUTHENTICATED") { c.append(node("p", readiness === "WRONG_NETWORK" ? "Switch the selected wallet to Arc Mainnet to continue." : "Verify your wallet at secure entry to see owner-scoped data."), link("Open secure entry", "/entry")); return; }
    try {
      const data = await arcfxApi.getReceivablesDashboard(); if (current !== version) return;
      if (data.network !== "arc-mainnet" || data.token !== "USDC" || data.tokenAddress?.toLowerCase() !== "0x3600000000000000000000000000000000000000" || !Array.isArray(data.recentActivity)) throw new Error("Dashboard response does not match Arc Mainnet USDC.");
      c.replaceChildren(node("h2", view === "activity" ? "Recent business activity" : "Business analytics"));
      if (view === "analytics") { c.append(node("p", `${data.openInvoiceCount} open invoices · ${data.overdueInvoiceCount} overdue · ${data.paidInvoiceCount} paid. Amounts are shown on the Dashboard.`), link("View business dashboard", "/dashboard")); const protocol = card(p, "Protocol analytics", "Public/global figures include all wallets and must never be treated as this business’s totals."); protocol.append(link("Open public protocol analytics ↗", "https://www.arcfx.app/analytics", true)); }
      else { const items = data.recentActivity as Array<{ type: string; timestamp: string; invoiceNumber: string | null; invoiceId: string | null }>;
        if (!items.length) c.append(node("p", "No business activity yet. Create an invoice to begin the record."));
        else { const list = node("ul", undefined, "tool-list"); for (const item of items) { const row = node("li"); row.append(node("span", `${item.type.replaceAll("_", " ")} · ${item.invoiceNumber || "Direct payment"}`), node("small", new Date(item.timestamp).toLocaleString())); if (item.invoiceId) row.append(link("Invoice", `/invoice?id=${encodeURIComponent(item.invoiceId)}`)); list.append(row); } c.append(list); }
      }
    } catch { if (current === version) c.replaceChildren(node("h2", "Business data unavailable"), node("p", "The owner-authenticated read failed. Refresh or verify the wallet session before retrying.")); }
  };
  arcfxWallet.onChange(() => void render());
}
