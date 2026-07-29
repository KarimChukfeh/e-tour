import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(V3_DIR, "artifacts", "contracts");
const BASELINE_PATH = path.join(V3_DIR, "baselines", "abi-surface.json");

function fail(message) {
    console.error(`ABI surface check failed: ${message}`);
    process.exit(1);
}

function walkJsonFiles(directory) {
    if (!fs.existsSync(directory)) {
        fail(`missing ${directory}; run npm run compile first`);
    }

    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkJsonFiles(target));
        } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
            files.push(target);
        }
    }
    return files;
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, sortObject(value[key])])
        );
    }
    return value;
}

function abiSortKey(item) {
    const inputs = (item.inputs || []).map((input) => input.type).join(",");
    const outputs = (item.outputs || []).map((output) => output.type).join(",");
    return [
        item.type || "",
        item.name || "",
        inputs,
        outputs,
        item.stateMutability || "",
        String(item.anonymous || false),
    ].join("|");
}

function collectAbis() {
    const contracts = {};
    for (const file of walkJsonFiles(ARTIFACTS_DIR).sort()) {
        const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!artifact.sourceName || !artifact.contractName || !Array.isArray(artifact.abi)) {
            continue;
        }
        if (artifact.sourceName.includes("/test-helpers/")) {
            continue;
        }

        const key = `${artifact.sourceName}:${artifact.contractName}`;
        contracts[key] = artifact.abi
            .map(sortObject)
            .sort((left, right) => abiSortKey(left).localeCompare(abiSortKey(right)));
    }
    return Object.fromEntries(Object.entries(contracts).sort(([left], [right]) => left.localeCompare(right)));
}

const contracts = collectAbis();
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contracts,
};

if (process.argv.includes("--write")) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ABI surface baseline: ${BASELINE_PATH}`);
    console.log(`Captured ${Object.keys(contracts).length} contract/interface ABI(s).`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    fail(`missing ${BASELINE_PATH}; run npm run abi:capture after review`);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")).contracts || {};
const baselineNames = new Set(Object.keys(baseline));
const actualNames = new Set(Object.keys(contracts));
const added = [...actualNames].filter((name) => !baselineNames.has(name)).sort();
const removed = [...baselineNames].filter((name) => !actualNames.has(name)).sort();
const changed = [...actualNames]
    .filter((name) =>
        baselineNames.has(name) &&
        JSON.stringify(contracts[name]) !== JSON.stringify(baseline[name])
    )
    .sort();

if (added.length || removed.length || changed.length) {
    if (added.length) console.error(`  Added: ${added.join(", ")}`);
    if (removed.length) console.error(`  Removed: ${removed.join(", ")}`);
    if (changed.length) console.error(`  Changed: ${changed.join(", ")}`);
    fail("public ABI differs from the reviewed baseline; review and run npm run abi:capture if intentional");
}

console.log(`ABI surface check passed for ${actualNames.size} contract/interface ABI(s).`);
