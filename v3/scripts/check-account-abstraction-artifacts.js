import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { keccak256 } from "ethers";
import solc from "solc";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(V3_DIR, "node_modules");
const AA_ROOT = path.join(
    NODE_MODULES,
    "@account-abstraction",
    "contracts"
);

const TARGETS = [
    [
        "contracts/core/EntryPoint.sol",
        "EntryPoint",
        "0x2a7c999e10f113d5f71f2abb9069a95091852afbd016309139559b9e47bb59dd",
        "0x518c4e21fe3b27a59a3914d37988fbb30bd892e7d86333a6ed85cf7dc093a052",
    ],
    [
        "contracts/accounts/SimpleAccount.sol",
        "SimpleAccount",
        "0x07189e53de89fdd954eafab24194ade337af2ef16d2147fbeafbefb95b3ed23e",
        "0x013b950eb5d44a379995379da00f9fdf0cc2bfce392e4b476defc6b61e8928c4",
    ],
    [
        "contracts/accounts/SimpleAccountFactory.sol",
        "SimpleAccountFactory",
        "0x59fab2d3ec602f4ee808d7ca07b15ffeae2c42e8e0215f230399226a94b1cf9d",
        "0x81a1a5e5faf3f52e1831f910a1fc05c9461ae5e92bf5e1ca48a2800bab15b354",
    ],
];

function sourcePath(sourceName) {
    if (sourceName.startsWith("contracts/")) {
        return path.join(AA_ROOT, sourceName.slice("contracts/".length));
    }
    if (sourceName.startsWith("@")) {
        return path.join(NODE_MODULES, sourceName);
    }
    return null;
}

function findImports(sourceName) {
    const resolved = sourcePath(sourceName);
    if (!resolved || !fs.existsSync(resolved)) {
        return { error: `Unresolved Solidity import: ${sourceName}` };
    }
    return { contents: fs.readFileSync(resolved, "utf8") };
}

const sources = Object.fromEntries(
    [
        "contracts/core/EntryPoint.sol",
        "contracts/accounts/SimpleAccountFactory.sol",
    ].map((sourceName) => [
        sourceName,
        {
            content: fs.readFileSync(sourcePath(sourceName), "utf8"),
        },
    ])
);
const input = {
    language: "Solidity",
    sources,
    settings: {
        evmVersion: "cancun",
        viaIR: true,
        optimizer: {
            enabled: true,
            runs: 1_000_000,
        },
        outputSelection: {
            "*": {
                "*": [
                    "abi",
                    "evm.bytecode.object",
                    "evm.deployedBytecode.object",
                ],
            },
        },
    },
};
const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
);
const errors = (output.errors ?? []).filter(
    (diagnostic) => diagnostic.severity === "error"
);
if (errors.length > 0) {
    for (const diagnostic of errors) {
        console.error(diagnostic.formattedMessage);
    }
    process.exit(1);
}

for (
    const [
        sourceName,
        contractName,
        expectedCreationHash,
        expectedRuntimeHash,
    ] of TARGETS
) {
    const compiled = output.contracts?.[sourceName]?.[contractName];
    if (!compiled) {
        throw new Error(`Missing compiled ${sourceName}:${contractName}`);
    }
    const artifact = require(
        `@account-abstraction/contracts/artifacts/${contractName}.json`
    );
    const abiMatches =
        JSON.stringify(compiled.abi) === JSON.stringify(artifact.abi);
    const packageCreationMatches =
        keccak256(artifact.bytecode) === expectedCreationHash;
    const packageRuntimeMatches =
        keccak256(artifact.deployedBytecode) === expectedRuntimeHash;
    if (
        !abiMatches ||
        !packageCreationMatches ||
        !packageRuntimeMatches
    ) {
        throw new Error(
            `${contractName} compiler ABI or pinned artifact hash changed ` +
            `(packageRuntime=${packageRuntimeMatches}, ` +
            `abi=${abiMatches}, packageCreation=` +
            `${packageCreationMatches})`
        );
    }
}

console.log(
    `ERC-4337 artifact check passed: ${TARGETS.length} v0.8 source ` +
    `interfaces compile with solc ${solc.version()}, Cancun, via-IR, and ` +
    "1,000,000 optimizer runs; official package artifact hashes are pinned."
);
