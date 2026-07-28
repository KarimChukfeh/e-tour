import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { verifyLocalhostBytecode } from "./sync-abis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const DEPLOYMENTS_DIR = path.join(V3_DIR, "deployments");
const HARDHAT_CLI = path.join(V3_DIR, "node_modules", "hardhat", "internal", "cli", "cli.js");
const REGENERATE_SCRIPT = path.join(__dirname, "regenerate-abis.js");
const DEFAULT_FRONTEND_ABIS_DIR = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "tic-tac-react",
    "src",
    "v2",
    "ABIs"
);

const GAME_SPECS = [
    {
        sourceAbiFile: "TicTacChainFactory-ABI.json",
        frontendAbiFile: "TicTacToeFactory-ABI.json",
        deploymentFile: (network) => `${network}-tictac-factory.json`,
        canonicalDeploymentFile: "tictac-factory.json",
        sourceFactoryKey: "TicTacChainFactory",
        sourceImplementationKey: "TicTacInstance",
        frontendFactoryKey: "TicTacToeFactory",
        frontendInstanceKey: "TicTacToeInstance",
        frontendImplementationKey: "TicTacToe",
    },
    {
        sourceAbiFile: "ConnectFourFactory-ABI.json",
        frontendAbiFile: "ConnectFourFactory-ABI.json",
        deploymentFile: (network) => `${network}-connectfour-factory.json`,
        canonicalDeploymentFile: "connectfour-factory.json",
        sourceFactoryKey: "ConnectFourFactory",
        sourceImplementationKey: "ConnectFourInstance",
        frontendFactoryKey: "ConnectFourFactory",
        frontendInstanceKey: "ConnectFourInstance",
        frontendImplementationKey: "ConnectFour",
    },
    {
        sourceAbiFile: "ChessOnChainFactory-ABI.json",
        frontendAbiFile: "ChessFactory-ABI.json",
        deploymentFile: (network) => `${network}-chess-factory.json`,
        canonicalDeploymentFile: "chess-factory.json",
        sourceFactoryKey: "ChessOnChainFactory",
        sourceImplementationKey: "ChessInstance",
        frontendFactoryKey: "ChessFactory",
        frontendInstanceKey: "ChessInstance",
        frontendImplementationKey: "Chess",
    },
];

function parseArgs(argv) {
    const args = {
        network: "localhost",
        frontendAbisDir: DEFAULT_FRONTEND_ABIS_DIR,
        checkOnly: false,
        skipCompile: false,
    };

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--network" && argv[i + 1]) {
            args.network = argv[++i];
        } else if (argv[i] === "--frontend-dir" && argv[i + 1]) {
            args.frontendAbisDir = path.resolve(argv[++i]);
        } else if (argv[i] === "--check") {
            args.checkOnly = true;
        } else if (argv[i] === "--skip-compile") {
            args.skipCompile = true;
        } else {
            throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
        }
    }

    return args;
}

function runNodeStep(label, scriptPath, args = []) {
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`${label} executable not found: ${scriptPath}`);
    }

    console.log(`\n${label}...`);
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: V3_DIR,
        env: process.env,
        stdio: "inherit",
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${label} failed with exit code ${result.status}`);
    }
}

function readJson(filePath, label = filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertAddress(value, label) {
    if (!ethers.isAddress(value)) {
        throw new Error(`${label} is missing or invalid: ${String(value)}`);
    }
}

function assertAbi(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty ABI array`);
    }
}

function validateGameBundle(bundle, spec, network) {
    if (bundle.network !== network) {
        throw new Error(
            `${spec.sourceAbiFile} network mismatch: expected ${network}, got ${bundle.network}`
        );
    }
    if (!bundle.chainId) {
        throw new Error(`${spec.sourceAbiFile} is missing chainId`);
    }
    assertAddress(bundle.factory?.address, `${spec.sourceAbiFile} factory address`);
    assertAddress(bundle.instance?.address, `${spec.sourceAbiFile} instance address`);
    assertAddress(
        bundle.playerProfile?.PlayerProfileImpl?.address,
        `${spec.sourceAbiFile} PlayerProfile address`
    );
    assertAddress(
        bundle.playerProfile?.PlayerRegistry?.address,
        `${spec.sourceAbiFile} PlayerRegistry address`
    );
    assertAddress(
        bundle.sessionAuthorization?.SessionKeyRegistry?.address,
        `${spec.sourceAbiFile} SessionKeyRegistry address`
    );
    assertAbi(bundle.factory?.abi, `${spec.sourceAbiFile} factory`);
    assertAbi(bundle.instance?.abi, `${spec.sourceAbiFile} instance`);
    assertAbi(
        bundle.playerProfile?.PlayerProfileImpl?.abi,
        `${spec.sourceAbiFile} PlayerProfile`
    );
    assertAbi(
        bundle.playerProfile?.PlayerRegistry?.abi,
        `${spec.sourceAbiFile} PlayerRegistry`
    );
    assertAbi(
        bundle.sessionAuthorization?.SessionKeyRegistry?.abi,
        `${spec.sourceAbiFile} SessionKeyRegistry`
    );
}

function walkSourceFiles(rootDir, excludedDir) {
    const files = [];
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        const fullPath = path.join(rootDir, entry.name);
        if (path.resolve(fullPath) === path.resolve(excludedDir)) continue;
        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(fullPath, excludedDir));
        } else if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

function discoverImportedAbiFiles(frontendV2Dir, frontendAbisDir) {
    const imported = new Set();
    const importPattern = /["'][^"']*\/ABIs\/([^"']+\.json)["']/g;

    for (const sourcePath of walkSourceFiles(frontendV2Dir, frontendAbisDir)) {
        const source = fs.readFileSync(sourcePath, "utf8");
        for (const match of source.matchAll(importPattern)) {
            imported.add(match[1]);
        }
    }

    if (imported.size === 0) {
        throw new Error(`No ABI JSON imports found under ${frontendV2Dir}`);
    }
    return imported;
}

function buildFrontendPayloads(network) {
    const gameBundles = new Map();
    const localDeployments = new Map();
    const networkDirectory = path.join(
        DEPLOYMENTS_DIR,
        network
    );

    for (const spec of GAME_SPECS) {
        const bundle = readJson(
            path.join(networkDirectory, spec.sourceAbiFile),
            spec.sourceAbiFile
        );
        const deployment = readJson(
            path.join(
                networkDirectory,
                spec.canonicalDeploymentFile
            ),
            spec.deploymentFile(network)
        );
        validateGameBundle(bundle, spec, network);

        const deployedFactory = deployment.factory?.[spec.sourceFactoryKey];
        const deployedImplementation =
            deployment.implementation?.[spec.sourceImplementationKey];
        if (bundle.factory.address !== deployedFactory) {
            throw new Error(`${spec.sourceAbiFile} factory address does not match its deployment`);
        }
        if (bundle.instance.address !== deployedImplementation) {
            throw new Error(`${spec.sourceAbiFile} instance address does not match its deployment`);
        }

        gameBundles.set(spec.frontendFactoryKey, bundle);
        localDeployments.set(spec.frontendFactoryKey, deployment);
    }

    const profilePayload = readJson(
        path.join(networkDirectory, "PlayerProfile-ABI.json"),
        "PlayerProfile-ABI.json"
    );
    const registryPayload = readJson(
        path.join(networkDirectory, "PlayerRegistry-ABI.json"),
        "PlayerRegistry-ABI.json"
    );
    const sharedDeployment = readJson(
        path.join(networkDirectory, "manifest.json"),
        `${network}/manifest.json`
    );

    assertAbi(profilePayload.contract?.abi, "PlayerProfile-ABI.json contract");
    assertAbi(registryPayload.contract?.abi, "PlayerRegistry-ABI.json contract");

    const generatedAt = new Date().toISOString();
    const firstBundle = gameBundles.values().next().value;
    const playerRegistryAddress =
        firstBundle.playerProfile.PlayerRegistry.address;

    for (const [factoryName, bundle] of gameBundles) {
        if (bundle.chainId !== firstBundle.chainId) {
            throw new Error(`${factoryName} ABI bundle has a different chainId`);
        }
        if (bundle.playerProfile.PlayerRegistry.address !== playerRegistryAddress) {
            throw new Error(`${factoryName} does not use the shared PlayerRegistry`);
        }
    }

    const combinedPayload = {
        network,
        chainId: firstBundle.chainId,
        generatedAt,
        playerProfile: {
            PlayerProfileImpl: { abi: profilePayload.contract.abi },
            PlayerRegistry: { abi: registryPayload.contract.abi },
        },
        sessionAuthorization: {
            SessionKeyRegistry: {
                address:
                    firstBundle.sessionAuthorization.SessionKeyRegistry
                        .address,
                abi: firstBundle.sessionAuthorization.SessionKeyRegistry.abi,
            },
        },
        factories: {},
        instances: {},
    };
    const registryAddressesByGame = {};
    const hardhatFactories = {};
    const hardhatImplementations = {};

    const payloads = new Map();
    for (const spec of GAME_SPECS) {
        const bundle = gameBundles.get(spec.frontendFactoryKey);
        const deployment = localDeployments.get(spec.frontendFactoryKey);

        payloads.set(spec.frontendAbiFile, bundle);
        combinedPayload.factories[spec.frontendFactoryKey] = {
            address: bundle.factory.address,
            abi: bundle.factory.abi,
            playerRegistry: bundle.playerProfile.PlayerRegistry.address,
            playerProfileImpl: bundle.playerProfile.PlayerProfileImpl.address,
            sessionRegistry:
                bundle.sessionAuthorization.SessionKeyRegistry.address,
        };
        combinedPayload.instances[spec.frontendInstanceKey] = {
            address: bundle.instance.address,
            abi: bundle.instance.abi,
        };
        registryAddressesByGame[spec.frontendFactoryKey] =
            bundle.playerProfile.PlayerRegistry.address;
        hardhatFactories[spec.frontendFactoryKey] =
            sharedDeployment.factories?.[spec.sourceFactoryKey];
        hardhatImplementations[spec.frontendImplementationKey] =
            sharedDeployment.implementations?.[spec.sourceImplementationKey];

        assertAddress(
            deployment.factory?.[spec.sourceFactoryKey],
            `${spec.deploymentFile(network)} factory`
        );
        assertAddress(
            deployment.implementation?.[spec.sourceImplementationKey],
            `${spec.deploymentFile(network)} implementation`
        );

        payloads.set(spec.deploymentFile(network), {
            ...deployment,
            factory: {
                [spec.frontendFactoryKey]:
                    deployment.factory[spec.sourceFactoryKey],
            },
            implementation: {
                [spec.frontendImplementationKey]:
                    deployment.implementation[spec.sourceImplementationKey],
            },
        });
    }

    payloads.set("ETour-Factory-ABIs.json", combinedPayload);
    payloads.set("PlayerProfile-ABI.json", {
        ...profilePayload,
        network,
        generatedAt,
    });
    payloads.set("PlayerRegistry-ABI.json", {
        ...registryPayload,
        network,
        generatedAt,
        addressesByGame: registryAddressesByGame,
    });
    payloads.set("hardhat-factory.json", {
        ...sharedDeployment,
        factories: hardhatFactories,
        implementations: hardhatImplementations,
    });

    return payloads;
}

async function verifyLiveLocalDeployment(network, payloads) {
    if (network !== "localhost") return;

    await verifyLocalhostBytecode();

    const rpcUrl = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const expectedChainId = BigInt(payloads.get("ETour-Factory-ABIs.json").chainId);
    const actualChainId = (await provider.getNetwork()).chainId;
    if (actualChainId !== expectedChainId) {
        throw new Error(
            `Local RPC chainId ${actualChainId} does not match deployment chainId ${expectedChainId}`
        );
    }

    const addresses = new Set();
    for (const payload of payloads.values()) {
        if (payload.factory?.address) addresses.add(payload.factory.address);
        if (payload.instance?.address) addresses.add(payload.instance.address);
        for (const address of Object.values(payload.factories || {})) {
            if (typeof address === "string") addresses.add(address);
        }
        for (const address of Object.values(payload.implementations || {})) {
            if (typeof address === "string") addresses.add(address);
        }
    }

    for (const address of addresses) {
        if ((await provider.getCode(address)) === "0x") {
            throw new Error(`No deployed code at ${address}`);
        }
    }
}

function assertImportCoverage(importedFiles, payloads) {
    const missingGenerators = [...importedFiles].filter((file) => !payloads.has(file));
    const unusedGenerators = [...payloads.keys()].filter((file) => !importedFiles.has(file));

    if (missingGenerators.length || unusedGenerators.length) {
        throw new Error(
            [
                "Frontend ABI import/generator mismatch.",
                missingGenerators.length
                    ? `Missing generators: ${missingGenerators.join(", ")}`
                    : null,
                unusedGenerators.length
                    ? `Generated but not imported: ${unusedGenerators.join(", ")}`
                    : null,
            ].filter(Boolean).join("\n")
        );
    }
}

function writePayloadsAtomically(frontendAbisDir, payloads) {
    const tempFiles = [];
    try {
        for (const [fileName, payload] of payloads) {
            const destination = path.join(frontendAbisDir, fileName);
            const tempPath = `${destination}.tmp-${process.pid}`;
            fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
            JSON.parse(fs.readFileSync(tempPath, "utf8"));
            tempFiles.push([tempPath, destination]);
        }
        for (const [tempPath, destination] of tempFiles) {
            fs.renameSync(tempPath, destination);
        }
    } catch (error) {
        for (const [tempPath] of tempFiles) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
        throw error;
    }
}

async function main() {
    const { network, frontendAbisDir, checkOnly, skipCompile } =
        parseArgs(process.argv.slice(2));
    const frontendV2Dir = path.dirname(frontendAbisDir);

    if (!fs.existsSync(frontendAbisDir)) {
        throw new Error(`Frontend ABI directory not found: ${frontendAbisDir}`);
    }
    if (!skipCompile) {
        runNodeStep("Compiling V3 contracts", HARDHAT_CLI, ["compile"]);
    }
    runNodeStep("Regenerating V3 ABI bundles", REGENERATE_SCRIPT, [
        "--network",
        network,
    ]);

    const importedFiles = discoverImportedAbiFiles(frontendV2Dir, frontendAbisDir);
    const payloads = buildFrontendPayloads(network);
    assertImportCoverage(importedFiles, payloads);
    await verifyLiveLocalDeployment(network, payloads);

    console.log(`\nValidated ${payloads.size} frontend ABI/deployment JSON payloads.`);
    if (checkOnly) {
        console.log("Check-only mode: no frontend files were changed.");
        return;
    }

    writePayloadsAtomically(frontendAbisDir, payloads);
    console.log(`Copied ${payloads.size} files to ${frontendAbisDir}:`);
    for (const fileName of [...payloads.keys()].sort()) {
        console.log(`  - ${fileName}`);
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
