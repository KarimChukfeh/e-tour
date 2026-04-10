// scripts/deploy-instance-modules.js
// Deploy the four ETourInstance modules shared by all factory-pattern game contracts.
// Replaces the old ETour_Core/Matches/Prizes/Escalation modules for the new architecture.

import hre from "hardhat";
import fs from "fs";
import path from "path";

const DEPLOYMENT_FILE = "./v2/deployments/instance-modules.json";
const MODULE_ARTIFACTS = {
    core: "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core",
    matches: "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches",
    matchesResolution: "contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution",
    prizes: "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes",
    escalation: "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation",
};

function normalizeBytecode(bytecode) {
    return typeof bytecode === "string" ? bytecode.toLowerCase() : "0x";
}

function zeroImmutableRefs(bytecode, immutableReferences = {}) {
    if (!bytecode || bytecode === "0x") return "0x";

    const chars = bytecode.slice(2).split("");
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

async function getImmutableReferences(fqName) {
    const [sourceName, contractName] = fqName.split(":");
    const buildInfo = await hre.artifacts.getBuildInfo(fqName);
    return buildInfo?.output?.contracts?.[sourceName]?.[contractName]?.evm?.deployedBytecode?.immutableReferences ?? {};
}

async function getCurrentArtifactHashes() {
    const entries = await Promise.all(
        Object.entries(MODULE_ARTIFACTS).map(async ([key, fqName]) => {
            const artifact = await hre.artifacts.readArtifact(fqName);
            const immutableReferences = await getImmutableReferences(fqName);
            const artifactBytecode = zeroImmutableRefs(
                normalizeBytecode(artifact.deployedBytecode),
                immutableReferences
            );
            return [key, hre.ethers.keccak256(artifactBytecode)];
        })
    );

    return Object.fromEntries(entries);
}

async function getOnchainCodeHashes(modules) {
    const entries = await Promise.all(
        Object.entries(modules).map(async ([key, address]) => {
            const fqName = MODULE_ARTIFACTS[key];
            const immutableReferences = await getImmutableReferences(fqName);
            const onchainCode = zeroImmutableRefs(
                normalizeBytecode(await hre.ethers.provider.getCode(address)),
                immutableReferences
            );
            return [key, onchainCode === "0x" ? null : hre.ethers.keccak256(onchainCode)];
        })
    );

    return Object.fromEntries(entries);
}

async function validateExistingInstanceModules(deployment) {
    if (!deployment?.modules) return { ok: false, reason: "Missing module deployment metadata." };
    if (!deployment.artifactHashes || !deployment.codeHashes) {
        return { ok: false, reason: "Cached module deployment is missing artifact/code fingerprints." };
    }

    const currentArtifactHashes = await getCurrentArtifactHashes();
    const { chainId } = await hre.ethers.provider.getNetwork();
    const expectedChainId = chainId.toString();

    if (deployment.chainId && deployment.chainId !== expectedChainId) {
        return {
            ok: false,
            reason: `Cached chainId ${deployment.chainId} does not match current chainId ${expectedChainId}.`,
        };
    }

    for (const [key, address] of Object.entries(deployment.modules)) {
        if (!address) {
            return { ok: false, reason: `Cached module '${key}' is missing an address.` };
        }

        const immutableReferences = await getImmutableReferences(MODULE_ARTIFACTS[key]);
        const onchainCode = zeroImmutableRefs(
            normalizeBytecode(await hre.ethers.provider.getCode(address)),
            immutableReferences
        );
        if (onchainCode === "0x") {
            return { ok: false, reason: `No contract code found for cached module '${key}' at ${address}.` };
        }

        const currentCodeHash = hre.ethers.keccak256(onchainCode);
        if (deployment.codeHashes?.[key] && deployment.codeHashes[key] !== currentCodeHash) {
            return {
                ok: false,
                reason: `Cached module '${key}' at ${address} does not match the last deployed on-chain code hash.`,
            };
        }

        if (deployment.artifactHashes?.[key] && deployment.artifactHashes[key] !== currentArtifactHashes[key]) {
            return {
                ok: false,
                reason: `Cached module '${key}' at ${address} does not match the current artifact fingerprint.`,
            };
        }
    }

    return { ok: true };
}

export function loadExistingInstanceModuleDeployment() {
    if (fs.existsSync(DEPLOYMENT_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
        if (data.network === hre.network.name) {
            return data;
        }
    }
    return null;
}

export function loadExistingInstanceModules() {
    return loadExistingInstanceModuleDeployment()?.modules ?? null;
}

export function saveInstanceModules(modules, chainId, artifactHashes, codeHashes) {
    const dir = "./v2/deployments";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify({
        network: hre.network.name,
        chainId,
        timestamp: new Date().toISOString(),
        modules,
        artifactHashes,
        codeHashes,
    }, null, 2));
    console.log("💾 Instance module addresses saved to:", DEPLOYMENT_FILE);
}

export async function getOrDeployInstanceModules(forceDeploy = false) {
    if (!forceDeploy) {
        const deployment = loadExistingInstanceModuleDeployment();
        if (deployment?.modules) {
            const validation = await validateExistingInstanceModules(deployment);
            if (validation.ok) {
                const existing = deployment.modules;
                console.log("📦 Reusing existing instance module deployment for:", hre.network.name);
                console.log("  ETourInstance_Core:      ", existing.core);
                console.log("  ETourInstance_Matches:   ", existing.matches);
                console.log("  ETourInstance_MatchesResolution:", existing.matchesResolution);
                console.log("  ETourInstance_Prizes:    ", existing.prizes);
                console.log("  ETourInstance_Escalation:", existing.escalation);
                console.log("");
                return existing;
            }

            console.log("⚠️ Cached instance modules are stale or incompatible.");
            console.log("  Reason:", validation.reason);
            console.log("  Redeploying fresh instance modules...");
            console.log("");
        }
    }

    const modules = await deployInstanceModules();
    const { chainId } = await hre.ethers.provider.getNetwork();
    const [artifactHashes, codeHashes] = await Promise.all([
        getCurrentArtifactHashes(),
        getOnchainCodeHashes(modules),
    ]);
    saveInstanceModules(modules, chainId.toString(), artifactHashes, codeHashes);
    return modules;
}

export async function deployInstanceModules() {
    console.log("=".repeat(60));
    console.log("Deploying ETourInstance Modules (factory/instance arch)...");
    console.log("=".repeat(60));

    console.log("Deploying ETourInstance_Core...");
    const Core = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
    );
    const core = await Core.deploy();
    await core.waitForDeployment();
    const coreAddr = await core.getAddress();
    console.log("✅ ETourInstance_Core deployed to:", coreAddr);

    console.log("Deploying ETourInstance_MatchesResolution...");
    const MatchesResolution = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution"
    );
    const matchesResolution = await MatchesResolution.deploy();
    await matchesResolution.waitForDeployment();
    const matchesResolutionAddr = await matchesResolution.getAddress();
    console.log("✅ ETourInstance_MatchesResolution deployed to:", matchesResolutionAddr);

    console.log("Deploying ETourInstance_Matches...");
    const Matches = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
    );
    const matches = await Matches.deploy(matchesResolutionAddr);
    await matches.waitForDeployment();
    const matchesAddr = await matches.getAddress();
    console.log("✅ ETourInstance_Matches deployed to:", matchesAddr);

    console.log("Deploying ETourInstance_Prizes...");
    const Prizes = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"
    );
    const prizes = await Prizes.deploy();
    await prizes.waitForDeployment();
    const prizesAddr = await prizes.getAddress();
    console.log("✅ ETourInstance_Prizes deployed to:", prizesAddr);

    console.log("Deploying ETourInstance_Escalation...");
    const Escalation = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"
    );
    const escalation = await Escalation.deploy();
    await escalation.waitForDeployment();
    const escalationAddr = await escalation.getAddress();
    console.log("✅ ETourInstance_Escalation deployed to:", escalationAddr);

    console.log("");
    console.log("✅ All 5 instance modules deployed.");
    console.log("");

    return {
        core: coreAddr,
        matches: matchesAddr,
        matchesResolution: matchesResolutionAddr,
        prizes: prizesAddr,
        escalation: escalationAddr,
    };
}

// ── Standalone entrypoint ─────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
    const force = process.env.FORCE === "1" || process.argv.includes("--force");

    getOrDeployInstanceModules(force)
        .then((addrs) => {
            console.log("=".repeat(60));
            console.log("Instance Module Addresses:");
            console.log("=".repeat(60));
            console.log("ETourInstance_Core:      ", addrs.core);
            console.log("ETourInstance_Matches:   ", addrs.matches);
            console.log("ETourInstance_MatchesResolution:", addrs.matchesResolution);
            console.log("ETourInstance_Prizes:    ", addrs.prizes);
            console.log("ETourInstance_Escalation:", addrs.escalation);
            if (force) console.log("\n⚠️  Forced new deployment (--force flag used)");
            else console.log("\n💡 To force new deployment: node scripts/deploy-instance-modules.js --force");
            process.exit(0);
        })
        .catch((err) => {
            console.error("❌ Instance module deployment failed:", err);
            process.exit(1);
        });
}
