import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Interface } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(V3_DIR, "config", "instance-state-changing-selectors.json");

const TARGETS = {
    TicTacInstance: path.join(
        V3_DIR,
        "artifacts",
        "contracts",
        "TicTacInstance.sol",
        "TicTacInstance.json"
    ),
    ConnectFourInstance: path.join(
        V3_DIR,
        "artifacts",
        "contracts",
        "ConnectFourInstance.sol",
        "ConnectFourInstance.json"
    ),
    ChessInstance: path.join(
        V3_DIR,
        "artifacts",
        "contracts",
        "ChessInstance.sol",
        "ChessInstance.json"
    ),
};

function fail(message) {
    console.error(`Instance selector check failed: ${message}`);
    process.exit(1);
}

function sortedContracts(contracts) {
    return [...contracts].sort((left, right) => left.localeCompare(right));
}

function collectActual() {
    const selectors = new Map();

    for (const [contractName, artifactPath] of Object.entries(TARGETS)) {
        if (!fs.existsSync(artifactPath)) {
            fail(`missing ${artifactPath}; run npm run compile first`);
        }

        const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
        const contractInterface = new Interface(artifact.abi);
        contractInterface.forEachFunction((fragment) => {
            if (fragment.stateMutability === "view" || fragment.stateMutability === "pure") {
                return;
            }

            const signature = fragment.format("sighash");
            const current = selectors.get(signature) || {
                signature,
                selector: fragment.selector,
                stateMutability: fragment.stateMutability,
                contracts: [],
            };

            if (
                current.selector !== fragment.selector ||
                current.stateMutability !== fragment.stateMutability
            ) {
                fail(`inconsistent selector or mutability for ${signature}`);
            }

            current.contracts.push(contractName);
            selectors.set(signature, current);
        });
    }

    return [...selectors.values()]
        .map((entry) => ({ ...entry, contracts: sortedContracts(entry.contracts) }))
        .sort((left, right) => left.signature.localeCompare(right.signature));
}

if (!fs.existsSync(CONFIG_PATH)) {
    fail(`missing reviewed allowlist ${CONFIG_PATH}`);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
if (config.schemaVersion !== 1 || !Array.isArray(config.selectors)) {
    fail("unsupported or malformed allowlist schema");
}

const expectedTargets = sortedContracts(Object.keys(TARGETS));
if (JSON.stringify(sortedContracts(config.contracts || [])) !== JSON.stringify(expectedTargets)) {
    fail("allowlisted contract set does not match the enforced instance targets");
}

const allowed = config.selectors.map((entry) => {
    if (
        !entry.signature ||
        !entry.selector ||
        !entry.stateMutability ||
        !entry.access ||
        !entry.rationale ||
        !Array.isArray(entry.contracts)
    ) {
        fail(`malformed allowlist entry for ${entry.signature || "<unknown>"}`);
    }

    return {
        signature: entry.signature,
        selector: entry.selector,
        stateMutability: entry.stateMutability,
        contracts: sortedContracts(entry.contracts),
    };
}).sort((left, right) => left.signature.localeCompare(right.signature));

const duplicateSignatures = allowed.filter(
    (entry, index) => index > 0 && entry.signature === allowed[index - 1].signature
);
if (duplicateSignatures.length > 0) {
    fail(`duplicate allowlist signature ${duplicateSignatures[0].signature}`);
}

const actual = collectActual();
if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    const allowedBySignature = new Map(allowed.map((entry) => [entry.signature, entry]));
    const actualBySignature = new Map(actual.map((entry) => [entry.signature, entry]));
    const added = actual.filter((entry) => !allowedBySignature.has(entry.signature));
    const removed = allowed.filter((entry) => !actualBySignature.has(entry.signature));
    const changed = actual.filter((entry) => {
        const expected = allowedBySignature.get(entry.signature);
        return expected && JSON.stringify(entry) !== JSON.stringify(expected);
    });

    if (added.length) console.error(`  Unreviewed: ${added.map((entry) => entry.signature).join(", ")}`);
    if (removed.length) console.error(`  Missing: ${removed.map((entry) => entry.signature).join(", ")}`);
    if (changed.length) console.error(`  Changed: ${changed.map((entry) => entry.signature).join(", ")}`);
    fail("compiled state-changing instance surface differs from the reviewed allowlist");
}

console.log(
    `Instance selector check passed: ${actual.length} reviewed state-changing signatures ` +
    `across ${expectedTargets.length} game instances.`
);
