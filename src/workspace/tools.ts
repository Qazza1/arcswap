import "./tools.css";
import { mountAppShell } from "../shared/appShell";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";
import { appPath } from "../shared/appOrigin";
import { mountMultisend, mountSend } from "./payments";
import { describeOutbound, type ActivityItem } from "./activityModel";

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
  trade: { intro: "The legacy Swap & Bridge surface is Arc Testnet-scoped. Arc Mainnet swap, bridge, and CCTP execution are not enabled.", heading: "Testnet Swap & Bridge", copy: "Open the existing Circle/App Kit experimental surface only when you deliberately intend to use Arc Testnet. It is not a Mainnet treasury action.", href: "/trade", action: "Open Testnet Swap & Bridge ↗" },
  agent: { intro: "x402 Agent Payments and Agent Evidence remain Arc Testnet-only. Mainnet automation is not enabled.", heading: "Testnet Agent Payments", copy: "The existing x402/EIP-3009 demonstration remains separate from Mainnet receivables and cannot submit a Mainnet payment from this destination.", href: "/agent", action: "Open Testnet Agent Payments ↗" },
};
if (view in legacy) {
  const item = legacy[view]!; const p = shell(item.intro, "TESTNET"); const c = card(p, item.heading, item.copy); c.append(link(item.action, item.href, true));
} else if (view === "send") {
  mountSend(root);
} else if (view === "multisend") {
  mountMultisend(root);
} else if (view === "contacts") {
  const p = shell("A local wallet address book in this browser. Customers are separate server-backed business records.", "LIVE");
  const KEY = "arcfx_address_book";
  type Contact = { name: string; address: string };
  const load = (): Contact[] => { try { const value = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(value) ? value.filter(x => typeof x?.name === "string" && /^0x[0-9a-fA-F]{40}$/.test(x?.address)) : []; } catch { return []; } };
  const store = (entries: Contact[]): boolean => { try { localStorage.setItem(KEY, JSON.stringify(entries)); return true; } catch { return false; } };

  const add = card(p, "Add a contact", "Contacts stay in this browser only. They do not create or edit a Customer record.");
  const form = node("form", undefined, "contact-form"); form.noValidate = true;
  const field = (label: string, id: string, placeholder: string) => { const wrap = node("div", undefined, "contact-field"); const l = node("label", label); l.htmlFor = id; const input = node("input"); input.id = id; input.placeholder = placeholder; input.autocomplete = "off"; input.spellcheck = false; wrap.append(l, input); return { wrap, input }; };
  const name = field("Name", "contact-name", "Supplier, teammate, or wallet label"); name.input.maxLength = 80;
  const address = field("Wallet address", "contact-address", "0x…"); address.input.classList.add("contact-mono");
  const save = node("button", "Save contact", "tool-button tool-button--primary"); save.type = "submit";
  const feedback = node("p", undefined, "contact-feedback"); feedback.setAttribute("role", "status");
  form.append(name.wrap, address.wrap, save); add.append(form, feedback);

  const saved = card(p, "Saved contacts", "");
  const count = saved.querySelector("p")!;
  const list = node("ul", undefined, "contact-list"); saved.append(list);
  const say = (text: string, tone: "ok" | "error" | "" = "") => { feedback.textContent = text; feedback.className = `contact-feedback${tone ? ` contact-feedback--${tone}` : ""}`; };
  const render = () => {
    const entries = load();
    count.textContent = entries.length ? `${entries.length} saved in this browser.` : "";
    list.replaceChildren();
    if (!entries.length) { const e = node("li", undefined, "contact-empty"); e.append(node("strong", "No contacts yet"), node("span", "Save a wallet address above to reuse it later in this browser.")); list.append(e); return; }
    for (const item of entries) {
      const row = node("li", undefined, "contact-row");
      const details = node("div", undefined, "contact-details"); details.append(node("strong", item.name), node("code", item.address));
      const actions = node("div", undefined, "contact-actions");
      const copy = node("button", "Copy", "tool-button"); copy.type = "button"; copy.setAttribute("aria-label", `Copy address for ${item.name}`);
      copy.addEventListener("click", () => { navigator.clipboard?.writeText(item.address).then(() => say(`Copied ${item.name}'s address.`, "ok"), () => say("Could not copy. Select the address and copy it manually.", "error")); });
      const remove = node("button", "Delete", "tool-button tool-button--danger"); remove.type = "button"; remove.setAttribute("aria-label", `Delete ${item.name}`);
      remove.addEventListener("click", () => { if (store(load().filter(e => e.address.toLowerCase() !== item.address.toLowerCase()))) { say(`Deleted ${item.name}.`); render(); } else say("This browser blocked local storage.", "error"); });
      actions.append(copy, remove); row.append(details, actions); list.append(row);
    }
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    const label = name.input.value.trim(); const value = address.input.value.trim();
    if (!label) { say("Enter a name for this contact.", "error"); name.input.focus(); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) { say("Enter a 0x wallet address with 40 hexadecimal characters.", "error"); address.input.focus(); return; }
    const entries = load();
    if (entries.some(e => e.address.toLowerCase() === value.toLowerCase())) { say("That address is already saved.", "error"); return; }
    if (!store([...entries, { name: label, address: value }])) { say("This browser blocked local storage.", "error"); return; }
    form.reset(); say(`Saved ${label}.`, "ok"); render();
  });
  render();
} else if (view === "settings") {
  const p = shell("Selected wallet and local ArcFX session state. No session token is displayed here.", "LIVE"); const c = card(p, "Connection", "ArcFX Disconnect is local to this app; it does not disconnect your browser wallet globally.");
  const detail = node("p", "Restoring selected wallet…", "tool-note"); c.append(detail);
  const render = async () => { detail.textContent = "Restoring selected wallet…"; const readiness = await arcfxApi.receivablesReadiness(); detail.textContent = `Wallet: ${arcfxWallet.address || "Not connected"} · Provider: ${arcfxWallet.providerInfo?.name || "Selected browser provider"} · Chain: ${arcfxWallet.chainId || "Unknown"} · Session: ${readiness}`; };
  arcfxWallet.watch(() => void render());
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
      else { const items = data.recentActivity as ActivityItem[];
        if (!items.length) c.append(node("p", "No business activity yet. Create an invoice or send a payment to begin the record."));
        else { const list = node("ul", undefined, "tool-list"); for (const item of items) { const outbound = describeOutbound(item);
          if (outbound) {
            const row = node("li", undefined, "tool-activity-outbound"); const main = node("div", undefined, "tool-activity-main");
            main.append(node("strong", `${outbound.label} · ${outbound.title}`), node("small", `${outbound.detail}${outbound.feeText ? ` · ${outbound.feeText}` : ""} · ${new Date(item.timestamp).toLocaleString()}`));
            if (outbound.recipients.length) {
              const details = node("details", undefined, "tool-recipients"); details.append(node("summary", "View recipients"));
              const rl = node("ol"); for (const r of outbound.recipients) { const li = node("li"); li.append(node("code", r.address), node("span", r.amountText)); rl.append(li); }
              details.append(rl); if (outbound.recipientsNote) details.append(node("p", outbound.recipientsNote, "tool-note")); main.append(details);
            }
            const end = node("div", undefined, "tool-activity-end"); end.append(node("strong", outbound.amountText), node("small", outbound.statusText));
            if (outbound.explorerHref) end.append(link("Explorer ↗", outbound.explorerHref, true));
            row.append(main, end); list.append(row); continue;
          }
          const row = node("li"); row.append(node("span", `${item.type.replaceAll("_", " ")} · ${item.invoiceNumber || "Direct payment"}`), node("small", new Date(item.timestamp).toLocaleString())); if (item.invoiceId) row.append(link("Invoice", `/invoice?id=${encodeURIComponent(item.invoiceId)}`)); list.append(row); } c.append(list); }
      }
    } catch { if (current === version) c.replaceChildren(node("h2", "Business data unavailable"), node("p", "The owner-authenticated read failed. Refresh or verify the wallet session before retrying.")); }
  };
  arcfxWallet.watch(() => void render());
}
