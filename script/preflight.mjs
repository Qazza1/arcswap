/**
 * Pre-deploy checks.
 *
 * "It builds" has repeatedly not been enough on this project. Bulk edits over
 * HTML and CSS have shipped: gradients broken by a regex that stopped at the
 * wrong paren, `<input … / aria-label>` tags, a :root remap that painted
 * backgrounds with the text colour, handlers pulled out of template literals,
 * and a CSV export whose header grew two columns while its rows did not.
 *
 * Every check here exists because something in that list got through. Run it
 * before pushing:
 *
 *   npm run preflight
 *
 * It is static and fast. It does not replace loading the pages — the runtime
 * probes still matter — but it catches the damage patterns that bulk edits
 * actually produce.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const note = (m) => notes.push(m);

// Scratch HTML in the project root — generated reports, one-off pages — is
// worth mentioning but must not block a deploy, since it was never meant to
// ship.
let tracked = new Set();
try {
  tracked = new Set(
    execFileSync("git", ["ls-files", "*.html"], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean)
  );
} catch { /* not a git checkout; fall back to treating everything as app pages */ }

// A page counts as part of the app if git tracks it OR the build is told to
// build it. Tracking alone was the wrong test: a brand-new page is untracked
// until the moment it is committed, which is precisely when these checks are
// most worth running.
const viteConfig = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
const registered = new Set(
  [...viteConfig.matchAll(/resolve\(__dirname,\s*"([^"]+\.html)"\)/g)].map((m) => m[1])
);

const allHtml = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
const pages = (tracked.size || registered.size)
  ? allHtml.filter((f) => tracked.has(f) || registered.has(f))
  : allHtml;
const strays = allHtml.filter((f) => !pages.includes(f));

// ── 1. CSS structure ────────────────────────────────────────────────────────
// A regex that eats one paren too many silently breaks every rule after it.
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  if (!styles) continue;

  const open = (styles.match(/\(/g) || []).length;
  const close = (styles.match(/\)/g) || []).length;
  if (open !== close) fail(`${page}: CSS has ${open} "(" and ${close} ")" — a rule is malformed`);

  const braces = (styles.match(/\{/g) || []).length - (styles.match(/\}/g) || []).length;
  if (braces !== 0) fail(`${page}: CSS braces unbalanced by ${braces}`);

  // var(--a), var(--b)) — the signature of a gradient chewed by a lazy regex.
  const m = styles.match(/var\(--[a-z-]+\)\s*,\s*var\(--[a-z-]+\)\)\s*;/);
  if (m) fail(`${page}: looks like a mangled gradient: ${m[0].slice(0, 60)}`);
}

// ── 2. Tag structure ────────────────────────────────────────────────────────
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");

  // `<input ... / aria-label="x">` — an attribute inserted after the solidus.
  for (const m of html.matchAll(/<[a-z]+[^>]*\/\s+[a-z-]+=/gi)) {
    fail(`${page}: attribute after the self-closing slash: ${m[0].slice(0, 70)}`);
  }
  // Duplicate ids break getElementById in ways that look like logic bugs.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set(), dupes = new Set();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  if (dupes.size) fail(`${page}: duplicate id(s): ${[...dupes].join(", ")}`);
}

// ── 3. CSP invariants ───────────────────────────────────────────────────────
// The policy promises script-src 'self'. Source-level handlers would survive
// into the build, so check here as well as in csp-guard (which checks dist/).
const EVENTS = /\son(click|change|input|submit|mouseover|mouseout|mouseenter|mouseleave|focus|focusin|focusout|blur|keyup|keydown|keypress|paste|dragover|drop|dragleave|dragenter)\s*=/gi;
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  const hits = [...html.matchAll(EVENTS)];
  if (hits.length) fail(`${page}: ${hits.length} inline event handler(s) — CSP blocks these`);
}

// ── 4. Event wiring integrity ───────────────────────────────────────────────
// Every __fxOn("hN", …) must have a matching data-fxh in the markup, and vice
// versa. A marker with no listener is a dead control; a listener with no marker
// is a handler that silently never runs.
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  const wired = new Set([...html.matchAll(/__fxOn\("([^"]+)"/g)].map((m) => m[1]));
  const marked = new Set();
  for (const m of html.matchAll(/\sdata-fxh="([^"]+)"/g)) {
    for (const id of m[1].trim().split(/\s+/)) marked.add(id);
  }
  for (const id of wired) if (!marked.has(id)) fail(`${page}: __fxOn("${id}") has no data-fxh in the markup`);
  for (const id of marked) if (!wired.has(id)) fail(`${page}: data-fxh="${id}" has no __fxOn listener`);

  // Delegated actions must name a function the page actually defines globally.
  const acts = new Set([...html.matchAll(/data-fx-act="([^"]+)"/g)].map((m) => m[1]));
  for (const act of acts) {
    const defined = new RegExp(`window\\.${act}\\s*=|function\\s+${act}\\b`).test(html);
    if (!defined) fail(`${page}: data-fx-act="${act}" names no function defined on this page`);
  }
  if (acts.size && !/function __fxDelegate/.test(html)) {
    fail(`${page}: uses data-fx-act but has no __fxDelegate dispatcher`);
  }
}

// ── 5. Routing ──────────────────────────────────────────────────────────────
// A page must be built AND routed, or it 404s only in production.
const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const built = registered;   // parsed once, at the top
const routed = new Set((vercel.rewrites || []).map((r) => r.destination.replace(/^\//, "")));
for (const page of pages) {
  if (!built.has(page)) fail(`${page}: not registered in vite.config.ts — it will not be built`);
  if (!routed.has(page) && page !== "index.html") fail(`${page}: no rewrite in vercel.json — its clean URL will 404`);
}

// ── 6. Lockfile completeness ────────────────────────────────────────────────
// `npm ci` rejects a lock that is not internally complete, and Windows npm
// prunes optional-peer entries that Linux CI then demands. This cost three
// consecutive red builds.
//
// npm itself is the only correct judge of this — a hand-rolled semver check
// gets ranges like "^1 || ^2 || ^3 || ^4" wrong — so run the real resolver in a
// scratch directory. --dry-run does the full resolution without installing, in
// about three seconds.
{
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "arcfx-lock-"));
  try {
    fs.copyFileSync("package.json", path.join(tmp, "package.json"));
    fs.copyFileSync("package-lock.json", path.join(tmp, "package-lock.json"));
    // A single fixed command string, not an args array: Node 24 refuses to
    // spawn npm.cmd without a shell (EINVAL), and passing an ARRAY through a
    // shell is what DEP0190 warns about. Every token here is a literal, so
    // there is nothing to escape.
    execSync("npm ci --dry-run --ignore-scripts --no-audit --no-fund", {
      cwd: tmp, stdio: "pipe",
    });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    const missing = [...out.matchAll(/Missing: (\S+) from lock file/g)].map((m) => m[1]);
    const why = out.split("\n").map((l) => l.replace(/^npm (error|ERR!)\s*/, "").trim())
      .filter((l) => l && !/^(Usage|Options|aliases|Run "npm|\[|npm ci$|Clean install)/.test(l))
      .slice(0, 3).join(" / ");
    fail(
      "npm ci would fail on this lockfile" +
      (missing.length ? ` — missing: ${[...new Set(missing)].join(", ")}` : "") +
      (why ? `\n      npm said: ${why}` : "") +
      "\n      Regenerate with node_modules moved aside, or add the missing entries."
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 6b. Optional peers that only Linux notices ──────────────────────────────
// The dry-run above passes on Windows even for the lock that broke CI, because
// this resolution is platform-dependent: Windows npm prunes optional-peer
// entries it will never install, and Linux npm then reports them missing.
//
// So check the invariant directly. Semver ranges are done with the real semver
// library — hand-rolling them is what produced a page of false positives the
// first time.
{
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const pkgs = lock.packages || {};
  let semver = null;
  try { semver = (await import("semver")).default; } catch { /* checked below */ }

  if (!semver) {
    note("semver not resolvable — skipped the optional-peer lockfile check");
  } else {
    for (const [owner, entry] of Object.entries(pkgs)) {
      const peers = entry.peerDependencies || {};
      const meta = entry.peerDependenciesMeta || {};
      for (const [dep, range] of Object.entries(peers)) {
        if (!meta[dep]?.optional) continue;

        // Walk up the nesting the way node resolution does: the nearest
        // node_modules/<dep> that an installer would place for this owner.
        let found = null;
        let scope = owner;
        while (scope !== null) {
          const candidate = pkgs[`${scope}${scope ? "/" : ""}node_modules/${dep}`];
          if (candidate) { found = candidate; break; }
          const cut = scope.lastIndexOf("/node_modules/");
          scope = cut === -1 ? (scope === "" ? null : "") : scope.slice(0, cut);
        }
        if (!found) continue;                       // not in the tree at all: fine
        if (semver.satisfies(found.version, range)) continue;

        fail(
          `package-lock.json: ${owner} declares optional peer ${dep}@${range}, ` +
          `but the nearest entry is ${found.version}.\n` +
          `      Linux \`npm ci\` will report this as "Missing: ${dep}@<x> from lock file".\n` +
          `      Add the nested entry, or regenerate the lock with node_modules moved aside.`
        );
      }
    }
  }
}

// ── 7. Contract formatting ──────────────────────────────────────────────────
// Only when Foundry is actually installed. "forge is not on PATH" is an
// environment fact, not a code defect, and reporting it as one is how a guard
// starts crying wolf — the dedicated Contracts job runs this properly anyway.
try {
  execFileSync("forge", ["fmt", "--check"], { stdio: "pipe" });
} catch (e) {
  if (e.code === "ENOENT" || e.code === "EINVAL") {
    note("forge not installed — skipped the contract formatting check");
  } else {
    fail("forge fmt --check fails — CI will reject the contract sources");
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`preflight: ${pages.length} tracked pages checked\n`);
if (strays.length) {
  console.log(`  note: ${strays.length} untracked HTML file(s) in the project root, not checked and not shipped:`);
  console.log(`        ${strays.join(", ")}`);
}
for (const n of notes) console.log("  note: " + n);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  problems.forEach((p) => console.error("  - " + p));
  console.error("\nFix these before deploying.");
  process.exit(1);
}
console.log("OK - no structural problems found.");
console.log("(still load the pages: this checks structure, not behaviour)");
