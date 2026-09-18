import fs from "node:fs";
import path from "node:path";
import { ROOT, loadManifest, validateManifest } from "./mainnet-release.mjs";

const hardhat = fs.readFileSync(path.join(ROOT, "hardhat.config.cjs"), "utf8");
const foundry = fs.readFileSync(path.join(ROOT, "foundry.toml"), "utf8");

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(message);
}

requireMatch(hardhat, /version:\s*["']0\.8\.35["']/, "Hardhat compiler must be 0.8.35");
requireMatch(hardhat, /optimizer:\s*\{\s*enabled:\s*true,\s*runs:\s*200\s*\}/, "Hardhat optimizer settings drifted");
requireMatch(hardhat, /evmVersion:\s*["']paris["']/, "Hardhat EVM version must be paris");
requireMatch(hardhat, /arc_mainnet:[\s\S]*?https:\/\/rpc\.mainnet\.arc\.io[\s\S]*?chainId:\s*5042/, "Hardhat Arc Mainnet profile drifted");
requireMatch(foundry, /solc\s*=\s*["']0\.8\.35["']/, "Foundry compiler must be 0.8.35");
requireMatch(foundry, /optimizer\s*=\s*true/, "Foundry optimizer must be enabled");
requireMatch(foundry, /optimizer_runs\s*=\s*200/, "Foundry optimizer runs must be 200");
requireMatch(foundry, /evm_version\s*=\s*["']paris["']/, "Foundry EVM version must be paris");

const result = validateManifest(loadManifest(), { requireReady: process.argv.includes("--require-ready") });
console.log(`Arc Mainnet release configuration is coherent; status: ${result.expectedStatus}.`);
