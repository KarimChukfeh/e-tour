import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    FailoverBundler,
    JsonRpcBundler,
} from "../sdk/bundler-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(
    fs.readFileSync(
        path.join(
            __dirname,
            "..",
            "config",
            "account-abstraction.json"
        ),
        "utf8"
    )
);
const network = process.env.AA_NETWORK ?? "arbitrumOne";
const entryPoint = config.entryPoint.networks[network]?.address;
if (!entryPoint) {
    throw new Error(`unsupported AA_NETWORK ${network}`);
}

function resolveEnvironment(value) {
    const missing = [];
    const url = value.replace(/\$\{([^}]+)\}/g, (_, name) => {
        if (!process.env[name]) missing.push(name);
        return process.env[name] ?? "";
    });
    return { url, missing };
}

const providers = [];
const skipped = [];
for (const configured of config.productionBundlerCandidates) {
    const template = configured.networks[network];
    if (!template) continue;
    const resolved = resolveEnvironment(template);
    if (resolved.missing.length > 0) {
        skipped.push({
            name: configured.name,
            missing: resolved.missing,
        });
        continue;
    }
    providers.push(
        new JsonRpcBundler({
            name: configured.name,
            url: resolved.url,
            timeoutMs: 10_000,
        })
    );
}

if (providers.length < 2) {
    console.error(
        JSON.stringify(
            {
                network,
                entryPoint,
                status: "not-ready",
                configuredProviders:
                    config.productionBundlerCandidates.length,
                runnableProviders: providers.length,
                skipped,
            },
            null,
            2
        )
    );
    process.exit(1);
}

const client = new FailoverBundler({ providers, entryPoint });
const health = await client.healthCheck();
console.log(
    JSON.stringify(
        { network, entryPoint, health, skipped },
        (_, value) =>
            value instanceof Error ? value.message : value,
        2
    )
);
if (health.filter((item) => item.healthy).length < 2) {
    process.exit(1);
}
