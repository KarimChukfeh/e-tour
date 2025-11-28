// scripts/deploy.js
// Dual-contract deployment script for ETour protocol and TicTacBlock game

import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
    console.log("🚀 Starting Dual-Contract Deployment (ETour + TicTacBlock)...\n");

    // Get the deployer account
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network:", hre.network.name);
    console.log("");

    // Step 1: Deploy ETour Protocol
    console.log("=" .repeat(60));
    console.log("Step 1: Deploying ETour Protocol...");
    console.log("=" .repeat(60));
    const ETour = await hre.ethers.getContractFactory("ETour");
    const etour = await ETour.deploy();
    await etour.waitForDeployment();
    const etourAddress = await etour.getAddress();
    console.log("✅ ETour deployed to:", etourAddress);
    console.log("");

    // Step 2: Deploy TicTacBlock with ETour integration
    console.log("=" .repeat(60));
    console.log("Step 2: Deploying TicTacBlock with ETour integration...");
    console.log("=" .repeat(60));
    const TicTacBlock = await hre.ethers.getContractFactory("TicTacBlock");
    const ticTacBlock = await TicTacBlock.deploy(etourAddress);
    await ticTacBlock.waitForDeployment();
    const ticTacBlockAddress = await ticTacBlock.getAddress();
    console.log("✅ TicTacBlock deployed to:", ticTacBlockAddress);
    console.log("");

    // Step 3: Verify integration
    console.log("=" .repeat(60));
    console.log("Step 3: Verifying Integration...");
    console.log("=" .repeat(60));
    const connectedETour = await ticTacBlock.etour();
    console.log("TicTacBlock.etour():", connectedETour);
    console.log("ETour address:", etourAddress);

    if (connectedETour.toLowerCase() !== etourAddress.toLowerCase()) {
        throw new Error("❌ ETour connection mismatch!");
    }
    console.log("✅ Integration verified successfully!");
    console.log("");

    // Step 4: Test ETour protocol functions
    console.log("=" .repeat(60));
    console.log("Step 4: Testing ETour Protocol Functions...");
    console.log("=" .repeat(60));

    // Test calculateTotalRounds
    const rounds2 = await etour.calculateTotalRounds(2);
    const rounds4 = await etour.calculateTotalRounds(4);
    const rounds8 = await etour.calculateTotalRounds(8);
    const rounds16 = await etour.calculateTotalRounds(16);
    console.log("calculateTotalRounds(2):", rounds2.toString(), "round");
    console.log("calculateTotalRounds(4):", rounds4.toString(), "rounds");
    console.log("calculateTotalRounds(8):", rounds8.toString(), "rounds");
    console.log("calculateTotalRounds(16):", rounds16.toString(), "rounds");
    console.log("");

    // Test three-way split (90% / 7.5% / 2.5%)
    const testAmount = hre.ethers.parseEther("1.0");
    const [participants, owner, protocol] = await etour.calculateThreeWaySplit(testAmount);
    console.log("Three-way split of 1.0 ETH:");
    console.log("  - Participants (90%):", hre.ethers.formatEther(participants), "ETH");
    console.log("  - Owner (7.5%):", hre.ethers.formatEther(owner), "ETH");
    console.log("  - Protocol (2.5%):", hre.ethers.formatEther(protocol), "ETH");
    console.log("");

    // Test power of two validation
    console.log("Power of two validation:");
    console.log("  isPowerOfTwo(2):", await etour.isPowerOfTwo(2));
    console.log("  isPowerOfTwo(4):", await etour.isPowerOfTwo(4));
    console.log("  isPowerOfTwo(7):", await etour.isPowerOfTwo(7));
    console.log("");

    // Step 5: Save deployment artifacts
    console.log("=" .repeat(60));
    console.log("Step 5: Saving Deployment Artifacts...");
    console.log("=" .repeat(60));

    const deploymentsDir = "./deployments";
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    // Get current block number
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp = new Date().toISOString();

    // Save network deployment info (both contracts)
    const networkDeployment = {
        network: hre.network.name,
        chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
        deployer: deployer.address,
        timestamp: timestamp,
        blockNumber: blockNumber,
        contracts: {
            ETour: etourAddress,
            TicTacBlock: ticTacBlockAddress
        }
    };

    const networkFile = path.join(deploymentsDir, `${hre.network.name}.json`);
    fs.writeFileSync(networkFile, JSON.stringify(networkDeployment, null, 2));
    console.log("✅ Network deployment info saved:", networkFile);

    // Save ETour ABI + address
    const etourArtifact = await hre.artifacts.readArtifact("ETour");
    const etourDeployment = {
        address: etourAddress,
        abi: etourArtifact.abi
    };
    const etourFile = path.join(deploymentsDir, `ETour-${hre.network.name}.json`);
    fs.writeFileSync(etourFile, JSON.stringify(etourDeployment, null, 2));
    console.log("✅ ETour ABI saved:", etourFile);

    // Save TicTacBlock ABI + address
    const ticTacBlockArtifact = await hre.artifacts.readArtifact("TicTacBlock");
    const ticTacBlockDeployment = {
        address: ticTacBlockAddress,
        abi: ticTacBlockArtifact.abi
    };
    const ticTacBlockFile = path.join(deploymentsDir, `TicTacBlock-${hre.network.name}.json`);
    fs.writeFileSync(ticTacBlockFile, JSON.stringify(ticTacBlockDeployment, null, 2));
    console.log("✅ TicTacBlock ABI saved:", ticTacBlockFile);
    console.log("");

    // Step 6: Verification instructions (for block explorers)
    console.log("=" .repeat(60));
    console.log("Step 6: Contract Verification");
    console.log("=" .repeat(60));
    console.log("To verify on block explorers (Etherscan, etc.), run:");
    console.log("");
    console.log(`npx hardhat verify --network ${hre.network.name} ${etourAddress}`);
    console.log(`npx hardhat verify --network ${hre.network.name} ${ticTacBlockAddress} "${etourAddress}"`);
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
    console.log("📍 Contract Addresses:");
    console.log("  ETour Protocol:", etourAddress);
    console.log("  TicTacBlock Game:", ticTacBlockAddress);
    console.log("");
    console.log("📁 Deployment Artifacts:");
    console.log("  -", networkFile);
    console.log("  -", etourFile);
    console.log("  -", ticTacBlockFile);
    console.log("");
    console.log("🔗 React Client Integration:");
    console.log("  Update your React app with:");
    console.log(`  const ETOUR_ADDRESS = "${etourAddress}";`);
    console.log(`  const TICTACBLOCK_ADDRESS = "${ticTacBlockAddress}";`);
    console.log("");
    console.log("🚀 The revolution has begun!");
    console.log("  ✅ ETour Protocol - Universal tournament infrastructure");
    console.log("  ✅ TicTacBlock - First game using the protocol");
    console.log("  📋 Ready for EternalChess, EternalConnect4, and more!");
    console.log("");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
