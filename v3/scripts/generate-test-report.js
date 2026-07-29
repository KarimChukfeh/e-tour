import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const V3_DIR = path.resolve(path.dirname(__filename), "..");
const OUTPUT_PATH = path.join(V3_DIR, "test-report-v3.html");
const RESULTS_PATH = path.join(
    os.tmpdir(),
    `etour-v3-test-report-${process.pid}.json`
);

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatDuration(milliseconds) {
    if (milliseconds < 1000) return `${milliseconds} ms`;
    if (milliseconds < 60_000) {
        return `${(milliseconds / 1000).toFixed(1)} s`;
    }
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = ((milliseconds % 60_000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
}

function gitValue(args, fallback = "unavailable") {
    const result = spawnSync("git", args, {
        cwd: V3_DIR,
        encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : fallback;
}

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: V3_DIR,
        env,
        stdio: "inherit",
    });
    return result.status ?? 1;
}

function summarizeSuites(tests) {
    const suites = new Map();
    for (const test of tests) {
        const title = test.suitePath[0] || "Uncategorized";
        const suite = suites.get(title) || {
            title,
            passed: 0,
            failed: 0,
            pending: 0,
            durationMs: 0,
            files: new Set(),
            tests: [],
        };
        suite[test.status]++;
        suite.durationMs += test.durationMs;
        if (test.file) suite.files.add(test.file);
        suite.tests.push(test);
        suites.set(title, suite);
    }
    return [...suites.values()].sort((left, right) =>
        left.title.localeCompare(right.title)
    );
}

function renderTest(test) {
    const hierarchy = test.suitePath.slice(1).join(" › ");
    const detail = [
        hierarchy
            ? `<div><strong>Context:</strong> ${escapeHtml(hierarchy)}</div>`
            : "",
        test.file
            ? `<div><strong>File:</strong> <code>${escapeHtml(test.file)}</code></div>`
            : "",
        test.error
            ? `<div class="error"><strong>${escapeHtml(test.error.name)}</strong>: ${escapeHtml(test.error.message)}${
                  test.error.stack
                      ? `<pre>${escapeHtml(test.error.stack)}</pre>`
                      : ""
              }</div>`
            : `<div class="success-note">Completed without an assertion or runtime failure.</div>`,
    ].join("");

    return `<details class="test-row ${test.status}" data-status="${test.status}" data-search="${escapeHtml(
        `${test.fullTitle} ${test.file || ""}`.toLowerCase()
    )}">
        <summary>
            <span class="status-dot" aria-hidden="true"></span>
            <span class="test-name">${escapeHtml(test.title)}</span>
            <span class="test-duration">${formatDuration(test.durationMs)}</span>
        </summary>
        <div class="test-detail">${detail}</div>
    </details>`;
}

function renderSuite(suite, index) {
    const total = suite.tests.length;
    const rate = total ? ((suite.passed / total) * 100).toFixed(1) : "0.0";
    return `<section class="suite-card" data-suite="${escapeHtml(
        suite.title.toLowerCase()
    )}">
        <button class="suite-heading" type="button" aria-expanded="${
            index < 3 ? "true" : "false"
        }">
            <span>
                <span class="suite-kicker">Test suite</span>
                <strong>${escapeHtml(suite.title)}</strong>
            </span>
            <span class="suite-metrics">
                <span>${suite.passed}/${total} passed</span>
                <span>${rate}%</span>
                <span>${formatDuration(suite.durationMs)}</span>
                <span class="chevron">›</span>
            </span>
        </button>
        <div class="suite-body ${index < 3 ? "open" : ""}">
            <div class="suite-meta">${suite.files.size} source file${
                suite.files.size === 1 ? "" : "s"
            } · ${suite.failed} failed · ${suite.pending} pending</div>
            <div class="tests">${suite.tests.map(renderTest).join("")}</div>
        </div>
    </section>`;
}

function generateHtml(results, metadata) {
    const suites = summarizeSuites(results.tests);
    const files = new Set(results.tests.map((test) => test.file).filter(Boolean));
    const slowest = [...results.tests]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 10);
    const passRate = results.summary.total
        ? ((results.summary.passed / results.summary.total) * 100).toFixed(1)
        : "0.0";
    const generated = new Date(results.endedAt).toLocaleString("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
    });
    const status =
        results.summary.failed === 0 && results.hookFailures.length === 0
            ? "passed"
            : "failed";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETour Protocol — V3 Test Report</title>
<style>
:root{color-scheme:dark;--bg:#080b14;--panel:#111728;--panel2:#171f34;--line:#29334d;--text:#edf2ff;--muted:#91a0bd;--blue:#5b8cff;--violet:#9b6cff;--green:#32d296;--red:#ff647c;--amber:#ffbd5a}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 20% -10%,#24285b 0,transparent 34%),var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{max-width:1500px;margin:auto;padding:32px 22px 70px}.hero{position:relative;overflow:hidden;padding:58px 52px;border:1px solid #4d4b88;border-radius:24px;background:linear-gradient(135deg,#283d94,#6542a7 55%,#8b3fb2);box-shadow:0 24px 80px #0008}
.hero:after{content:"";position:absolute;width:470px;height:470px;border-radius:50%;right:-170px;top:-240px;background:#fff1}.eyebrow,.suite-kicker{text-transform:uppercase;letter-spacing:.16em;font-size:.72rem;font-weight:800;color:#c8d4ff}.hero h1{margin:8px 0 6px;font-size:clamp(2.3rem,5vw,4.7rem);line-height:1.02;letter-spacing:-.055em}.hero p{max-width:850px;margin:0;color:#e1e7ff;font-size:1.08rem}.badges{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.badge{padding:8px 13px;border:1px solid #ffffff38;border-radius:999px;background:#0c102a44;backdrop-filter:blur(8px)}.badge.good{border-color:#76f5c5;color:#8ff8d0}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin:24px 0}.stat{padding:24px;border:1px solid var(--line);border-radius:17px;background:linear-gradient(145deg,var(--panel2),var(--panel));box-shadow:0 10px 30px #0004}.stat span{display:block;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.1em;font-weight:750}.stat strong{display:block;margin-top:5px;font-size:2.15rem;letter-spacing:-.04em}.stat.good strong{color:var(--green)}.stat.bad strong{color:var(--red)}
.section{margin-top:34px}.section-title{display:flex;justify-content:space-between;gap:20px;align-items:end;margin:0 0 14px}.section-title h2{margin:0;font-size:1.65rem;letter-spacing:-.025em}.section-title p{margin:0;color:var(--muted)}
.controls{position:sticky;top:10px;z-index:5;display:flex;gap:10px;flex-wrap:wrap;padding:13px;margin:20px 0;border:1px solid var(--line);border-radius:15px;background:#101628e8;backdrop-filter:blur(14px)}input,button{font:inherit}#search{min-width:240px;flex:1;padding:11px 14px;color:var(--text);border:1px solid var(--line);border-radius:10px;background:#090e1c}.filter{padding:10px 14px;color:var(--text);border:1px solid var(--line);border-radius:10px;background:var(--panel2);cursor:pointer}.filter.active{border-color:var(--blue);background:#21386f}
.suite-card{margin:12px 0;border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}.suite-heading{width:100%;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 22px;text-align:left;color:var(--text);border:0;background:linear-gradient(100deg,#182038,#13192a);cursor:pointer}.suite-heading strong{display:block;margin-top:3px;font-size:1.08rem}.suite-metrics{display:flex;align-items:center;gap:18px;color:var(--muted);white-space:nowrap}.chevron{font-size:1.8rem;color:var(--blue);transition:.2s}.suite-heading[aria-expanded=true] .chevron{transform:rotate(90deg)}.suite-body{display:none;padding:0 17px 17px}.suite-body.open{display:block}.suite-meta{padding:12px 5px;color:var(--muted);font-size:.84rem}
.test-row{margin:7px 0;border:1px solid var(--line);border-radius:11px;background:#0d1322}.test-row[hidden]{display:none}.test-row summary{display:flex;align-items:center;gap:12px;padding:13px 14px;cursor:pointer;list-style:none}.test-row summary::-webkit-details-marker{display:none}.status-dot{width:9px;height:9px;flex:0 0 auto;border-radius:50%;background:var(--amber);box-shadow:0 0 0 4px #ffbd5a18}.passed .status-dot{background:var(--green);box-shadow:0 0 0 4px #32d29618}.failed .status-dot{background:var(--red);box-shadow:0 0 0 4px #ff647c18}.test-name{flex:1}.test-duration{color:var(--muted);font-variant-numeric:tabular-nums}.test-detail{padding:2px 36px 16px;color:var(--muted)}code,pre{font-family:"SFMono-Regular",Consolas,monospace}.test-detail code{color:#b8c8ff}.success-note{color:#6ed9b0}.error{margin-top:10px;color:#ffc0ca}.error pre{overflow:auto;padding:12px;border-radius:8px;background:#080b14;color:#e9a8b4}
.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}.panel{padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.panel h3{margin:0 0 15px}.slow{display:grid;grid-template-columns:1fr auto;gap:7px 15px;padding:8px 0;border-bottom:1px solid #202a40}.slow:last-child{border:0}.slow span:last-child{color:var(--amber)}.meta{display:grid;grid-template-columns:auto 1fr;gap:9px 14px}.meta dt{color:var(--muted)}.meta dd{margin:0;overflow-wrap:anywhere}.empty{padding:30px;text-align:center;color:var(--muted)}footer{margin-top:35px;padding:22px;text-align:center;color:var(--muted);border-top:1px solid var(--line)}
@media(max-width:950px){.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.hero{padding:40px 28px}.suite-metrics span:nth-child(2),.suite-metrics span:nth-child(3){display:none}}@media(max-width:560px){.stats{grid-template-columns:1fr}.suite-heading{padding:17px 14px}.shell{padding:15px 10px 45px}}
</style>
</head>
<body>
<main class="shell">
<header class="hero">
  <div class="eyebrow">ETour protocol · independently reproducible artifact</div>
  <h1>V3 Test Report</h1>
  <p>Complete behavioral validation of the V3 factory/instance architecture, tournament accounting, session authorization, browser SDK, ERC-4337 account abstraction, sponsorship policy, and recovery paths.</p>
  <div class="badges">
    <span class="badge ${status === "passed" ? "good" : ""}">${status === "passed" ? "✓ All tests passed" : "✕ Failures detected"}</span>
    <span class="badge">Generated ${escapeHtml(generated)}</span>
    <span class="badge">Commit ${escapeHtml(metadata.commit)}</span>
    <span class="badge">${escapeHtml(metadata.treeState)}</span>
  </div>
</header>
<section class="stats" aria-label="Test summary">
  <div class="stat"><span>Total tests</span><strong>${results.summary.total}</strong></div>
  <div class="stat good"><span>Passing</span><strong>${results.summary.passed}</strong></div>
  <div class="stat ${results.summary.failed ? "bad" : ""}"><span>Failing</span><strong>${results.summary.failed}</strong></div>
  <div class="stat"><span>Pass rate</span><strong>${passRate}%</strong></div>
  <div class="stat"><span>Duration</span><strong>${formatDuration(results.durationMs)}</strong></div>
</section>
<section class="section">
  <div class="section-title"><div><div class="eyebrow">Evidence map</div><h2>Suite organization</h2></div><p>${suites.length} top-level suites · ${files.size} test files</p></div>
  <div class="controls">
    <input id="search" type="search" placeholder="Search tests, suites, or files…" aria-label="Search tests">
    <button class="filter active" data-filter="all">All</button>
    <button class="filter" data-filter="passed">Passed</button>
    <button class="filter" data-filter="failed">Failed</button>
    <button class="filter" id="expand-all">Expand suites</button>
  </div>
  <div id="suite-list">${suites.map(renderSuite).join("")}</div>
  <div class="empty" id="empty" hidden>No tests match the current filters.</div>
</section>
<section class="section grid">
  <div class="panel"><h3>Slowest scenarios</h3>${slowest
      .map(
          (test) =>
              `<div class="slow"><span>${escapeHtml(test.fullTitle)}</span><span>${formatDuration(test.durationMs)}</span></div>`
      )
      .join("")}</div>
  <div class="panel"><h3>Run provenance</h3><dl class="meta">
    <dt>Command</dt><dd><code>npm run test:report</code></dd>
    <dt>Started</dt><dd>${escapeHtml(results.startedAt)}</dd>
    <dt>Completed</dt><dd>${escapeHtml(results.endedAt)}</dd>
    <dt>Node</dt><dd>${escapeHtml(process.version)}</dd>
    <dt>Platform</dt><dd>${escapeHtml(`${process.platform} ${process.arch}`)}</dd>
    <dt>Commit</dt><dd><code>${escapeHtml(metadata.fullCommit)}</code></dd>
    <dt>Tree</dt><dd>${escapeHtml(metadata.treeState)}</dd>
    <dt>Hook failures</dt><dd>${results.hookFailures.length}</dd>
  </dl></div>
</section>
<footer>Generated from the actual V3 Mocha/Hardhat run. This report contains no external scripts, fonts, trackers, or network dependencies.</footer>
</main>
<script>
const search=document.querySelector("#search"),filters=[...document.querySelectorAll(".filter[data-filter]")],rows=[...document.querySelectorAll(".test-row")],suites=[...document.querySelectorAll(".suite-card")];let active="all";
function apply(){const q=search.value.trim().toLowerCase();let visible=0;for(const row of rows){const show=(active==="all"||row.dataset.status===active)&&(!q||row.dataset.search.includes(q));row.hidden=!show;if(show)visible++}for(const suite of suites){const shown=[...suite.querySelectorAll(".test-row")].some(r=>!r.hidden);suite.hidden=!shown;if(q&&shown){suite.querySelector(".suite-body").classList.add("open");suite.querySelector(".suite-heading").setAttribute("aria-expanded","true")}}document.querySelector("#empty").hidden=visible!==0}
search.addEventListener("input",apply);for(const button of filters)button.addEventListener("click",()=>{active=button.dataset.filter;filters.forEach(b=>b.classList.toggle("active",b===button));apply()});
document.querySelectorAll(".suite-heading").forEach(button=>button.addEventListener("click",()=>{const body=button.nextElementSibling,open=!body.classList.contains("open");body.classList.toggle("open",open);button.setAttribute("aria-expanded",String(open))}));
document.querySelector("#expand-all").addEventListener("click",event=>{const open=event.target.textContent.includes("Expand");document.querySelectorAll(".suite-body").forEach(body=>body.classList.toggle("open",open));document.querySelectorAll(".suite-heading").forEach(button=>button.setAttribute("aria-expanded",String(open)));event.target.textContent=open?"Collapse suites":"Expand suites"});
</script>
</body>
</html>`;
}

console.log("Building the V3 browser SDK...");
const sdkStatus = run("npm", ["run", "sdk:build"]);
if (sdkStatus !== 0) process.exit(sdkStatus);

console.log("\nRunning the complete V3 Hardhat test suite...");
const hardhatPath = path.join(V3_DIR, "node_modules", ".bin", "hardhat");
const testStatus = run(hardhatPath, ["test"], {
    ...process.env,
    V3_TEST_REPORT_JSON: RESULTS_PATH,
});

if (!fs.existsSync(RESULTS_PATH)) {
    console.error(
        "Test report generation failed: the V3 reporter did not produce results."
    );
    process.exit(testStatus || 1);
}

const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
fs.rmSync(RESULTS_PATH, { force: true });
const fullCommit = gitValue(["rev-parse", "HEAD"]);
const treeState =
    gitValue(["status", "--porcelain"], "") === ""
        ? "clean source tree"
        : "dirty development tree";
const metadata = {
    fullCommit,
    commit: fullCommit.slice(0, 12),
    treeState,
};
const html = generateHtml(results, metadata);
const temporaryPath = `${OUTPUT_PATH}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, html, "utf8");
fs.renameSync(temporaryPath, OUTPUT_PATH);

console.log(`\nV3 HTML test report generated: ${OUTPUT_PATH}`);
console.log(
    `Result: ${results.summary.passed}/${results.summary.total} passed, ` +
        `${results.summary.failed} failed, ${results.summary.pending} pending.`
);
process.exit(testStatus);
