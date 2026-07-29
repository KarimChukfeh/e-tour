import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { keccak256 } from "ethers";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const output = path.join(
    root,
    "deployments",
    "arbitrumOne-release-template.json"
);
const aa = JSON.parse(
    fs.readFileSync(path.join(root, "config", "account-abstraction.json"), "utf8")
);

const contracts = [
    ["ETourInstance_Core", "contracts/modules/ETourInstance_Core.sol"],
    ["ETourInstance_Matches", "contracts/modules/ETourInstance_Matches.sol"],
    ["ETourInstance_Prizes", "contracts/modules/ETourInstance_Prizes.sol"],
    ["ETourInstance_Escalation", "contracts/modules/ETourInstance_Escalation.sol"],
    ["ChessRulesModule", "contracts/modules/ChessRulesModule.sol"],
    ["PlayerProfile", "contracts/PlayerProfile.sol"],
    ["PlayerRegistry", "contracts/PlayerRegistry.sol"],
    ["SessionKeyRegistry", "contracts/SessionKeyRegistry.sol"],
    ["ETourSessionAccount", "contracts/account-abstraction/ETourSessionAccount.sol"],
    ["ETourSessionAccountFactory", "contracts/account-abstraction/ETourSessionAccountFactory.sol"],
    ["ETourSessionPaymaster", "contracts/account-abstraction/ETourSessionPaymaster.sol"],
    ["TicTacInstance", "contracts/TicTacInstance.sol"],
    ["ConnectFourInstance", "contracts/ConnectFourInstance.sol"],
    ["ChessInstance", "contracts/ChessInstance.sol"],
    ["TicTacChainFactory", "contracts/TicTacChainFactory.sol"],
    ["ConnectFourFactory", "contracts/ConnectFourFactory.sol"],
    ["ChessOnChainFactory", "contracts/ChessOnChainFactory.sol"],
];

const records = {};
for (const [name, sourceName] of contracts) {
    const artifactPath = path.join(root, "artifacts", sourceName, `${name}.json`);
    assert(fs.existsSync(artifactPath), `missing artifact ${artifactPath}; compile first`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    records[name] = {
        sourceName,
        address: null,
        verified: false,
        creationBytecodeKeccak256: hashBytecode(artifact.bytecode),
        deployedBytecodeKeccak256: hashBytecode(artifact.deployedBytecode),
        abiSha256: crypto
            .createHash("sha256")
            .update(`${JSON.stringify(artifact.abi)}\n`)
            .digest("hex"),
    };
}

const source = gitState();
const template = {
    schemaVersion: 1,
    manifestKind: "arbitrum-one-v3-release-template",
    generatedAt: new Date().toISOString(),
    generation: "v3",
    network: "arbitrumOne",
    chainId: "42161",
    source,
    entryPoint: {
        version: aa.entryPoint.release,
        address: aa.entryPoint.networks.arbitrumOne.address,
    },
    releaseGates: {
        externalAuditReport: null,
        externalAuditReportSha256: null,
        unresolvedCritical: null,
        unresolvedHigh: null,
        freezeFile: "baselines/release-freeze.json",
        securityRegister: "baselines/internal-security-review.json",
    },
    roleInputs: {
        deployer: "DEPLOYER_ADDRESS",
        protocolOwner: "PROTOCOL_OWNER_ADDRESS",
        paymasterOwner: "PAYMASTER_OWNER_ADDRESS",
        paymasterFundingWallet: "PAYMASTER_FUNDING_ADDRESS",
    },
    canaryInputs: {
        paymasterDepositWei: "PAYMASTER_DEPOSIT_WEI",
        lowBalanceThresholdWei: "PAYMASTER_ALERT_THRESHOLD_WEI",
        primaryBundler: "PIMLICO_API_KEY",
        failoverBundler: "ALCHEMY_API_KEY",
        explorerVerification: "ARBISCAN_API_KEY",
    },
    expectedContracts: records,
    deploymentManifest: "deployments/arbitrumOne/manifest.json",
    addressBook: "deployments/arbitrumOne/address-book.json",
    verificationCommand:
        "npm run deployment:verify:arbitrum",
    postDeploymentGates: [
        "validate canonical manifest and runtime bytecode",
        "verify every contract on Arbiscan",
        "publish checksummed address book and ABI checksums",
        "enable monitoring before funding the capped canary deposit",
        "complete all three game canaries, recovery, failover, and direct fallback",
        "obtain explicit cutover approval"
    ]
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(template, null, 2)}\n`);
console.log(
    `Prepared Arbitrum One release template for ${contracts.length} V3 contracts: ${output}`
);

function hashBytecode(bytecode) {
    assert(/^0x[0-9a-fA-F]*$/u.test(bytecode), "artifact bytecode is invalid");
    return keccak256(bytecode);
}

function gitState() {
    try {
        const commit = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
        }).trim();
        const status = execFileSync("git", ["status", "--porcelain", "--", "v3"], {
            cwd: path.resolve(root, ".."),
            encoding: "utf8",
        }).trim();
        return { commit, dirty: status.length > 0 };
    } catch {
        return { commit: null, dirty: true };
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(`Production release preparation failed: ${message}`);
}
