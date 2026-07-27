import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const BUILD_INFO_DIR = path.join(V3_DIR, "artifacts", "build-info");
const BASELINE_PATH = path.join(V3_DIR, "baselines", "storage-layout.json");

const TARGETS = [
    ["contracts/ETourInstance_Base.sol", "ETourInstance_Base", "base"],
    ["contracts/ETourInstance.sol", "ETourInstance", "instance"],
    ["contracts/TicTacInstance.sol", "TicTacInstance", "instance"],
    ["contracts/ConnectFourInstance.sol", "ConnectFourInstance", "instance"],
    ["contracts/ChessInstance.sol", "ChessInstance", "instance"],
    ["contracts/modules/ETourInstance_Core.sol", "ETourInstance_Core", "delegatecall-module"],
    ["contracts/modules/ETourInstance_Matches.sol", "ETourInstance_Matches", "delegatecall-module"],
    ["contracts/modules/ETourInstance_Prizes.sol", "ETourInstance_Prizes", "delegatecall-module"],
    ["contracts/modules/ETourInstance_Escalation.sol", "ETourInstance_Escalation", "delegatecall-module"],
    ["contracts/modules/ChessRulesModule.sol", "ChessRulesModule", "stateless-rules-module"],
];

function fail(message) {
    console.error(`Storage layout check failed: ${message}`);
    process.exit(1);
}

function normalizeEntry(entry) {
    return {
        label: entry.label,
        slot: entry.slot,
        offset: entry.offset,
        type: entry.type,
        contract: entry.contract,
    };
}

function loadCompilationOutputs() {
    if (!fs.existsSync(BUILD_INFO_DIR)) {
        fail(`missing ${BUILD_INFO_DIR}; run npm run compile first`);
    }

    const outputs = new Map();
    const compilerVersions = new Set();
    const files = fs.readdirSync(BUILD_INFO_DIR).filter((name) => name.endsWith(".json")).sort();
    if (files.length === 0) {
        fail(`no build-info JSON files found in ${BUILD_INFO_DIR}`);
    }

    for (const file of files) {
        const buildInfo = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, file), "utf8"));
        compilerVersions.add(buildInfo.solcLongVersion || buildInfo.solcVersion || "unknown");
        for (const [sourceName, contracts] of Object.entries(buildInfo.output?.contracts || {})) {
            for (const [contractName, output] of Object.entries(contracts)) {
                outputs.set(`${sourceName}:${contractName}`, output);
            }
        }
    }

    return { outputs, compilerVersions: [...compilerVersions].sort() };
}

function assertPrefix(contractName, actual, expected) {
    if (actual.length < expected.length) {
        fail(`${contractName} has ${actual.length} storage entries; expected at least ${expected.length}`);
    }

    for (let i = 0; i < expected.length; i++) {
        const left = actual[i];
        const right = expected[i];
        for (const field of ["label", "slot", "offset", "type"]) {
            if (left[field] !== right[field]) {
                fail(
                    `${contractName} diverges from ETourInstance_Base at entry ${i} (${field}: ` +
                    `${String(left[field])} != ${String(right[field])})`
                );
            }
        }
    }
}

const { outputs, compilerVersions } = loadCompilationOutputs();
const contracts = {};

for (const [sourceName, contractName, role] of TARGETS) {
    const output = outputs.get(`${sourceName}:${contractName}`);
    if (!output?.storageLayout) {
        fail(`missing compiler storage layout for ${sourceName}:${contractName}`);
    }

    contracts[contractName] = {
        sourceName,
        role,
        storage: output.storageLayout.storage.map(normalizeEntry),
        types: output.storageLayout.types,
    };
}

const baseStorage = contracts.ETourInstance_Base.storage;
for (const [contractName, contract] of Object.entries(contracts)) {
    if (contract.role === "stateless-rules-module") {
        if (contract.storage.length !== 0) {
            fail(`${contractName} is expected to be stateless but has ${contract.storage.length} entries`);
        }
        continue;
    }
    if (contractName !== "ETourInstance_Base") {
        assertPrefix(contractName, contract.storage, baseStorage);
    }
}

const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    compilerVersions,
    canonicalBase: "contracts/ETourInstance_Base.sol:ETourInstance_Base",
    contracts,
};

if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote storage layout baseline: ${BASELINE_PATH}`);
}

console.log(
    `Storage layout check passed for ${Object.keys(contracts).length} contracts/modules ` +
    `(${baseStorage.length} canonical base entries).`
);
