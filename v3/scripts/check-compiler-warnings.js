import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const BUILD_INFO_DIR = path.join(V3_DIR, "artifacts", "build-info");
const BASELINE_PATH = path.join(V3_DIR, "baselines", "compiler-warnings.json");

function fail(message) {
    console.error(`Compiler warning check failed: ${message}`);
    process.exit(1);
}

function loadWarnings() {
    if (!fs.existsSync(BUILD_INFO_DIR)) {
        fail(`missing ${BUILD_INFO_DIR}; run npm run compile first`);
    }

    const files = fs.readdirSync(BUILD_INFO_DIR)
        .filter((name) => name.endsWith(".json"))
        .sort();
    if (files.length === 0) {
        fail(`no build-info JSON files found in ${BUILD_INFO_DIR}`);
    }

    const warnings = new Map();
    for (const file of files) {
        const buildInfo = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, file), "utf8"));
        for (const warning of buildInfo.output?.errors || []) {
            if (warning.severity !== "warning") continue;
            const source = warning.sourceLocation?.file || "<compiler>";
            const key = [
                warning.errorCode || warning.type || "unknown",
                source,
                warning.message || warning.formattedMessage || "unknown warning",
            ].join("|");
            warnings.set(key, {
                errorCode: warning.errorCode || null,
                type: warning.type || null,
                source,
                message: warning.message || warning.formattedMessage || "unknown warning",
                count: (warnings.get(key)?.count || 0) + 1,
            });
        }
    }

    return [...warnings.values()].sort((left, right) =>
        `${left.source}|${left.errorCode}|${left.message}`.localeCompare(
            `${right.source}|${right.errorCode}|${right.message}`
        )
    );
}

function keyFor(group) {
    return [group.errorCode || group.type || "unknown", group.source, group.message].join("|");
}

const groups = loadWarnings();
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
};

if (process.argv.includes("--write")) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote compiler warning baseline: ${BASELINE_PATH}`);
    console.log(`Captured ${report.total} warning(s) in ${groups.length} group(s).`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    fail(`missing ${BASELINE_PATH}; run npm run warnings:capture after review`);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
const allowed = new Map(baseline.groups.map((group) => [keyFor(group), group.count]));
const regressions = groups.filter((group) => group.count > (allowed.get(keyFor(group)) || 0));

if (regressions.length > 0) {
    for (const group of regressions) {
        console.error(
            `  ${group.source}: ${group.message} ` +
            `(actual ${group.count}, allowed ${allowed.get(keyFor(group)) || 0})`
        );
    }
    fail(`${regressions.length} warning group(s) are new or increased`);
}

console.log(
    `Compiler warning check passed: ${report.total} current warning(s); ` +
    `${baseline.total} baseline warning(s). Reductions are allowed.`
);
