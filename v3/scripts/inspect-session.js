import hre from "hardhat";
import {
    environmentAddress,
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

const { file, manifest } = loadDeploymentManifest(
    hre.network.name
);
const registryAddress = requiredAddress(
    manifest.sessionAuthorization?.SessionKeyRegistry,
    "manifest sessionAuthorization.SessionKeyRegistry"
);
const instance = environmentAddress("INSTANCE");
const primary = environmentAddress("PRIMARY");
const requestedExecutor = process.env.EXECUTOR
    ? hre.ethers.getAddress(process.env.EXECUTOR)
    : null;
const registry = await hre.ethers.getContractAt(
    "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
    registryAddress
);
const session = await registry.getSession(instance, primary);
const latest = await hre.ethers.provider.getBlock("latest");
const now = BigInt(latest.timestamp);
const active =
    session.executor === hre.ethers.ZeroAddress
        ? false
        : await registry.isSessionActive(
              instance,
              primary,
              session.executor
          );
let status = "inactive";
if (session.executor === hre.ethers.ZeroAddress) {
    status = session.generation === 0n ? "missing" : "revoked";
} else if (
    requestedExecutor &&
    requestedExecutor !== session.executor
) {
    status = "rotated";
} else if (session.validUntil <= now) {
    status = "expired";
} else if (active) {
    status = "active";
}

console.log(
    JSON.stringify(
        {
            network: hre.network.name,
            manifest: file,
            registry: registryAddress,
            instance,
            primary,
            requestedExecutor,
            status,
            session: {
                executor: session.executor,
                issuedAt: session.issuedAt.toString(),
                validUntil: session.validUntil.toString(),
                generation: session.generation.toString(),
                secondsRemaining:
                    session.validUntil > now
                        ? (session.validUntil - now).toString()
                        : "0",
            },
        },
        null,
        2
    )
);
