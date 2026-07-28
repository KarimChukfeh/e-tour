import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SOURCE_DIRECTORIES = ["sdk", "scripts"];
const SENSITIVE =
    /\b(privateKey|mnemonic|seedPhrase|sessionSecret)\b/i;
const findings = [];

for (const directory of SOURCE_DIRECTORIES) {
    const base = path.join(ROOT, directory);
    for (const file of walk(base)) {
        if (!/\.(js|ts)$/.test(file)) continue;
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
            if (
                /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(
                    line
                ) &&
                SENSITIVE.test(lines.slice(index, index + 5).join("\n"))
            ) {
                findings.push(
                    `${path.relative(ROOT, file)}:${index + 1} may log key material`
                );
            }
        });
    }
}

const deployments = path.join(ROOT, "deployments");
if (fs.existsSync(deployments)) {
    for (const file of walk(deployments)) {
        if (!file.endsWith(".json")) continue;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        inspectObject(parsed, path.relative(ROOT, file));
    }
}

if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exit(1);
}
console.log(
    "Secret-output check passed: no reviewed source log or deployment secret fields found."
);

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const target = path.join(directory, entry.name);
            return entry.isDirectory() ? walk(target) : [target];
        });
}

function inspectObject(value, location) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE.test(key)) {
            findings.push(`${location} contains forbidden field ${key}`);
        }
        inspectObject(child, location);
    }
}
