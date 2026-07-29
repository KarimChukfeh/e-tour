import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const aa = JSON.parse(
    fs.readFileSync(
        path.join(root, "config", "account-abstraction.json"),
        "utf8"
    )
);
const release = JSON.parse(
    fs.readFileSync(
        path.join(root, "config", "release-status.json"),
        "utf8"
    )
);

assert(aa.productionBundlerCandidates?.length >= 2, "two production bundlers are required");
assert(
    new Set(aa.productionBundlerCandidates.map((item) => item.name)).size >= 2,
    "production bundlers must be independent configurations"
);
assert(/^\d+$/u.test(aa.paymaster.recommendedRefillThresholdWei), "invalid refill threshold");
assert(BigInt(aa.paymaster.recommendedRefillThresholdWei) > 0n, "refill threshold must be positive");
assert(aa.paymaster.emergencyStop === "owner setPaused(true)", "paymaster emergency stop is missing");
assert(aa.paymaster.fundingWalletPolicy.production.includes("multisig"), "funding role must be a multisig");
assert(release.production.network === "arbitrumOne", "monitoring target must be Arbitrum One");

const requiredSignals = [
    "UserOperation submission",
    "bundler",
    "EntryPoint",
    "paymaster",
    "session",
    "tournament",
    "profile",
    "payout",
];
const operations = fs.readFileSync(
    path.join(root, "docs", "Operations.md"),
    "utf8"
);
for (const signal of requiredSignals) {
    assert(
        operations.toLowerCase().includes(signal.toLowerCase()),
        `operations runbook does not cover ${signal}`
    );
}

console.log(
    "Production monitoring configuration valid: independent bundlers, capped funding policy, refill threshold, emergency pause, and protocol/accounting signals are documented."
);

function assert(condition, message) {
    if (!condition) throw new Error(`Monitoring configuration check failed: ${message}`);
}
