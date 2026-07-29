import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const registerPath = path.join(
    root,
    "baselines",
    "internal-security-review.json"
);
const allowedSeverities = new Set([
    "critical",
    "high",
    "medium",
    "low",
    "informational",
]);
const allowedStatuses = new Set(["open", "fixed", "accepted"]);

assert(fs.existsSync(registerPath), `missing ${registerPath}`);
const register = JSON.parse(fs.readFileSync(registerPath, "utf8"));
assert(register.schemaVersion === 1, "unsupported review schema");
assert(Array.isArray(register.scope) && register.scope.length > 0, "review scope is empty");
assert(Array.isArray(register.findings), "findings must be an array");

const ids = new Set();
for (const finding of register.findings) {
    assert(/^V3-INT-\d{3}$/u.test(finding.id), `invalid finding id ${finding.id}`);
    assert(!ids.has(finding.id), `duplicate finding id ${finding.id}`);
    ids.add(finding.id);
    assert(allowedSeverities.has(finding.severity), `${finding.id} has invalid severity`);
    assert(allowedStatuses.has(finding.status), `${finding.id} has invalid status`);
    assert(finding.title, `${finding.id} is missing a title`);

    if (finding.status === "fixed") {
        assert(finding.resolution, `${finding.id} is missing its resolution`);
        assert(
            Array.isArray(finding.regressionTests) &&
                finding.regressionTests.length > 0,
            `${finding.id} has no regression test`
        );
        for (const reference of finding.regressionTests) {
            const [file] = reference.split(": ");
            assert(
                fs.existsSync(path.join(root, file)),
                `${finding.id} references missing test ${file}`
            );
        }
    }

    if (finding.status === "accepted") {
        assert(finding.rationale, `${finding.id} has no acceptance rationale`);
        assert(finding.owner, `${finding.id} has no risk owner`);
    }
}

const blocking = register.findings.filter(
    (finding) =>
        finding.status === "open" &&
        (finding.severity === "critical" || finding.severity === "high")
);
assert(
    blocking.length === 0,
    `unresolved critical/high findings: ${blocking.map((item) => item.id).join(", ")}`
);

const counts = Object.fromEntries(
    [...allowedStatuses].map((status) => [
        status,
        register.findings.filter((finding) => finding.status === status).length,
    ])
);
console.log(
    `Internal security review valid: ${register.findings.length} finding(s), ` +
        `${counts.fixed} fixed, ${counts.accepted} accepted, ${counts.open} open, ` +
        "0 unresolved critical/high."
);

function assert(condition, message) {
    if (!condition) throw new Error(`Security review check failed: ${message}`);
}
