import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const shell = read("../src/shared/appShell.ts");
const css = read("../src/shared/appShell.css");
const receivables = read("../src/workspace/receivables.ts");
const dashboard = read("../src/workspace/dashboard.ts");
const tools = read("../src/workspace/tools.ts");
const api = read("../src/shared/arcfxApi.ts");

test("all Mainnet business pages wait for the shared restored owner session", () => {
  assert.match(dashboard, /await arcfxApi\.receivablesReadiness\(\)/);
  assert.match(receivables, /const readiness = await arcfxApi\.receivablesReadiness\(\)/);
  assert.match(receivables, /root\.replaceChildren\(message\("Restoring secure workspace…"\)\)/);
  assert.match(receivables, /current !== version/);
  assert.match(api, /await arcfxWallet\.restore\(\)/);
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
  assert.match(css, /\.workspace-skip\s*\{[^}]*translateY\(-160%\)/);
  assert.match(css, /\.workspace-skip:focus\s*\{[^}]*translateY\(0\)/);
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
