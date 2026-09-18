import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, bindPublicRoles, deploymentDisposition, loadManifest, validateManifest,
} from "./mainnet-release.mjs";

const OWNER = "0x4F81E3939232815e3C98B124A17BaC75304C82D8";
const TESTNET_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "arc-testnet.json"), "utf8"));

function pendingManifest() {
  const manifest = structuredClone(loadManifest());
  for (const contract of manifest.contracts) {
    contract.address = null;
    contract.transactionHash = null;
    contract.blockNumber = null;
    contract.liveRuntimeBytecodeSha256 = null;
  }
  manifest.status = "ready-for-owner-approval";
  return manifest;
}

function recordConfirmedShape(manifest, name, address) {
  const contract = manifest.contracts.find((entry) => entry.name === name);
  Object.assign(contract, {
    address,
    transactionHash: `0x${"11".repeat(32)}`,
    blockNumber: 123,
    liveRuntimeBytecodeSha256: contract.expectedRuntimeBytecodeSha256,
  });
  manifest.status = "deployment-in-progress";
  return contract;
}

test("current Mainnet manifest validates with the approved public roles", () => {
  const manifest = loadManifest();
  assert.equal(manifest.roles.owner.value, OWNER);
  assert.equal(manifest.roles.treasury.value, OWNER);
  assert.equal(validateManifest(manifest, { requireReady: true }).owner, OWNER);
});

test("binding public roles produces a reviewable ready manifest and cannot rebind a deployment", () => {
  const manifest = pendingManifest();
  manifest.roles.owner.value = null;
  manifest.roles.treasury.value = null;
  for (const contract of manifest.contracts) contract.constructorArguments[0].value = null;
  manifest.status = "blocked-missing-public-parameters";
  assert.throws(() => validateManifest(manifest, { requireReady: true }), /OWNER_ADDRESS.*TREASURY_ADDRESS/);
  const bound = bindPublicRoles(manifest, {
    ARCFX_MAINNET_OWNER_ADDRESS: OWNER,
    ARCFX_MAINNET_TREASURY_ADDRESS: OWNER,
  });
  assert.equal(validateManifest(bound, { requireReady: true }).expectedStatus, "ready-for-owner-approval");
  recordConfirmedShape(bound, "ArcFXPayments", "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398");
  assert.throws(() => bindPublicRoles(bound, {
    ARCFX_MAINNET_OWNER_ADDRESS: OWNER,
    ARCFX_MAINNET_TREASURY_ADDRESS: OWNER,
  }), /cannot be rebound/);
});

test("same address on Testnet and Mainnet is allowed with distinct explicit chain identities", () => {
  const manifest = pendingManifest();
  const testnetAddress = TESTNET_MANIFEST.contracts.find((entry) => entry.name === "ArcFXMultisender").address;
  recordConfirmedShape(manifest, "ArcFXPayments", testnetAddress);
  const result = validateManifest(manifest, { requireReady: true });
  assert.equal(result.deployedCount, 1);
  assert.equal(manifest.contracts[0].caip2, "eip155:5042");
  assert.equal(TESTNET_MANIFEST.chainId, 5042002);
});

test("copied Testnet tuple, wrong manifest chain, and artifact drift fail closed", () => {
  const copied = pendingManifest();
  const entry = recordConfirmedShape(copied, "ArcFXPayments", TESTNET_MANIFEST.contracts[0].address);
  entry.network = TESTNET_MANIFEST.network;
  entry.chainId = TESTNET_MANIFEST.chainId;
  entry.caip2 = `eip155:${TESTNET_MANIFEST.chainId}`;
  entry.rpc = TESTNET_MANIFEST.rpc;
  assert.throws(() => validateManifest(copied), /deployment chain provenance/);

  const wrongChain = pendingManifest();
  wrongChain.chainId = 5042002;
  assert.throws(() => validateManifest(wrongChain), /release identity drifted/);

  const drift = pendingManifest();
  drift.contracts[0].creationBytecodeSha256 = "00".repeat(32);
  assert.throws(() => validateManifest(drift), /bytecode hash/);
});

test("resume state skips only complete records and refuses ambiguous partial records", () => {
  const manifest = pendingManifest();
  assert.equal(deploymentDisposition(manifest.contracts[0]), "deploy");
  recordConfirmedShape(manifest, "ArcFXPayments", "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398");
  assert.equal(deploymentDisposition(manifest.contracts[0]), "verify-and-skip");
  assert.equal(deploymentDisposition(manifest.contracts[1]), "deploy");
  manifest.contracts[1].transactionHash = `0x${"22".repeat(32)}`;
  assert.throws(() => deploymentDisposition(manifest.contracts[1]), /record is partial/);
  assert.throws(() => validateManifest(manifest), /record is partial/);
});
