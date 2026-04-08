import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  paths: {
    sources: "./contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
      },
    },
    amoy: {
      type: "http",
      chainType: "l1",
      url: process.env.RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: process.env.CONTRACT_DEPLOYER_PRIVATE_KEY ? [process.env.CONTRACT_DEPLOYER_PRIVATE_KEY] : [],
    },
    polygon: {
      type: "http",
      chainType: "l1",
      url: process.env.RPC_URL ?? "https://polygon-rpc.com",
      chainId: 137,
      accounts: process.env.CONTRACT_DEPLOYER_PRIVATE_KEY ? [process.env.CONTRACT_DEPLOYER_PRIVATE_KEY] : [],
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
  },
});
