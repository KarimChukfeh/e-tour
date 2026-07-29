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
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode",
            "evm.deployedBytecode",
            "evm.methodIdentifiers",
            "metadata",
            "storageLayout",
          ],
          "": ["ast"],
        },
      },
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
      chainId: 412346,
      accounts: {
        count: 250,
        accountsBalance: "10000000000000000000000",
      },
      mining: {
        auto: true,
        interval: 0,
      },
      // Keep browser-wallet fee suggestions valid after the deployment-heavy
      // bootstrap blocks. With a non-zero EIP-1559 base fee, those blocks can
      // ratchet the next-block base fee above MetaMask's cached max fee.
      initialBaseFeePerGas: 0,
      allowUnlimitedContractSize: true,
      blockGasLimit: 300000000,
    },
    localhost: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: 412346,
      gasPrice: 1000000000,
      allowUnlimitedContractSize: true,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161,
    },
  },
  etherscan: {
    apiKey: process.env.ARBISCAN_API_KEY || "",
    customChains: [
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: Boolean(process.env.REPORT_GAS),
    currency: "USD",
    noColors: Boolean(process.env.REPORT_GAS_FILE),
    outputFile: process.env.REPORT_GAS_FILE || undefined,
  },
  mocha: {
    timeout: 40000,
    reporter: process.env.V3_TEST_REPORT_JSON
      ? join(__dirname, "scripts", "test-report-reporter.cjs")
      : "spec",
  },
};
