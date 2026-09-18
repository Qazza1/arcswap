import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = path.join(ROOT, "deployments", "arc-mainnet.release.json");
export const MAINNET_CHAIN_ID = 5042;
export const MAINNET_CAIP2 = "eip155:5042";
export const MAINNET_RPC = "https://rpc.mainnet.arc.io";
export const MAINNET_EXPLORER = "https://explorer.arc.io";
export const MAINNET_USDC = "0x3600000000000000000000000000000000000000";
export const BROADCAST_APPROVAL = "DEPLOY_ARCFX_TO_ARC_MAINNET_5042";

const EXPECTED_CONTRACTS = new Map([
  ["ArcFXPayments", "artifacts/contracts/ArcFXPayments.sol/ArcFXPayments.json"],
  ["ArcFXMultisender", "artifacts/contracts/ArcFXMultisender.sol/ArcFXMultisender.json"],
]);

export function bytecodeSha256(bytecode) {
  if (typeof bytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) {
    throw new Error("Cannot hash missing or malformed bytecode");
  }
  return crypto.createHash("sha256").update(Buffer.from(bytecode.slice(2), "hex")).digest("hex");
}

export function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function loadArtifact(relativePath) {
  const expectedRoot = path.join(ROOT, "artifacts", "contracts") + path.sep;
  const absolute = path.resolve(ROOT, relativePath);
  if (!absolute.startsWith(expectedRoot)) throw new Error(`Artifact path escapes expected directory: ${relativePath}`);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export function publicAddress(name, value) {
  if (!value) throw new Error(`Missing required public value: ${name}`);
  let normalized;
  try { normalized = getAddress(value); } catch { throw new Error(`Invalid address in ${name}`); }
  if (normalized === getAddress("0x0000000000000000000000000000000000000000")) {
    throw new Error(`${name} must not be the zero address`);
  }
  return normalized;
}

function optionalPublicAddress(name, value) {
  return value === null ? null : publicAddress(name, value);
}

export function deploymentDisposition(contract) {
  const values = [contract.address, contract.transactionHash, contract.blockNumber, contract.liveRuntimeBytecodeSha256];
  const present = values.filter((value) => value !== null).length;
  if (present !== 0 && present !== values.length) throw new Error(`${contract.name}: deployment record is partial`);
  return present === 0 ? "deploy" : "verify-and-skip";
}

function validateDeployedFields(contract) {
  if (deploymentDisposition(contract) === "deploy") return false;
  publicAddress(`${contract.name}.address`, contract.address);
  if (!/^0x[0-9a-fA-F]{64}$/.test(contract.transactionHash)) throw new Error(`${contract.name}: invalid deployment transaction hash`);
  if (!Number.isSafeInteger(contract.blockNumber) || contract.blockNumber < 1) throw new Error(`${contract.name}: invalid deployment block`);
  if (contract.liveRuntimeBytecodeSha256 !== contract.expectedRuntimeBytecodeSha256) {
    throw new Error(`${contract.name}: live runtime bytecode hash does not match the reviewed artifact`);
  }
  return true;
}

export function validateManifest(manifest, { requireReady = false } = {}) {
  if (manifest.network !== "arc-mainnet" || manifest.chainId !== MAINNET_CHAIN_ID || manifest.caip2 !== MAINNET_CAIP2) {
    throw new Error("Arc Mainnet release identity drifted");
  }
  if (manifest.rpc !== MAINNET_RPC || manifest.explorer !== MAINNET_EXPLORER || manifest.usdc?.toLowerCase() !== MAINNET_USDC) {
    throw new Error("Arc Mainnet public network constants drifted");
  }
  if (manifest.build?.compiler !== "0.8.35" || manifest.build?.optimizer?.enabled !== true
      || manifest.build?.optimizer?.runs !== 200 || manifest.build?.evmVersion !== "paris") {
    throw new Error("Arc Mainnet release build settings drifted");
  }

  const owner = optionalPublicAddress("roles.owner.value", manifest.roles?.owner?.value ?? null);
  const treasury = optionalPublicAddress("roles.treasury.value", manifest.roles?.treasury?.value ?? null);
  if (manifest.roles?.owner?.source !== "ARCFX_MAINNET_OWNER_ADDRESS"
      || manifest.roles?.treasury?.source !== "ARCFX_MAINNET_TREASURY_ADDRESS") {
    throw new Error("Mainnet public role bindings drifted");
  }
  if ((owner === null) !== (treasury === null)) throw new Error("Owner and treasury must be bound together");

  if (!Array.isArray(manifest.contracts) || manifest.contracts.length !== EXPECTED_CONTRACTS.size) {
    throw new Error("Mainnet manifest must contain exactly the reviewed contracts");
  }
  let deployedCount = 0;
  for (const [name, artifactPath] of EXPECTED_CONTRACTS) {
    const contract = manifest.contracts.find((entry) => entry.name === name);
    if (!contract || contract.artifact !== artifactPath) throw new Error(`${name}: wrong or missing artifact`);
    // Deployment identity is (CAIP-2, address), never address alone. A CREATE
    // address can legitimately recur on two EVM chains. Copied Testnet
    // provenance must still fail validation in this Mainnet release.
    if (contract.network !== manifest.network || contract.chainId !== manifest.chainId
        || contract.caip2 !== manifest.caip2 || contract.rpc !== manifest.rpc) {
      throw new Error(`${name}: deployment chain provenance does not match Arc Mainnet`);
    }
    const artifact = loadArtifact(artifactPath);
    const creationHash = bytecodeSha256(artifact.bytecode);
    const runtimeHash = bytecodeSha256(artifact.deployedBytecode);
    if (contract.creationBytecodeSha256 !== creationHash || contract.expectedRuntimeBytecodeSha256 !== runtimeHash) {
      throw new Error(`${name}: bytecode hash does not match the compiled reviewed artifact`);
    }
    const constructor = artifact.abi.find((entry) => entry.type === "constructor");
    if (!constructor || constructor.inputs?.length !== 1 || constructor.inputs[0].name !== "_treasury"
        || constructor.inputs[0].type !== "address") {
      throw new Error(`${name}: constructor ABI differs from the reviewed one-address treasury shape`);
    }
    const args = contract.constructorArguments;
    if (!Array.isArray(args) || args.length !== 1 || args[0].name !== "_treasury"
        || args[0].source !== "ARCFX_MAINNET_TREASURY_ADDRESS" || args[0].value !== manifest.roles.treasury.value) {
      throw new Error(`${name}: constructor arguments are not bound to the reviewed treasury role`);
    }
    if (validateDeployedFields(contract)) deployedCount++;
  }

  const expectedStatus = owner === null
    ? "blocked-missing-public-parameters"
    : deployedCount === 0
      ? "ready-for-owner-approval"
      : deployedCount === manifest.contracts.length
        ? "deployed-runtime-verified"
        : "deployment-in-progress";
  if (manifest.status !== expectedStatus) throw new Error(`Manifest status must be ${expectedStatus}`);
  if (requireReady && owner === null) {
    throw new Error("Mainnet release is blocked: ARCFX_MAINNET_OWNER_ADDRESS and ARCFX_MAINNET_TREASURY_ADDRESS are not bound");
  }
  return { owner, treasury, deployedCount, expectedStatus };
}

export function bindPublicRoles(manifest, env = process.env) {
  if (manifest.contracts?.some((contract) => contract.address !== null)) {
    throw new Error("Public roles cannot be rebound after any deployment has been recorded");
  }
  const owner = publicAddress("ARCFX_MAINNET_OWNER_ADDRESS", env.ARCFX_MAINNET_OWNER_ADDRESS);
  const treasury = publicAddress("ARCFX_MAINNET_TREASURY_ADDRESS", env.ARCFX_MAINNET_TREASURY_ADDRESS);
  const next = structuredClone(manifest);
  next.roles.owner.value = owner;
  next.roles.treasury.value = treasury;
  for (const contract of next.contracts) contract.constructorArguments[0].value = treasury;
  next.status = next.contracts.some((contract) => contract.address !== null)
    ? "deployment-in-progress"
    : "ready-for-owner-approval";
  validateManifest(next, { requireReady: true });
  return next;
}

export function writeManifest(manifest) {
  validateManifest(manifest);
  const temporary = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, MANIFEST_PATH);
}
