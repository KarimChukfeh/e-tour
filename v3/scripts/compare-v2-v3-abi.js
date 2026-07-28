import fs from "fs";
import path from "path";
import { Fragment } from "ethers";

const V3_ROOT = process.cwd();
const REPOSITORY_ROOT = path.resolve(V3_ROOT, "..");
const BASELINE = path.join(
    V3_ROOT,
    "baselines",
    "v2-v3-abi-diff.json"
);
const write = process.argv.includes("--write");
const comparisons = [
    {
        name: "TicTacChainFactory",
        v2: ["TicTacChainFactory-ABI.json", "factory"],
        v3: "artifacts/contracts/TicTacChainFactory.sol/TicTacChainFactory.json",
    },
    {
        name: "TicTacInstance",
        v2: ["TicTacChainFactory-ABI.json", "instance"],
        v3: "artifacts/contracts/TicTacInstance.sol/TicTacInstance.json",
    },
    {
        name: "ConnectFourFactory",
        v2: ["ConnectFourFactory-ABI.json", "factory"],
        v3: "artifacts/contracts/ConnectFourFactory.sol/ConnectFourFactory.json",
    },
    {
        name: "ConnectFourInstance",
        v2: ["ConnectFourFactory-ABI.json", "instance"],
        v3: "artifacts/contracts/ConnectFourInstance.sol/ConnectFourInstance.json",
    },
    {
        name: "ChessOnChainFactory",
        v2: ["ChessOnChainFactory-ABI.json", "factory"],
        v3: "artifacts/contracts/ChessOnChainFactory.sol/ChessOnChainFactory.json",
    },
    {
        name: "ChessInstance",
        v2: ["ChessOnChainFactory-ABI.json", "instance"],
        v3: "artifacts/contracts/ChessInstance.sol/ChessInstance.json",
    },
    {
        name: "PlayerRegistry",
        v2: ["PlayerRegistry-ABI.json", "contract"],
        v3: "artifacts/contracts/PlayerRegistry.sol/PlayerRegistry.json",
    },
    {
        name: "PlayerProfile",
        v2: ["PlayerProfile-ABI.json", "contract"],
        v3: "artifacts/contracts/PlayerProfile.sol/PlayerProfile.json",
    },
];

const contracts = {};
for (const comparison of comparisons) {
    const v2Bundle = JSON.parse(
        fs.readFileSync(
            path.join(
                REPOSITORY_ROOT,
                "v2",
                "deployments",
                comparison.v2[0]
            ),
            "utf8"
        )
    );
    const v2Abi =
        nested(v2Bundle, comparison.v2.slice(1))?.abi ??
        nested(v2Bundle, comparison.v2);
    const v3Abi = JSON.parse(
        fs.readFileSync(
            path.join(V3_ROOT, comparison.v3),
            "utf8"
        )
    ).abi;
    const v2 = surface(v2Abi);
    const v3 = surface(v3Abi);
    contracts[comparison.name] = {
        added: v3.filter((item) => !v2.includes(item)),
        removed: v2.filter((item) => !v3.includes(item)),
        unchangedCount: v3.filter((item) => v2.includes(item))
            .length,
    };
}

const report = {
    schemaVersion: 1,
    policy:
        "Reviewed V2-to-V3 public ABI delta; changes require an explicit baseline update.",
    contracts,
};
if (write) {
    fs.writeFileSync(
        BASELINE,
        `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(`Wrote ${BASELINE}`);
} else {
    if (!fs.existsSync(BASELINE)) {
        throw new Error(
            `${BASELINE} is missing; review and capture with --write`
        );
    }
    const expected = JSON.parse(
        fs.readFileSync(BASELINE, "utf8")
    );
    if (JSON.stringify(expected) !== JSON.stringify(report)) {
        console.error(
            "V2-to-V3 ABI delta changed; review it before updating the baseline."
        );
        process.exit(1);
    }
    console.log(
        `V2-to-V3 ABI comparison passed for ${comparisons.length} contract surfaces.`
    );
}

function nested(value, keys) {
    return keys.reduce((current, key) => current?.[key], value);
}

function surface(abi) {
    return abi
        .filter((item) =>
            ["function", "event", "error"].includes(item.type)
        )
        .map((item) => Fragment.from(item).format("sighash"))
        .sort();
}
