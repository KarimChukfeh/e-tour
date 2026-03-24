// scripts/deploy-chessonchain-factory.js
// Deploy ChessOnChainFactory (+ ChessRulesModule + instance modules if not already deployed).
//
// Usage:
//   npx hardhat run scripts/deploy-chessonchain-factory.js --network localhost
//   npx hardhat run scripts/deploy-chessonchain-factory.js --network arbitrum
//   npx hardhat run scripts/deploy-chessonchain-factory.js --network localhost --force

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";

const DEPLOYMENTS_DIR = "./deployments";

async function main() {
    const force = process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();

    console.log("=".repeat(60));
    console.log("ChessOnChainFactory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network: ", network, `(chainId: ${chainId})`);
    if (force) console.log("Mode:     FORCE (redeploying modules)");
    console.log("");

    // ── 1. Instance Modules ──────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. ChessRulesModule (game-specific, always redeployed) ───────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessRulesModule...");
    console.log("=".repeat(60));
    const ChessRules = await hre.ethers.getContractFactory("ChessRulesModule");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddr = await chessRules.getAddress();
    console.log("✅ ChessRulesModule deployed to:", chessRulesAddr);
    console.log("");

    // ── 3. ChessOnChainFactory ───────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessOnChainFactory...");
    console.log("=".repeat(60));
    const ChessFactory = await hre.ethers.getContractFactory("ChessOnChainFactory");
    const factory = await ChessFactory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation,
        chessRulesAddr
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();
    console.log("✅ ChessOnChainFactory deployed to:", factoryAddr);
    console.log("   ChessInstance implementation:", implAddr);
    console.log("");

    // ── 4. Save artifacts ────────────────────────────────────────────────────
    if (!fs.existsSync(DEPLOYMENTS_DIR)) fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp   = new Date().toISOString();

    const deployment = {
        network,
        chainId: chainId.toString(),
        deployer: deployer.address,
        timestamp,
        blockNumber,
        modules: {
            ETourInstance_Core:       modules.core,
            ETourInstance_Matches:    modules.matches,
            ETourInstance_Prizes:     modules.prizes,
            ETourInstance_Escalation: modules.escalation,
            ChessRulesModule:         chessRulesAddr,
        },
        factory: {
            ChessOnChainFactory: factoryAddr,
        },
        implementation: {
            ChessInstance: implAddr,
        },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-chess-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));
    console.log("💾 Deployment saved to:", deployFile);

    // ABI file with addresses — drop-in for frontend
    const [factoryArt, instanceArt] = await Promise.all([
        hre.artifacts.readArtifact("ChessOnChainFactory"),
        hre.artifacts.readArtifact("ChessInstance"),
    ]);

    const abiFile = path.join(DEPLOYMENTS_DIR, "ChessOnChainFactory-ABI.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network,
        chainId: chainId.toString(),
        deployedAt: timestamp,
        modules: deployment.modules,
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: instanceArt.abi },
    }, null, 2));
    console.log("💾 ABI file saved to:", abiFile);
    console.log("");

    // ── 5. Summary ───────────────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("🎉 DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("");
    console.log("Network:", network, "| Block:", blockNumber);
    console.log("");
    console.log("📍 Instance Modules:");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("  ChessRulesModule:        ", chessRulesAddr);
    console.log("");
    console.log("📍 Factory:");
    console.log("  ChessOnChainFactory:", factoryAddr);
    console.log("  ChessInstance impl: ", implAddr);
    console.log("");
    console.log("📁 Artifacts:");
    console.log("  -", deployFile);
    console.log("  -", abiFile);
    console.log("");
    console.log("🔗 Next step: factory.createInstance(playerCount, entryFee, timeouts)");
    console.log("");
    console.log("=".repeat(60));
    console.log("Verification Commands:");
    console.log("=".repeat(60));
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${modules.core}`);
    console.log(`npx hardhat verify --network ${n} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${n} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${n} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${n} ${chessRulesAddr}`);
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${chessRulesAddr}"`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("❌ Deployment failed:", err);
        process.exit(1);
    });
