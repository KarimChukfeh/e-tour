// scripts/deploy-all-factory.js
// One-shot deployment of the entire ETour factory/instance architecture:
//   1. ETourInstance modules (Core, Matches, Prizes, Escalation)
//   2. ChessRulesModule
//   3. PlayerProfile implementation + PlayerRegistry
//   4. TicTacChainFactory, ConnectFourFactory, ChessOnChainFactory
//   5. Authorize all three factories on the registry
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
    console.log("ETour Full Factory Deployment");
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
    const ChessRules = await hre.ethers.getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule");
    const chessRules = await ChessRules.deploy();
    await chessRules.waitForDeployment();
    const chessRulesAddr = await chessRules.getAddress();
    console.log("  ChessRulesModule:", chessRulesAddr);
    console.log("");

    // ── Step 3: PlayerProfile implementation + PlayerRegistry ─────────────────
    console.log("=".repeat(60));
    console.log("Deploying PlayerProfile + PlayerRegistry...");
    const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await PlayerProfile.deploy();
    await profileImpl.waitForDeployment();
    const profileImplAddr = await profileImpl.getAddress();
    console.log("  PlayerProfile (impl):", profileImplAddr);

    const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await PlayerRegistry.deploy(profileImplAddr);
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    console.log("  PlayerRegistry:      ", registryAddr);
    console.log("");

    // ── Step 4: TicTacChainFactory ────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
    const ticTacFactory = await TicTacFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, registryAddr
    );
    await ticTacFactory.waitForDeployment();
    const ticTacFactoryAddr = await ticTacFactory.getAddress();
    const ticTacImplAddr    = await ticTacFactory.implementation();
    await (await registry.authorizeFactory(ticTacFactoryAddr)).wait();
    console.log("  TicTacChainFactory:", ticTacFactoryAddr, "[authorized]");
    console.log("  TicTacInstance impl:", ticTacImplAddr);
    console.log("");

    // ── Step 5: ConnectFourFactory ────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ConnectFourFactory...");
    const C4Factory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
    const c4Factory = await C4Factory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, registryAddr
    );
    await c4Factory.waitForDeployment();
    const c4FactoryAddr = await c4Factory.getAddress();
    const c4ImplAddr    = await c4Factory.implementation();
    await (await registry.authorizeFactory(c4FactoryAddr)).wait();
    console.log("  ConnectFourFactory:", c4FactoryAddr, "[authorized]");
    console.log("  ConnectFourInstance impl:", c4ImplAddr);
    console.log("");

    // ── Step 6: ChessOnChainFactory ───────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ChessOnChainFactory...");
    const ChessFactory = await hre.ethers.getContractFactory("contracts/ChessOnChainFactory.sol:ChessOnChainFactory");
    const chessFactory = await ChessFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation, chessRulesAddr, registryAddr
    );
    await chessFactory.waitForDeployment();
    const chessFactoryAddr = await chessFactory.getAddress();
    const chessImplAddr    = await chessFactory.implementation();
    await (await registry.authorizeFactory(chessFactoryAddr)).wait();
    console.log("  ChessOnChainFactory:", chessFactoryAddr, "[authorized]");
    console.log("  ChessInstance impl:", chessImplAddr);
    console.log("");

    // ── Step 7: Save artifacts ────────────────────────────────────────────────
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
        playerProfile: {
            PlayerProfileImpl: profileImplAddr,
            PlayerRegistry: registryAddr,
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
    console.log("Deployment saved to:", deployFile);

    const [ticTacArt, c4Art, chessArt, ticTacInstArt, c4InstArt, chessInstArt, profileArt, registryArt] =
        await Promise.all([
            hre.artifacts.readArtifact("contracts/TicTacChainFactory.sol:TicTacChainFactory"),
            hre.artifacts.readArtifact("contracts/ConnectFourFactory.sol:ConnectFourFactory"),
            hre.artifacts.readArtifact("contracts/ChessOnChainFactory.sol:ChessOnChainFactory"),
            hre.artifacts.readArtifact("contracts/TicTacInstance.sol:TicTacInstance"),
            hre.artifacts.readArtifact("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
            hre.artifacts.readArtifact("contracts/ChessInstance.sol:ChessInstance"),
            hre.artifacts.readArtifact("contracts/PlayerProfile.sol:PlayerProfile"),
            hre.artifacts.readArtifact("contracts/PlayerRegistry.sol:PlayerRegistry"),
        ]);

    const abiFile = path.join(deploymentsDir, "ETour-Factory-ABIs.json");
    const playerProfileArtifacts = {
        PlayerProfileImpl: { address: profileImplAddr, abi: profileArt.abi },
        PlayerRegistry: { address: registryAddr, abi: registryArt.abi },
    };
    fs.writeFileSync(abiFile, JSON.stringify({
        network,
        chainId: chainId.toString(),
        deployedAt: timestamp,
        modules: deployment.modules,
        playerProfile: playerProfileArtifacts,
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
    console.log("ABI file saved to:", abiFile);

    fs.writeFileSync(
        path.join(deploymentsDir, "PlayerProfile-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerProfileImpl,
        }, null, 2)
    );
    fs.writeFileSync(
        path.join(deploymentsDir, "PlayerRegistry-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerRegistry,
        }, null, 2)
    );

    const perGameDeploymentFiles = [
        {
            path: path.join(deploymentsDir, `${network}-tictac-factory.json`),
            payload: {
                network,
                chainId: chainId.toString(),
                deployer: deployer.address,
                timestamp,
                blockNumber,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                },
                playerProfile: {
                    PlayerProfileImpl: profileImplAddr,
                    PlayerRegistry: registryAddr,
                },
                factory: { TicTacChainFactory: ticTacFactoryAddr },
                implementation: { TicTacInstance: ticTacImplAddr },
            },
        },
        {
            path: path.join(deploymentsDir, `${network}-connectfour-factory.json`),
            payload: {
                network,
                chainId: chainId.toString(),
                deployer: deployer.address,
                timestamp,
                blockNumber,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                },
                playerProfile: {
                    PlayerProfileImpl: profileImplAddr,
                    PlayerRegistry: registryAddr,
                },
                factory: { ConnectFourFactory: c4FactoryAddr },
                implementation: { ConnectFourInstance: c4ImplAddr },
            },
        },
        {
            path: path.join(deploymentsDir, `${network}-chess-factory.json`),
            payload: {
                network,
                chainId: chainId.toString(),
                deployer: deployer.address,
                timestamp,
                blockNumber,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                    ChessRulesModule: chessRulesAddr,
                },
                playerProfile: {
                    PlayerProfileImpl: profileImplAddr,
                    PlayerRegistry: registryAddr,
                },
                factory: { ChessOnChainFactory: chessFactoryAddr },
                implementation: { ChessInstance: chessImplAddr },
            },
        },
    ];

    for (const file of perGameDeploymentFiles) {
        fs.writeFileSync(file.path, JSON.stringify(file.payload, null, 2));
        console.log("Deployment saved to:", file.path);
    }

    const perGameAbiFiles = [
        {
            path: path.join(deploymentsDir, "TicTacChainFactory-ABI.json"),
            payload: {
                network,
                chainId: chainId.toString(),
                deployedAt: timestamp,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                },
                playerProfile: playerProfileArtifacts,
                factory: { address: ticTacFactoryAddr, abi: ticTacArt.abi },
                instance: { address: ticTacImplAddr, abi: ticTacInstArt.abi },
            },
        },
        {
            path: path.join(deploymentsDir, "ConnectFourFactory-ABI.json"),
            payload: {
                network,
                chainId: chainId.toString(),
                deployedAt: timestamp,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                },
                playerProfile: playerProfileArtifacts,
                factory: { address: c4FactoryAddr, abi: c4Art.abi },
                instance: { address: c4ImplAddr, abi: c4InstArt.abi },
            },
        },
        {
            path: path.join(deploymentsDir, "ChessOnChainFactory-ABI.json"),
            payload: {
                network,
                chainId: chainId.toString(),
                deployedAt: timestamp,
                modules: {
                    ETourInstance_Core: modules.core,
                    ETourInstance_Matches: modules.matches,
                    ETourInstance_Prizes: modules.prizes,
                    ETourInstance_Escalation: modules.escalation,
                    ChessRulesModule: chessRulesAddr,
                },
                playerProfile: playerProfileArtifacts,
                factory: { address: chessFactoryAddr, abi: chessArt.abi },
                instance: { address: chessImplAddr, abi: chessInstArt.abi },
            },
        },
    ];

    for (const file of perGameAbiFiles) {
        fs.writeFileSync(file.path, JSON.stringify(file.payload, null, 2));
        console.log("ABI file saved to:", file.path);
    }
    console.log("");

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("FULL FACTORY DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("Network:", network, "| Block:", blockNumber);
    console.log("");
    console.log("Instance Modules:");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("  ChessRulesModule:        ", chessRulesAddr);
    console.log("");
    console.log("Player Profile System:");
    console.log("  PlayerProfile (impl):", profileImplAddr);
    console.log("  PlayerRegistry:      ", registryAddr);
    console.log("");
    console.log("Factories (all authorized on registry):");
    console.log("  TicTacChainFactory: ", ticTacFactoryAddr);
    console.log("  ConnectFourFactory: ", c4FactoryAddr);
    console.log("  ChessOnChainFactory:", chessFactoryAddr);
    console.log("");
    console.log("Implementation Contracts (EIP-1167 clone targets):");
    console.log("  TicTacInstance:     ", ticTacImplAddr);
    console.log("  ConnectFourInstance:", c4ImplAddr);
    console.log("  ChessInstance:      ", chessImplAddr);
    console.log("");
    console.log("Artifacts:");
    console.log("  -", deployFile);
    console.log("  -", abiFile);
    console.log("");
    const n = network;
    console.log("Verification Commands:");
    console.log(`npx hardhat verify --network ${n} ${modules.core}`);
    console.log(`npx hardhat verify --network ${n} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${n} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${n} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${n} ${chessRulesAddr}`);
    console.log(`npx hardhat verify --network ${n} ${profileImplAddr}`);
    console.log(`npx hardhat verify --network ${n} ${registryAddr} "${profileImplAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${ticTacFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${c4FactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${chessFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${chessRulesAddr}" "${registryAddr}"`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Deployment failed:", err);
        process.exit(1);
    });
