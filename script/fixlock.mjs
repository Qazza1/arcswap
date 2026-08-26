/**
 * Repairs optional-peer entries that Windows npm prunes and Linux CI demands.
 *
 *   npm run fix:lock
 *
 * Every `npm install` on Windows drops the nested utf-8-validate entries that
 * the `ws` copies under hardhat and jayson declare as optional peers at ^5.0.2 —
 * a range the root's 6.0.6 cannot satisfy. `npm ci` passes locally with the
 * exact lockfile that fails on Linux, so the breakage is invisible until CI goes
 * red. It has now done so twice.
 *
 * A full regeneration also fixes it, but drags along a hundred-odd unrelated
 * version changes including the Circle SDK. This resolves the missing entries in
 * a clean room and copies ONLY those across, leaving every version untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, "package-lock.json");

const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
const pkgs = lock.packages || {};

// Which optional peers is the tree currently unable to satisfy?
let semver;
try { semver = (await import("semver")).default; }
catch { console.error("semver is not resolvable — run npm install first."); process.exit(1); }

const missing = [];
for (const [owner, entry] of Object.entries(pkgs)) {
  const peers = entry.peerDependencies || {};
  const meta = entry.peerDependenciesMeta || {};
  for (const [dep, range] of Object.entries(peers)) {
    if (!meta[dep]?.optional) continue;
    let found = null, scope = owner;
    while (scope !== null) {
      const cand = pkgs[`${scope}${scope ? "/" : ""}node_modules/${dep}`];
      if (cand) { found = cand; break; }
      const cut = scope.lastIndexOf("/node_modules/");
      scope = cut === -1 ? (scope === "" ? null : "") : scope.slice(0, cut);
    }
    if (found && !semver.satisfies(found.version, range)) missing.push({ owner, dep, range });
  }
}

if (!missing.length) {
  console.log("Lockfile is already complete — nothing to repair.");
  process.exit(0);
}

console.log(`${missing.length} unsatisfied optional peer(s):`);
missing.forEach((m) => console.log(`  ${m.owner} needs ${m.dep}@${m.range}`));

// Resolve the same package.json in a clean room, where npm produces the nested
// entries it would install on a fresh machine.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arcfx-lockfix-"));
console.log(`\nresolving in a clean room (${tmp}) …`);
fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
execSync("npm install --package-lock-only --ignore-scripts --no-audit --no-fund", {
  cwd: tmp, stdio: "pipe",
});
const clean = JSON.parse(fs.readFileSync(path.join(tmp, "package-lock.json"), "utf8"));

let added = 0;
for (const key of Object.keys(clean.packages)) {
  // Only nested copies of the deps we know are missing, nothing else.
  if (pkgs[key]) continue;
  const isWanted = missing.some((m) => key.endsWith(`/node_modules/${m.dep}`));
  if (!isWanted) continue;
  pkgs[key] = clean.packages[key];
  added++;
  console.log(`  + ${key} -> ${clean.packages[key].version}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

if (!added) {
  console.error("\nA clean resolution produced no nested entries. Regenerate the lock by hand:");
  console.error("  mv node_modules ../parked && rm package-lock.json && npm install --package-lock-only && mv ../parked node_modules");
  process.exit(1);
}

// Keep npm's own ordering so the diff stays small.
const sorted = {};
for (const k of Object.keys(pkgs).sort()) sorted[k] = pkgs[k];
lock.packages = sorted;
fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");

console.log(`\nwrote ${added} entr${added === 1 ? "y" : "ies"}. Re-run: npm run preflight`);
