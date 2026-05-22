/**
 * deploy-payments.cjs
 *
 * Deploys ArcFXPayments to Arc Testnet.
 * Powers Pay Links and Invoices with a 0.15% protocol fee.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-payments.cjs --network arc_testnet
 *
 * Before running:
 *   1. Add DEPLOYER_PRIVATE_KEY to your .env file
 *      (MetaMask → Settings → Account details → Export private key)
 *   2. Make sure your wallet has testnet USDC for gas on Arc Testnet
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("─────────────────────────────────────────");
  console.log("  ArcFX Payments — Deployment");
  console.log("─────────────────────────────────────────");
  console.log("  Network:  ", hre.network.name);
  console.log("  Deployer: ", deployer.address);
  console.log("");

  // Treasury address — receives the 0.15% protocol fee on every payment.
  // Change this to your ArcFX treasury wallet before mainnet deployment.
  const TREASURY = deployer.address;

  console.log("  Treasury: ", TREASURY);
  console.log("  Fee:       0.15% (15 bps) on every payment");
  console.log("  Tokens:    USDC + EURC (6 decimals)");
  console.log("");
  console.log("  Fee math example:");
  console.log("    Payer sends:   1000 USDC");
  console.log("    Protocol fee:  1.5 USDC → treasury");
  console.log("    Recipient gets: 998.5 USDC");
  console.log("");

  // Deploy
  console.log("  Deploying...");
  const factory  = await hre.ethers.getContractFactory("ArcFXPayments");
  const contract = await factory.deploy(TREASURY);
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  console.log("  ✅ Deployed at:", address);
  console.log("");
  console.log("─────────────────────────────────────────");
  console.log("  Next steps:");
  console.log("  1. Copy the contract address above");
  console.log("  2. Add it to pay.html as PAYMENTS_CONTRACT_ADDRESS");
  console.log("  3. Add it to invoice.html as PAYMENTS_CONTRACT_ADDRESS");
  console.log("  4. Verify on ArcScan:");
  console.log(`     https://testnet.arcscan.app/address/${address}`);
  console.log("─────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
