// scripts/deploy-tictacchain-factory.js
// Deploy TicTacChainFactory (+ player/session registries and instance modules).
//
// Usage:
//   npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost
//   FORCE=1 npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost
//   REGISTRY=0x... SESSION_REGISTRY=0x... npx hardhat run scripts/deploy-tictacchain-factory.js --network localhost

import hre from "hardhat";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";
import {
    assertDeploymentTarget,
    atomicWriteJson,
    networkDeploymentDirectory,
} from "./lib/deployment-output.js";

const DEPLOYMENTS_DIR = "./deployments";

async function main() {
    const force =
        process.env.FORCE === "1" || process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();
    const normalizedChainId = assertDeploymentTarget(network, chainId);

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
    let profileImplAddr;
    if (registryAddr) {
        console.log("Using existing PlayerRegistry:", registryAddr);
    } else {
        console.log("Deploying PlayerProfile + PlayerRegistry...");
        const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
        const profileImpl = await PlayerProfile.deploy();
        await profileImpl.waitForDeployment();
        profileImplAddr = await profileImpl.getAddress();
        console.log("  PlayerProfile (impl):", profileImplAddr);

        const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
        const registry = await PlayerRegistry.deploy(profileImplAddr);
        await registry.waitForDeployment();
        registryAddr = await registry.getAddress();
        console.log("  PlayerRegistry:      ", registryAddr);
    }
    console.log("");

    // ── 3. SessionKeyRegistry ────────────────────────────────────────────────
    let sessionRegistryAddr = process.env.SESSION_REGISTRY;
    if (sessionRegistryAddr) {
        const existing = await hre.ethers.getContractAt(
            "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
            sessionRegistryAddr
        );
        if (
            (await existing.PLAYER_REGISTRY()).toLowerCase() !==
            registryAddr.toLowerCase()
        ) {
            throw new Error("SESSION_REGISTRY belongs to a different PlayerRegistry");
        }
        console.log("Using existing SessionKeyRegistry:", sessionRegistryAddr);
    } else {
        const SessionRegistry = await hre.ethers.getContractFactory(
            "contracts/SessionKeyRegistry.sol:SessionKeyRegistry"
        );
        const sessionRegistry = await SessionRegistry.deploy(registryAddr);
        await sessionRegistry.waitForDeployment();
        sessionRegistryAddr = await sessionRegistry.getAddress();
        console.log("  SessionKeyRegistry:  ", sessionRegistryAddr);
    }
    console.log("");

    // ── 4. TicTacChainFactory ────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
    const factory = await TicTacFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation,
        registryAddr, sessionRegistryAddr
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();
    console.log("  TicTacChainFactory:", factoryAddr);
    console.log("  TicTacInstance impl:", implAddr);

    // Authorize factory on registry
    const registry = await hre.ethers.getContractAt("contracts/PlayerRegistry.sol:PlayerRegistry", registryAddr);
    if (!profileImplAddr) {
        profileImplAddr = await registry.profileImplementation();
    }
    await (await registry.authorizeFactory(factoryAddr)).wait();
    console.log("  Factory authorized on registry");
    console.log("");

    // ── 5. Save artifacts ────────────────────────────────────────────────────
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp   = new Date().toISOString();
    const networkOutputDir = networkDeploymentDirectory(
        DEPLOYMENTS_DIR,
        network
    );
    const writeNetworkOutput = (fileName, value) => {
        atomicWriteJson(path.join(networkOutputDir, fileName), value);
        if (network === "localhost") {
            atomicWriteJson(path.join(DEPLOYMENTS_DIR, fileName), value);
        }
    };

    const deployment = {
        network, chainId: normalizedChainId, deployer: deployer.address, timestamp, blockNumber,
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
        sessionAuthorization: {
            SessionKeyRegistry: sessionRegistryAddr,
        },
        factory: { TicTacChainFactory: factoryAddr },
        implementation: { TicTacInstance: implAddr },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-tictac-factory.json`);
    atomicWriteJson(deployFile, deployment);
    atomicWriteJson(
        path.join(networkOutputDir, "tictac-factory.json"),
        deployment
    );

    const [factoryArt, instanceArt, profileArt, registryArt, sessionRegistryArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/TicTacChainFactory.sol:TicTacChainFactory"),
        hre.artifacts.readArtifact("contracts/TicTacInstance.sol:TicTacInstance"),
        hre.artifacts.readArtifact("contracts/PlayerProfile.sol:PlayerProfile"),
        hre.artifacts.readArtifact("contracts/PlayerRegistry.sol:PlayerRegistry"),
        hre.artifacts.readArtifact("contracts/SessionKeyRegistry.sol:SessionKeyRegistry"),
    ]);

    const playerProfileArtifacts = {
        PlayerProfileImpl: { address: profileImplAddr, abi: profileArt.abi },
        PlayerRegistry: { address: registryAddr, abi: registryArt.abi },
    };

    const abiFile = path.join(networkOutputDir, "TicTacChainFactory-ABI.json");
    writeNetworkOutput("TicTacChainFactory-ABI.json", {
        network, chainId: normalizedChainId, deployedAt: timestamp,
        modules: deployment.modules,
        playerProfile: playerProfileArtifacts,
        sessionAuthorization: {
            SessionKeyRegistry: {
                address: sessionRegistryAddr,
                abi: sessionRegistryArt.abi,
            },
        },
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: instanceArt.abi },
    });

    writeNetworkOutput("PlayerProfile-ABI.json", {
        network,
        chainId: normalizedChainId,
        deployedAt: timestamp,
        contract: playerProfileArtifacts.PlayerProfileImpl,
    });

    writeNetworkOutput("PlayerRegistry-ABI.json", {
        network,
        chainId: normalizedChainId,
        deployedAt: timestamp,
        contract: playerProfileArtifacts.PlayerRegistry,
    });
    writeNetworkOutput("SessionKeyRegistry-ABI.json", {
        network,
        chainId: normalizedChainId,
        deployedAt: timestamp,
        contract: {
            address: sessionRegistryAddr,
            abi: sessionRegistryArt.abi,
        },
    });

    console.log("DEPLOYMENT COMPLETE | Network:", network, "| Block:", blockNumber);
    console.log("  Artifacts:", deployFile);
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${sessionRegistryAddr} "${registryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}" "${sessionRegistryAddr}"`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Deployment failed:", err); process.exit(1); });
