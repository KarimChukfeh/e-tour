import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";

const KNOWN_NETWORKS = Object.freeze({
    hardhat: "412346",
    localhost: "412346",
    arbitrumSepolia: "421614",
    arbitrum: "42161",
});

export function assertDeploymentTarget(
    network,
    chainId,
    { allowUnknown = process.env.ALLOW_UNRECOGNIZED_DEPLOYMENT_NETWORK === "1" } = {}
) {
    const normalizedChainId = BigInt(chainId).toString();
    const expected = KNOWN_NETWORKS[network];
    if (!expected && !allowUnknown) {
        throw new Error(
            `unrecognized deployment network ${network}; set ` +
                "ALLOW_UNRECOGNIZED_DEPLOYMENT_NETWORK=1 only after review"
        );
    }
    if (expected && expected !== normalizedChainId) {
        throw new Error(
            `${network} must use chain ID ${expected}, not ${normalizedChainId}`
        );
    }
    return normalizedChainId;
}

export function networkDeploymentDirectory(
    deploymentsDirectory,
    network
) {
    if (
        !network ||
        network.includes("/") ||
        network.includes("\\") ||
        network === "." ||
        network === ".."
    ) {
        throw new Error(`invalid network output name ${network}`);
    }
    return path.join(deploymentsDirectory, network);
}

export function canonicalManifestPath(
    deploymentsDirectory,
    network
) {
    return path.join(
        networkDeploymentDirectory(deploymentsDirectory, network),
        "manifest.json"
    );
}

export function atomicWriteJson(file, value) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(
        directory,
        `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(
            descriptor,
            `${JSON.stringify(value, null, 2)}\n`,
            "utf8"
        );
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, file);
        let directoryDescriptor;
        try {
            directoryDescriptor = fs.openSync(
                directory,
                "r"
            );
            fs.fsyncSync(directoryDescriptor);
        } catch {
            // Some platforms do not support fsync on directories.
        } finally {
            if (directoryDescriptor !== undefined) {
                fs.closeSync(directoryDescriptor);
            }
        }
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw error;
    }
}

export function repositoryMetadata(repositoryRoot) {
    const commit = git(repositoryRoot, [
        "rev-parse",
        "HEAD",
    ]);
    const status = git(repositoryRoot, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
    ]);
    return {
        commit,
        dirty: status.length > 0,
    };
}

export function requireReviewedSourceState(
    network,
    repository
) {
    if (
        repository.dirty &&
        network !== "localhost" &&
        network !== "hardhat" &&
        process.env.ALLOW_DIRTY_DEPLOYMENT !== "1"
    ) {
        throw new Error(
            "refusing a public-network deployment from a dirty source tree; " +
                "commit the reviewed source or set ALLOW_DIRTY_DEPLOYMENT=1"
        );
    }
}

export async function compilerMetadata(hre, fullyQualifiedName) {
    const buildInfo =
        await hre.artifacts.getBuildInfo(fullyQualifiedName);
    if (!buildInfo) {
        throw new Error(
            `missing build info for ${fullyQualifiedName}`
        );
    }
    const settings = buildInfo.input.settings;
    return {
        version: buildInfo.solcVersion,
        longVersion: buildInfo.solcLongVersion,
        settings: {
            optimizer: settings.optimizer,
            viaIR: settings.viaIR ?? false,
            evmVersion: settings.evmVersion ?? null,
            metadata: settings.metadata ?? null,
        },
    };
}

export function artifactRecord(
    ethers,
    artifact,
    {
        address = null,
        constructorArguments = [],
        deployment = "singleton",
    } = {}
) {
    return {
        sourceName: artifact.sourceName,
        contractName: artifact.contractName,
        address,
        deployment,
        constructorArguments,
        creationBytecodeHash:
            artifact.bytecode && artifact.bytecode !== "0x"
                ? ethers.keccak256(artifact.bytecode)
                : null,
        deployedBytecodeHash:
            artifact.deployedBytecode &&
            artifact.deployedBytecode !== "0x"
                ? ethers.keccak256(
                      artifact.deployedBytecode
                  )
                : null,
        abi: artifact.abi,
    };
}

function git(repositoryRoot, args) {
    const result = spawnSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.trim()}`
        );
    }
    return result.stdout.trim();
}
