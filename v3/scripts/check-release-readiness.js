import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const statusPath = path.join(root, "config", "release-status.json");
const freezePath = path.join(root, "baselines", "release-freeze.json");
const templatePath = path.join(
    root,
    "deployments",
    "arbitrumOne-release-template.json"
);
const stage = process.argv[2] ?? "local";
const stages = new Set(["local", "audit", "production", "cutover"]);

assert(stages.has(stage), `unknown stage ${stage}`);
assert(fs.existsSync(statusPath), `missing ${statusPath}`);
const release = JSON.parse(fs.readFileSync(statusPath, "utf8"));

assert(release.schemaVersion === 1, "unsupported release-status schema");
assert(release.eip7702?.decision === "deferred", "EIP-7702 decision is not frozen");
assert(release.eip7702?.includedInV3 === false, "unexpected EIP-7702 release scope");
assert(release.internalReview?.status === "complete", "internal review is incomplete");
assert(fs.existsSync(path.join(root, release.internalReview.report)), "internal review report is missing");
assert(fs.existsSync(path.join(root, release.internalReview.register)), "risk register is missing");
assert(fs.existsSync(freezePath), "audit freeze is missing; run npm run release:freeze:capture");
assert(fs.existsSync(templatePath), "Arbitrum One release template is missing");

if (stage !== "local") {
    const audit = release.externalAudit;
    assert(audit.required === true, "external audit must remain mandatory");
    assert(audit.status === "complete", "external audit is not complete");
    assert(audit.auditor, "external auditor is not recorded");
    assert(audit.report, "external audit report is not recorded");
    const reportPath = path.join(root, audit.report);
    assert(fs.existsSync(reportPath), "external audit report file is missing");
    assert(
        sha256(reportPath) === audit.reportSha256,
        "external audit report checksum mismatch"
    );
    assert(audit.unresolvedCritical === 0, "external audit has unresolved critical findings");
    assert(audit.unresolvedHigh === 0, "external audit has unresolved high findings");
}

if (stage === "production" || stage === "cutover") {
    const production = release.production;
    assert(production.deploymentStatus === "deployed", "Arbitrum One is not deployed");
    assert(production.manifest, "production manifest is not recorded");
    assert(fs.existsSync(path.join(root, production.manifest)), "production manifest is missing");
    assert(production.allContractsVerified === true, "production contracts are not all verified");
    assert(production.monitoringEnabled === true, "production monitoring is not enabled");
    assert(production.cappedPaymasterFunded === true, "canary paymaster is not funded");
}

if (stage === "cutover") {
    assert(release.production.canaryStatus === "approved", "production canary is not approved");
    assert(release.production.canaryReport, "canary report is not recorded");
    assert(release.cutover.status === "approved", "cutover has no explicit approval");
    assert(release.cutover.approvedBy, "cutover approver is not recorded");
    assert(release.cutover.approvedAt, "cutover approval time is not recorded");
    assert(
        release.cutover.defaultCreationGeneration === "v3",
        "new tournament creation is not routed to V3"
    );
    assert(release.cutover.v2ReadsEnabled === true, "V2 history reads must stay enabled");
    assert(release.cutover.v2ActivePlayEnabled === true, "active V2 play must stay enabled");
}

console.log(`Release readiness passed for stage '${stage}'.`);

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
    if (!condition) throw new Error(`Release readiness failed: ${message}`);
}
