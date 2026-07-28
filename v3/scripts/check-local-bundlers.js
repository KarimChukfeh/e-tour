import { createRequire } from "module";
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { FailoverBundler } from "../sdk/bundler-client.js";
import { LocalBundler } from "../sdk/local-bundler.js";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";
import {
    isLocalDevelopmentNetwork,
} from "./lib/deployment-output.js";

if (!isLocalDevelopmentNetwork(hre.network.name)) {
    throw new Error("local bundler checks require a local Hardhat network");
}

const require = createRequire(import.meta.url);
const entryPointArtifact = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const config = JSON.parse(
    fs.readFileSync(
        path.join(
            process.cwd(),
            "config",
            "account-abstraction.json"
        ),
        "utf8"
    )
);
const configured = config.localBundlers ?? [];
if (configured.length < 2) {
    throw new Error("at least two local bundlers must be configured");
}

const { manifest } = loadDeploymentManifest(hre.network.name);
const entryPointAddress = requiredAddress(
    manifest.accountAbstraction?.entryPoint,
    "manifest accountAbstraction.entryPoint"
);
const entryPoint = new hre.ethers.Contract(
    entryPointAddress,
    entryPointArtifact.abi,
    hre.ethers.provider
);
const signers = await hre.ethers.getSigners();
const providers = configured.map((item) => {
    const signer = signers[item.fundedSignerIndex];
    if (!signer) {
        throw new Error(
            `missing funded signer ${item.fundedSignerIndex} for ${item.name}`
        );
    }
    const bundler = new LocalBundler({
        entryPoint,
        bundlerSigner: signer,
    });
    return {
        name: item.name,
        signer: signer.address,
        async request(request) {
            return bundler.request(request);
        },
    };
});
const client = new FailoverBundler({
    providers,
    entryPoint: entryPointAddress,
});
const health = await client.healthCheck();
const supported = await client.request({
    method: "eth_supportedEntryPoints",
    params: [],
});
const balances = await Promise.all(
    providers.map(async (provider) => ({
        name: provider.name,
        signer: provider.signer,
        balanceWei: (
            await hre.ethers.provider.getBalance(
                provider.signer
            )
        ).toString(),
    }))
);
const ready =
    health.every((item) => item.healthy) &&
    supported
        .map(hre.ethers.getAddress)
        .includes(hre.ethers.getAddress(entryPointAddress)) &&
    balances.every((item) => BigInt(item.balanceWei) > 0n);

console.log(
    JSON.stringify(
        {
            status: ready ? "healthy" : "invalid",
            network: hre.network.name,
            chainId: (
                await hre.ethers.provider.getNetwork()
            ).chainId.toString(),
            entryPoint: entryPointAddress,
            health,
            fundedBundlers: balances,
        },
        null,
        2
    )
);
if (!ready) process.exitCode = 1;
