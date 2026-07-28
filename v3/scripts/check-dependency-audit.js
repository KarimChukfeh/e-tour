import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(V3_DIR, "baselines", "npm-audit.json");
const SEVERITIES = ["info", "low", "moderate", "high", "critical", "total"];

function fail(message) {
    console.error(`Dependency audit check failed: ${message}`);
    process.exit(1);
}

function runAudit(extraArgs = []) {
    const result = spawnSync(
        "npm",
        ["audit", "--json", ...extraArgs],
        { cwd: V3_DIR, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    if (result.error) fail(result.error.message);

    try {
        return JSON.parse(result.stdout);
    } catch {
        fail(`could not parse npm audit JSON: ${result.stdout || result.stderr}`);
    }
}

function summarize(audit) {
    const advisoryIds = new Set();
    for (const vulnerability of Object.values(audit.vulnerabilities || {})) {
        for (const via of vulnerability.via || []) {
            if (via && typeof via === "object" && via.source !== undefined) {
                advisoryIds.add(String(via.source));
            }
        }
    }

    return {
        counts: Object.fromEntries(
            SEVERITIES.map((severity) => [
                severity,
                audit.metadata?.vulnerabilities?.[severity] || 0,
            ])
        ),
        advisoryIds: [...advisoryIds].sort(),
        vulnerablePackages: Object.keys(audit.vulnerabilities || {}).sort(),
    };
}

const production = summarize(runAudit(["--omit=dev"]));
if (production.counts.total !== 0) {
    fail(
        `production dependency graph has ${production.counts.total} vulnerability finding(s); ` +
        "production dependencies must remain clean"
    );
}

const full = summarize(runAudit());
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: {
        productionVulnerabilitiesAllowed: 0,
        developmentGraph: "no new advisories, vulnerable packages, or severity-count regressions",
    },
    production,
    developmentInclusive: full,
};

if (process.argv.includes("--write")) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote npm audit baseline: ${BASELINE_PATH}`);
    console.log(
        `Production graph: 0 findings. Development-inclusive graph: ${full.counts.total} known finding(s).`
    );
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    fail(`missing ${BASELINE_PATH}; run npm run audit:capture after review`);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")).developmentInclusive;
const regressions = [];
for (const severity of SEVERITIES) {
    if (full.counts[severity] > baseline.counts[severity]) {
        regressions.push(
            `${severity} count increased from ${baseline.counts[severity]} to ${full.counts[severity]}`
        );
    }
}

const allowedAdvisories = new Set(baseline.advisoryIds);
const newAdvisories = full.advisoryIds.filter((id) => !allowedAdvisories.has(id));
if (newAdvisories.length) regressions.push(`new advisories: ${newAdvisories.join(", ")}`);

const allowedPackages = new Set(baseline.vulnerablePackages);
const newPackages = full.vulnerablePackages.filter((name) => !allowedPackages.has(name));
if (newPackages.length) regressions.push(`new vulnerable packages: ${newPackages.join(", ")}`);

if (regressions.length) {
    for (const regression of regressions) console.error(`  ${regression}`);
    fail("npm audit regressed from the reviewed development-tooling baseline");
}

console.log(
    `Dependency audit check passed: production graph is clean; ` +
    `${full.counts.total} known development-inclusive finding(s), no regression.`
);
