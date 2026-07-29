import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const buildInfoDirectory = path.join(root, "artifacts", "build-info");

assert(
    fs.existsSync(buildInfoDirectory),
    "missing build info; run npm run compile first"
);
const buildInfoFiles = fs
    .readdirSync(buildInfoDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
        name,
        modifiedAt: fs.statSync(
            path.join(buildInfoDirectory, name)
        ).mtimeMs,
    }))
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
const sourceOutputs = new Map();
for (const { name } of buildInfoFiles) {
    const buildInfo = JSON.parse(
        fs.readFileSync(
            path.join(buildInfoDirectory, name),
            "utf8"
        )
    );
    for (const [sourceName, output] of Object.entries(
        buildInfo.output?.sources ?? {}
    )) {
        if (
            !sourceName.startsWith("contracts/") ||
            sourceName.includes("/test-helpers/") ||
            !output.ast
        ) {
            continue;
        }
        const sourcePath = path.join(root, sourceName);
        if (!fs.existsSync(sourcePath)) continue;
        const compiledSource =
            buildInfo.input?.sources?.[sourceName]?.content;
        if (
            compiledSource ===
            fs.readFileSync(sourcePath, "utf8")
        ) {
            sourceOutputs.set(sourceName, output);
        }
    }
}
assert(sourceOutputs.size > 0, "no current production ASTs found; compile first");

const failures = [];
let apiCount = 0;
for (const [sourceName, output] of sourceOutputs) {
    visit(output.ast, "", (node, contractName) => {
        if (isApiFunction(node)) {
            apiCount += 1;
            checkFunction(sourceName, contractName, node);
        } else if (isPublicStateVariable(node)) {
            apiCount += 1;
            checkNotice(
                sourceName,
                contractName,
                `${node.name} getter`,
                documentationText(node)
            );
        }
    });
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`  ${failure}`);
    }
    throw new Error(
        `NatSpec check failed: ${failures.length} missing or incomplete API document(s)`
    );
}
console.log(
    `NatSpec check passed for ${apiCount} public/external production API declarations and getters.`
);

function checkFunction(sourceName, contractName, node) {
    const name =
        node.kind === "constructor"
            ? "constructor"
            : node.kind === "receive" || node.kind === "fallback"
              ? node.kind
              : node.name;
    const label = `${name}()`;
    const text = documentationText(node);
    if (/@inheritdoc\b/u.test(text)) return;

    checkNotice(sourceName, contractName, label, text);
    for (const parameter of node.parameters?.parameters ?? []) {
        if (
            parameter.name &&
            !new RegExp(
                `@param\\s+${escapeRegExp(parameter.name)}(?:\\s|$)`,
                "u"
            ).test(text)
        ) {
            failures.push(
                `${sourceName}:${contractName}.${label} missing @param ${parameter.name}`
            );
        }
    }

    const returns = node.returnParameters?.parameters ?? [];
    const returnTags = [...text.matchAll(/@return(?:\s+(\w+))?/gu)];
    for (const output of returns) {
        if (
            output.name &&
            !new RegExp(
                `@return\\s+${escapeRegExp(output.name)}(?:\\s|$)`,
                "u"
            ).test(text)
        ) {
            failures.push(
                `${sourceName}:${contractName}.${label} missing @return ${output.name}`
            );
        }
    }
    if (returnTags.length < returns.length) {
        failures.push(
            `${sourceName}:${contractName}.${label} documents ${returnTags.length}/${returns.length} return value(s)`
        );
    }
}

function checkNotice(sourceName, contractName, label, text) {
    if (!hasNotice(text)) {
        failures.push(
            `${sourceName}:${contractName}.${label} missing @notice text`
        );
    }
}

function hasNotice(text) {
    if (/@notice(?:\s|$)/u.test(text)) return true;
    return text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .some((line) => line.length > 0 && !line.startsWith("@"));
}

function documentationText(node) {
    if (typeof node.documentation === "string") {
        return node.documentation;
    }
    return node.documentation?.text ?? "";
}

function isApiFunction(node) {
    return (
        node.nodeType === "FunctionDefinition" &&
        (node.visibility === "public" || node.visibility === "external")
    );
}

function isPublicStateVariable(node) {
    return (
        node.nodeType === "VariableDeclaration" &&
        node.stateVariable === true &&
        node.visibility === "public"
    );
}

function visit(node, contractName, callback) {
    if (!node || typeof node !== "object") return;
    const nextContract =
        node.nodeType === "ContractDefinition"
            ? node.name
            : contractName;
    callback(node, nextContract);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child?.nodeType) visit(child, nextContract, callback);
            }
        } else if (value?.nodeType) {
            visit(value, nextContract, callback);
        }
    }
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assert(condition, message) {
    if (!condition) throw new Error(`NatSpec check failed: ${message}`);
}
