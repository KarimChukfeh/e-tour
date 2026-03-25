// scripts/deploy-chessonchain-factory.js
// Deploy ChessOnChainFactory (+ ChessRulesModule + PlayerRegistry + instance modules if not already deployed).
//
// Usage:
//   npx hardhat run scripts/deploy-chessonchain-factory.js --network localhost
//   REGISTRY=0x... npx hardhat run scripts/deploy-chessonchain-factory.js --network localhost

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";

const DEPLOYMENTS_DIR = "./v2/deployments";

async function main() {
    const force = process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();

    console.log("=".repeat(60));
    console.log("ChessOnChainFactory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Network: ", network, `(chainId: ${chainId})`);
    console.log("");

    // ── 1. Instance Modules ──────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. ChessRulesModule ──────────────────────────────────────────────────
    console.log("Deploying ChessRulesModule...");
    const ChessRules = await hre.ethers.getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddr = await chessRules.getAddress();
    console.log("  ChessRulesModule:", chessRulesAddr);
    console.log("");

    // ── 3. PlayerProfile + PlayerRegistry ────────────────────────────────────
    let registryAddr = process.env.REGISTRY;
    if (registryAddr) {
        console.log("Using existing PlayerRegistry:", registryAddr);
    } else {
        console.log("Deploying PlayerProfile + PlayerRegistry...");
        const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
        const profileImpl = await PlayerProfile.deploy();
        await profileImpl.waitForDeployment();
        const profileImplAddr = await profileImpl.getAddress();

        const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
        const registry = await PlayerRegistry.deploy(profileImplAddr);
        await registry.waitForDeployment();
        registryAddr = await registry.getAddress();
        console.log("  PlayerProfile (impl):", profileImplAddr);
        console.log("  PlayerRegistry:      ", registryAddr);
    }
    console.log("");

    // ── 4. ChessOnChainFactory ───────────────────────────────────────────────
    console.log("Deploying ChessOnChainFactory...");
    const ChessFactory = await hre.ethers.getContractFactory("contracts/ChessOnChainFactory.sol:ChessOnChainFactory");
    const factory = await ChessFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, chessRulesAddr, registryAddr
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();

    const registry = await hre.ethers.getContractAt("contracts/PlayerRegistry.sol:PlayerRegistry", registryAddr);
    await (await registry.authorizeFactory(factoryAddr)).wait();
    console.log("  ChessOnChainFactory:", factoryAddr, "[authorized]");
    console.log("  ChessInstance impl: ", implAddr);
    console.log("");

    // ── 5. Save artifacts ────────────────────────────────────────────────────
    if (!fs.existsSync(DEPLOYMENTS_DIR)) fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp   = new Date().toISOString();

    const deployment = {
        network, chainId: chainId.toString(), deployer: deployer.address, timestamp, blockNumber,
        modules: {
            ETourInstance_Core:       modules.core,
            ETourInstance_Matches:    modules.matches,
            ETourInstance_Prizes:     modules.prizes,
            ETourInstance_Escalation: modules.escalation,
            ChessRulesModule:         chessRulesAddr,
        },
        playerProfile: { PlayerRegistry: registryAddr },
        factory: { ChessOnChainFactory: factoryAddr },
        implementation: { ChessInstance: implAddr },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-chess-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));

    const [factoryArt, instanceArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/ChessOnChainFactory.sol:ChessOnChainFactory"),
        hre.artifacts.readArtifact("contracts/ChessInstance.sol:ChessInstance"),
    ]);
    const abiFile = path.join(DEPLOYMENTS_DIR, "ChessOnChainFactory-ABI.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network, chainId: chainId.toString(), deployedAt: timestamp,
        modules: deployment.modules,
        playerProfile: deployment.playerProfile,
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: chessRulesAddr, instanceAbi: instanceArt.abi },
    }, null, 2));

    console.log("DEPLOYMENT COMPLETE | Network:", network, "| Block:", blockNumber);
    console.log("  Artifacts:", deployFile);
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${chessRulesAddr}`);
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${chessRulesAddr}" "${registryAddr}"`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Deployment failed:", err); process.exit(1); });
