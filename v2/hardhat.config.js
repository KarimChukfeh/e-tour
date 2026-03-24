import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      accounts: {
        count: 250,
        accountsBalance: "10000000000000000000000",
      },
      mining: {
        auto: true,
        interval: 0,
      },
      allowUnlimitedContractSize: true,
      blockGasLimit: 300000000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 412346,
      gas: 1000000000,
      gasPrice: 100000000,
      allowUnlimitedContractSize: true,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
    currency: "USD",
  },
  mocha: {
    timeout: 40000,
  },
};
