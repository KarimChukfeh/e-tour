// scripts/deploy-instance-modules.js
// Deploy the four ETourInstance modules shared by all factory-pattern game contracts.
// Replaces the old ETour_Core/Matches/Prizes/Escalation modules for the new architecture.

import hre from "hardhat";
import fs from "fs";
import path from "path";

const DEPLOYMENT_FILE = "./v2/deployments/instance-modules.json";

export function loadExistingInstanceModules() {
    if (fs.existsSync(DEPLOYMENT_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
        if (data.network === hre.network.name) {
            return data.modules;
        }
    }
    return null;
}

export function saveInstanceModules(modules) {
    const dir = "./v2/deployments";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify({
        network: hre.network.name,
        chainId: null,
        timestamp: new Date().toISOString(),
        modules,
    }, null, 2));
    console.log("💾 Instance module addresses saved to:", DEPLOYMENT_FILE);
}

export async function getOrDeployInstanceModules(forceDeploy = false) {
    if (!forceDeploy) {
        const existing = loadExistingInstanceModules();
        if (existing) {
            console.log("📦 Reusing existing instance module deployment for:", hre.network.name);
            console.log("  ETourInstance_Core:      ", existing.core);
            console.log("  ETourInstance_Matches:   ", existing.matches);
            console.log("  ETourInstance_Prizes:    ", existing.prizes);
            console.log("  ETourInstance_Escalation:", existing.escalation);
            console.log("");
            return existing;
        }
    }

    const modules = await deployInstanceModules();
    saveInstanceModules(modules);
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

    console.log("Deploying ETourInstance_Matches...");
    const Matches = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
    );
    const matches = await Matches.deploy();
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
    console.log("✅ All 4 instance modules deployed.");
    console.log("");

    return {
        core: coreAddr,
        matches: matchesAddr,
        prizes: prizesAddr,
        escalation: escalationAddr,
    };
}

// ── Standalone entrypoint ─────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
    const force = process.argv.includes("--force");

    getOrDeployInstanceModules(force)
        .then((addrs) => {
            console.log("=".repeat(60));
            console.log("Instance Module Addresses:");
            console.log("=".repeat(60));
            console.log("ETourInstance_Core:      ", addrs.core);
            console.log("ETourInstance_Matches:   ", addrs.matches);
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
