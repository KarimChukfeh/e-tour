// scripts/deploy-connectfour-factory.js
// Deploy ConnectFourFactory (+ PlayerRegistry + instance modules if not already deployed).
//
// Usage:
//   npx hardhat run scripts/deploy-connectfour-factory.js --network localhost
//   REGISTRY=0x... npx hardhat run scripts/deploy-connectfour-factory.js --network localhost

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
    console.log("ConnectFourFactory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Network: ", network, `(chainId: ${chainId})`);
    console.log("");

    // ── 1. Instance Modules ──────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. PlayerProfile + PlayerRegistry ────────────────────────────────────
    let registryAddr = process.env.REGISTRY;
    let profileImplAddr;
    if (registryAddr) {
        console.log("Using existing PlayerRegistry:", registryAddr);
    } else {
        console.log("Deploying PlayerProfile + PlayerRegistry...");
        const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
        const profileImpl = await PlayerProfile.deploy();
        await profileImpl.waitForDeployment();
        profileImplAddr = await profileImpl.getAddress();

        const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
        const registry = await PlayerRegistry.deploy(profileImplAddr);
        await registry.waitForDeployment();
        registryAddr = await registry.getAddress();
        console.log("  PlayerProfile (impl):", profileImplAddr);
        console.log("  PlayerRegistry:      ", registryAddr);
    }
    console.log("");

    // ── 3. ConnectFourFactory ────────────────────────────────────────────────
    console.log("Deploying ConnectFourFactory...");
    const C4Factory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
    const factory = await C4Factory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, registryAddr
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();

    const registry = await hre.ethers.getContractAt("contracts/PlayerRegistry.sol:PlayerRegistry", registryAddr);
    if (!profileImplAddr) {
        profileImplAddr = await registry.profileImplementation();
    }
    await (await registry.authorizeFactory(factoryAddr)).wait();
    console.log("  ConnectFourFactory:", factoryAddr, "[authorized]");
    console.log("  ConnectFourInstance impl:", implAddr);
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
        playerProfile: {
            PlayerProfileImpl: profileImplAddr,
            PlayerRegistry: registryAddr,
        },
        factory: { ConnectFourFactory: factoryAddr },
        implementation: { ConnectFourInstance: implAddr },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-connectfour-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));

    const [factoryArt, instanceArt, profileArt, registryArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/ConnectFourFactory.sol:ConnectFourFactory"),
        hre.artifacts.readArtifact("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
        hre.artifacts.readArtifact("contracts/PlayerProfile.sol:PlayerProfile"),
        hre.artifacts.readArtifact("contracts/PlayerRegistry.sol:PlayerRegistry"),
    ]);

    const playerProfileArtifacts = {
        PlayerProfileImpl: { address: profileImplAddr, abi: profileArt.abi },
        PlayerRegistry: { address: registryAddr, abi: registryArt.abi },
    };

    const abiFile = path.join(DEPLOYMENTS_DIR, "ConnectFourFactory-ABI.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network, chainId: chainId.toString(), deployedAt: timestamp,
        modules: deployment.modules,
        playerProfile: playerProfileArtifacts,
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: instanceArt.abi },
    }, null, 2));

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "PlayerProfile-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerProfileImpl,
        }, null, 2)
    );

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "PlayerRegistry-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerRegistry,
        }, null, 2)
    );

    console.log("DEPLOYMENT COMPLETE | Network:", network, "| Block:", blockNumber);
    console.log("  Artifacts:", deployFile);
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}"`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Deployment failed:", err); process.exit(1); });
