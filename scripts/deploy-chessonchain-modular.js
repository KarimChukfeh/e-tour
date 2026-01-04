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

    // Deploy ChessRulesModule
    console.log("=" .repeat(60));
    console.log("Deploying ChessRulesModule...");
    console.log("=" .repeat(60));
    const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
    const chessRulesModule = await ChessRulesModule.deploy();
    await chessRulesModule.waitForDeployment();
    const chessRulesModuleAddress = await chessRulesModule.getAddress();
    console.log("✅ ChessRulesModule deployed to:", chessRulesModuleAddress);
    console.log("");

    // Deploy ChessOnChain with module addresses
    console.log("=" .repeat(60));
    console.log("Deploying ChessOnChain...");
    console.log("=" .repeat(60));
    const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
    console.log("📝 Deploying with module addresses:");
    console.log("   Core:       ", modules.core);
    console.log("   Matches:    ", modules.matches);
    console.log("   Prizes:     ", modules.prizes);
    console.log("   Raffle:     ", modules.raffle);
    console.log("   Escalation: ", modules.escalation);
    console.log("   GameCache:  ", modules.gameCache);
    console.log("   ChessRules: ", chessRulesModuleAddress);
    const chessOnChain = await ChessOnChain.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.raffle,
        modules.escalation,
        modules.gameCache,
        chessRulesModuleAddress
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
            ChessRulesModule: chessRulesModuleAddress
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
        modules: modules,
        abi: chessOnChainArtifact.abi
    };

    const abiFile = path.join(deploymentsDir, "ChessOnChain-ABI-modular.json");
    fs.writeFileSync(abiFile, JSON.stringify(fullABI, null, 2));
    console.log("✅ Full ABI compiled and saved:", abiFile);
    console.log("");

    // Compile and save module ABIs
    console.log("=" .repeat(60));
    console.log("Compiling Module ABIs...");
    console.log("=" .repeat(60));

    const moduleConfigs = [
        { name: "ETour_Core", address: modules.core },
        { name: "ETour_Matches", address: modules.matches },
        { name: "ETour_Prizes", address: modules.prizes },
        { name: "ETour_Raffle", address: modules.raffle },
        { name: "ETour_Escalation", address: modules.escalation },
        { name: "GameCacheModule", address: modules.gameCache },
        { name: "ChessRulesModule", address: chessRulesModuleAddress }
    ];

    const moduleABIs = [];
    for (const module of moduleConfigs) {
        try {
            const artifact = await hre.artifacts.readArtifact(module.name);
            const moduleABI = {
                contractName: module.name,
                address: module.address,
                network: hre.network.name,
                chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
                deployedAt: timestamp,
                abi: artifact.abi
            };

            const moduleAbiFile = path.join(deploymentsDir, `${module.name}-ABI.json`);
            fs.writeFileSync(moduleAbiFile, JSON.stringify(moduleABI, null, 2));
            console.log(`✅ ${module.name} ABI saved:`, moduleAbiFile);
            moduleABIs.push(moduleAbiFile);
        } catch (error) {
            console.log(`⚠️  Could not compile ABI for ${module.name}:`, error.message);
        }
    }
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
    console.log(`npx hardhat verify --network ${hre.network.name} ${chessRulesModuleAddress}`);
    console.log("");
    console.log("# Verify ChessOnChain:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${chessOnChainAddress} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.raffle} ${modules.escalation} ${modules.gameCache} ${chessRulesModuleAddress}`);
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
    console.log("  ETour_Core:        ", modules.core);
    console.log("  ETour_Matches:     ", modules.matches);
    console.log("  ETour_Prizes:      ", modules.prizes);
    console.log("  ETour_Raffle:      ", modules.raffle);
    console.log("  ETour_Escalation:  ", modules.escalation);
    console.log("  GameCacheModule:   ", modules.gameCache);
    console.log("  ChessRulesModule:  ", chessRulesModuleAddress);
    console.log("");
    console.log("📍 Contract Address:");
    console.log("  ChessOnChain:", chessOnChainAddress);
    console.log("");
    console.log("📁 Deployment Artifacts:");
    console.log("  -", networkFile);
    console.log("  -", abiFile);
    moduleABIs.forEach(file => console.log("  -", file));
    console.log("");
    console.log("🔗 Frontend Integration:");
    console.log("  Update your client app with:");
    console.log(`  const CHESSONCHAIN_ADDRESS = "${chessOnChainAddress}";`);
    console.log("  Import ABI from:", abiFile);
    console.log("");
    console.log("🚀 ChessOnChain is live!");
    console.log("  ✅ ETour Modular Protocol - Reusable tournament infrastructure");
    console.log("  ✅ ChessRulesModule - Stateless chess validation logic (11.3 KB)");
    console.log("  ✅ ChessOnChain - Optimized chess tournament game (20.1 KB)");
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
