// scripts/deploy-all-factory.js
// One-shot deployment of the entire ETour factory/instance architecture:
//   1. ETourInstance modules (Core, Matches, Prizes, Escalation)
//   2. ChessRulesModule
//   3. TicTacChainFactory, ConnectFourFactory, ChessOnChainFactory
//
// Usage:
//   npx hardhat run scripts/deploy-all-factory.js --network <network>
//   npx hardhat run scripts/deploy-all-factory.js --network <network> --force

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";

async function main() {
    const force = process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();

    console.log("=".repeat(60));
    console.log("🚀 ETour Full Factory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network: ", network, `(chainId: ${chainId})`);
    if (force) console.log("Mode:     FORCE (redeploying everything)");
    console.log("");

    // ── Step 1: Instance Modules ──────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── Step 2: ChessRulesModule ──────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessRulesModule...");
    console.log("=".repeat(60));
    const ChessRules = await hre.ethers.getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddr = await chessRules.getAddress();
    console.log("✅ ChessRulesModule:", chessRulesAddr);
    console.log("");

    // ── Step 3: TicTacChainFactory ────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    console.log("=".repeat(60));
    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
    const ticTacFactory = await TicTacFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation
    );
    await ticTacFactory.waitForDeployment();
    const ticTacFactoryAddr = await ticTacFactory.getAddress();
    const ticTacImplAddr    = await ticTacFactory.implementation();
    console.log("✅ TicTacChainFactory:", ticTacFactoryAddr);
    console.log("   TicTacInstance impl:", ticTacImplAddr);
    console.log("");

    // ── Step 4: ConnectFourFactory ────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ConnectFourFactory...");
    console.log("=".repeat(60));
    const C4Factory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
    const c4Factory = await C4Factory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation
    );
    await c4Factory.waitForDeployment();
    const c4FactoryAddr = await c4Factory.getAddress();
    const c4ImplAddr    = await c4Factory.implementation();
    console.log("✅ ConnectFourFactory:", c4FactoryAddr);
    console.log("   ConnectFourInstance impl:", c4ImplAddr);
    console.log("");

    // ── Step 5: ChessOnChainFactory ───────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessOnChainFactory...");
    console.log("=".repeat(60));
    const ChessFactory = await hre.ethers.getContractFactory("contracts/ChessOnChainFactory.sol:ChessOnChainFactory");
    const chessFactory = await ChessFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, chessRulesAddr
    );
    await chessFactory.waitForDeployment();
    const chessFactoryAddr = await chessFactory.getAddress();
    const chessImplAddr    = await chessFactory.implementation();
    console.log("✅ ChessOnChainFactory:", chessFactoryAddr);
    console.log("   ChessInstance impl:", chessImplAddr);
    console.log("");

    // ── Step 6: Save artifacts ────────────────────────────────────────────────
    const deploymentsDir = "./v2/deployments";
    if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

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

    const deployFile = path.join(deploymentsDir, `${network}-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));
    console.log("💾 Deployment saved to:", deployFile);

    // ABI file for frontend
    const [ticTacArt, c4Art, chessArt, ticTacInstArt, c4InstArt, chessInstArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/TicTacChainFactory.sol:TicTacChainFactory"),
        hre.artifacts.readArtifact("contracts/ConnectFourFactory.sol:ConnectFourFactory"),
        hre.artifacts.readArtifact("contracts/ChessOnChainFactory.sol:ChessOnChainFactory"),
        hre.artifacts.readArtifact("contracts/TicTacInstance.sol:TicTacInstance"),
        hre.artifacts.readArtifact("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
        hre.artifacts.readArtifact("contracts/ChessInstance.sol:ChessInstance"),
    ]);

    const abiFile = path.join(deploymentsDir, "ETour-Factory-ABIs.json");
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
    console.log("💾 ABI file saved to:", abiFile);
    console.log("");

    // ── Step 7: Summary ───────────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("🎉 FULL FACTORY DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("");
    console.log("Network: ", network, " | Block:", blockNumber);
    console.log("");
    console.log("📍 Instance Modules:");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("  ChessRulesModule:        ", chessRulesAddr);
    console.log("");
    console.log("📍 Factories:");
    console.log("  TicTacChainFactory: ", ticTacFactoryAddr);
    console.log("  ConnectFourFactory: ", c4FactoryAddr);
    console.log("  ChessOnChainFactory:", chessFactoryAddr);
    console.log("");
    console.log("📍 Implementation Contracts (EIP-1167 clone targets):");
    console.log("  TicTacInstance:     ", ticTacImplAddr);
    console.log("  ConnectFourInstance:", c4ImplAddr);
    console.log("  ChessInstance:      ", chessImplAddr);
    console.log("");
    console.log("📁 Artifacts:");
    console.log("  -", deployFile);
    console.log("  -", abiFile);
    console.log("");
    console.log("🔗 Next steps:");
    console.log("   factory.createInstance(playerCount, entryFee, timeouts)");
    console.log("   Players enroll via instance.enrollInTournament({ value: entryFee })");
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
    console.log(`npx hardhat verify --network ${n} ${ticTacFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}"`);
    console.log(`npx hardhat verify --network ${n} ${c4FactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}"`);
    console.log(`npx hardhat verify --network ${n} ${chessFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${chessRulesAddr}"`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("❌ Deployment failed:", err);
        process.exit(1);
    });
