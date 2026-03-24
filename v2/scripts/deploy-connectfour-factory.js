// scripts/deploy-connectfour-factory.js
// Deploy ConnectFourFactory (+ instance modules if not already deployed).
//
// Usage:
//   npx hardhat run scripts/deploy-connectfour-factory.js --network localhost
//   npx hardhat run scripts/deploy-connectfour-factory.js --network arbitrum
//   npx hardhat run scripts/deploy-connectfour-factory.js --network localhost --force

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
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("Network: ", network, `(chainId: ${chainId})`);
    if (force) console.log("Mode:     FORCE (redeploying modules)");
    console.log("");

    // ── 1. Instance Modules ──────────────────────────────────────────────────
    const modules = await getOrDeployInstanceModules(force);

    // ── 2. ConnectFourFactory ────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("Deploying ConnectFourFactory...");
    console.log("=".repeat(60));
    const C4Factory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
    const factory = await C4Factory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation
    );
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const implAddr    = await factory.implementation();
    console.log("✅ ConnectFourFactory deployed to:", factoryAddr);
    console.log("   ConnectFourInstance implementation:", implAddr);
    console.log("");

    // ── 3. Save artifacts ────────────────────────────────────────────────────
    if (!fs.existsSync(DEPLOYMENTS_DIR)) fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

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
        },
        factory: {
            ConnectFourFactory: factoryAddr,
        },
        implementation: {
            ConnectFourInstance: implAddr,
        },
    };

    const deployFile = path.join(DEPLOYMENTS_DIR, `${network}-connectfour-factory.json`);
    fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));
    console.log("💾 Deployment saved to:", deployFile);

    // ABI file with addresses — drop-in for frontend
    const [factoryArt, instanceArt] = await Promise.all([
        hre.artifacts.readArtifact("contracts/ConnectFourFactory.sol:ConnectFourFactory"),
        hre.artifacts.readArtifact("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
    ]);

    const abiFile = path.join(DEPLOYMENTS_DIR, "ConnectFourFactory-ABI.json");
    fs.writeFileSync(abiFile, JSON.stringify({
        network,
        chainId: chainId.toString(),
        deployedAt: timestamp,
        modules: deployment.modules,
        factory:  { address: factoryAddr, abi: factoryArt.abi },
        instance: { address: implAddr,    abi: instanceArt.abi },
    }, null, 2));
    console.log("💾 ABI file saved to:", abiFile);
    console.log("");

    // ── 4. Summary ───────────────────────────────────────────────────────────
    console.log("=".repeat(60));
    console.log("🎉 DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("");
    console.log("Network:", network, "| Block:", blockNumber);
    console.log("");
    console.log("📍 Instance Modules:");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("");
    console.log("📍 Factory:");
    console.log("  ConnectFourFactory:        ", factoryAddr);
    console.log("  ConnectFourInstance impl:  ", implAddr);
    console.log("");
    console.log("📁 Artifacts:");
    console.log("  -", deployFile);
    console.log("  -", abiFile);
    console.log("");
    console.log("🔗 Next step: factory.createInstance(playerCount, entryFee, timeouts)");
    console.log("");
    console.log("=".repeat(60));
    console.log("Verification Commands:");
    console.log("=".repeat(60));
    const n = network;
    console.log(`npx hardhat verify --network ${n} ${modules.core}`);
    console.log(`npx hardhat verify --network ${n} ${modules.matches}`);
    console.log(`npx hardhat verify --network ${n} ${modules.prizes}`);
    console.log(`npx hardhat verify --network ${n} ${modules.escalation}`);
    console.log(`npx hardhat verify --network ${n} ${factoryAddr} "${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}"`);
    console.log("");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("❌ Deployment failed:", err);
        process.exit(1);
    });
