import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const shell = read("../src/shared/appShell.ts");
const css = read("../src/shared/appShell.css");
const skipCss = read("../src/shared/skip.css");
const html = ["customers", "invoices", "invoice", "dashboard", "workspace", "entry"].map(name => [name, read(`../${name}.html`)]);
const receivables = read("../src/workspace/receivables.ts");
const dashboard = read("../src/workspace/dashboard.ts");
const tools = read("../src/workspace/tools.ts");
const api = read("../src/shared/arcfxApi.ts");

test("all Mainnet business pages wait for the shared restored owner session", () => {
  assert.match(dashboard, /await arcfxApi\.receivablesReadiness\(\)/);
  assert.match(receivables, /const readiness = await arcfxApi\.receivablesReadiness\(\)/);
  assert.match(receivables, /root\.replaceChildren\(message\("Restoring secure workspace…"\)\)/);
  assert.match(receivables, /current !== version/);
  // Readiness evaluates the settled bootstrap; it never restores (Step 6G.1 loop).
  assert.match(api, /await arcfxWallet\.settled\(\)/);
  assert.doesNotMatch(api, /arcfxWallet\.restore\(\)/);
  assert.match(receivables, /arcfxWallet\.watch\(\(\) => void render\(\)\)/);
  assert.match(dashboard, /arcfxWallet\.watch\(\(\) => void render\(\)\)/);
  assert.doesNotMatch(receivables + dashboard + tools, /arcfxWallet\.onChange\(\(\) => void render\(\)\)/);
  assert.doesNotMatch(receivables, /arcfxWallet\.onChange\(\(\) => void load\(\)\)/);
});

test("status navigation does not represent Testnet tools as Mainnet execution", () => {
  for (const label of ["Payment Links", "Multisend / Payouts", "Swap & Bridge", "Agent Payments"]) {
    assert.match(shell, new RegExp(`label: "${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\n]*status: "TESTNET"`));
  }
  assert.match(shell, /label: "Send"[^\n]*status: "NOT ENABLED"/);
  assert.match(shell, /label: "Activity"[^\n]*status: "LIVE"/);
  assert.match(shell, /label: "Analytics"[^\n]*status: "LIVE"/);
  assert.match(tools, /Mainnet Payouts execution is not enabled/);
  assert.match(tools, /Arc Mainnet swap, bridge, and CCTP execution are not enabled/);
  assert.match(tools, /Mainnet automation is not enabled/);
});

test("the app uses one primary Mainnet indicator and focus-only skip links", () => {
  assert.match(shell, /<span class="app-mainnet">Arc Mainnet<\/span>/);
  assert.doesNotMatch(receivables, /make\("span", "fx-network"/);
  assert.match(skipCss, /\.workspace-skip\s*\{[^}]*clip-path: inset\(50%\)/);
  assert.match(skipCss, /\.workspace-skip:focus\s*\{[^}]*clip-path: none/);
  for (const [name, source] of html) {
    assert.match(source, /<link rel="stylesheet" href="\/src\/shared\/skip\.css"\s*\/?>/, `${name}.html links skip.css without JS`);
  }
  assert.match(css, /body\.receivables-page a\.workspace-skip[^\n]*color: var\(--fx-on-accent\)/);
  assert.match(css, /@media \(max-width: 980px\)/);
});

test("private Activity is owner-scoped and Browser Contacts remains local", () => {
  assert.match(tools, /arcfxApi\.getReceivablesDashboard\(\)/);
  assert.match(tools, /arcfxApi\.receivablesReadiness\(\)/);
  assert.match(tools, /data\.network !== "arc-mainnet"/);
  assert.match(tools, /arcfx_address_book/);
  assert.match(tools, /Customers are separate server-backed business records/);
  assert.doesNotMatch(tools, /sessionToken|Bearer/);
});

test("legacy transaction tools remain deliberately Testnet-scoped", () => {
  for (const path of ["../pay.html", "../multisend.html", "../trade.html", "../agent.html"]) {
    assert.match(read(path), /Arc Testnet|Arc Network Testnet/, `${path} must retain its Testnet identification`);
  }
  assert.match(tools, /href: "\/pay"/);
  assert.match(tools, /href: "\/multisend"/);
  assert.match(tools, /href: "\/trade"/);
  assert.match(tools, /href: "\/agent"/);
});

test("the sidebar has no New invoice item; New invoice is a primary page action", () => {
  assert.doesNotMatch(shell, /label: "New invoice"/);
  assert.match(shell, /label: "Invoices", href: "\/invoices"/);
  assert.match(shell, /label: "Customers", href: "\/customers"/);
  assert.match(shell, /label: "Payment Links"[^\n]*status: "TESTNET"/);
  assert.match(dashboard, /class="dashboard-primary" href="\$\{appPath\("\/invoice"\)\}">New invoice/);
  assert.match(receivables, /"Invoices",\s*\n[^\n]*\n\s*\[nav\("New invoice", "\/invoice", "fx-button--primary"\)\]/);
});

test("Browser Contacts uses labelled fields, a primary save, and row actions", () => {
  assert.match(tools, /field\("Name", "contact-name"/);
  assert.match(tools, /field\("Wallet address", "contact-address"/);
  assert.match(tools, /"Save contact", "tool-button tool-button--primary"/);
  assert.match(tools, /No contacts yet/);
  assert.match(tools, /"Copy", "tool-button"/);
  assert.match(tools, /"Delete", "tool-button tool-button--danger"/);
  assert.match(tools, /localStorage\.setItem\(KEY/);
});

test("app links stay on this project's Vercel previews and never on foreign hosts", async () => {
  const source = read("../src/shared/appOrigin.ts");
  const pattern = new RegExp(source.match(/const PREVIEW_HOST = \/(.+)\/;/)[1]);
  assert.ok(pattern.test("arcswap-abc123def-qazza-s-projects.vercel.app"));
  assert.ok(pattern.test("arcswap-git-step6g1-qazza-s-projects.vercel.app"));
  for (const host of ["evil.vercel.app", "arcswap-x-other-team.vercel.app", "arcswap-x-qazza-s-projects.vercel.app.evil.com", "app.arcfx.app.evil.com"]) {
    assert.equal(pattern.test(host), false, host);
  }
});
