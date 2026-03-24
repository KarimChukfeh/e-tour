// scripts/deploy-factories.js
// Deploy all three ETour factory contracts:
//   TicTacChainFactory, ConnectFourFactory, ChessOnChainFactory
//
// Requires instance modules already deployed (reads from deployments/instance-modules.json).
// Run deploy-instance-modules.js first, or use deploy-all-factory.js to do both.
//
// Usage:
//   npx hardhat run scripts/deploy-factories.js --network <network>
//   npx hardhat run scripts/deploy-factories.js --network <network> --force   (redeploy)

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";

const DEPLOYMENT_FILE = "./deployments/factories.json";

function loadExistingFactories() {
    if (fs.existsSync(DEPLOYMENT_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
        if (data.network === hre.network.name) return data;
    }
    return null;
}

function saveFactories(data) {
    const dir = "./deployments";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(data, null, 2));
    console.log("💾 Factory addresses saved to:", DEPLOYMENT_FILE);
}

async function main() {
    const force = process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();

    console.log("=".repeat(60));
    console.log("ETour Factory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network: ", network, `(chainId: ${chainId})`);
    if (force) console.log("Mode:     FORCE (redeploying everything)");
    console.log("");

    // ── 1. Instance Modules ─────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. ChessRulesModule ─────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessRulesModule...");
    console.log("=".repeat(60));
    const ChessRules = await hre.ethers.getContractFactory("ChessRulesModule");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddr = await chessRules.getAddress();
    console.log("✅ ChessRulesModule deployed to:", chessRulesAddr);
    console.log("");

    // ── 3. TicTacChainFactory ───────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    console.log("=".repeat(60));
    const TicTacFactory = await hre.ethers.getContractFactory("TicTacChainFactory");
    const ticTacFactory = await TicTacFactory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation
    );
    await ticTacFactory.waitForDeployment();
    const ticTacFactoryAddr = await ticTacFactory.getAddress();
    const ticTacImplAddr = await ticTacFactory.implementation();
    console.log("✅ TicTacChainFactory deployed to:", ticTacFactoryAddr);
    console.log("   TicTacInstance implementation:", ticTacImplAddr);
    console.log("");

    // ── 4. ConnectFourFactory ───────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ConnectFourFactory...");
    console.log("=".repeat(60));
    const C4Factory = await hre.ethers.getContractFactory("ConnectFourFactory");
    const c4Factory = await C4Factory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation
    );
    await c4Factory.waitForDeployment();
    const c4FactoryAddr = await c4Factory.getAddress();
    const c4ImplAddr = await c4Factory.implementation();
    console.log("✅ ConnectFourFactory deployed to:", c4FactoryAddr);
    console.log("   ConnectFourInstance implementation:", c4ImplAddr);
    console.log("");

    // ── 5. ChessOnChainFactory ──────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessOnChainFactory...");
    console.log("=".repeat(60));
    const ChessFactory = await hre.ethers.getContractFactory("ChessOnChainFactory");
    const chessFactory = await ChessFactory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation,
        chessRulesAddr
    );
    await chessFactory.waitForDeployment();
    const chessFactoryAddr = await chessFactory.getAddress();
    const chessImplAddr = await chessFactory.implementation();
    console.log("✅ ChessOnChainFactory deployed to:", chessFactoryAddr);
    console.log("   ChessInstance implementation:", chessImplAddr);
    console.log("");

    // ── 6. Save artifacts ───────────────────────────────────────────────────
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp = new Date().toISOString();

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
        factories: {
            TicTacChainFactory:  ticTacFactoryAddr,
            ConnectFourFactory:  c4FactoryAddr,
            ChessOnChainFactory: chessFactoryAddr,
        },
        implementations: {
            TicTacInstance:      ticTacImplAddr,
            ConnectFourInstance: c4ImplAddr,
            ChessInstance:       chessImplAddr,
        },
    };

    saveFactories(deployment);

    // Save combined ABI file for frontend
    const abiDir = "./deployments";
    const [ticTacArt, c4Art, chessArt] = await Promise.all([
        hre.artifacts.readArtifact("TicTacChainFactory"),
        hre.artifacts.readArtifact("ConnectFourFactory"),
        hre.artifacts.readArtifact("ChessOnChainFactory"),
    ]);
    const [ticTacInstArt, c4InstArt, chessInstArt] = await Promise.all([
        hre.artifacts.readArtifact("TicTacInstance"),
        hre.artifacts.readArtifact("ConnectFourInstance"),
        hre.artifacts.readArtifact("ChessInstance"),
    ]);

    const abiFile = path.join(abiDir, "ETour-Factory-ABIs.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network,
        chainId: chainId.toString(),
        deployedAt: timestamp,
        modules: deployment.modules,
        factories: {
            TicTacChainFactory:  { address: ticTacFactoryAddr,  abi: ticTacArt.abi },
            ConnectFourFactory:  { address: c4FactoryAddr,       abi: c4Art.abi },
            ChessOnChainFactory: { address: chessFactoryAddr,    abi: chessArt.abi },
        },
        instances: {
            TicTacInstance:      { address: ticTacImplAddr,  abi: ticTacInstArt.abi },
            ConnectFourInstance: { address: c4ImplAddr,       abi: c4InstArt.abi },
            ChessInstance:       { address: chessImplAddr,    abi: chessInstArt.abi },
        },
    }, null, 2));
    console.log("✅ ABI file saved to:", abiFile);
    console.log("");

    // ── 7. Summary ──────────────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("🎉 FACTORY DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("");
    console.log("📍 Instance Modules (shared):");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("  ChessRulesModule:        ", chessRulesAddr);
    console.log("");
    console.log("📍 Factory Addresses:");
    console.log("  TicTacChainFactory: ", ticTacFactoryAddr);
    console.log("  ConnectFourFactory: ", c4FactoryAddr);
    console.log("  ChessOnChainFactory:", chessFactoryAddr);
    console.log("");
    console.log("📍 Implementation Contracts (clone targets):");
    console.log("  TicTacInstance:     ", ticTacImplAddr);
    console.log("  ConnectFourInstance:", c4ImplAddr);
    console.log("  ChessInstance:      ", chessImplAddr);
    console.log("");
    console.log("📁 Artifacts:");
    console.log("  -", DEPLOYMENT_FILE);
    console.log("  -", abiFile);
    console.log("");
    console.log("🔗 To create a tournament instance:");
    console.log("   factory.createInstance(playerCount, entryFee, timeouts)");
    console.log("");
    printVerificationCommands(network, modules, chessRulesAddr, ticTacFactoryAddr, c4FactoryAddr, chessFactoryAddr);
}

function printVerificationCommands(network, modules, chessRulesAddr, ticTacAddr, c4Addr, chessAddr) {
    console.log("=".repeat(60));
    console.log("Verification Commands");
    console.log("=".repeat(60));
    console.log(`npx hardhat verify --network ${network} ${modules.core}`);
    console.log(`npx hardhat verify --network ${network} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${network} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${network} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${network} ${chessRulesAddr}`);
    console.log(`npx hardhat verify --network ${network} ${ticTacAddr} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${network} ${c4Addr} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${network} ${chessAddr} ${modules.core} ${modules.matches} ${modules.prizes} ${modules.escalation} ${chessRulesAddr}`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("❌ Factory deployment failed:", err);
        process.exit(1);
    });
