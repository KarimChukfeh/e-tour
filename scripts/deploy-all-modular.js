// scripts/deploy-all-modular.js
// Deploy all game contracts with shared ETour modules (gas-efficient)

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployModules } from "./deploy-modules.js";

async function main() {
    console.log("🚀 Starting Complete Modular ETour Deployment...\n");

    // Get the deployer account
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network:", hre.network.name);
    console.log("");

    // Get or deploy all modules once (shared across all games)
    const modules = await getOrDeployModules();

    // Deploy TicTacChain
    console.log("=" .repeat(60));
    console.log("Deploying TicTacChain...");
    console.log("=" .repeat(60));
    const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
    const ticTacChain = await TicTacChain.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.raffle,
        modules.escalation
    );
    await ticTacChain.waitForDeployment();
    const ticTacChainAddress = await ticTacChain.getAddress();
    console.log("✅ TicTacChain deployed to:", ticTacChainAddress);
    console.log("");

    // Deploy ChessOnChain
    console.log("=" .repeat(60));
    console.log("Deploying ChessOnChain...");
    console.log("=" .repeat(60));
    const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
    const chessOnChain = await ChessOnChain.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.raffle,
        modules.escalation
    );
    await chessOnChain.waitForDeployment();
    const chessOnChainAddress = await chessOnChain.getAddress();
    console.log("✅ ChessOnChain deployed to:", chessOnChainAddress);
    console.log("");

    // Deploy ConnectFourOnChain
    console.log("=" .repeat(60));
    console.log("Deploying ConnectFourOnChain...");
    console.log("=" .repeat(60));
    const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
    const connectFourOnChain = await ConnectFourOnChain.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.raffle,
        modules.escalation
    );
    await connectFourOnChain.waitForDeployment();
    const connectFourOnChainAddress = await connectFourOnChain.getAddress();
    console.log("✅ ConnectFourOnChain deployed to:", connectFourOnChainAddress);
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
            ETour_Escalation: modules.escalation
        },
        contracts: {
            TicTacChain: ticTacChainAddress,
            ChessOnChain: chessOnChainAddress,
            ConnectFourOnChain: connectFourOnChainAddress
        }
    };

    const networkFile = path.join(deploymentsDir, `${hre.network.name}-all-modular.json`);
    fs.writeFileSync(networkFile, JSON.stringify(networkDeployment, null, 2));
    console.log("✅ Network deployment info saved:", networkFile);

    // Compile and save ABIs
    console.log("");
    console.log("=" .repeat(60));
    console.log("Compiling ABIs...");
    console.log("=" .repeat(60));

    const ticTacChainArtifact = await hre.artifacts.readArtifact("TicTacChain");
    const chessOnChainArtifact = await hre.artifacts.readArtifact("ChessOnChain");
    const connectFourOnChainArtifact = await hre.artifacts.readArtifact("ConnectFourOnChain");

    const allABIs = {
        network: hre.network.name,
        chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
        deployedAt: timestamp,
        modules: modules,
        contracts: {
            TicTacChain: {
                address: ticTacChainAddress,
                abi: ticTacChainArtifact.abi
            },
            ChessOnChain: {
                address: chessOnChainAddress,
                abi: chessOnChainArtifact.abi
            },
            ConnectFourOnChain: {
                address: connectFourOnChainAddress,
                abi: connectFourOnChainArtifact.abi
            }
        }
    };

    const abiFile = path.join(deploymentsDir, "ETour-All-ABIs-modular.json");
    fs.writeFileSync(abiFile, JSON.stringify(allABIs, null, 2));
    console.log("✅ All ABIs compiled and saved:", abiFile);
    console.log("");

    // Verification instructions
    console.log("=" .repeat(60));
    console.log("Contract Verification");
    console.log("=" .repeat(60));
    console.log("To verify on block explorers (Etherscan, Arbiscan, etc.), run:");
    console.log("");
    console.log("# Verify modules (once):");
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.core}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.raffle}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${modules.escalation}`);
    console.log("");
    console.log("# Verify game contracts:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${ticTacChainAddress} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.raffle} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${chessOnChainAddress} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.raffle} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${connectFourOnChainAddress} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.raffle} ${modules.escalation}`);
    console.log("");

    // Final summary
    console.log("=" .repeat(60));
    console.log("🎉 COMPLETE DEPLOYMENT SUCCESSFUL! 🎉");
    console.log("=" .repeat(60));
    console.log("");
    console.log("📋 Deployment Summary:");
    console.log("  Network:", hre.network.name);
    console.log("  Chain ID:", networkDeployment.chainId);
    console.log("  Block:", blockNumber);
    console.log("");
    console.log("📍 Module Addresses (Shared):");
    console.log("  ETour_Core:       ", modules.core);
    console.log("  ETour_Matches:    ", modules.matches);
    console.log("  ETour_Prizes:     ", modules.prizes);
    console.log("  ETour_Raffle:     ", modules.raffle);
    console.log("  ETour_Escalation: ", modules.escalation);
    console.log("");
    console.log("📍 Game Contract Addresses:");
    console.log("  TicTacChain:      ", ticTacChainAddress);
    console.log("  ChessOnChain:     ", chessOnChainAddress);
    console.log("  ConnectFourOnChain:", connectFourOnChainAddress);
    console.log("");
    console.log("📁 Deployment Artifacts:");
    console.log("  -", networkFile);
    console.log("  -", abiFile);
    console.log("");
    console.log("💡 Modular Architecture Benefits:");
    console.log("  ✅ Shared modules reduce deployment cost");
    console.log("  ✅ All 3 games use the same tournament logic");
    console.log("  ✅ ~3,000 lines of reusable code");
    console.log("  ✅ Easy to add new games using existing modules");
    console.log("");
    console.log("🔗 Frontend Integration:");
    console.log("  Import contract addresses and ABIs from:", abiFile);
    console.log("");
    console.log("🚀 All ETour games are live!");
    console.log("  📋 18 total tiers across 3 games");
    console.log("  👥 Up to 384 concurrent players");
    console.log("  🎮 TicTacToe, Chess, and Connect Four tournaments!");
    console.log("");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
