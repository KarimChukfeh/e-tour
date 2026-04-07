#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const v2Root = path.resolve(repoRoot, "v2");
const testRoot = path.resolve(v2Root, "test");
const defaultOutput = path.resolve(v2Root, "reports", "v2-test-report.html");
const defaultJsonOutput = path.resolve(v2Root, "reports", "v2-test-report.json");
const defaultRawOutput = path.resolve(v2Root, "reports", "v2-test-output.txt");

function parseArgs(argv) {
    const out = {
        output: defaultOutput,
        jsonOutput: defaultJsonOutput,
        rawOutput: defaultRawOutput,
        noRun: false,
        noCompile: false,
        grep: null,
        files: [],
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--no-run") {
            out.noRun = true;
            continue;
        }
        if (arg === "--no-compile") {
            out.noCompile = true;
            continue;
        }
        if (arg === "--output") {
            out.output = path.resolve(repoRoot, argv[++index]);
            continue;
        }
        if (arg === "--json-output") {
            out.jsonOutput = path.resolve(repoRoot, argv[++index]);
            continue;
        }
        if (arg === "--raw-output") {
            out.rawOutput = path.resolve(repoRoot, argv[++index]);
            continue;
        }
        if (arg === "--grep") {
            out.grep = argv[++index];
            continue;
        }
        if (arg === "--file") {
            out.files.push(path.resolve(repoRoot, argv[++index]));
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return out;
}

async function listTestFiles(rootDir) {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === ".DS_Store") continue;
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listTestFiles(fullPath));
            continue;
        }
        if (!entry.name.endsWith(".test.js")) continue;
        if (entry.name === "protocolSuite.js") continue;
        files.push(fullPath);
    }
    return files.sort();
}

function installDiscoveryGlobals(scenarios, currentFileRef) {
    const suiteStack = [];

    const pushSuite = (title, fn) => {
        suiteStack.push(title);
        try {
            fn?.call({ timeout() {} });
        } finally {
            suiteStack.pop();
        }
    };

    const recordTest = (title) => {
        scenarios.push({
            file: currentFileRef.path,
            fileLabel: path.relative(repoRoot, currentFileRef.path),
            suitePath: [...suiteStack],
            title,
            expectation: title.replace(/^[A-Z]\d+(?:\.\d+)?\s+/, ""),
            fullTitle: [...suiteStack, title].join(" > "),
            status: "not_run",
            durationMs: null,
            error: null,
        });
    };

    function makeDescribe() {
        const describe = (title, fn) => pushSuite(title, fn);
        describe.only = describe;
        describe.skip = describe;
        return describe;
    }

    function makeIt() {
        const it = (title) => recordTest(title);
        it.only = it;
        it.skip = it;
        return it;
    }

    global.describe = makeDescribe();
    global.context = global.describe;
    global.it = makeIt();
    global.specify = global.it;
    global.before = () => {};
    global.after = () => {};
    global.beforeEach = () => {};
    global.afterEach = () => {};
}

async function collectScenarios(testFiles) {
    const scenarios = [];
    const currentFileRef = { path: null };
    installDiscoveryGlobals(scenarios, currentFileRef);
    process.env.HARDHAT_CONFIG = path.resolve(v2Root, "hardhat.config.js");

    for (const file of testFiles) {
        currentFileRef.path = file;
        await import(`${pathToFileURL(file).href}?report=${Date.now()}-${Math.random()}`);
    }

    return scenarios;
}

function stripAnsi(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseSpecOutput(rawOutput) {
    const output = stripAnsi(rawOutput);
    const lines = output.split(/\r?\n/);
    const passing = new Map();
    const failing = new Map();
    const suiteStack = [];
    const failures = [];

    let inFailureSummary = false;
    let activeFailure = null;

    const finalizeFailure = () => {
        if (!activeFailure) return;
        const titlePath = activeFailure.titleLines.filter(Boolean);
        if (titlePath.length > 0) {
            const fullTitle = titlePath.join(" > ");
            failing.set(fullTitle, {
                status: "failed",
                error: activeFailure.errorLines.join("\n").trim() || null,
            });
            failures.push({
                fullTitle,
                error: activeFailure.errorLines.join("\n").trim() || null,
            });
        }
        activeFailure = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, "    ");
        const trimmed = line.trim();
        if (!trimmed) {
            finalizeFailure();
            continue;
        }

        if (/^\d+\s+passing/.test(trimmed) || /^\d+\s+failing/.test(trimmed)) {
            inFailureSummary = /^\d+\s+failing/.test(trimmed) || inFailureSummary;
            continue;
        }

        if (/^\d+\)\s/.test(trimmed)) {
            finalizeFailure();
            inFailureSummary = true;
            activeFailure = {
                titleLines: [trimmed.replace(/^\d+\)\s+/, "")],
                errorLines: [],
            };
            continue;
        }

        if (inFailureSummary && activeFailure) {
            if (/^(AssertionError|Error|TypeError|ReferenceError|SyntaxError)/.test(trimmed) || /^at\s/.test(trimmed)) {
                activeFailure.errorLines.push(trimmed);
            } else if (!/^(expected|actual|-|\+)/.test(trimmed)) {
                activeFailure.titleLines.push(trimmed);
            }
            continue;
        }

        const passMatch = line.match(/^(\s*)✔\s(.+?)(?:\s\((\d+)ms\))?$/);
        if (passMatch) {
            const depth = Math.max(0, Math.floor(passMatch[1].length / 2) - 1);
            const titlePath = [...suiteStack.slice(0, depth), passMatch[2]];
            passing.set(titlePath.join(" > "), {
                status: "passed",
                durationMs: passMatch[3] ? Number(passMatch[3]) : null,
            });
            continue;
        }

        if (/^[├└]/.test(trimmed) || trimmed.startsWith("Hardhat version") || trimmed.startsWith("Usage:")) {
            continue;
        }
        if (trimmed.startsWith("[dotenv@")) {
            continue;
        }

        const suiteMatch = line.match(/^(\s+)([^✔].+)$/);
        if (!suiteMatch) continue;
        if (/^[-=]+$/.test(trimmed)) continue;
        if (/^(failing|passing|pending)/.test(trimmed)) continue;
        if (/^at\s/.test(trimmed)) continue;
        if (trimmed.startsWith("Command:")) continue;
        if (trimmed.startsWith("Chunk ID:")) continue;

        const depth = Math.floor(suiteMatch[1].length / 2) - 1;
        if (depth < 0) continue;
        suiteStack.splice(depth);
        suiteStack[depth] = trimmed;
    }

    finalizeFailure();

    const summary = {
        passing: Number(output.match(/(\d+)\s+passing/)?.[1] ?? 0),
        failing: Number(output.match(/(\d+)\s+failing/)?.[1] ?? 0),
        pending: Number(output.match(/(\d+)\s+pending/)?.[1] ?? 0),
    };

    return { passing, failing, summary, failures };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function groupScenarios(scenarios) {
    const files = new Map();

    for (const scenario of scenarios) {
        let fileGroup = files.get(scenario.fileLabel);
        if (!fileGroup) {
            fileGroup = { label: scenario.fileLabel, suites: new Map(), scenarios: [] };
            files.set(scenario.fileLabel, fileGroup);
        }
        fileGroup.scenarios.push(scenario);

        const suiteKey = scenario.suitePath.slice(0, 2).join(" > ");
        let suiteGroup = fileGroup.suites.get(suiteKey);
        if (!suiteGroup) {
            suiteGroup = {
                title: scenario.suitePath[0] ?? "Ungrouped",
                subtitle: scenario.suitePath[1] ?? "",
                scenarios: [],
            };
            fileGroup.suites.set(suiteKey, suiteGroup);
        }
        suiteGroup.scenarios.push(scenario);
    }

    return [...files.values()];
}

function scenarioStatusClass(status) {
    if (status === "passed") return "passed";
    if (status === "failed") return "failed";
    if (status === "pending") return "pending";
    return "not-run";
}

function renderHtml({ scenarios, grouped, runMeta, summary, failures }) {
    const generatedAt = new Date().toLocaleString("en-CA", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "America/Toronto",
    });

    const total = scenarios.length;
    const passed = scenarios.filter(item => item.status === "passed").length;
    const failed = scenarios.filter(item => item.status === "failed").length;
    const notRun = scenarios.filter(item => item.status === "not_run").length;

    const sectionsHtml = grouped.map(fileGroup => {
        const suitesHtml = [...fileGroup.suites.values()].map(suite => {
            const rows = suite.scenarios.map(test => `
                <tr class="${scenarioStatusClass(test.status)}">
                    <td class="status-cell"><span class="status-pill ${scenarioStatusClass(test.status)}">${escapeHtml(test.status)}</span></td>
                    <td><code>${escapeHtml(test.title)}</code></td>
                    <td>${escapeHtml(test.expectation)}</td>
                    <td>${test.durationMs == null ? "—" : `${test.durationMs} ms`}</td>
                    <td>${test.error ? `<details><summary>Failure</summary><pre>${escapeHtml(test.error)}</pre></details>` : "—"}</td>
                </tr>
            `).join("");

            return `
                <section class="suite-card">
                    <div class="suite-head">
                        <h3>${escapeHtml(suite.subtitle || suite.title)}</h3>
                        ${suite.subtitle ? `<p>${escapeHtml(suite.title)}</p>` : ""}
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>Outcome</th>
                                <th>Scenario</th>
                                <th>Expectation</th>
                                <th>Duration</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </section>
            `;
        }).join("");

        return `
            <section class="file-card">
                <div class="file-head">
                    <h2>${escapeHtml(fileGroup.label)}</h2>
                    <p>${fileGroup.scenarios.length} scenarios</p>
                </div>
                ${suitesHtml}
            </section>
        `;
    }).join("");

    const failuresHtml = failures.length === 0
        ? "<p class=\"muted\">No failing scenarios in the latest parsed run.</p>"
        : failures.map(item => `
            <article class="failure-card">
                <h4>${escapeHtml(item.fullTitle)}</h4>
                <pre>${escapeHtml(item.error || "No error details captured.")}</pre>
            </article>
        `).join("");

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ETour V2 Test Report</title>
    <style>
        :root {
            --bg: #f6f2ea;
            --panel: #fffdfa;
            --ink: #1b1a17;
            --muted: #645f55;
            --line: #d8d0c2;
            --pass: #1f7a3f;
            --fail: #af2f2f;
            --pending: #9c6c18;
            --notrun: #5a6473;
            --accent: #17324d;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
            background: linear-gradient(180deg, #f6f2ea 0%, #efe7da 100%);
            color: var(--ink);
        }
        .shell {
            max-width: 1440px;
            margin: 0 auto;
            padding: 32px 24px 64px;
        }
        .hero, .summary-grid, .file-card, .failure-card, .meta-card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 18px;
            box-shadow: 0 14px 40px rgba(27, 26, 23, 0.06);
        }
        .hero {
            padding: 28px;
            margin-bottom: 24px;
        }
        .hero h1 {
            margin: 0 0 8px;
            font-size: 2.4rem;
            line-height: 1.05;
            color: var(--accent);
        }
        .hero p {
            margin: 0;
            color: var(--muted);
            max-width: 900px;
            line-height: 1.5;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
            gap: 12px;
            padding: 18px;
            margin-bottom: 24px;
        }
        .metric {
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 14px;
            background: #fffcf7;
        }
        .metric .label {
            display: block;
            font-size: 0.82rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            margin-bottom: 6px;
        }
        .metric .value {
            font-size: 1.7rem;
            font-weight: 700;
        }
        .meta-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 16px;
            margin-bottom: 28px;
        }
        .meta-card {
            padding: 18px 20px;
        }
        .meta-card h3 {
            margin: 0 0 10px;
            color: var(--accent);
        }
        .meta-card p, .meta-card li {
            color: var(--muted);
            line-height: 1.5;
        }
        .file-card {
            padding: 20px;
            margin-bottom: 22px;
        }
        .file-head {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 12px;
            margin-bottom: 18px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--line);
        }
        .file-head h2, .suite-head h3, .failure-card h4 {
            margin: 0;
        }
        .file-head p, .suite-head p {
            margin: 0;
            color: var(--muted);
        }
        .suite-card {
            margin-bottom: 16px;
            border: 1px solid var(--line);
            border-radius: 14px;
            overflow: hidden;
        }
        .suite-head {
            padding: 14px 16px;
            background: #f8f3eb;
            border-bottom: 1px solid var(--line);
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            text-align: left;
            padding: 12px 14px;
            border-bottom: 1px solid #ece4d6;
            vertical-align: top;
        }
        th {
            font-size: 0.82rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            background: #fffaf2;
        }
        tr:last-child td {
            border-bottom: 0;
        }
        .status-pill {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-weight: 700;
            border: 1px solid currentColor;
        }
        .status-pill.passed { color: var(--pass); }
        .status-pill.failed { color: var(--fail); }
        .status-pill.pending { color: var(--pending); }
        .status-pill.not-run { color: var(--notrun); }
        tr.passed { background: rgba(31, 122, 63, 0.03); }
        tr.failed { background: rgba(175, 47, 47, 0.04); }
        tr.not-run { background: rgba(90, 100, 115, 0.03); }
        .failure-card {
            padding: 18px 20px;
            margin-bottom: 14px;
        }
        pre {
            white-space: pre-wrap;
            word-break: break-word;
            background: #1b1a17;
            color: #f8f4ea;
            padding: 14px;
            border-radius: 12px;
            overflow: auto;
        }
        code {
            font-family: "SFMono-Regular", "Menlo", monospace;
            font-size: 0.92em;
        }
        details summary {
            cursor: pointer;
            color: var(--accent);
        }
        .muted {
            color: var(--muted);
        }
        @media (max-width: 880px) {
            .file-head {
                flex-direction: column;
                align-items: flex-start;
            }
            th:nth-child(4), td:nth-child(4) {
                display: none;
            }
        }
    </style>
</head>
<body>
    <main class="shell">
        <section class="hero">
            <h1>ETour V2 Test Report</h1>
            <p>This report groups every discovered V2 test scenario by file and logical suite, mirrors each scenario’s stated expectation from the test title, and merges the latest Hardhat run outcome when available.</p>
        </section>

        <section class="summary-grid">
            <div class="metric"><span class="label">Generated</span><span class="value">${escapeHtml(generatedAt)}</span></div>
            <div class="metric"><span class="label">Total Scenarios</span><span class="value">${total}</span></div>
            <div class="metric"><span class="label">Passed</span><span class="value">${passed}</span></div>
            <div class="metric"><span class="label">Failed</span><span class="value">${failed}</span></div>
            <div class="metric"><span class="label">Not Run</span><span class="value">${notRun}</span></div>
        </section>

        <section class="meta-row">
            <article class="meta-card">
                <h3>Run Metadata</h3>
                <p><strong>Mode:</strong> ${escapeHtml(runMeta.mode)}</p>
                <p><strong>Command:</strong> <code>${escapeHtml(runMeta.command)}</code></p>
                <p><strong>Summary:</strong> ${summary.passing} passing, ${summary.failing} failing, ${summary.pending} pending</p>
            </article>
            <article class="meta-card">
                <h3>Expectation Source</h3>
                <p>The <em>Expectation</em> column comes from the <code>it(...)</code> title with the scenario ID stripped. That keeps the report aligned with the real test intent instead of introducing a second hand-maintained expectation layer.</p>
            </article>
        </section>

        ${sectionsHtml}

        <section class="file-card">
            <div class="file-head">
                <h2>Failures</h2>
                <p>${failures.length} captured from the latest parsed run</p>
            </div>
            ${failuresHtml}
        </section>
    </main>
</body>
</html>`;
}

async function runHardhatTests(options) {
    const command = "./node_modules/.bin/hardhat";
    const args = ["test", "--config", "v2/hardhat.config.js"];
    if (options.noCompile) args.push("--no-compile");
    if (options.grep) args.push("--grep", options.grep);
    if (options.files.length > 0) {
        for (const file of options.files) {
            args.push(path.relative(repoRoot, file));
        }
    }

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: repoRoot,
            env: { ...process.env, FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", code => {
            resolve({
                code,
                stdout,
                stderr,
                command: `${command} ${args.join(" ")}`,
            });
        });
    });
}

function mergeOutcomes(scenarios, parsedResults) {
    const passByTitle = new Map();
    const failByTitle = new Map();

    for (const [fullTitle, result] of parsedResults.passing.entries()) {
        const title = fullTitle.split(" > ").at(-1);
        const bucket = passByTitle.get(title) ?? [];
        bucket.push({ fullTitle, result });
        passByTitle.set(title, bucket);
    }

    for (const [fullTitle, result] of parsedResults.failing.entries()) {
        const title = fullTitle.split(" > ").at(-1);
        const bucket = failByTitle.get(title) ?? [];
        bucket.push({ fullTitle, result });
        failByTitle.set(title, bucket);
    }

    for (const scenario of scenarios) {
        const pass = parsedResults.passing.get(scenario.fullTitle);
        if (pass) {
            scenario.status = "passed";
            scenario.durationMs = pass.durationMs;
            continue;
        }

        const fail = parsedResults.failing.get(scenario.fullTitle);
        if (fail) {
            scenario.status = "failed";
            scenario.error = fail.error;
            continue;
        }

        const passCandidates = passByTitle.get(scenario.title) ?? [];
        if (passCandidates.length === 1) {
            scenario.status = "passed";
            scenario.durationMs = passCandidates[0].result.durationMs;
            continue;
        }

        const failCandidates = failByTitle.get(scenario.title) ?? [];
        if (failCandidates.length === 1) {
            scenario.status = "failed";
            scenario.error = failCandidates[0].result.error;
        }
    }
}

async function writeArtifacts({ html, report, output, jsonOutput, rawOutput, rawText }) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, html, "utf8");
    await fs.writeFile(jsonOutput, JSON.stringify(report, null, 2), "utf8");
    if (rawText != null) {
        await fs.writeFile(rawOutput, rawText, "utf8");
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const testFiles = options.files.length > 0 ? options.files : await listTestFiles(testRoot);
    const scenarios = await collectScenarios(testFiles);

    let runMeta = {
        mode: options.noRun ? "discovery-only" : "run-and-report",
        command: options.noRun ? "not run" : "./node_modules/.bin/hardhat test --config v2/hardhat.config.js",
    };
    let parsedResults = {
        passing: new Map(),
        failing: new Map(),
        summary: { passing: 0, failing: 0, pending: 0 },
        failures: [],
    };
    let rawText = null;

    if (!options.noRun) {
        const run = await runHardhatTests(options);
        runMeta = {
            mode: run.code === 0 ? "run-and-report" : "run-and-report (with failures)",
            command: run.command,
            exitCode: run.code,
        };
        rawText = `${run.stdout}${run.stderr}`;
        parsedResults = parseSpecOutput(rawText);
        mergeOutcomes(scenarios, parsedResults);
    }

    const grouped = groupScenarios(scenarios);
    const report = {
        generatedAt: new Date().toISOString(),
        runMeta,
        summary: parsedResults.summary,
        scenarios,
        failures: parsedResults.failures,
    };
    const html = renderHtml({
        scenarios,
        grouped,
        runMeta,
        summary: parsedResults.summary,
        failures: parsedResults.failures,
    });

    await writeArtifacts({
        html,
        report,
        output: options.output,
        jsonOutput: options.jsonOutput,
        rawOutput: options.rawOutput,
        rawText,
    });

    console.log(`HTML report written to ${options.output}`);
    console.log(`JSON report written to ${options.jsonOutput}`);
    if (!options.noRun) {
        console.log(`Raw test output written to ${options.rawOutput}`);
        if (runMeta.exitCode && runMeta.exitCode !== 0) {
            process.exit(runMeta.exitCode);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
