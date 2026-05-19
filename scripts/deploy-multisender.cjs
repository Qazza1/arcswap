/**
 * deploy-multisender.cjs
 *
 * Deploys ArcFXMultisender to Arc Testnet.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multisender.cjs --network arc_testnet
 *
 * Before running:
 *   1. Add DEPLOYER_PRIVATE_KEY to your .env file
 *      (export your MetaMask private key - Settings → Account details → Export)
 *   2. Make sure your wallet has testnet USDC for gas on Arc Testnet
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("─────────────────────────────────────────");
  console.log("  ArcFX Multisender — Deployment");
  console.log("─────────────────────────────────────────");
  console.log("  Network:   ", hre.network.name);
  console.log("  Deployer:  ", deployer.address);
  console.log("");

  // The fee recipient is your wallet address (receives 0.1% fee on pro sends)
  // Change this to any address you want to receive fees
  const FEE_RECIPIENT = deployer.address;

  console.log("  Fee recipient:", FEE_RECIPIENT);
  console.log("  Fee:          0.1% on pro tier sends");
  console.log("  Free limit:   5 recipients");
  console.log("  Pro limit:    500 recipients");
  console.log("");

  // Deploy
  console.log("  Deploying...");
  const factory  = await hre.ethers.getContractFactory("ArcFXMultisender");
  const contract = await factory.deploy(FEE_RECIPIENT);
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  console.log("  ✅ Deployed at:", address);
  console.log("");
  console.log("─────────────────────────────────────────");
  console.log("  Next steps:");
  console.log("  1. Copy the contract address above");
  console.log("  2. Paste it into multisend.html as MULTISENDER_ADDRESS");
  console.log("  3. Verify on ArcScan:");
  console.log(`     https://testnet.arcscan.app/address/${address}`);
  console.log("─────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
