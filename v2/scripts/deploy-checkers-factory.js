import hre from "hardhat";
import fs from "fs";
import path from "path";

function normalizeModules(raw) {
    if (!raw) return null;

    if (raw.core && raw.matches && raw.prizes && raw.escalation) {
        return {
            core: raw.core,
            matches: raw.matches,
            prizes: raw.prizes,
            escalation: raw.escalation,
        };
    }

    if (
        raw.ETourInstance_Core &&
        raw.ETourInstance_Matches &&
        raw.ETourInstance_Prizes &&
        raw.ETourInstance_Escalation
    ) {
        return {
            core: raw.ETourInstance_Core,
            matches: raw.ETourInstance_Matches,
            prizes: raw.ETourInstance_Prizes,
            escalation: raw.ETourInstance_Escalation,
        };
    }

    return null;
}

function loadDeploymentJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveSharedModules(network) {
    const fromEnv = normalizeModules({
        core: process.env.MODULE_CORE,
        matches: process.env.MODULE_MATCHES,
        prizes: process.env.MODULE_PRIZES,
        escalation: process.env.MODULE_ESCALATION,
    });
    if (fromEnv) return fromEnv;

    const candidates = [
        path.join("./v2/deployments", `${network}-factory.json`),
        path.join("./v2/deployments", "instance-modules.json"),
    ];

    for (const candidate of candidates) {
        const deployment = loadDeploymentJson(candidate);
        if (deployment?.network && deployment.network !== network) continue;
        const modules = normalizeModules(deployment?.modules);
        if (modules) return modules;
    }

    throw new Error(
        "Unable to resolve shared ETour module addresses. " +
        "Set MODULE_CORE, MODULE_MATCHES, MODULE_PRIZES, MODULE_ESCALATION " +
        "or provide a deployment manifest in v2/deployments."
    );
}

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const { chainId } = await hre.ethers.provider.getNetwork();
    const modules = resolveSharedModules(network);

    console.log("=".repeat(60));
    console.log("Deploying Checkers Reference Stack");
    console.log("=".repeat(60));
    console.log("Network: ", network, `(chainId: ${chainId})`);
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
    console.log("");
    console.log("Using shared ETour modules:");
    console.log("  ETourInstance_Core:      ", modules.core);
    console.log("  ETourInstance_Matches:   ", modules.matches);
    console.log("  ETourInstance_Prizes:    ", modules.prizes);
    console.log("  ETourInstance_Escalation:", modules.escalation);
    console.log("");

    const PlayerProfile = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await PlayerProfile.deploy();
    await profileImpl.waitForDeployment();
    const profileImplAddr = await profileImpl.getAddress();

    const PlayerRegistry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await PlayerRegistry.deploy(profileImplAddr);
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();

    const CheckersFactory = await hre.ethers.getContractFactory("contracts/CheckersFactory.sol:CheckersFactory");
    const factory = await CheckersFactory.deploy(
        modules.core,
        modules.matches,
        modules.prizes,
        modules.escalation,
        registryAddr
    );
    await factory.waitForDeployment();

    const factoryAddr = await factory.getAddress();
    const implementationAddr = await factory.implementation();

    await (await registry.authorizeFactory(factoryAddr)).wait();

    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const timestamp = new Date().toISOString();
    const deploymentsDir = "./v2/deployments";
    if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

    const deployment = {
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
        factory: {
            CheckersFactory: factoryAddr,
        },
        implementation: {
            Checkers: implementationAddr,
        },
    };

    const outputPath = path.join(deploymentsDir, `${network}-checkers-factory.json`);
    fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

    const [factoryArtifact, instanceArtifact, profileArtifact, registryArtifact] = await Promise.all([
        hre.artifacts.readArtifact("contracts/CheckersFactory.sol:CheckersFactory"),
        hre.artifacts.readArtifact("contracts/Checkers.sol:Checkers"),
        hre.artifacts.readArtifact("contracts/PlayerProfile.sol:PlayerProfile"),
        hre.artifacts.readArtifact("contracts/PlayerRegistry.sol:PlayerRegistry"),
    ]);

    const abiBundlePath = path.join(deploymentsDir, "CheckersFactory-ABI.json");
    fs.writeFileSync(abiBundlePath, JSON.stringify({
        network,
        chainId: chainId.toString(),
        generatedAt: timestamp,
        modules: deployment.modules,
        playerProfile: {
            PlayerProfileImpl: { address: profileImplAddr, abi: profileArtifact.abi },
            PlayerRegistry: { address: registryAddr, abi: registryArtifact.abi },
        },
        factory: {
            CheckersFactory: { address: factoryAddr, abi: factoryArtifact.abi },
        },
        instance: {
            Checkers: { address: implementationAddr, abi: instanceArtifact.abi },
        },
    }, null, 2));

    console.log("Deployed contracts:");
    console.log("  PlayerProfile impl:", profileImplAddr);
    console.log("  PlayerRegistry:    ", registryAddr);
    console.log("  CheckersFactory:   ", factoryAddr);
    console.log("  Checkers impl:     ", implementationAddr);
    console.log("");
    console.log("Deployment saved to:", outputPath);
    console.log("ABI bundle saved to:", abiBundlePath);
    console.log("");
    console.log("Verification command:");
    console.log(
        `npx hardhat verify --network ${network} ${factoryAddr} ` +
        `"${modules.core}" "${modules.matches}" "${modules.prizes}" "${modules.escalation}" "${registryAddr}"`
    );
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Checkers deployment failed:", err);
        process.exit(1);
    });
