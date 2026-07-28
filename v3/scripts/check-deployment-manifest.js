import fs from "fs";
import path from "path";
import { isAddress } from "ethers";
import {
    assertDeploymentTarget,
    canonicalManifestPath,
    networkDeploymentDirectory,
} from "./lib/deployment-output.js";

const deploymentsDirectory = path.join(
    process.cwd(),
    "deployments"
);
const network = parseNetwork(process.argv.slice(2));
const file = canonicalManifestPath(
    deploymentsDirectory,
    network
);

assert(fs.existsSync(file), `missing canonical manifest ${file}`);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const normalizedChainId = assertDeploymentTarget(
    network,
    manifest.chainId
);

assert(manifest.schemaVersion === 2, "schemaVersion must be 2");
assert(
    manifest.manifestKind === "complete-v3-deployment",
    "manifestKind must identify a complete V3 deployment"
);
assert(manifest.generation === "v3", "generation must be v3");
assert(manifest.network === network, "manifest network mismatch");
assert(
    manifest.chainId === normalizedChainId,
    "manifest chain ID must be normalized"
);
assert(
    /^[0-9a-f]{40}$/u.test(manifest.source?.commit ?? ""),
    "source.commit must be a full lowercase git commit"
);
assert(
    typeof manifest.source?.dirty === "boolean",
    "source.dirty must be a boolean"
);
assertCompiler(manifest.compilers?.protocol, "protocol compiler");
assertCompiler(manifest.compiler, "legacy compiler metadata");
assert(
    manifest.entryPoint?.version === "0.8",
    "EntryPoint version must be 0.8"
);

const expectedContracts = {
    EntryPoint: manifest.entryPoint?.address,
    SimpleAccountImplementation:
        manifest.accountAbstraction?.simpleAccountImplementation,
    SimpleAccountFactory:
        manifest.accountAbstraction?.officialSimpleAccountFactory,
    ETourInstance_Core:
        manifest.modules?.ETourInstance_Core,
    ETourInstance_Matches:
        manifest.modules?.ETourInstance_Matches,
    ETourInstance_Prizes:
        manifest.modules?.ETourInstance_Prizes,
    ETourInstance_Escalation:
        manifest.modules?.ETourInstance_Escalation,
    ChessRulesModule:
        manifest.modules?.ChessRulesModule,
    PlayerProfile:
        manifest.playerProfile?.PlayerProfileImpl,
    PlayerRegistry:
        manifest.playerProfile?.PlayerRegistry,
    SessionKeyRegistry:
        manifest.sessionAuthorization?.SessionKeyRegistry,
    ETourSessionAccount: null,
    ETourSessionAccountFactory:
        manifest.accountAbstraction?.sessionAccountFactory,
    ETourSessionPaymaster:
        manifest.accountAbstraction?.sessionPaymaster,
    TicTacChainFactory:
        manifest.factories?.TicTacChainFactory,
    ConnectFourFactory:
        manifest.factories?.ConnectFourFactory,
    ChessOnChainFactory:
        manifest.factories?.ChessOnChainFactory,
    TicTacInstance:
        manifest.implementations?.TicTacInstance,
    ConnectFourInstance:
        manifest.implementations?.ConnectFourInstance,
    ChessInstance:
        manifest.implementations?.ChessInstance,
};

assert(
    manifest.abiPolicy?.embedded === true,
    "manifest must embed contract ABIs"
);
assert(
    manifest.abiPolicy?.contractCount ===
        Object.keys(expectedContracts).length,
    "abiPolicy.contractCount mismatch"
);
assert(
    Object.keys(manifest.contracts ?? {}).length ===
        Object.keys(expectedContracts).length,
    "contracts map is incomplete"
);

for (const [name, expectedAddress] of Object.entries(
    expectedContracts
)) {
    const record = manifest.contracts?.[name];
    assert(record, `missing contracts.${name}`);
    assert(
        Array.isArray(record.abi) && record.abi.length > 0,
        `${name} must contain a non-empty ABI`
    );
    assert(
        typeof record.sourceName === "string" &&
            record.sourceName.endsWith(".sol"),
        `${name} sourceName is missing`
    );
    assertHash(record.creationBytecodeHash, `${name} creation hash`);
    assertHash(record.deployedBytecodeHash, `${name} runtime hash`);
    if (expectedAddress === null) {
        assert(
            record.address === null,
            `${name} must be marked counterfactual`
        );
    } else {
        assert(
            isAddress(expectedAddress),
            `${name} expected address is invalid`
        );
        assert(
            record.address?.toLowerCase() ===
                expectedAddress.toLowerCase(),
            `${name} address disagrees with the deployment summary`
        );
    }
}

assert(
    manifest.entryPoint.address.toLowerCase() ===
        manifest.accountAbstraction.entryPoint.toLowerCase(),
    "EntryPoint address fields disagree"
);
assert(
    manifest.accountAbstraction.senderCreator.toLowerCase() ===
        manifest.entryPoint.senderCreator.toLowerCase(),
    "SenderCreator address fields disagree"
);
assert(
    /^\d+$/u.test(
        manifest.sessionAuthorization?.ttlSeconds ?? ""
    ),
    "session TTL must be recorded in seconds"
);
assert(
    /^\d+$/u.test(
        manifest.accountAbstraction?.paymasterDeposit ?? ""
    ),
    "paymaster deposit must be recorded in wei"
);

const networkDirectory = networkDeploymentDirectory(
    deploymentsDirectory,
    network
);
const outputFiles = fs.readdirSync(networkDirectory);
assert(
    !outputFiles.some((name) => name.endsWith(".tmp")),
    "incomplete atomic-write temporary files remain"
);
for (const name of outputFiles.filter((item) =>
    item.endsWith(".json")
)) {
    const output = JSON.parse(
        fs.readFileSync(
            path.join(networkDirectory, name),
            "utf8"
        )
    );
    if (output.network !== undefined) {
        assert(
            output.network === network,
            `${name} belongs to ${output.network}, not ${network}`
        );
    }
    if (output.chainId !== undefined) {
        assert(
            BigInt(output.chainId).toString() ===
                normalizedChainId,
            `${name} chain ID mismatch`
        );
    }
}

console.log(
    `Deployment manifest valid: ${file} ` +
        `(${Object.keys(expectedContracts).length} contracts, ` +
        `${outputFiles.length} network-scoped outputs)`
);

function parseNetwork(argv) {
    let value = process.env.DEPLOYMENT_NETWORK ?? "localhost";
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === "--network" && argv[index + 1]) {
            value = argv[++index];
        } else {
            throw new Error(
                `unknown or incomplete argument ${argv[index]}`
            );
        }
    }
    return value;
}

function assertCompiler(value, label) {
    assert(
        /^\d+\.\d+\.\d+/u.test(value?.version ?? ""),
        `${label} version is missing`
    );
    assert(
        typeof value?.settings?.optimizer?.enabled ===
            "boolean",
        `${label} optimizer settings are missing`
    );
    assert(
        Number.isInteger(
            value?.settings?.optimizer?.runs
        ),
        `${label} optimizer runs are missing`
    );
    assert(
        typeof value?.settings?.viaIR === "boolean",
        `${label} viaIR setting is missing`
    );
}

function assertHash(value, label) {
    assert(
        value === null ||
            /^0x[0-9a-fA-F]{64}$/u.test(value),
        `${label} is invalid`
    );
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
