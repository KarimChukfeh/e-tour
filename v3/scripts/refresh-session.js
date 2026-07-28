import hre from "hardhat";
import {
    environmentAddress,
    loadDeploymentManifest,
    requireLocalMutation,
    requiredAddress,
} from "./lib/deployment-manifest.js";

requireLocalMutation(hre.network.name);
const { manifest } = loadDeploymentManifest(hre.network.name);
const registryAddress = requiredAddress(
    manifest.sessionAuthorization?.SessionKeyRegistry,
    "manifest sessionAuthorization.SessionKeyRegistry"
);
const instance = environmentAddress("INSTANCE");
const newExecutor = environmentAddress("NEW_EXECUTOR");
const signerIndex = Number(process.env.PRIMARY_INDEX ?? "1");
const signers = await hre.ethers.getSigners();
const primary = signers[signerIndex];
if (!primary) throw new Error(`no signer at PRIMARY_INDEX ${signerIndex}`);

const registry = await hre.ethers.getContractAt(
    "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
    registryAddress,
    primary
);
const transaction = await registry.refreshSession(
    instance,
    newExecutor
);
const receipt = await transaction.wait();
console.log(
    JSON.stringify(
        {
            network: hre.network.name,
            registry: registryAddress,
            instance,
            primary: primary.address,
            newExecutor,
            transactionHash: receipt.hash,
            blockNumber: receipt.blockNumber,
        },
        null,
        2
    )
);
