import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getAddress } from "ethers";
import { fileURLToPath } from "url";
import {
    canonicalManifestPath,
    networkDeploymentDirectory,
} from "./lib/deployment-output.js";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const network = process.argv[2] ?? "arbitrumOne";
const deploymentRoot = path.join(root, "deployments");
const manifestPath = canonicalManifestPath(deploymentRoot, network);
assert(fs.existsSync(manifestPath), `missing canonical manifest ${manifestPath}`);
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert(manifest.network === network, "manifest network mismatch");

const contracts = {};
for (const [name, record] of Object.entries(manifest.contracts ?? {})) {
    if (record.address === null) continue;
    contracts[name] = {
        address: getAddress(record.address),
        sourceName: record.sourceName,
        abiSha256: sha256(Buffer.from(`${JSON.stringify(record.abi)}\n`)),
        deployedBytecodeHash: record.deployedBytecodeHash,
        runtimeBytecodeHash: record.runtimeBytecodeHash,
    };
}
assert(Object.keys(contracts).length >= 19, "complete deployment addresses are missing");

const addressBook = {
    schemaVersion: 1,
    generation: "v3",
    network,
    chainId: String(manifest.chainId),
    source: manifest.source,
    manifest: path.relative(root, manifestPath).split(path.sep).join("/"),
    manifestSha256: sha256(manifestBytes),
    generatedAt: new Date().toISOString(),
    contracts,
};
const outputDirectory = networkDeploymentDirectory(deploymentRoot, network);
fs.mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, "address-book.json");
fs.writeFileSync(output, `${JSON.stringify(addressBook, null, 2)}\n`);
console.log(
    `Wrote checksummed ${network} V3 address book with ${Object.keys(contracts).length} deployed contracts: ${output}`
);

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
    if (!condition) throw new Error(`Address-book build failed: ${message}`);
}
