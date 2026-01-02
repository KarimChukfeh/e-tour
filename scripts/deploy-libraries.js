// scripts/deploy-libraries.js
// Deploy shared ETour libraries ONCE for all game contracts

import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
    console.log("🚀 Starting Library Deployment...\n");

    // Get the deployer account
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying libraries with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network:", hre.network.name);
    console.log("");

    const libraries = {};
    const timestamp = new Date().toISOString();
    const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();

    console.log("=" .repeat(60));
    console.log("Deploying Shared ETour Libraries");
    console.log("=" .repeat(60));
    console.log("");

    // Deploy ETourLib_Core (no dependencies)
    console.log("1/4 Deploying ETourLib_Core...");
    const ETourLib_Core = await hre.ethers.getContractFactory("ETourLib_Core");
    const coreLib = await ETourLib_Core.deploy();
    await coreLib.waitForDeployment();
    libraries.ETourLib_Core = await coreLib.getAddress();
    console.log("  ✓ ETourLib_Core:", libraries.ETourLib_Core);

    // Deploy ETourLib_Matches (depends on ETourLib_Core)
    console.log("2/4 Deploying ETourLib_Matches...");
    const ETourLib_Matches = await hre.ethers.getContractFactory("ETourLib_Matches", {
        libraries: { ETourLib_Core: libraries.ETourLib_Core }
    });
    const matchesLib = await ETourLib_Matches.deploy();
    await matchesLib.waitForDeployment();
    libraries.ETourLib_Matches = await matchesLib.getAddress();
    console.log("  ✓ ETourLib_Matches:", libraries.ETourLib_Matches);

    // Deploy ETourLib_Prizes (no dependencies)
    console.log("3/4 Deploying ETourLib_Prizes...");
    const ETourLib_Prizes = await hre.ethers.getContractFactory("ETourLib_Prizes");
    const prizesLib = await ETourLib_Prizes.deploy();
    await prizesLib.waitForDeployment();
    libraries.ETourLib_Prizes = await prizesLib.getAddress();
    console.log("  ✓ ETourLib_Prizes:", libraries.ETourLib_Prizes);

    // Deploy ChessRules (no dependencies)
    console.log("4/4 Deploying ChessRules...");
    const ChessRules = await hre.ethers.getContractFactory("ChessRules");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    libraries.ChessRules = await chessRules.getAddress();
    console.log("  ✓ ChessRules:", libraries.ChessRules);
    console.log("");

    // Get current block number
    const blockNumber = await hre.ethers.provider.getBlockNumber();

    // Create deployments directory if it doesn't exist
    const deploymentsDir = "./deployments";
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    // Save library deployment info
    const libraryDeployment = {
        network: hre.network.name,
        chainId: chainId,
        deployer: deployer.address,
        timestamp: timestamp,
        blockNumber: blockNumber,
        libraries: libraries
    };

    const libraryFile = path.join(deploymentsDir, `${hre.network.name}-libraries.json`);
    fs.writeFileSync(libraryFile, JSON.stringify(libraryDeployment, null, 2));

    // Final summary
    console.log("=" .repeat(60));
    console.log("✅ LIBRARY DEPLOYMENT SUCCESSFUL!");
    console.log("=" .repeat(60));
    console.log("");
    console.log("📚 Library Addresses (shared by all games):");
    console.log("  ETourLib_Core:    ", libraries.ETourLib_Core);
    console.log("  ETourLib_Matches: ", libraries.ETourLib_Matches);
    console.log("  ETourLib_Prizes:  ", libraries.ETourLib_Prizes);
    console.log("  ChessRules:       ", libraries.ChessRules);
    console.log("");
    console.log("📁 Deployment Info Saved:");
    console.log("  -", libraryFile);
    console.log("");
    console.log("📝 Next Steps:");
    console.log("  These libraries will be reused by all game contracts.");
    console.log("  Now deploy game contracts:");
    console.log("    npx hardhat run scripts/deploy-tictacchain.js --network", hre.network.name);
    console.log("    npx hardhat run scripts/deploy-chessonchain.js --network", hre.network.name);
    console.log("    npx hardhat run scripts/deploy-connectfour.js --network", hre.network.name);
    console.log("");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Library deployment failed:", error);
        process.exit(1);
    });
