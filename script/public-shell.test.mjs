import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("public shell keeps marketing and workspace origins explicit", () => {
  const shell = read("src/shared/publicShell.ts");
  assert.match(shell, /const PUBLIC_ORIGIN = "https:\/\/www\.arcfx\.app"/);
  assert.match(shell, /const APP_ENTRY = "https:\/\/app\.arcfx\.app\/entry"/);
  assert.match(shell, /public-brand.*href="\$\{PUBLIC_ORIGIN\}\/"/s);
  assert.match(shell, /public-open-app.*href="\$\{APP_ENTRY\}"/s);
  assert.doesNotMatch(shell, /arcfxWallet|arcfxApi|Authorization|sessionStorage/);
});

test("entry is an app-origin surface with a constrained logo", () => {
  const entry = read("src/workspace/entry.ts");
  const css = read("src/shared/appShell.css");
  assert.match(entry, /document\.body\.classList\.add\("app-workspace"\)/);
  assert.match(entry, /class="entry-logo"/);
  assert.match(css, /\.entry-logo\s*\{[^}]*width:\s*clamp\(116px, 28vw, 160px\)/s);
  assert.match(css, /\.entry-logo\s*\{[^}]*max-height:\s*52px/s);
});

test("public and legacy public routes no longer mount the workspace header", () => {
  for (const file of ["developers.html", "docs.html", "docs-api.html", "security.html", "pricing.html", "agent.html", "analytics.html", "ecosystem.html", "history.html", "multisend.html", "pay.html", "trade.html"]) {
    const source = read(file);
    assert.match(source, /mountPublicShell/, `${file} mounts the public shell`);
    assert.doesNotMatch(source, /arcfxMountHeader/, `${file} does not mount the legacy workspace header`);
  }
});

test("legacy public workspace paths remain host-scoped redirects", () => {
  const config = JSON.parse(read("vercel.json"));
  for (const source of ["/app", "/customers", "/invoices", "/invoice"]) {
    const rule = config.redirects.find((entry) => entry.source === source);
    assert.ok(rule, `${source} has a public redirect`);
    assert.deepEqual(rule.has, [{ type: "host", value: "www.arcfx.app" }]);
    assert.match(rule.destination, /^https:\/\/app\.arcfx\.app\//);
  }
});
