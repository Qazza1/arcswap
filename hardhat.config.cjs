require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Mainnet preflight must not instantiate a signer. The existing private-key
// mechanism is enabled only after the exact, separately reviewed approval
// phrase is present for the broadcast invocation.
const mainnetBroadcastApproved =
  process.env.ARCFX_MAINNET_DEPLOY_APPROVAL === "DEPLOY_ARCFX_TO_ARC_MAINNET_5042";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.35",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    // Arc Testnet
    arc_testnet: {
      url: "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    // Arc Mainnet core network only. Contract addresses are deliberately not
    // configured here; deployment tooling must bind them in a reviewed release
    // manifest after a real deployment.
    arc_mainnet: {
      url: "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts: mainnetBroadcastApproved && process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    // Local hardhat node for testing
    hardhat: {
      chainId: 31337,
    },
  },
  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};
