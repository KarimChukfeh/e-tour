import baseConfig from "./hardhat.config.js";

// Keep the Arbitrum-shaped node separate from the ordinary V2/V3 localhost
// node, which conventionally owns port 8545.
const port = Number(process.env.ARBITRUM_LOCAL_PORT ?? "8546");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("ARBITRUM_LOCAL_PORT must be a valid TCP port");
}

const fundedAccounts = {
  count: 250,
  accountsBalance: "10000000000000000000000",
};

/**
 * Fully local Arbitrum-shaped development network.
 *
 * It intentionally uses Arbitrum One's chain ID so EIP-712/UserOperation
 * domains match the eventual target, but it runs only on a local Hardhat node
 * with deterministic development accounts. The distinct `arbitrumLocal`
 * network name keeps every manifest and ABI separate from production output.
 */
export default {
  ...baseConfig,
  networks: {
    hardhat: {
      ...baseConfig.networks.hardhat,
      chainId: 42161,
      accounts: fundedAccounts,
    },
    arbitrumLocal: {
      url: `http://127.0.0.1:${port}`,
      chainId: 42161,
      allowUnlimitedContractSize: true,
    },
    arbitrum: baseConfig.networks.arbitrum,
  },
};
