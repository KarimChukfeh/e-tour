import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENTS_DIR = path.resolve(__dirname, "..", "deployments");
const BUILD_INFO_DIR = path.resolve(__dirname, "..", "artifacts", "build-info");
const FRONTEND_ABIS_DIR = path.resolve(__dirname, "..", "..", "..", "tic-tac-react", "src", "v2", "ABIs");
const FILES_TO_SYNC = [
    "TicTacChainFactory-ABI.json",
    "ConnectFourFactory-ABI.json",
    "ChessOnChainFactory-ABI.json",
    "ETour-Factory-ABIs.json",
    "PlayerProfile-ABI.json",
    "PlayerRegistry-ABI.json",
    "localhost-tictac-factory.json",
    "localhost-connectfour-factory.json",
    "localhost-chess-factory.json",
];
const LOCAL_RPC_URL = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const MODULE_SPECS = [
    {
        label: "ETourInstance_Core",
        deploymentKey: "ETourInstance_Core",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "modules", "ETourInstance_Core.sol", "ETourInstance_Core.json"),
        sourceName: "contracts/modules/ETourInstance_Core.sol",
        contractName: "ETourInstance_Core",
    },
    {
        label: "ETourInstance_Matches",
        deploymentKey: "ETourInstance_Matches",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "modules", "ETourInstance_Matches.sol", "ETourInstance_Matches.json"),
        sourceName: "contracts/modules/ETourInstance_Matches.sol",
        contractName: "ETourInstance_Matches",
    },
    {
        label: "ETourInstance_MatchesResolution",
        deploymentKey: "ETourInstance_MatchesResolution",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "modules", "ETourInstance_MatchesResolution.sol", "ETourInstance_MatchesResolution.json"),
        sourceName: "contracts/modules/ETourInstance_MatchesResolution.sol",
        contractName: "ETourInstance_MatchesResolution",
    },
    {
        label: "ETourInstance_Prizes",
        deploymentKey: "ETourInstance_Prizes",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "modules", "ETourInstance_Prizes.sol", "ETourInstance_Prizes.json"),
        sourceName: "contracts/modules/ETourInstance_Prizes.sol",
        contractName: "ETourInstance_Prizes",
    },
    {
        label: "ETourInstance_Escalation",
        deploymentKey: "ETourInstance_Escalation",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "modules", "ETourInstance_Escalation.sol", "ETourInstance_Escalation.json"),
        sourceName: "contracts/modules/ETourInstance_Escalation.sol",
        contractName: "ETourInstance_Escalation",
    },
];
const INSTANCE_SPECS = [
    {
        label: "TicTacInstance",
        deploymentFile: "localhost-tictac-factory.json",
        implementationKey: "TicTacInstance",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "TicTacInstance.sol", "TicTacInstance.json"),
        sourceName: "contracts/TicTacInstance.sol",
        contractName: "TicTacInstance",
    },
    {
        label: "ConnectFourInstance",
        deploymentFile: "localhost-connectfour-factory.json",
        implementationKey: "ConnectFourInstance",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "ConnectFourInstance.sol", "ConnectFourInstance.json"),
        sourceName: "contracts/ConnectFourInstance.sol",
        contractName: "ConnectFourInstance",
    },
    {
        label: "ChessInstance",
        deploymentFile: "localhost-chess-factory.json",
        implementationKey: "ChessInstance",
        artifactPath: path.resolve(__dirname, "..", "artifacts", "contracts", "ChessInstance.sol", "ChessInstance.json"),
        sourceName: "contracts/ChessInstance.sol",
        contractName: "ChessInstance",
    },
];
let immutableReferenceCache = null;

function ensureDirExists(dirPath, label) {
    if (!fs.existsSync(dirPath)) {
        throw new Error(`${label} not found at ${dirPath}`);
    }
}

function zeroImmutableRefs(bytecode, immutableReferences = {}) {
    if (!bytecode || bytecode === "0x") return "0x";

    const chars = bytecode.slice(2).toLowerCase().split("");
    for (const refs of Object.values(immutableReferences)) {
        for (const ref of refs) {
            const start = ref.start * 2;
            const end = start + ref.length * 2;
            for (let i = start; i < end; i++) {
                chars[i] = "0";
            }
        }
    }
    return `0x${chars.join("")}`;
}

function getImmutableReferenceMap() {
    if (immutableReferenceCache) return immutableReferenceCache;

    immutableReferenceCache = new Map();
    for (const fileName of fs.readdirSync(BUILD_INFO_DIR)) {
        const buildInfo = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, fileName), "utf8"));
        for (const [sourceName, contracts] of Object.entries(buildInfo.output.contracts)) {
            for (const [contractName, contractOutput] of Object.entries(contracts)) {
                immutableReferenceCache.set(
                    `${sourceName}:${contractName}`,
                    contractOutput.evm?.deployedBytecode?.immutableReferences ?? {}
                );
            }
        }
    }

    return immutableReferenceCache;
}

function getImmutableReferences(sourceName, contractName) {
    return getImmutableReferenceMap().get(`${sourceName}:${contractName}`) ?? {};
}

async function verifyLocalhostBytecode() {
    const provider = new ethers.JsonRpcProvider(LOCAL_RPC_URL);

    try {
        await provider.getBlockNumber();
    } catch {
        console.log(`Skipping localhost bytecode verification (${LOCAL_RPC_URL} unavailable).`);
        return;
    }

    const mismatches = [];
    const sharedDeploymentPath = path.join(DEPLOYMENTS_DIR, "localhost-factory.json");
    if (fs.existsSync(sharedDeploymentPath)) {
        const sharedDeployment = JSON.parse(fs.readFileSync(sharedDeploymentPath, "utf8"));
        for (const spec of MODULE_SPECS) {
            if (!fs.existsSync(spec.artifactPath)) continue;

            const address = sharedDeployment.modules?.[spec.deploymentKey];
            if (!address) continue;

            const artifact = JSON.parse(fs.readFileSync(spec.artifactPath, "utf8"));
            const immutableReferences = getImmutableReferences(spec.sourceName, spec.contractName);
            const onChainCode = zeroImmutableRefs(await provider.getCode(address), immutableReferences);
            const artifactCode = zeroImmutableRefs(artifact.deployedBytecode, immutableReferences);

            if (onChainCode === "0x") {
                mismatches.push(`${spec.label}: missing code at ${address}`);
                continue;
            }

            if (onChainCode !== artifactCode) {
                mismatches.push(`${spec.label}: bytecode drift at ${address}`);
            }
        }
    }

    for (const spec of INSTANCE_SPECS) {
        const deploymentPath = path.join(DEPLOYMENTS_DIR, spec.deploymentFile);
        if (!fs.existsSync(deploymentPath) || !fs.existsSync(spec.artifactPath)) continue;

        const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
        const artifact = JSON.parse(fs.readFileSync(spec.artifactPath, "utf8"));
        const immutableReferences = getImmutableReferences(spec.sourceName, spec.contractName);

        const implementationAddress = deployment.implementation?.[spec.implementationKey];
        if (!implementationAddress) continue;

        const onChainImplementationCode = zeroImmutableRefs(
            await provider.getCode(implementationAddress),
            immutableReferences
        );
        const artifactCode = zeroImmutableRefs(artifact.deployedBytecode, immutableReferences);
        if (onChainImplementationCode === "0x") {
            mismatches.push(`${spec.label}: missing code at ${implementationAddress}`);
            continue;
        }

        if (onChainImplementationCode !== artifactCode) {
            mismatches.push(`${spec.label}: implementation bytecode drift at ${implementationAddress}`);
        }
    }

    if (mismatches.length > 0) {
        throw new Error(
            [
                "Refusing to sync localhost ABI files because the running node does not match the current build artifacts.",
                ...mismatches.map((mismatch) => `- ${mismatch}`),
                "Reset/redeploy localhost and rerun the sync.",
            ].join("\n")
        );
    }
}

async function main() {
    ensureDirExists(DEPLOYMENTS_DIR, "Deployments directory");
    ensureDirExists(FRONTEND_ABIS_DIR, "Frontend ABI directory");
    await verifyLocalhostBytecode();

    let copied = 0;
    let skipped = 0;

    for (const fileName of FILES_TO_SYNC) {
        const sourcePath = path.join(DEPLOYMENTS_DIR, fileName);
        const destPath = path.join(FRONTEND_ABIS_DIR, fileName);

        if (!fs.existsSync(sourcePath)) {
            console.log(`Skipping missing file: ${fileName}`);
            skipped += 1;
            continue;
        }

        fs.copyFileSync(sourcePath, destPath);
        console.log(`Copied ${fileName}`);
        copied += 1;
    }

    console.log("");
    console.log(`V2 ABI sync complete: ${copied} copied, ${skipped} skipped.`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
