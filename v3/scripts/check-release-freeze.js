import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const outputPath = path.join(root, "baselines", "release-freeze.json");
const write = process.argv.includes("--write");

const fixedInputs = [
    ".solhint.json",
    "hardhat.config.js",
    "hardhat.arbitrum-local.config.js",
    "package.json",
    "package-lock.json",
    "sdk/tsconfig.json",
    "config/account-abstraction.json",
    "config/coverage-thresholds.json",
    "config/instance-state-changing-selectors.json",
    "baselines/abi-surface.json",
    "baselines/contract-sizes.json",
    "baselines/storage-layout.json",
    "baselines/internal-security-review.json",
];
const sourceInputs = [
    ...walk(path.join(root, "contracts")).filter((file) => file.endsWith(".sol")),
    ...walk(path.join(root, "scripts")).filter((file) => file.endsWith(".js")),
    ...walk(path.join(root, "sdk")).filter(
        (file) =>
            !file.includes(`${path.sep}dist${path.sep}`) &&
            (file.endsWith(".ts") || file.endsWith(".js"))
    ),
    ...walk(path.join(root, "test")).filter((file) => file.endsWith(".js")),
].map(relative);
const inputs = [...new Set([...fixedInputs, ...sourceInputs])].sort();

for (const file of inputs) {
    assert(fs.existsSync(path.join(root, file)), `missing freeze input ${file}`);
}

const files = Object.fromEntries(
    inputs.map((file) => [file, sha256(path.join(root, file))])
);
const aggregateSha256 = crypto
    .createHash("sha256")
    .update(
        Object.entries(files)
            .map(([file, digest]) => `${file}\0${digest}\n`)
            .join("")
    )
    .digest("hex");
const report = {
    schemaVersion: 1,
    frozenAt: new Date().toISOString(),
    algorithm: "sha256",
    scope:
        "Production Solidity, SDK, deployment/release scripts, regression tests, " +
        "compiler/dependency/configuration inputs, ABI surface, storage layout, " +
        "reviewed size baseline, and internal finding register",
    aggregateSha256,
    files,
};

if (write) {
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        `Captured audit freeze ${aggregateSha256} across ${inputs.length} files: ${outputPath}`
    );
    process.exit(0);
}

assert(fs.existsSync(outputPath), `missing ${outputPath}; run with --write after review`);
const baseline = JSON.parse(fs.readFileSync(outputPath, "utf8"));
assert(baseline.schemaVersion === 1, "unsupported freeze schema");
assert(
    JSON.stringify(Object.keys(baseline.files).sort()) ===
        JSON.stringify(inputs),
    "freeze file set changed"
);
const changed = inputs.filter((file) => baseline.files[file] !== files[file]);
assert(
    changed.length === 0,
    `frozen input changed: ${changed.join(", ")}`
);
assert(
    baseline.aggregateSha256 === aggregateSha256,
    "aggregate freeze checksum changed"
);
console.log(
    `Audit freeze valid: ${aggregateSha256} across ${inputs.length} files.`
);

function walk(target) {
    return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(target, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

function relative(file) {
    return path.relative(root, file).split(path.sep).join("/");
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
    if (!condition) throw new Error(`Release freeze check failed: ${message}`);
}
