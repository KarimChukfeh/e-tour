import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const thresholds = JSON.parse(
    fs.readFileSync(
        path.join(root, "config", "coverage-thresholds.json"),
        "utf8"
    )
);
const coveragePath = path.join(
    root,
    "coverage",
    "coverage-final.json"
);
assert(fs.existsSync(coveragePath), `missing ${coveragePath}; run coverage first`);
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));

for (const [relativeFile, minimum] of Object.entries(thresholds.files)) {
    const entry = Object.entries(coverage).find(([file]) => {
        const normalized = file.split(path.sep).join("/");
        return (
            normalized === relativeFile ||
            normalized.endsWith(`/${relativeFile}`)
        );
    })?.[1];
    assert(entry, `coverage is missing ${relativeFile}`);
    const actual = {
        statements: percent(Object.values(entry.s)),
        branches: percent(Object.values(entry.b).flat()),
        functions: percent(Object.values(entry.f)),
        lines: linePercent(entry),
    };
    for (const metric of ["statements", "branches", "functions", "lines"]) {
        assert(
            actual[metric] >= minimum[metric],
            `${relativeFile} ${metric} ${actual[metric].toFixed(2)}% is below ${minimum[metric]}%`
        );
    }
    console.log(
        `${relativeFile}: statements ${actual.statements.toFixed(2)}%, ` +
            `branches ${actual.branches.toFixed(2)}%, functions ${actual.functions.toFixed(2)}%, ` +
            `lines ${actual.lines.toFixed(2)}%`
    );
}
console.log(`Coverage thresholds passed for '${thresholds.campaign}'.`);

function percent(values) {
    if (values.length === 0) return 100;
    return (values.filter((value) => value > 0).length * 100) / values.length;
}

function linePercent(entry) {
    const byLine = new Map();
    for (const [statementId, count] of Object.entries(entry.s)) {
        const line = entry.statementMap[statementId].start.line;
        byLine.set(line, (byLine.get(line) ?? 0) + count);
    }
    return percent([...byLine.values()]);
}

function assert(condition, message) {
    if (!condition) throw new Error(`Coverage threshold check failed: ${message}`);
}
