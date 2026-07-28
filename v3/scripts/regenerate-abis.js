import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENTS_DIR = path.resolve(__dirname, "..", "deployments");
const ARTIFACTS_DIR = path.resolve(__dirname, "..", "artifacts", "contracts");

const GAME_SPECS = [
    {
        label: "TicTacChainFactory",
        deploymentFile: (network) => `${network}-tictac-factory.json`,
        abiFile: "TicTacChainFactory-ABI.json",
        factoryArtifact: path.join(ARTIFACTS_DIR, "TicTacChainFactory.sol", "TicTacChainFactory.json"),
        instanceArtifact: path.join(ARTIFACTS_DIR, "TicTacInstance.sol", "TicTacInstance.json"),
        factoryDeploymentKey: "TicTacChainFactory",
        instanceDeploymentKey: "TicTacInstance",
    },
    {
        label: "ConnectFourFactory",
        deploymentFile: (network) => `${network}-connectfour-factory.json`,
        abiFile: "ConnectFourFactory-ABI.json",
        factoryArtifact: path.join(ARTIFACTS_DIR, "ConnectFourFactory.sol", "ConnectFourFactory.json"),
        instanceArtifact: path.join(ARTIFACTS_DIR, "ConnectFourInstance.sol", "ConnectFourInstance.json"),
        factoryDeploymentKey: "ConnectFourFactory",
        instanceDeploymentKey: "ConnectFourInstance",
    },
    {
        label: "ChessOnChainFactory",
        deploymentFile: (network) => `${network}-chess-factory.json`,
        abiFile: "ChessOnChainFactory-ABI.json",
        factoryArtifact: path.join(ARTIFACTS_DIR, "ChessOnChainFactory.sol", "ChessOnChainFactory.json"),
        instanceArtifact: path.join(ARTIFACTS_DIR, "ChessInstance.sol", "ChessInstance.json"),
        factoryDeploymentKey: "ChessOnChainFactory",
        instanceDeploymentKey: "ChessInstance",
    },
];

function parseArgs(argv) {
    const args = { network: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--network" && argv[i + 1]) {
            args.network = argv[i + 1];
            i++;
        }
    }
    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readAbi(filePath) {
    return readJson(filePath).abi;
}

function ensureFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} not found: ${filePath}`);
    }
}

function resolveNetwork(explicitNetwork) {
    if (explicitNetwork) return explicitNetwork;

    const candidate = path.join(DEPLOYMENTS_DIR, "TicTacChainFactory-ABI.json");
    if (fs.existsSync(candidate)) {
        return readJson(candidate).network;
    }

    throw new Error("Could not infer network. Pass --network <name>.");
}

function buildPlayerProfileSection(deployment, profileAbi, registryAbi) {
    return {
        PlayerProfileImpl: {
            address: deployment.playerProfile?.PlayerProfileImpl ?? null,
            abi: profileAbi,
        },
        PlayerRegistry: {
            address: deployment.playerProfile?.PlayerRegistry ?? null,
            abi: registryAbi,
        },
    };
}

function buildSessionAuthorizationSection(deployment, sessionRegistryAbi) {
    return {
        SessionKeyRegistry: {
            address:
                deployment.sessionAuthorization?.SessionKeyRegistry ?? null,
            abi: sessionRegistryAbi,
        },
    };
}

function main() {
    const { network } = parseArgs(process.argv.slice(2));
    const targetNetwork = resolveNetwork(network);

    const profileArtifactPath = path.join(ARTIFACTS_DIR, "PlayerProfile.sol", "PlayerProfile.json");
    const registryArtifactPath = path.join(ARTIFACTS_DIR, "PlayerRegistry.sol", "PlayerRegistry.json");
    const sessionRegistryArtifactPath = path.join(
        ARTIFACTS_DIR,
        "SessionKeyRegistry.sol",
        "SessionKeyRegistry.json"
    );
    ensureFile(profileArtifactPath, "PlayerProfile artifact");
    ensureFile(registryArtifactPath, "PlayerRegistry artifact");
    ensureFile(sessionRegistryArtifactPath, "SessionKeyRegistry artifact");

    const profileAbi = readAbi(profileArtifactPath);
    const registryAbi = readAbi(registryArtifactPath);
    const sessionRegistryAbi = readAbi(sessionRegistryArtifactPath);
    const generatedAt = new Date().toISOString();

    const perGameOutputs = [];
    for (const spec of GAME_SPECS) {
        const deploymentPath = path.join(DEPLOYMENTS_DIR, spec.deploymentFile(targetNetwork));
        ensureFile(deploymentPath, `${spec.label} deployment`);
        ensureFile(spec.factoryArtifact, `${spec.label} artifact`);
        ensureFile(spec.instanceArtifact, `${spec.label} instance artifact`);

        const deployment = readJson(deploymentPath);
        const factoryAbi = readAbi(spec.factoryArtifact);
        const instanceAbi = readAbi(spec.instanceArtifact);
        const playerProfile = buildPlayerProfileSection(deployment, profileAbi, registryAbi);
        const sessionAuthorization = buildSessionAuthorizationSection(
            deployment,
            sessionRegistryAbi
        );

        const payload = {
            network: deployment.network,
            chainId: deployment.chainId,
            deployedAt: deployment.timestamp,
            modules: deployment.modules,
            playerProfile,
            sessionAuthorization,
            factory: {
                address: deployment.factory?.[spec.factoryDeploymentKey] ?? null,
                abi: factoryAbi,
            },
            instance: {
                address: deployment.implementation?.[spec.instanceDeploymentKey] ?? null,
                abi: instanceAbi,
            },
        };

        fs.writeFileSync(
            path.join(DEPLOYMENTS_DIR, spec.abiFile),
            JSON.stringify(payload, null, 2)
        );

        perGameOutputs.push({
            label: spec.label,
            deployment,
            playerProfile,
            sessionAuthorization,
            payload,
        });
    }

    const sessionRegistryAddress =
        perGameOutputs[0]?.payload.sessionAuthorization.SessionKeyRegistry
            .address ?? null;
    for (const { label, payload } of perGameOutputs) {
        if (
            payload.sessionAuthorization.SessionKeyRegistry.address !==
            sessionRegistryAddress
        ) {
            throw new Error(
                `${label} does not use the shared SessionKeyRegistry`
            );
        }
    }

    const combined = {
        network: targetNetwork,
        chainId: perGameOutputs[0]?.deployment.chainId ?? null,
        generatedAt,
        playerProfile: {
            PlayerProfileImpl: { abi: profileAbi },
            PlayerRegistry: { abi: registryAbi },
        },
        sessionAuthorization: {
            SessionKeyRegistry: {
                address: sessionRegistryAddress,
                abi: sessionRegistryAbi,
            },
        },
        factories: Object.fromEntries(
            perGameOutputs.map(({ label, payload }) => [
                label,
                {
                    address: payload.factory.address,
                    abi: payload.factory.abi,
                    playerRegistry: payload.playerProfile.PlayerRegistry.address,
                    playerProfileImpl: payload.playerProfile.PlayerProfileImpl.address,
                    sessionRegistry:
                        payload.sessionAuthorization.SessionKeyRegistry.address,
                },
            ])
        ),
        instances: Object.fromEntries(
            perGameOutputs.map(({ label, payload }) => [
                label.replace("Factory", "Instance"),
                {
                    address: payload.instance.address,
                    abi: payload.instance.abi,
                },
            ])
        ),
    };

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "ETour-Factory-ABIs.json"),
        JSON.stringify(combined, null, 2)
    );

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "PlayerProfile-ABI.json"),
        JSON.stringify({
            network: targetNetwork,
            generatedAt,
            contract: {
                abi: profileAbi,
            },
        }, null, 2)
    );

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "PlayerRegistry-ABI.json"),
        JSON.stringify({
            network: targetNetwork,
            generatedAt,
            contract: {
                abi: registryAbi,
            },
            addressesByGame: Object.fromEntries(
                perGameOutputs.map(({ label, payload }) => [
                    label,
                    payload.playerProfile.PlayerRegistry.address,
                ])
            ),
        }, null, 2)
    );

    fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, "SessionKeyRegistry-ABI.json"),
        JSON.stringify({
            network: targetNetwork,
            generatedAt,
            contract: {
                address: sessionRegistryAddress,
                abi: sessionRegistryAbi,
            },
            addressesByGame: Object.fromEntries(
                perGameOutputs.map(({ label, payload }) => [
                    label,
                    payload.sessionAuthorization.SessionKeyRegistry.address,
                ])
            ),
        }, null, 2)
    );

    console.log(`Regenerated V3 ABI files for network: ${targetNetwork}`);
    for (const spec of GAME_SPECS) {
        console.log(`  - ${spec.abiFile}`);
    }
    console.log("  - ETour-Factory-ABIs.json");
    console.log("  - PlayerProfile-ABI.json");
    console.log("  - PlayerRegistry-ABI.json");
    console.log("  - SessionKeyRegistry-ABI.json");
}

main();
