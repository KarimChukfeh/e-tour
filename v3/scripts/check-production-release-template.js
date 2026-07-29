import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const templatePath = path.join(
    root,
    "deployments",
    "arbitrumOne-release-template.json"
);
assert(fs.existsSync(templatePath), `missing ${templatePath}`);
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));

assert(template.schemaVersion === 1, "unsupported schema");
assert(template.manifestKind === "arbitrum-one-v3-release-template", "wrong manifest kind");
assert(template.network === "arbitrumOne", "wrong network");
assert(template.chainId === "42161", "wrong chain ID");
assert(template.generation === "v3", "wrong deployment generation");
assert(/^0x[0-9a-fA-F]{40}$/u.test(template.entryPoint?.address ?? ""), "invalid EntryPoint");
assert(template.entryPoint?.version === "0.8.0", "wrong EntryPoint release");
assert(Object.keys(template.expectedContracts ?? {}).length === 17, "expected 17 V3 deployables");

for (const [name, record] of Object.entries(template.expectedContracts)) {
    assert(record.address === null, `${name} template address must remain null`);
    assert(record.verified === false, `${name} template cannot claim verification`);
    assert(record.sourceName?.endsWith(".sol"), `${name} source is missing`);
    assert(/^0x[0-9a-fA-F]{64}$/u.test(record.creationBytecodeKeccak256), `${name} creation hash is invalid`);
    assert(/^0x[0-9a-fA-F]{64}$/u.test(record.deployedBytecodeKeccak256), `${name} runtime hash is invalid`);
    assert(/^[0-9a-f]{64}$/u.test(record.abiSha256), `${name} ABI checksum is invalid`);
}

assert(template.releaseGates.externalAuditReport === null, "template cannot claim an audit");
assert(template.releaseGates.unresolvedCritical === null, "template cannot claim finding counts");
assert(template.releaseGates.unresolvedHigh === null, "template cannot claim finding counts");
console.log(
    `Arbitrum One release template valid: ${Object.keys(template.expectedContracts).length} contracts, no fabricated deployment or audit evidence.`
);

function assert(condition, message) {
    if (!condition) throw new Error(`Production release template check failed: ${message}`);
}
