// scripts/deploy-all-factory.js
// One-shot deployment of the entire ETour factory/instance architecture:
//   1. ETourInstance modules (Core, Matches, Prizes, Escalation)
//   2. ChessRulesModule
//   3. PlayerProfile implementation + PlayerRegistry + SessionKeyRegistry
//   4. TicTacChainFactory, ConnectFourFactory, ChessOnChainFactory
//   5. Authorize all three factories on the registry
//
// Usage:
//   npx hardhat run scripts/deploy-all-factory.js --network <network>
//   FORCE=1 npx hardhat run scripts/deploy-all-factory.js --network <network>

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { getOrDeployInstanceModules } from "./deploy-instance-modules.js";
import {
    ENTRY_POINT_ADDRESS,
    deployLocalAccountAbstraction,
} from "./lib/account-abstraction-deployment.js";

async function main() {
    const force =
        process.env.FORCE === "1" || process.argv.includes("--force");

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

    // ── Step 0: Canonical ERC-4337 infrastructure ────────────────────────────
    const accountAbstraction = await deployLocalAccountAbstraction(
        hre,
        { signer: deployer, writeManifest: true }
    );
    console.log("ERC-4337 EntryPoint:", ENTRY_POINT_ADDRESS);
    console.log(
        "Official SimpleAccountFactory:",
        accountAbstraction.simpleAccountFactory
    );
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

    // ── Step 3: PlayerProfile + player/session registries ─────────────────────
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

    const SessionRegistry = await hre.ethers.getContractFactory(
        "contracts/SessionKeyRegistry.sol:SessionKeyRegistry"
    );
    const sessionRegistry = await SessionRegistry.deploy(registryAddr);
    await sessionRegistry.waitForDeployment();
    const sessionRegistryAddr = await sessionRegistry.getAddress();
    console.log("  SessionKeyRegistry:  ", sessionRegistryAddr);

    const SessionAccountFactory = await hre.ethers.getContractFactory(
        "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory"
    );
    const sessionAccountFactory =
        await SessionAccountFactory.deploy(ENTRY_POINT_ADDRESS);
    await sessionAccountFactory.waitForDeployment();
    const sessionAccountFactoryAddr =
        await sessionAccountFactory.getAddress();
    console.log(
        "  SessionAccountFactory:",
        sessionAccountFactoryAddr
    );

    const SessionPaymaster = await hre.ethers.getContractFactory(
        "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster"
    );
    const sessionPaymaster = await SessionPaymaster.deploy(
        ENTRY_POINT_ADDRESS,
        sessionRegistryAddr,
        sessionAccountFactoryAddr
    );
    await sessionPaymaster.waitForDeployment();
    const sessionPaymasterAddr = await sessionPaymaster.getAddress();
    const configuredDeposit = process.env.PAYMASTER_DEPOSIT_WEI;
    const initialPaymasterDeposit =
        configuredDeposit !== undefined
            ? BigInt(configuredDeposit)
            : network === "localhost" || network === "hardhat"
                ? hre.ethers.parseEther("0.5")
                : 0n;
    if (initialPaymasterDeposit > 0n) {
        await (
            await sessionPaymaster.deposit({
                value: initialPaymasterDeposit,
            })
        ).wait();
    }
    console.log("  SessionPaymaster:    ", sessionPaymasterAddr);
    console.log(
        "  Paymaster deposit:   ",
        hre.ethers.formatEther(
            await sessionPaymaster.getDeposit()
        ),
        "ETH"
    );
    console.log("");

    // ── Step 4: TicTacChainFactory ────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying TicTacChainFactory...");
    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
    const ticTacFactory = await TicTacFactory.deploy(
        modules.core, modules.matches, modules.prizes, modules.escalation,
        registryAddr, sessionRegistryAddr
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
        modules.core, modules.matches, modules.prizes, modules.escalation,
        registryAddr, sessionRegistryAddr
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
        modules.core, modules.matches, modules.prizes, modules.escalation,
        chessRulesAddr, registryAddr, sessionRegistryAddr
    );
    await chessFactory.waitForDeployment();
    const chessFactoryAddr = await chessFactory.getAddress();
    const chessImplAddr    = await chessFactory.implementation();
    await (await registry.authorizeFactory(chessFactoryAddr)).wait();
    for (const approvedFactory of [
        ticTacFactoryAddr,
        c4FactoryAddr,
        chessFactoryAddr,
    ]) {
        await (
            await sessionPaymaster.setFactoryAllowed(
                approvedFactory,
                true
            )
        ).wait();
    }
    const configuredPaymasterOwner =
        process.env.PAYMASTER_OWNER_ADDRESS;
    if (
        configuredPaymasterOwner &&
        hre.ethers.getAddress(configuredPaymasterOwner) !==
            deployer.address
    ) {
        await (
            await sessionPaymaster.transferOwnership(
                configuredPaymasterOwner
            )
        ).wait();
    }
    console.log("  ChessOnChainFactory:", chessFactoryAddr, "[authorized]");
    console.log("  ChessInstance impl:", chessImplAddr);
    console.log("");

    // ── Step 7: Save artifacts ────────────────────────────────────────────────
    const deploymentsDir = "./deployments";
    if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
    const abiOutputDir =
        network === "localhost"
            ? deploymentsDir
            : path.join(deploymentsDir, network);
    if (!fs.existsSync(abiOutputDir)) {
        fs.mkdirSync(abiOutputDir, { recursive: true });
    }

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
        sessionAuthorization: {
            SessionKeyRegistry: sessionRegistryAddr,
            ttlSeconds: (await sessionRegistry.SESSION_TTL()).toString(),
        },
        accountAbstraction: {
            entryPoint: ENTRY_POINT_ADDRESS,
            officialSimpleAccountFactory:
                accountAbstraction.simpleAccountFactory,
            sessionAccountFactory: sessionAccountFactoryAddr,
            sessionPaymaster: sessionPaymasterAddr,
            paymasterDeposit:
                (await sessionPaymaster.getDeposit()).toString(),
            paymasterOwner: await sessionPaymaster.owner(),
            paymasterFundingAddress:
                process.env.PAYMASTER_FUNDING_ADDRESS ??
                deployer.address,
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

    const [
        ticTacArt,
        c4Art,
        chessArt,
        ticTacInstArt,
        c4InstArt,
        chessInstArt,
        profileArt,
        registryArt,
        sessionRegistryArt,
        sessionAccountArt,
        sessionAccountFactoryArt,
        sessionPaymasterArt,
    ] =
        await Promise.all([
            hre.artifacts.readArtifact("contracts/TicTacChainFactory.sol:TicTacChainFactory"),
            hre.artifacts.readArtifact("contracts/ConnectFourFactory.sol:ConnectFourFactory"),
            hre.artifacts.readArtifact("contracts/ChessOnChainFactory.sol:ChessOnChainFactory"),
            hre.artifacts.readArtifact("contracts/TicTacInstance.sol:TicTacInstance"),
            hre.artifacts.readArtifact("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
            hre.artifacts.readArtifact("contracts/ChessInstance.sol:ChessInstance"),
            hre.artifacts.readArtifact("contracts/PlayerProfile.sol:PlayerProfile"),
            hre.artifacts.readArtifact("contracts/PlayerRegistry.sol:PlayerRegistry"),
            hre.artifacts.readArtifact("contracts/SessionKeyRegistry.sol:SessionKeyRegistry"),
            hre.artifacts.readArtifact("contracts/account-abstraction/ETourSessionAccount.sol:ETourSessionAccount"),
            hre.artifacts.readArtifact("contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory"),
            hre.artifacts.readArtifact("contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster"),
        ]);

    const abiFile = path.join(abiOutputDir, "ETour-Factory-ABIs.json");
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
        sessionAuthorization: {
            SessionKeyRegistry: {
                address: sessionRegistryAddr,
                abi: sessionRegistryArt.abi,
            },
        },
        accountAbstraction: {
            EntryPoint: {
                address: ENTRY_POINT_ADDRESS,
                abi: accountAbstraction.artifacts.EntryPoint.abi,
            },
            ETourSessionAccount: {
                address: null,
                abi: sessionAccountArt.abi,
            },
            ETourSessionAccountFactory: {
                address: sessionAccountFactoryAddr,
                abi: sessionAccountFactoryArt.abi,
            },
            ETourSessionPaymaster: {
                address: sessionPaymasterAddr,
                abi: sessionPaymasterArt.abi,
            },
        },
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
        path.join(abiOutputDir, "PlayerProfile-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerProfileImpl,
        }, null, 2)
    );
    fs.writeFileSync(
        path.join(abiOutputDir, "PlayerRegistry-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerRegistry,
        }, null, 2)
    );
    fs.writeFileSync(
        path.join(abiOutputDir, "SessionKeyRegistry-ABI.json"),
        JSON.stringify({
            network,
            chainId: chainId.toString(),
            deployedAt: timestamp,
            contract: {
                address: sessionRegistryAddr,
                abi: sessionRegistryArt.abi,
            },
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
                sessionAuthorization: {
                    SessionKeyRegistry: sessionRegistryAddr,
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
                sessionAuthorization: {
                    SessionKeyRegistry: sessionRegistryAddr,
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
                sessionAuthorization: {
                    SessionKeyRegistry: sessionRegistryAddr,
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
            path: path.join(abiOutputDir, "TicTacChainFactory-ABI.json"),
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
                sessionAuthorization: {
                    SessionKeyRegistry: {
                        address: sessionRegistryAddr,
                        abi: sessionRegistryArt.abi,
                    },
                },
                factory: { address: ticTacFactoryAddr, abi: ticTacArt.abi },
                instance: { address: ticTacImplAddr, abi: ticTacInstArt.abi },
            },
        },
        {
            path: path.join(abiOutputDir, "ConnectFourFactory-ABI.json"),
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
                sessionAuthorization: {
                    SessionKeyRegistry: {
                        address: sessionRegistryAddr,
                        abi: sessionRegistryArt.abi,
                    },
                },
                factory: { address: c4FactoryAddr, abi: c4Art.abi },
                instance: { address: c4ImplAddr, abi: c4InstArt.abi },
            },
        },
        {
            path: path.join(abiOutputDir, "ChessOnChainFactory-ABI.json"),
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
                sessionAuthorization: {
                    SessionKeyRegistry: {
                        address: sessionRegistryAddr,
                        abi: sessionRegistryArt.abi,
                    },
                },
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
    console.log("  SessionKeyRegistry:  ", sessionRegistryAddr);
    console.log("  EntryPoint:          ", ENTRY_POINT_ADDRESS);
    console.log(
        "  SessionAccountFactory:",
        sessionAccountFactoryAddr
    );
    console.log("  SessionPaymaster:    ", sessionPaymasterAddr);
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
    console.log(`npx hardhat verify --network ${n} ${sessionRegistryAddr} "${registryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${sessionAccountFactoryAddr} "${ENTRY_POINT_ADDRESS}"`);
    console.log(`npx hardhat verify --network ${n} ${sessionPaymasterAddr} "${ENTRY_POINT_ADDRESS}" "${sessionRegistryAddr}" "${sessionAccountFactoryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${ticTacFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}" "${sessionRegistryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${c4FactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}" "${sessionRegistryAddr}"`);
    console.log(`npx hardhat verify --network ${n} ${chessFactoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${chessRulesAddr}" "${registryAddr}" "${sessionRegistryAddr}"`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Deployment failed:", err);
        process.exit(1);
    });
