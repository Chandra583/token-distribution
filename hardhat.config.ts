import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY    = process.env.PRIVATE_KEY    ?? "0x0000000000000000000000000000000000000000000000000000000000000001";
const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545";
const OPBNB_RPC_URL   = process.env.OPBNB_RPC_URL   ?? "https://opbnb-testnet-rpc.bnbchain.org";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // BSC Testnet (L1) — 3s blocks, 10 gwei gas
    bscTestnet: {
      url: ALCHEMY_RPC_URL,
      chainId: 97,
      gasPrice: 10_000_000_000, // 10 gwei
      accounts: [PRIVATE_KEY],
    },
    // opBNB Testnet (L2) — 1s blocks, ~0.001 gwei gas (~10,000× cheaper)
    opbnbTestnet: {
      url: OPBNB_RPC_URL,
      chainId: 5611,
      gasPrice: 1_000_000, // 0.001 gwei — opBNB L2 gas price
      accounts: [PRIVATE_KEY],
    },
    hardhat: {
      chainId: 31337,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
