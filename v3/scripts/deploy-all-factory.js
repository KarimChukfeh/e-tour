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
import {
    artifactRecord,
    assertDeploymentTarget,
    atomicWriteJson,
    canonicalManifestPath,
    compilerMetadata,
    isLocalDevelopmentNetwork,
    networkDeploymentDirectory,
    repositoryMetadata,
    requireReviewedSourceState,
} from "./lib/deployment-output.js";

async function main() {
    const force =
        process.env.FORCE === "1" || process.argv.includes("--force");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();
    const normalizedChainId = assertDeploymentTarget(
        network,
        chainId
    );
    const repository = repositoryMetadata(
        path.resolve(process.cwd(), "..")
    );
    requireReviewedSourceState(network, repository);
    const protocolCompiler = await compilerMetadata(
        hre,
        "contracts/TicTacChainFactory.sol:TicTacChainFactory"
    );

    console.log("=".repeat(60));
    console.log("ETour Full Factory Deployment");
    console.log("=".repeat(60));
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log(
        "Network: ",
        network,
        `(chainId: ${normalizedChainId})`
    );
    console.log(
        "Source:  ",
        repository.commit,
        repository.dirty ? "(dirty development tree)" : "(clean)"
    );
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
            : isLocalDevelopmentNetwork(network)
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
    const networkOutputDir = networkDeploymentDirectory(
        deploymentsDir,
        network
    );
    if (!fs.existsSync(networkOutputDir)) {
        fs.mkdirSync(networkOutputDir, { recursive: true });
    }

    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp   = new Date().toISOString();

    const deployment = {
        schemaVersion: 3,
        generation: "v3",
        network,
        chainId: normalizedChainId,
        deployer: deployer.address,
        timestamp,
        blockNumber,
        source: repository,
        compiler: protocolCompiler,
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
        coreArt,
        matchesArt,
        prizesArt,
        escalationArt,
        chessRulesArt,
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
            hre.artifacts.readArtifact("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"),
            hre.artifacts.readArtifact("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"),
            hre.artifacts.readArtifact("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"),
            hre.artifacts.readArtifact("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"),
            hre.artifacts.readArtifact("contracts/modules/ChessRulesModule.sol:ChessRulesModule"),
        ]);

    const abiFile = path.join(
        networkOutputDir,
        "ETour-Factory-ABIs.json"
    );
    const playerProfileArtifacts = {
        PlayerProfileImpl: { address: profileImplAddr, abi: profileArt.abi },
        PlayerRegistry: { address: registryAddr, abi: registryArt.abi },
    };
    const writeNetworkOutput = (fileName, payload) => {
        const canonical = path.join(
            networkOutputDir,
            fileName
        );
        atomicWriteJson(canonical, payload);
        if (network === "localhost") {
            atomicWriteJson(
                path.join(deploymentsDir, fileName),
                payload
            );
        }
        return canonical;
    };
    const combinedAbiPayload = {
        network,
        chainId: normalizedChainId,
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
    };
    writeNetworkOutput(
        "ETour-Factory-ABIs.json",
        combinedAbiPayload
    );
    console.log("ABI file saved to:", abiFile);

    writeNetworkOutput(
        "PlayerProfile-ABI.json",
        {
            network,
            chainId: normalizedChainId,
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerProfileImpl,
        }
    );
    writeNetworkOutput(
        "PlayerRegistry-ABI.json",
        {
            network,
            chainId: normalizedChainId,
            deployedAt: timestamp,
            contract: playerProfileArtifacts.PlayerRegistry,
        }
    );
    writeNetworkOutput(
        "SessionKeyRegistry-ABI.json",
        {
            network,
            chainId: normalizedChainId,
            deployedAt: timestamp,
            contract: {
                address: sessionRegistryAddr,
                abi: sessionRegistryArt.abi,
            },
        }
    );

    const perGameDeploymentFiles = [
        {
            path: path.join(deploymentsDir, `${network}-tictac-factory.json`),
            payload: {
                network,
                chainId: normalizedChainId,
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
                chainId: normalizedChainId,
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
                chainId: normalizedChainId,
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
        atomicWriteJson(file.path, file.payload);
        atomicWriteJson(
            path.join(
                networkOutputDir,
                path
                    .basename(file.path)
                    .replace(`${network}-`, "")
            ),
            file.payload
        );
        console.log("Deployment saved to:", file.path);
    }

    const perGameAbiFiles = [
        {
            path: path.join(networkOutputDir, "TicTacChainFactory-ABI.json"),
            payload: {
                network,
                chainId: normalizedChainId,
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
            path: path.join(networkOutputDir, "ConnectFourFactory-ABI.json"),
            payload: {
                network,
                chainId: normalizedChainId,
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
            path: path.join(networkOutputDir, "ChessOnChainFactory-ABI.json"),
            payload: {
                network,
                chainId: normalizedChainId,
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
        atomicWriteJson(file.path, file.payload);
        if (network === "localhost") {
            atomicWriteJson(
                path.join(
                    deploymentsDir,
                    path.basename(file.path)
                ),
                file.payload
            );
        }
        console.log("ABI file saved to:", file.path);
    }

    const contracts = {
        EntryPoint: artifactRecord(
            hre.ethers,
            accountAbstraction.artifacts.EntryPoint,
            { address: ENTRY_POINT_ADDRESS }
        ),
        SimpleAccountImplementation: artifactRecord(
            hre.ethers,
            accountAbstraction.artifacts.SimpleAccount,
            {
                address:
                    accountAbstraction.simpleAccountImplementation,
                constructorArguments: [ENTRY_POINT_ADDRESS],
            }
        ),
        SimpleAccountFactory: artifactRecord(
            hre.ethers,
            accountAbstraction.artifacts.SimpleAccountFactory,
            {
                address:
                    accountAbstraction.simpleAccountFactory,
                constructorArguments: [ENTRY_POINT_ADDRESS],
            }
        ),
        ETourInstance_Core: artifactRecord(
            hre.ethers,
            coreArt,
            { address: modules.core }
        ),
        ETourInstance_Matches: artifactRecord(
            hre.ethers,
            matchesArt,
            { address: modules.matches }
        ),
        ETourInstance_Prizes: artifactRecord(
            hre.ethers,
            prizesArt,
            { address: modules.prizes }
        ),
        ETourInstance_Escalation: artifactRecord(
            hre.ethers,
            escalationArt,
            { address: modules.escalation }
        ),
        ChessRulesModule: artifactRecord(
            hre.ethers,
            chessRulesArt,
            { address: chessRulesAddr }
        ),
        PlayerProfile: artifactRecord(
            hre.ethers,
            profileArt,
            { address: profileImplAddr }
        ),
        PlayerRegistry: artifactRecord(
            hre.ethers,
            registryArt,
            {
                address: registryAddr,
                constructorArguments: [profileImplAddr],
            }
        ),
        SessionKeyRegistry: artifactRecord(
            hre.ethers,
            sessionRegistryArt,
            {
                address: sessionRegistryAddr,
                constructorArguments: [registryAddr],
            }
        ),
        ETourSessionAccount: {
            ...artifactRecord(
                hre.ethers,
                sessionAccountArt,
                {
                    deployment:
                        "counterfactual-per-session",
                }
            ),
            constructorArgumentPolicy: [
                ENTRY_POINT_ADDRESS,
                "<browser-session-owner>",
                sessionAccountFactoryAddr,
            ],
        },
        ETourSessionAccountFactory: artifactRecord(
            hre.ethers,
            sessionAccountFactoryArt,
            {
                address: sessionAccountFactoryAddr,
                constructorArguments: [ENTRY_POINT_ADDRESS],
            }
        ),
        ETourSessionPaymaster: artifactRecord(
            hre.ethers,
            sessionPaymasterArt,
            {
                address: sessionPaymasterAddr,
                constructorArguments: [
                    ENTRY_POINT_ADDRESS,
                    sessionRegistryAddr,
                    sessionAccountFactoryAddr,
                ],
            }
        ),
        TicTacChainFactory: artifactRecord(
            hre.ethers,
            ticTacArt,
            {
                address: ticTacFactoryAddr,
                constructorArguments: [
                    modules.core,
                    modules.matches,
                    modules.prizes,
                    modules.escalation,
                    registryAddr,
                    sessionRegistryAddr,
                ],
            }
        ),
        ConnectFourFactory: artifactRecord(
            hre.ethers,
            c4Art,
            {
                address: c4FactoryAddr,
                constructorArguments: [
                    modules.core,
                    modules.matches,
                    modules.prizes,
                    modules.escalation,
                    registryAddr,
                    sessionRegistryAddr,
                ],
            }
        ),
        ChessOnChainFactory: artifactRecord(
            hre.ethers,
            chessArt,
            {
                address: chessFactoryAddr,
                constructorArguments: [
                    modules.core,
                    modules.matches,
                    modules.prizes,
                    modules.escalation,
                    chessRulesAddr,
                    registryAddr,
                    sessionRegistryAddr,
                ],
            }
        ),
        TicTacInstance: artifactRecord(
            hre.ethers,
            ticTacInstArt,
            { address: ticTacImplAddr }
        ),
        ConnectFourInstance: artifactRecord(
            hre.ethers,
            c4InstArt,
            { address: c4ImplAddr }
        ),
        ChessInstance: artifactRecord(
            hre.ethers,
            chessInstArt,
            { address: chessImplAddr }
        ),
    };
    for (const record of Object.values(contracts)) {
        if (!record.address) {
            record.runtimeBytecodeHash = null;
            continue;
        }
        const runtimeBytecode =
            await hre.ethers.provider.getCode(record.address);
        if (!runtimeBytecode || runtimeBytecode === "0x") {
            throw new Error(
                `missing runtime bytecode for ${record.contractName} ` +
                    `at ${record.address}`
            );
        }
        record.runtimeBytecodeHash =
            hre.ethers.keccak256(runtimeBytecode);
    }
    const completeManifest = {
        ...deployment,
        manifestKind: "complete-v3-deployment",
        compilers: {
            protocol: protocolCompiler,
            canonicalEntryPoint: {
                version: "0.8.28",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 1_000_000,
                    },
                    viaIR: true,
                    evmVersion: "cancun",
                },
                package:
                    "@account-abstraction/contracts@0.8.0",
            },
        },
        entryPoint: {
            version: "0.8",
            address: ENTRY_POINT_ADDRESS,
            senderCreator: accountAbstraction.senderCreator,
        },
        accountAbstraction: {
            ...deployment.accountAbstraction,
            simpleAccountImplementation:
                accountAbstraction.simpleAccountImplementation,
            senderCreator: accountAbstraction.senderCreator,
        },
        abiPolicy: {
            embedded: true,
            contractCount: Object.keys(contracts).length,
            canonicalBundle:
                "ETour-Factory-ABIs.json",
        },
        contracts,
    };
    const canonicalManifest = canonicalManifestPath(
        deploymentsDir,
        network
    );
    // Write the complete manifest last. Its presence means every sibling
    // deployment and ABI output for this run was written successfully.
    atomicWriteJson(canonicalManifest, completeManifest);
    atomicWriteJson(deployFile, completeManifest);
    console.log(
        "Canonical deployment manifest saved to:",
        canonicalManifest
    );
    console.log("Compatibility manifest saved to:", deployFile);
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
    if (isLocalDevelopmentNetwork(n)) {
        console.log(
            "Local deployment: validate with the manifest, smoke, " +
                "acceptance, and bytecode-size checks."
        );
    } else {
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
    }
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Deployment failed:", err);
        process.exit(1);
    });
