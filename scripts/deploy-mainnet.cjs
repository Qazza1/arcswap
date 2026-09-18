/**
 * Arc Mainnet deployment entry point.
 *
 * Default execution is preflight-only. Broadcast additionally requires the
 * exact ARCFX_MAINNET_DEPLOY_APPROVAL phrase and the repository's existing
 * DEPLOYER_PRIVATE_KEY Hardhat signer configuration. Neither secret is logged.
 */
const hre = require("hardhat");

async function main() {
  const release = await import("../script/mainnet-release.mjs");
  const manifest = release.loadManifest();
  const state = release.validateManifest(manifest, { requireReady: true });

  if (hre.network.name !== "arc_mainnet") throw new Error("Refusing deployment: Hardhat network must be arc_mainnet");
  if (hre.network.config.url !== release.MAINNET_RPC) throw new Error("Refusing deployment: Mainnet RPC differs from reviewed release manifest");
  const connected = await hre.ethers.provider.getNetwork();
  if (connected.chainId !== BigInt(release.MAINNET_CHAIN_ID)) {
    throw new Error(`Refusing deployment: connected to chain ${connected.chainId}, expected ${release.MAINNET_CHAIN_ID}`);
  }
  const usdcCode = await hre.ethers.provider.getCode(release.MAINNET_USDC);
  if (usdcCode === "0x") throw new Error("Refusing deployment: canonical Arc Mainnet USDC interface has no runtime code");

  console.log("ArcFX Arc Mainnet deployment plan");
  console.log(`  network:  ${manifest.network} (${manifest.caip2})`);
  console.log(`  RPC:      ${manifest.rpc}`);
  console.log(`  owner:    ${state.owner}`);
  console.log(`  treasury: ${state.treasury}`);
  for (const contract of manifest.contracts) {
    console.log(`  ${contract.name}: ${contract.address ?? "pending"}`);
    console.log(`    artifact: ${contract.artifact}`);
    console.log(`    constructor _treasury: ${state.treasury}`);
    console.log(`    creation sha256: ${contract.creationBytecodeSha256}`);
    console.log(`    runtime sha256:  ${contract.expectedRuntimeBytecodeSha256}`);
  }

  if (process.env.ARCFX_MAINNET_DEPLOY_APPROVAL !== release.BROADCAST_APPROVAL) {
    console.log("Preflight passed. No signer was loaded and no transaction was broadcast.");
    return;
  }

  const signers = await hre.ethers.getSigners();
  if (signers.length !== 1) throw new Error("Broadcast requires exactly one configured Hardhat deployer signer");
  const signer = signers[0];
  const signerAddress = await signer.getAddress();
  if (signerAddress.toLowerCase() !== state.owner.toLowerCase()) {
    throw new Error("Configured signer does not match the reviewed ARCFX_MAINNET_OWNER_ADDRESS");
  }

  for (const entry of manifest.contracts) {
    if (release.deploymentDisposition(entry) === "verify-and-skip") {
      const receipt = await hre.ethers.provider.getTransactionReceipt(entry.transactionHash);
      if (!receipt || receipt.status !== 1 || receipt.blockNumber !== entry.blockNumber
          || !receipt.contractAddress || receipt.contractAddress.toLowerCase() !== entry.address.toLowerCase()) {
        throw new Error(`${entry.name}: recorded deployment receipt is missing or inconsistent; refusing to redeploy`);
      }
      const previousTx = await hre.ethers.provider.getTransaction(entry.transactionHash);
      if (!previousTx || previousTx.to !== null || previousTx.from.toLowerCase() !== state.owner.toLowerCase()) {
        throw new Error(`${entry.name}: recorded deployment transaction is not from the reviewed owner`);
      }
      const expectedFactory = await hre.ethers.getContractFactory(entry.name, signer);
      const expectedTx = await expectedFactory.getDeployTransaction(state.treasury);
      if (previousTx.data.toLowerCase() !== expectedTx.data.toLowerCase()) {
        throw new Error(`${entry.name}: recorded deployment input differs from reviewed artifact and constructor`);
      }
      const existingCode = await hre.ethers.provider.getCode(entry.address);
      if (release.bytecodeSha256(existingCode) !== entry.expectedRuntimeBytecodeSha256) {
        throw new Error(`${entry.name}: previously recorded address no longer matches reviewed runtime`);
      }
      const existing = expectedFactory.attach(entry.address);
      if ((await existing.owner()).toLowerCase() !== state.owner.toLowerCase()
          || (await existing.treasury()).toLowerCase() !== state.treasury.toLowerCase()) {
        throw new Error(`${entry.name}: recorded contract owner or treasury differs from reviewed roles`);
      }
      console.log(`${entry.name}: already confirmed and runtime-verified at ${entry.address}`);
      continue;
    }

    const factory = await hre.ethers.getContractFactory(entry.name, signer);
    const contract = await factory.deploy(state.treasury);
    const transaction = contract.deploymentTransaction();
    if (!transaction) throw new Error(`${entry.name}: deployment transaction was not created`);
    console.log(`${entry.name}: submitted ${transaction.hash}`);
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`${entry.name}: deployment was not confirmed successfully`);
    const address = await contract.getAddress();
    if (!receipt.contractAddress || receipt.contractAddress.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`${entry.name}: confirmed receipt does not identify the expected deployed address`);
    }
    const runtimeCode = await hre.ethers.provider.getCode(address);
    const runtimeHash = release.bytecodeSha256(runtimeCode);
    if (runtimeHash !== entry.expectedRuntimeBytecodeSha256) {
      throw new Error(`${entry.name}: confirmed runtime does not match the reviewed artifact`);
    }
    if ((await contract.owner()).toLowerCase() !== state.owner.toLowerCase()) {
      throw new Error(`${entry.name}: onchain owner does not match the reviewed owner`);
    }
    if ((await contract.treasury()).toLowerCase() !== state.treasury.toLowerCase()) {
      throw new Error(`${entry.name}: onchain treasury does not match the reviewed treasury`);
    }

    entry.address = address;
    entry.transactionHash = transaction.hash;
    entry.blockNumber = receipt.blockNumber;
    entry.liveRuntimeBytecodeSha256 = runtimeHash;
    manifest.status = manifest.contracts.every((candidate) => candidate.address !== null)
      ? "deployed-runtime-verified"
      : "deployment-in-progress";
    release.writeManifest(manifest);
    console.log(`${entry.name}: confirmed at ${address}; manifest updated after runtime verification`);
  }
}

main().catch((error) => {
  console.error(`Mainnet deployment stopped: ${error.message || error}`);
  process.exitCode = 1;
});
