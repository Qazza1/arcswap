/**
 * Guards the Content-Security-Policy.
 *
 * The policy in vercel.json sends `script-src 'self'` with no 'unsafe-inline',
 * which is only safe to promise because the build contains no inline scripts
 * and no inline event handlers. Nothing prevents someone adding an onclick=
 * back later — and the failure mode is nasty: it works locally, where no CSP
 * header is served, and silently does nothing in production.
 *
 * So the built output is checked, not the source. Run after `vite build`:
 *
 *   node script/csp-guard.mjs
 *
 * If this fails, the fix is a real listener, not a looser policy. Static markup
 * uses the data-fxh + __fxOn pattern; markup rendered from a template literal
 * uses data-fx-act with the delegated dispatcher.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

if (!fs.existsSync(DIST)) {
  console.error("No dist/. Run `npx vite build` first.");
  process.exit(1);
}

const HANDLER = /\son(click|change|input|submit|mouseover|mouseout|mouseenter|mouseleave|focus|focusin|focusout|blur|keyup|keydown|keypress|paste|dragover|drop|dragleave|dragenter)\s*=/gi;
// A <script> with no src= is inline, whether or not it is a module.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>/gi;

// script-src allows these two hosts; anything else would be blocked at runtime.
const ALLOWED_SCRIPT_HOSTS = new Set(["cdn.sheetjs.com", "cdnjs.cloudflare.com"]);

const pages = fs.readdirSync(DIST).filter((f) => f.endsWith(".html"));
if (!pages.length) { console.error("dist/ has no HTML pages — did the build run?"); process.exit(1); }

const problems = [];
let handlers = 0, inlineScripts = 0;

for (const page of pages.sort()) {
  const html = fs.readFileSync(path.join(DIST, page), "utf8");

  for (const m of html.matchAll(HANDLER)) {
    handlers++;
    const near = html.slice(Math.max(0, m.index - 60), m.index + 70).replace(/\s+/g, " ");
    problems.push(`${page}: inline handler on${m[1]}= ...${near}...`);
  }
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    inlineScripts++;
    problems.push(`${page}: inline <script> — ${m[0].slice(0, 70)}`);
  }
  // Third-party scripts must be on the allowlist the policy actually sends.
  for (const m of html.matchAll(/<script[^>]*\ssrc="(https?:\/\/[^"]+)"/gi)) {
    const host = new URL(m[1]).host;
    if (!ALLOWED_SCRIPT_HOSTS.has(host)) {
      problems.push(`${page}: script from ${host}, which script-src does not allow`);
    }
  }
}

console.log(`checked ${pages.length} built pages`);
console.log(`  inline event handlers : ${handlers}`);
console.log(`  inline <script> blocks: ${inlineScripts}`);

if (problems.length) {
  console.error(`\nCSP would block ${problems.length} thing(s):\n`);
  problems.slice(0, 25).forEach((p) => console.error("  - " + p));
  if (problems.length > 25) console.error(`  ... and ${problems.length - 25} more`);
  console.error(
    "\nFix with a real listener, not a looser policy:\n" +
    "  static markup   -> data-fxh=\"hN\" + __fxOn(\"hN\", \"click\", function (event) { ... })\n" +
    "  rendered markup -> data-fx-on=\"click\" data-fx-act=\"fnName\" (delegated dispatcher)\n"
  );
  process.exit(1);
}

console.log("\nOK - nothing in the build needs 'unsafe-inline'.");
