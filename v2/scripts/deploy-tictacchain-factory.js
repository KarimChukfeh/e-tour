// scripts/deploy-tictacchain-factory.js
// Deploy TicTacChainFactory (+ PlayerRegistry + instance modules if not already deployed).
//
// Usage:
//   npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost
//   npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost --force
//   REGISTRY=0x... npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost

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
    console.log("TicTacChainFactory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network: ", network, `(chainId: ${chainId})`);
    if (force) console.log("Mode:     FORCE (redeploying modules)");
    console.log("");

    // ── 1. Instance Modules ──────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. PlayerProfile + PlayerRegistry ────────────────────────────────────
    // Reuse existing registry if REGISTRY env var is set, otherwise deploy fresh.
    let registryAddr = process.env.REGISTRY;
    if (registryAddr) {
        console.log("Using existing PlayerRegistry:", registryAddr);
    } else {
        console.log("Deploying PlayerProfile + PlayerRegistry...");
        const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
        const profileImpl = await PlayerProfile.deploy();
        await profileImpl.waitForDeployment();
        const profileImplAddr = await profileImpl.getAddress();
        console.log("  PlayerProfile (impl):", profileImplAddr);

        const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
        const registry = await PlayerRegistry.deploy(profileImplAddr);
        await registry.waitForDeployment();
        registryAddr = await registry.getAddress();
        console.log("  PlayerRegistry:      ", registryAddr);
    }
    console.log("");

    // ── 3. TicTacChainFactory ────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
    const factory = await TicTacFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, registryAddr
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();
    console.log("  TicTacChainFactory:", factoryAddr);
    console.log("  TicTacInstance impl:", implAddr);

    // Authorize factory on registry
    const registry = await hre.ethers.getContractAt("contracts/PlayerRegistry.sol:PlayerRegistry", registryAddr);
    await (await registry.authorizeFactory(factoryAddr)).wait();
    console.log("  Factory authorized on registry");
    console.log("");

    // ── 4. Save artifacts ────────────────────────────────────────────────────
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
        },
        playerProfile: { PlayerRegistry: registryAddr },
        factory: { TicTacChainFactory: factoryAddr },
        implementation: { TicTacInstance: implAddr },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-tictac-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));

    const [factoryArt, instanceArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/TicTacChainFactory.sol:TicTacChainFactory"),
        hre.artifacts.readArtifact("contracts/TicTacInstance.sol:TicTacInstance"),
    ]);
    const abiFile = path.join(DEPLOYMENTS_DIR, "TicTacChainFactory-ABI.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network, chainId: chainId.toString(), deployedAt: timestamp,
        modules: deployment.modules,
        playerProfile: deployment.playerProfile,
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: instanceArt.abi },
    }, null, 2));

    console.log("DEPLOYMENT COMPLETE | Network:", network, "| Block:", blockNumber);
    console.log("  Artifacts:", deployFile);
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}"`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Deployment failed:", err); process.exit(1); });
