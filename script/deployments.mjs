/**
 * Deployment manifests + automated bytecode verification.
 *
 * Why this exists
 * ───────────────
 * ArcFXMultisender's source was edited after it was deployed and never
 * redeployed, so `contracts/` and the chain disagreed about the fee rate for
 * weeks. Nothing caught it, because nothing was checking. A UI change was made
 * on the assumption that both contracts charged 0.10%; only reading FEE_BPS
 * on-chain revealed Payments charges 0.15%.
 *
 * This makes that class of drift impossible to miss:
 *
 *   node script/deployments.mjs check    read the chain, compare against the
 *                                        manifest, exit non-zero on any drift
 *   node script/deployments.mjs write    regenerate the manifest from the chain
 *                                        (run this only after a real deploy)
 *
 * `check` needs no secrets and no local compile — it reads a public RPC — so it
 * runs in CI on every push.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { id } from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "deployments", "arc-testnet.json");

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const EXPLORER = "https://testnet.arcscan.app";

// The deployed contracts, and the byte-exact source that produced each. The
// verified/ copies are the reference, NOT contracts/ — the working sources are
// edited between deploys and are expected to differ.
const CONTRACTS = [
  {
    name: "ArcFXPayments",
    address: "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
    source: "verified/ArcFXPayments.deployed.sol",
    working: "contracts/ArcFXPayments.sol",
    // Constants read back from the chain and pinned here. A redeploy that
    // changes one of these fails `check` until the manifest is regenerated,
    // which is the point: the rate can never silently move again.
    constants: { FEE_BPS: 15, BPS_DENOM: 10000 },
  },
  {
    name: "ArcFXMultisender",
    address: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
    source: "verified/ArcFXMultisender.deployed.sol",
    working: "contracts/ArcFXMultisender.sol",
    constants: { FEE_BPS: 10, BPS_DENOM: 10000, FREE_LIMIT: 5, MAX_LIMIT: 500 },
  },
];

const BUILD = {
  compiler: "v0.8.20+commit.a1b79de6",
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "paris",
  license: "MIT",
};

// ── chain helpers ───────────────────────────────────────────────────────────

/** Raised when the chain could not be reached at all, as opposed to disagreeing. */
class Unreachable extends Error {}

async function rpc(method, params, attempt = 0) {
  let res;
  try {
    res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // A public testnet RPC from a CI runner is not always available. Retry
    // before concluding anything, and never let a network blip read as drift.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return rpc(method, params, attempt + 1);
    }
    throw new Unreachable(`${RPC} unreachable: ${err.message}`);
  }
  if (res.status >= 500 || res.status === 429) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return rpc(method, params, attempt + 1);
    }
    throw new Unreachable(`${RPC} returned HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * 4-byte selector for a function signature.
 *
 * Computed, never hardcoded. Solidity uses keccak256, and Node's built-in
 * "sha3-256" is the FIPS variant — a different function — so this borrows
 * ethers' keccak, which the project already depends on.
 */
function selector(signature) {
  return id(signature).slice(0, 10);
}

async function readUint(address, signature) {
  const data = selector(signature);
  const out = await rpc("eth_call", [{ to: address, data }, "latest"]);
  if (!out || out === "0x") return null;
  return Number(BigInt(out));
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── manifest ────────────────────────────────────────────────────────────────

async function collect() {
  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (chainId !== CHAIN_ID) {
    throw new Error(`RPC reports chainId ${chainId}, expected ${CHAIN_ID} (wrong network?)`);
  }

  const entries = [];
  for (const c of CONTRACTS) {
    const code = await rpc("eth_getCode", [c.address, "latest"]);
    if (!code || code === "0x") throw new Error(`${c.name}: no code at ${c.address}`);

    const srcPath = path.join(ROOT, c.source);
    if (!fs.existsSync(srcPath)) throw new Error(`${c.name}: missing ${c.source}`);
    // Read as raw bytes: the metadata hash is computed over exact bytes, so a
    // line-ending change would alter it. verified/*.sol is pinned -text in
    // .gitattributes for exactly this reason.
    const srcBytes = fs.readFileSync(srcPath);

    const constants = {};
    for (const key of Object.keys(c.constants)) {
      constants[key] = await readUint(c.address, `${key}()`);
    }

    entries.push({
      name: c.name,
      address: c.address,
      explorer: `${EXPLORER}/address/${c.address}`,
      runtimeBytecode: {
        sha256: sha256(Buffer.from(code.slice(2), "hex")),
        bytes: (code.length - 2) / 2,
      },
      source: {
        path: c.source,
        sha256: sha256(srcBytes),
        bytes: srcBytes.length,
      },
      workingSource: c.working,
      constants,
    });
  }

  return {
    $comment:
      "Generated by script/deployments.mjs. Regenerate ONLY after a real deploy: " +
      "`node script/deployments.mjs write`. CI runs `check` on every push.",
    network: "arc-testnet",
    chainId,
    rpc: "https://rpc.testnet.arc.network",
    explorer: EXPLORER,
    build: BUILD,
    generatedAt: new Date().toISOString().slice(0, 10),
    contracts: entries,
  };
}

// ── commands ────────────────────────────────────────────────────────────────

async function write() {
  const manifest = await collect();
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, MANIFEST)}`);
  for (const c of manifest.contracts) {
    console.log(`  ${c.name.padEnd(17)} ${c.address}  ${JSON.stringify(c.constants)}`);
  }
}

async function check() {
  if (!fs.existsSync(MANIFEST)) {
    console.error("No manifest. Run: node script/deployments.mjs write");
    process.exit(1);
  }
  const pinned = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const live = await collect();
  const problems = [];

  for (const want of pinned.contracts) {
    const got = live.contracts.find((c) => c.name === want.name);
    if (!got) { problems.push(`${want.name}: not found on chain`); continue; }

    if (got.address.toLowerCase() !== want.address.toLowerCase()) {
      problems.push(`${want.name}: address moved ${want.address} -> ${got.address}`);
    }
    if (got.runtimeBytecode.sha256 !== want.runtimeBytecode.sha256) {
      problems.push(
        `${want.name}: DEPLOYED BYTECODE CHANGED\n` +
        `      pinned ${want.runtimeBytecode.sha256}\n` +
        `      onchain ${got.runtimeBytecode.sha256}`
      );
    }
    if (got.source.sha256 !== want.source.sha256) {
      problems.push(
        `${want.name}: ${want.source.path} was edited — it must stay byte-exact\n` +
        `      pinned ${want.source.sha256}\n` +
        `      onDisk ${got.source.sha256}`
      );
    }
    for (const [k, v] of Object.entries(want.constants)) {
      if (got.constants[k] !== v) {
        problems.push(`${want.name}.${k}: manifest says ${v}, chain says ${got.constants[k]}`);
      }
    }
  }

  const width = Math.max(...live.contracts.map((c) => c.name.length));
  console.log(`Arc Testnet (chainId ${live.chainId}) via ${RPC}\n`);
  for (const c of live.contracts) {
    const consts = Object.entries(c.constants).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ${c.name.padEnd(width)}  ${c.address}`);
    console.log(`  ${" ".repeat(width)}  ${c.runtimeBytecode.bytes} bytes  ${consts}`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n`);
    problems.forEach((p) => console.error("  - " + p));
    console.error(
      "\nIf a deploy really happened, regenerate with:\n" +
      "  node script/deployments.mjs write\n"
    );
    process.exit(1);
  }
  console.log("\nOK - chain matches the manifest.");
}

const cmd = process.argv[2] || "check";
const run = { check, write }[cmd];
if (!run) { console.error(`unknown command "${cmd}" (use check | write)`); process.exit(1); }
run().catch((err) => {
  // An unreachable chain is not evidence of drift, and failing CI for it would
  // train everyone to ignore a red build — which defeats the whole guard. Say
  // so loudly and pass; a real disagreement still fails.
  if (err instanceof Unreachable) {
    console.warn("SKIPPED: " + err.message);
    console.warn("The chain could not be read, so nothing was verified. This is");
    console.warn("not a pass — re-run when the RPC is available.");
    process.exit(0);
  }
  console.error("FAILED: " + err.message);
  process.exit(1);
});
