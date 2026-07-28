import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(V3_DIR, "baselines", "static-analysis.json");
const CONFIG_PATH = path.join(V3_DIR, ".solhint.json");
const require = createRequire(import.meta.url);

function fail(message) {
    console.error(`Static analysis check failed: ${message}`);
    process.exit(1);
}

function collectGroups() {
    try {
        const { processPath } = require("solhint");
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        const previousDirectory = process.cwd();
        process.chdir(V3_DIR);
        const reports = processPath("contracts/**/*.sol", config, V3_DIR);
        process.chdir(previousDirectory);

        const groups = new Map();
        for (const report of reports) {
            const relativePath = path.relative(V3_DIR, report.file).split(path.sep).join("/");
            for (const message of report.reports || []) {
                const key = [
                    relativePath,
                    message.ruleId || "<parser>",
                    message.severity || 0,
                    message.message,
                ].join("|");
                groups.set(key, {
                    source: relativePath,
                    ruleId: message.ruleId || null,
                    severity: message.severity || 0,
                    message: message.message,
                    count: (groups.get(key)?.count || 0) + 1,
                });
            }
        }

        return [...groups.values()].sort((left, right) =>
            `${left.source}|${left.ruleId}|${left.message}`.localeCompare(
                `${right.source}|${right.ruleId}|${right.message}`
            )
        );
    } catch (error) {
        fail(error.message);
    }
}

function keyFor(group) {
    return [group.source, group.ruleId || "<parser>", group.severity, group.message].join("|");
}

const groups = collectGroups();
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: "solhint",
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
};

if (process.argv.includes("--write")) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote static-analysis baseline: ${BASELINE_PATH}`);
    console.log(`Captured ${report.total} finding(s) in ${groups.length} group(s).`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    fail(`missing ${BASELINE_PATH}; run npm run static:capture after review`);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
const allowed = new Map(baseline.groups.map((group) => [keyFor(group), group.count]));
const regressions = groups.filter((group) => group.count > (allowed.get(keyFor(group)) || 0));

if (regressions.length > 0) {
    for (const group of regressions) {
        console.error(
            `  ${group.source} [${group.ruleId}]: ${group.message} ` +
            `(actual ${group.count}, allowed ${allowed.get(keyFor(group)) || 0})`
        );
    }
    fail(`${regressions.length} Solhint finding group(s) are new or increased`);
}

console.log(
    `Static analysis check passed: ${report.total} current finding(s); ` +
    `${baseline.total} baseline finding(s). Reductions are allowed.`
);
