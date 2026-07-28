import { createRequire } from "module";
import hre from "hardhat";
import {
    ENTRY_POINT_ADDRESS,
} from "./lib/account-abstraction-deployment.js";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

const require = createRequire(import.meta.url);
const entryPointArtifact = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const { file, manifest } = loadDeploymentManifest(
    hre.network.name
);
const configured = requiredAddress(
    manifest.accountAbstraction?.entryPoint,
    "manifest accountAbstraction.entryPoint"
);
const factoryAddress = requiredAddress(
    manifest.accountAbstraction?.sessionAccountFactory,
    "manifest accountAbstraction.sessionAccountFactory"
);
const paymasterAddress = requiredAddress(
    manifest.accountAbstraction?.sessionPaymaster,
    "manifest accountAbstraction.sessionPaymaster"
);
const entryPoint = new hre.ethers.Contract(
    configured,
    entryPointArtifact.abi,
    hre.ethers.provider
);
const factory = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
    factoryAddress
);
const paymaster = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster",
    paymasterAddress
);
const [code, senderCreator, factoryEntryPoint, paymasterEntryPoint] =
    await Promise.all([
        hre.ethers.provider.getCode(configured),
        entryPoint.senderCreator(),
        factory.ENTRY_POINT(),
        paymaster.ENTRY_POINT(),
    ]);
const report = {
    network: hre.network.name,
    chainId: (
        await hre.ethers.provider.getNetwork()
    ).chainId.toString(),
    manifest: file,
    configured,
    canonical: ENTRY_POINT_ADDRESS,
    codePresent: code !== "0x",
    codeHash:
        code === "0x" ? null : hre.ethers.keccak256(code),
    senderCreator,
    sessionAccountFactory: factoryAddress,
    factoryEntryPoint,
    sessionPaymaster: paymasterAddress,
    paymasterEntryPoint,
};
const compatible =
    configured === ENTRY_POINT_ADDRESS &&
    report.codePresent &&
    factoryEntryPoint === configured &&
    paymasterEntryPoint === configured;
console.log(
    JSON.stringify(
        { ...report, status: compatible ? "compatible" : "invalid" },
        null,
        2
    )
);
if (!compatible) process.exitCode = 1;
