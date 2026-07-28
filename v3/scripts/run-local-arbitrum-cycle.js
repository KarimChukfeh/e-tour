import path from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const v3Directory = path.resolve(__dirname, "..");
const hardhatCli = path.join(
    v3Directory,
    "node_modules",
    "hardhat",
    "internal",
    "cli",
    "cli.js"
);
const config = path.join(
    v3Directory,
    "hardhat.arbitrum-local.config.js"
);
const port = Number(process.env.ARBITRUM_LOCAL_PORT ?? "8546");
const rpcUrl = `http://127.0.0.1:${port}`;
const full = process.argv.includes("--full");
for (const argument of process.argv.slice(2)) {
    if (argument !== "--full") {
        throw new Error(`unknown argument ${argument}`);
    }
}

const occupiedChainId = await rpcChainId(rpcUrl);
if (occupiedChainId !== null) {
    throw new Error(
        `${rpcUrl} is already in use (chain ID ${occupiedChainId}); stop the ` +
            "existing node or set ARBITRUM_LOCAL_PORT"
    );
}

console.log(
    `Starting isolated local Arbitrum simulation on ${rpcUrl} ` +
        "(chain ID 42161; funded Hardhat development wallets)"
);
const node = spawn(
    process.execPath,
    [
        hardhatCli,
        "--config",
        config,
        "node",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
    ],
    {
        cwd: v3Directory,
        env: {
            ...process.env,
            ARBITRUM_LOCAL_PORT: String(port),
        },
        // Hardhat prints deterministic development private keys and every RPC
        // call to stdout. Discard it so secrets never reach CI logs. Capture
        // only the bounded stderr startup diagnostics; stderr is not used for
        // normal RPC logging.
        stdio: ["ignore", "ignore", "pipe"],
    }
);
let startupError = "";
node.stderr.on("data", (chunk) => {
    if (startupError.length < 4_000) {
        startupError += chunk.toString().slice(0, 4_000 - startupError.length);
    }
});

let stopped = false;
node.once("exit", () => {
    stopped = true;
});

try {
    await waitForRpc(rpcUrl, node, () => startupError);
    const steps = [
        ["Build browser SDK", "npm", ["run", "sdk:build"]],
        [
            "Compile contracts",
            process.execPath,
            [hardhatCli, "--config", config, "compile"],
        ],
        [
            "Deploy complete V3 stack",
            process.execPath,
            [
                hardhatCli,
                "--config",
                config,
                "run",
                "scripts/deploy-all-factory.js",
                "--network",
                "arbitrumLocal",
            ],
            { FORCE: "1" },
        ],
        [
            "Validate canonical manifest",
            process.execPath,
            [
                "scripts/check-deployment-manifest.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Check canonical EntryPoint",
            process.execPath,
            [
                hardhatCli,
                "--config",
                config,
                "run",
                "scripts/check-entrypoint.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Check two funded local bundlers",
            process.execPath,
            [
                hardhatCli,
                "--config",
                config,
                "run",
                "scripts/check-local-bundlers.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Smoke deployed wiring",
            process.execPath,
            [
                hardhatCli,
                "--config",
                config,
                "run",
                "scripts/smoke-deployment.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Run local Arbitrum acceptance",
            process.execPath,
            [
                hardhatCli,
                "--config",
                config,
                "run",
                "scripts/local-arbitrum-acceptance.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Regenerate network-scoped ABIs",
            process.execPath,
            [
                "scripts/regenerate-abis.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        [
            "Revalidate canonical manifest",
            process.execPath,
            [
                "scripts/check-deployment-manifest.js",
                "--network",
                "arbitrumLocal",
            ],
        ],
        ["Check secret-safe output", "npm", ["run", "secrets:check"]],
        ["Check contract sizes", "npm", ["run", "size"]],
    ];
    if (full) {
        steps.push(
            ["Run complete tests", "npm", ["test"]],
            [
                "Run complete CI policy gates",
                "npm",
                ["run", "ci:checks"],
            ]
        );
    }
    for (const [label, command, args, extraEnvironment] of steps) {
        runStep(label, command, args, extraEnvironment);
    }
    console.log(
        `Local Arbitrum cycle passed${full ? " with full regression gates" : ""}.`
    );
} finally {
    if (!stopped) {
        node.kill("SIGTERM");
        await Promise.race([
            new Promise((resolve) => node.once("exit", resolve)),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (!stopped) node.kill("SIGKILL");
    }
}

function runStep(label, command, args, extraEnvironment = {}) {
    console.log(`\n[local-arbitrum] ${label}`);
    const result = spawnSync(command, args, {
        cwd: v3Directory,
        env: {
            ...process.env,
            ARBITRUM_LOCAL_PORT: String(port),
            ...extraEnvironment,
        },
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${label} failed with exit code ${result.status}`
        );
    }
}

async function waitForRpc(url, child, getStartupError) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                "local Hardhat node exited before becoming ready" +
                    formatStartupError(getStartupError())
            );
        }
        if ((await rpcChainId(url)) === "42161") return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
        "local Hardhat node did not become ready in 30 seconds" +
            formatStartupError(getStartupError())
    );
}

function formatStartupError(value) {
    const clean = value.trim();
    return clean ? `:\n${clean}` : "";
}

async function rpcChainId(url) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_chainId",
                params: [],
            }),
            signal: AbortSignal.timeout(500),
        });
        if (!response.ok) return null;
        const payload = await response.json();
        if (typeof payload.result !== "string") return null;
        return BigInt(payload.result).toString();
    } catch {
        return null;
    }
}
