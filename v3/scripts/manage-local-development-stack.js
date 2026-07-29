import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const HARDHAT_CLI = path.join(
    V3_DIR,
    "node_modules",
    "hardhat",
    "internal",
    "cli",
    "cli.js"
);
const STATE_DIRECTORY = path.join(V3_DIR, "cache", "local-stack");
const STATE_FILE = path.join(STATE_DIRECTORY, "state.json");
const LOG_FILE = path.join(STATE_DIRECTORY, "node.log");
const HOST = "127.0.0.1";
const PORT = Number(process.env.LOCAL_STACK_PORT ?? "8545");
const RPC_URL = `http://${HOST}:${PORT}`;
const EXPECTED_CHAIN_ID = "412346";
const mode = process.argv[2] ?? "fresh";

if (!["fresh", "stop", "status"].includes(mode)) {
    throw new Error(`Unknown mode '${mode}'. Use fresh, stop, or status.`);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("LOCAL_STACK_PORT must be a valid TCP port.");
}

if (mode === "stop") {
    await stopExistingLocalNode();
    console.log(`Local V3 backend stopped (${RPC_URL}).`);
} else if (mode === "status") {
    const chainId = await rpcChainId();
    if (chainId === null) {
        console.log(`Local V3 backend is not running at ${RPC_URL}.`);
        process.exitCode = 1;
    } else {
        console.log(
            `Local V3 backend is running at ${RPC_URL} ` +
                `(chain ID ${chainId}).`
        );
    }
} else {
    await startFreshStack();
}

async function startFreshStack() {
    console.log(`Resetting the local V3 backend at ${RPC_URL}...`);
    await stopExistingLocalNode();
    fs.mkdirSync(STATE_DIRECTORY, { recursive: true });

    const logDescriptor = fs.openSync(LOG_FILE, "w", 0o600);
    const node = spawn(
        process.execPath,
        [
            HARDHAT_CLI,
            "node",
            "--hostname",
            HOST,
            "--port",
            String(PORT),
        ],
        {
            cwd: V3_DIR,
            env: process.env,
            stdio: ["ignore", logDescriptor, logDescriptor],
        }
    );
    fs.closeSync(logDescriptor);

    try {
        await waitForRpc(EXPECTED_CHAIN_ID, node.pid);
        writeState(node.pid);
        runStep(
            "Deploy complete V3 stack",
            process.execPath,
            [
                HARDHAT_CLI,
                "run",
                "scripts/deploy-all-factory.js",
                "--network",
                "localhost",
            ],
            { FORCE: "1" }
        );
        runStep(
            "Validate deployment manifest",
            process.execPath,
            [
                "scripts/check-deployment-manifest.js",
                "--network",
                "localhost",
            ]
        );
        runStep(
            "Smoke-test deployed bytecode and wiring",
            process.execPath,
            [
                HARDHAT_CLI,
                "run",
                "scripts/smoke-deployment.js",
                "--network",
                "localhost",
            ]
        );
    } catch (error) {
        await terminateProcess(node.pid);
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        throw error;
    }

    const accounts = await rpc("eth_accounts");
    console.log("");
    console.log("Fresh local V3 backend is ready.");
    console.log(`  RPC:       ${RPC_URL}`);
    console.log(`  Chain ID:  ${EXPECTED_CHAIN_ID}`);
    console.log(`  Accounts:  ${accounts.length} deterministic funded wallets`);
    console.log(`  First:     ${accounts[0]}`);
    console.log(`  Manifest:  v3/deployments/localhost/manifest.json`);
    console.log(`  Node log:  v3/cache/local-stack/node.log`);
    console.log("");
    console.log("Keep this terminal open while developing.");
    console.log(
        "Stop with Ctrl-C here, or run in another terminal: " +
            "npm --prefix v3 run local:stack:stop"
    );
    await keepNodeAlive(node);
}

function runStep(label, command, args, extraEnvironment = {}) {
    console.log(`\n[local-stack] ${label}`);
    const result = spawnSync(command, args, {
        cwd: V3_DIR,
        env: {
            ...process.env,
            LOCAL_RPC_URL: RPC_URL,
            ...extraEnvironment,
        },
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${label} failed with exit code ${result.status}.`);
    }
}

function writeState(pid) {
    fs.writeFileSync(
        STATE_FILE,
        `${JSON.stringify(
            {
                schemaVersion: 1,
                pid,
                managerPid: process.pid,
                rpcUrl: RPC_URL,
                chainId: EXPECTED_CHAIN_ID,
                startedAt: new Date().toISOString(),
                logFile: LOG_FILE,
            },
            null,
            2
        )}\n`,
        { encoding: "utf8", mode: 0o600 }
    );
}

async function stopExistingLocalNode() {
    const pids = new Set();
    let managedState = null;
    if (fs.existsSync(STATE_FILE)) {
        try {
            managedState = JSON.parse(
                fs.readFileSync(STATE_FILE, "utf8")
            );
            if (Number.isInteger(managedState.pid)) {
                pids.add(managedState.pid);
            }
        } catch {
            // A malformed cache file is ignored; the listener check below is
            // authoritative.
        }
    }

    if (
        Number.isInteger(managedState?.managerPid) &&
        managedState.managerPid !== process.pid &&
        processExists(managedState.managerPid)
    ) {
        const managerCommand = processCommand(
            managedState.managerPid
        );
        if (!/manage-local-development-stack\.js\s+fresh/u.test(managerCommand)) {
            throw new Error(
                `Cached manager PID ${managedState.managerPid} belongs to ` +
                    `an unrecognized process: ${managerCommand || "unknown"}.`
            );
        }
        await terminateProcess(managedState.managerPid);
        const deadline = Date.now() + 5_000;
        while ((await rpcChainId()) !== null && Date.now() < deadline) {
            await delay(100);
        }
        if ((await rpcChainId()) === null) {
            if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
            return;
        }
    }

    for (const pid of listenerPids(PORT)) pids.add(pid);
    for (const pid of pids) {
        if (!processExists(pid)) continue;
        const command = processCommand(pid);
        if (!isRecognizedLocalNode(command)) {
            throw new Error(
                `Port ${PORT} is owned by an unrecognized process ` +
                    `(PID ${pid}: ${command || "unknown"}). Stop it manually.`
            );
        }
        await terminateProcess(pid);
    }

    const deadline = Date.now() + 5_000;
    while ((await rpcChainId()) !== null && Date.now() < deadline) {
        await delay(100);
    }
    if ((await rpcChainId()) !== null) {
        throw new Error(`Could not release ${RPC_URL}.`);
    }
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

function listenerPids(port) {
    const result = spawnSync(
        "lsof",
        [
            "-nP",
            `-iTCP:${port}`,
            "-sTCP:LISTEN",
            "-t",
        ],
        { encoding: "utf8" }
    );
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(
            `Could not inspect port ${port}: ${result.stderr.trim()}`
        );
    }
    return result.stdout
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isInteger);
}

function processCommand(pid) {
    const result = spawnSync(
        "ps",
        ["-p", String(pid), "-o", "command="],
        { encoding: "utf8" }
    );
    return result.status === 0 ? result.stdout.trim() : "";
}

function isRecognizedLocalNode(command) {
    return (
        /(?:^|[/\s])anvil(?:\s|$)/u.test(command) ||
        (/hardhat/u.test(command) && /\bnode\b/u.test(command))
    );
}

function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function terminateProcess(pid) {
    if (!processExists(pid)) return;
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (processExists(pid) && Date.now() < deadline) {
        await delay(100);
    }
    if (processExists(pid)) process.kill(pid, "SIGKILL");
}

async function keepNodeAlive(node) {
    await new Promise((resolve, reject) => {
        let shuttingDown = false;
        const shutdown = async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            try {
                await terminateProcess(node.pid);
                if (fs.existsSync(STATE_FILE)) {
                    fs.unlinkSync(STATE_FILE);
                }
                resolve();
            } catch (error) {
                reject(error);
            }
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        node.once("exit", (code, signal) => {
            if (shuttingDown) return;
            if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
            reject(
                new Error(
                    `Local Hardhat node stopped unexpectedly ` +
                        `(code ${code ?? "none"}, signal ${signal ?? "none"}). ` +
                        `See ${LOG_FILE}.`
                )
            );
        });
    });
}

async function waitForRpc(expectedChainId, pid) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (!processExists(pid)) {
            throw new Error(
                `Local Hardhat node exited during startup. See ${LOG_FILE}.`
            );
        }
        if ((await rpcChainId()) === expectedChainId) return;
        await delay(250);
    }
    throw new Error(
        `Local Hardhat node did not become ready in 30 seconds. ` +
            `See ${LOG_FILE}.`
    );
}

async function rpcChainId() {
    try {
        const value = await rpc("eth_chainId");
        return BigInt(value).toString();
    } catch {
        return null;
    }
}

async function rpc(method, params = []) {
    const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
        }),
        signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
        throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (payload.error) {
        throw new Error(
            `RPC ${method} failed: ${payload.error.message}`
        );
    }
    return payload.result;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
