// scripts/deploy-chessonchain-modular.js
// Deployment script for modular ChessOnChain with ETour modules

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployModules } from "./deploy-modules.js";

async function main() {
    console.log("🚀 Starting Modular ChessOnChain Deployment...\n");

    // Get the deployer account
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network:", hre.network.name);
    console.log("");

    // Get or deploy modules (reuses existing if available)
    const modules = await getOrDeployModules();

    // Deploy ChessOnChain_Rules module (stateless rules engine)
    console.log("=" .repeat(60));
    console.log("Deploying ChessOnChain_Rules Module...");
    console.log("=" .repeat(60));
    const ChessOnChain_Rules = await hre.ethers.getContractFactory("contracts/modules/ChessOnChain_Rules.sol:ChessOnChain_Rules");
    const chessRules = await ChessOnChain_Rules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddress = await chessRules.getAddress();
    console.log("✅ ChessOnChain_Rules module deployed to:", chessRulesAddress);
    console.log("");

    // Deploy ChessOnChain with module addresses and rules engine
    console.log("=" .repeat(60));
    console.log("Deploying ChessOnChain...");
    console.log("=" .repeat(60));
    const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
    const chessOnChain = await ChessOnChain.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.raffle,
        modules.escalation,
        modules.gameCache,
        chessRulesAddress
    );
    await chessOnChain.waitForDeployment();
    const chessOnChainAddress = await chessOnChain.getAddress();
    console.log("✅ ChessOnChain deployed to:", chessOnChainAddress);
    console.log("");

    // Get current block number
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp = new Date().toISOString();

    // Create deployments directory if it doesn't exist
    const deploymentsDir = "./deployments";
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    // Save network deployment info
    console.log("=" .repeat(60));
    console.log("Saving Deployment Artifacts...");
    console.log("=" .repeat(60));

    const networkDeployment = {
        network: hre.network.name,
        chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
        deployer: deployer.address,
        timestamp: timestamp,
        blockNumber: blockNumber,
        modules: {
            ETour_Core: modules.core,
            ETour_Matches: modules.matches,
            ETour_Prizes: modules.prizes,
            ETour_Raffle: modules.raffle,
            ETour_Escalation: modules.escalation,
            GameCacheModule: modules.gameCache,
            ChessOnChain_Rules: chessRulesAddress
        },
        contracts: {
            ChessOnChain: chessOnChainAddress
        }
    };

    const networkFile = path.join(deploymentsDir, `${hre.network.name}-chess-modular.json`);
    fs.writeFileSync(networkFile, JSON.stringify(networkDeployment, null, 2));
    console.log("✅ Network deployment info saved:", networkFile);

    // Compile and save full ABI
    console.log("");
    console.log("=" .repeat(60));
    console.log("Compiling Full ABI...");
    console.log("=" .repeat(60));

    const chessOnChainArtifact = await hre.artifacts.readArtifact("ChessOnChain");

    const fullABI = {
        contractName: "ChessOnChain",
        address: chessOnChainAddress,
        network: hre.network.name,
        chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
        deployedAt: timestamp,
        modules: {
            ...modules,
            chessRules: chessRulesAddress
        },
        abi: chessOnChainArtifact.abi
    };

    const abiFile = path.join(deploymentsDir, "ChessOnChain-ABI-modular.json");
    fs.writeFileSync(abiFile, JSON.stringify(fullABI, null, 2));
    console.log("✅ Full ABI compiled and saved:", abiFile);
    console.log("");

    // Verification instructions
    console.log("=" .repeat(60));
    console.log("Contract Verification");
    console.log("=" .repeat(60));
    console.log("To verify on block explorers (Etherscan, Arbiscan, etc.), run:");
    console.log("");
    console.log("# Verify modules:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.core}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.raffle}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.gameCache}`);
    console.log("");
    console.log("# Verify ChessOnChain_Rules:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${chessRulesAddress}`);
    console.log("");
    console.log("# Verify ChessOnChain:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${chessOnChainAddress} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.raffle} ${modules.escalation} ${modules.gameCache} ${chessRulesAddress}`);
    console.log("");

    // Final summary
    console.log("=" .repeat(60));
    console.log("🎉 DEPLOYMENT SUCCESSFUL! 🎉");
    console.log("=" .repeat(60));
    console.log("");
    console.log("📋 Deployment Summary:");
    console.log("  Network:", hre.network.name);
    console.log("  Chain ID:", networkDeployment.chainId);
    console.log("  Block:", blockNumber);
    console.log("");
    console.log("📍 Module Addresses:");
    console.log("  ETour_Core:         ", modules.core);
    console.log("  ETour_Matches:      ", modules.matches);
    console.log("  ETour_Prizes:       ", modules.prizes);
    console.log("  ETour_Raffle:       ", modules.raffle);
    console.log("  ETour_Escalation:   ", modules.escalation);
    console.log("  GameCacheModule:    ", modules.gameCache);
    console.log("  ChessOnChain_Rules: ", chessRulesAddress);
    console.log("");
    console.log("📍 Contract Address:");
    console.log("  ChessOnChain:", chessOnChainAddress);
    console.log("");
    console.log("📁 Deployment Artifacts:");
    console.log("  -", networkFile);
    console.log("  -", abiFile);
    console.log("");
    console.log("🔗 Frontend Integration:");
    console.log("  Update your client app with:");
    console.log(`  const CHESSONCHAIN_ADDRESS = "${chessOnChainAddress}";`);
    console.log("  Import ABI from:", abiFile);
    console.log("");
    console.log("🚀 ChessOnChain is live!");
    console.log("  ✅ ETour Modular Protocol - Reusable tournament infrastructure");
    console.log("  ✅ ChessOnChain - Full-featured chess tournament game");
    console.log("  📋 6 tiers, up to 128 players per tournament!");
    console.log("");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
