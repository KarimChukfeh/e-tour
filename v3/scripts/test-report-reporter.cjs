const fs = require("fs");
const path = require("path");
const Mocha = require("mocha");

const {
    EVENT_RUN_BEGIN,
    EVENT_RUN_END,
    EVENT_TEST_PASS,
    EVENT_TEST_FAIL,
    EVENT_TEST_PENDING,
} = Mocha.Runner.constants;

function suitePath(test) {
    const suites = [];
    let current = test.parent;
    while (current && current.title) {
        suites.unshift(current.title);
        current = current.parent;
    }
    return suites;
}

function serializeError(error) {
    if (!error) return null;
    return {
        name: error.name || "Error",
        message: error.message || String(error),
        stack: error.stack || null,
        actual: error.actual === undefined ? null : String(error.actual),
        expected:
            error.expected === undefined ? null : String(error.expected),
    };
}

class V3TestReportReporter {
    constructor(runner) {
        this.runner = runner;
        this.startedAt = null;
        this.tests = [];
        this.hookFailures = [];

        runner
            .once(EVENT_RUN_BEGIN, () => {
                this.startedAt = new Date();
            })
            .on(EVENT_TEST_PASS, (test) => {
                this.tests.push(this.serializeTest(test, "passed"));
            })
            .on(EVENT_TEST_PENDING, (test) => {
                this.tests.push(this.serializeTest(test, "pending"));
            })
            .on(EVENT_TEST_FAIL, (runnable, error) => {
                if (runnable.type === "test") {
                    this.tests.push(
                        this.serializeTest(runnable, "failed", error)
                    );
                    return;
                }
                this.hookFailures.push({
                    title: runnable.fullTitle(),
                    suitePath: suitePath(runnable),
                    error: serializeError(error),
                });
            })
            .once(EVENT_RUN_END, () => this.writeReport());
    }

    serializeTest(test, status, error = null) {
        return {
            title: test.title,
            fullTitle: test.fullTitle(),
            suitePath: suitePath(test),
            file: test.file
                ? path.relative(process.cwd(), test.file)
                : null,
            status,
            durationMs: test.duration || 0,
            speed: test.speed || null,
            error: serializeError(error),
        };
    }

    writeReport() {
        const outputPath = process.env.V3_TEST_REPORT_JSON;
        if (!outputPath) {
            throw new Error(
                "V3_TEST_REPORT_JSON must name the reporter output file"
            );
        }

        const endedAt = new Date();
        const stats = this.runner.stats || {};
        const payload = {
            schemaVersion: 1,
            project: "ETour V3",
            startedAt: this.startedAt?.toISOString() || null,
            endedAt: endedAt.toISOString(),
            durationMs:
                stats.duration ||
                (this.startedAt ? endedAt - this.startedAt : 0),
            summary: {
                total: stats.tests || this.tests.length,
                passed: stats.passes || 0,
                failed: stats.failures || 0,
                pending: stats.pending || 0,
            },
            tests: this.tests,
            hookFailures: this.hookFailures,
        };

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const temporaryPath = `${outputPath}.${process.pid}.tmp`;
        fs.writeFileSync(
            temporaryPath,
            `${JSON.stringify(payload, null, 2)}\n`,
            "utf8"
        );
        fs.renameSync(temporaryPath, outputPath);
    }
}

module.exports = V3TestReportReporter;
