// scripts/deploy-connectfour.js
// Deployment script for ConnectFourOnChain (reuses shared libraries)

import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
    console.log("🚀 Starting ConnectFourOnChain Deployment...\n");

    // Get the deployer account
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network:", hre.network.name);
    console.log("");

    const timestamp = new Date().toISOString();
    const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();

    // Load library addresses from previous deployment
    const deploymentsDir = "./deployments";
    const libraryFile = path.join(deploymentsDir, `${hre.network.name}-libraries.json`);
    
    let libraries;
    if (fs.existsSync(libraryFile)) {
        console.log("📚 Loading shared library addresses from:", libraryFile);
        const libraryDeployment = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
        libraries = libraryDeployment.libraries;
        console.log("  ✓ ETourLib_Core:    ", libraries.ETourLib_Core);
        console.log("  ✓ ETourLib_Matches: ", libraries.ETourLib_Matches);
        console.log("  ✓ ETourLib_Prizes:  ", libraries.ETourLib_Prizes);
        console.log("");
    } else {
        console.error("❌ Library deployment file not found!");
        console.error("   Please deploy libraries first:");
        console.error(`   npx hardhat run scripts/deploy-libraries.js --network ${hre.network.name}`);
        console.error("");
        process.exit(1);
    }

    // ===== DEPLOY CONNECTFOURONCHAIN =====
    console.log("=" .repeat(60));
    console.log("Deploying ConnectFourOnChain (with shared libraries)");
    console.log("=" .repeat(60));
    console.log("");

    const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain", {
        libraries: {
            ETourLib_Core: libraries.ETourLib_Core,
            ETourLib_Matches: libraries.ETourLib_Matches,
            ETourLib_Prizes: libraries.ETourLib_Prizes
        }
    });
    const connectFourOnChain = await ConnectFourOnChain.deploy();
    await connectFourOnChain.waitForDeployment();
    const connectFourAddress = await connectFourOnChain.getAddress();
    console.log("✅ ConnectFourOnChain deployed to:", connectFourAddress);
    console.log("");

    // Get current block number
    const blockNumber = await hre.ethers.provider.getBlockNumber();

    // Create deployments directory if it doesn't exist
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    // Save network deployment info
    console.log("=" .repeat(60));
    console.log("Saving Deployment Artifacts...");
    console.log("=" .repeat(60));

    const networkDeployment = {
        network: hre.network.name,
        chainId: chainId,
        deployer: deployer.address,
        timestamp: timestamp,
        blockNumber: blockNumber,
        libraries: libraries,
        contracts: {
            ConnectFourOnChain: connectFourAddress
        }
    };

    const networkFile = path.join(deploymentsDir, `${hre.network.name}-connectfour.json`);
    fs.writeFileSync(networkFile, JSON.stringify(networkDeployment, null, 2));
    console.log("✅ Network deployment info saved:", networkFile);

    // Save full ABI as CFOCABI.json
    const connectFourArtifact = await hre.artifacts.readArtifact("ConnectFourOnChain");
    const fullABI = {
        contractName: "ConnectFourOnChain",
        address: connectFourAddress,
        network: hre.network.name,
        chainId: chainId,
        deployedAt: timestamp,
        abi: connectFourArtifact.abi
    };

    const abiFile = path.join(deploymentsDir, "CFOCABI.json");
    fs.writeFileSync(abiFile, JSON.stringify(fullABI, null, 2));
    console.log("✅ Full ABI compiled and saved:", abiFile);
    console.log("");

    // Final summary
    console.log("=" .repeat(60));
    console.log("🎉 DEPLOYMENT SUCCESSFUL! 🎉");
    console.log("=" .repeat(60));
    console.log("");
    console.log("📋 Deployment Summary:");
    console.log("  Network:", hre.network.name);
    console.log("  Chain ID:", chainId);
    console.log("  Block:", blockNumber);
    console.log("");
    console.log("📍 Contract Address:");
    console.log("  ConnectFourOnChain:", connectFourAddress);
    console.log("");
    console.log("📚 Using Shared Libraries:");
    console.log("  ETourLib_Core:    ", libraries.ETourLib_Core);
    console.log("  ETourLib_Matches: ", libraries.ETourLib_Matches);
    console.log("  ETourLib_Prizes:  ", libraries.ETourLib_Prizes);
    console.log("");
    console.log("📁 Deployment Artifacts:");
    console.log("  -", networkFile);
    console.log("  -", abiFile);
    console.log("");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
