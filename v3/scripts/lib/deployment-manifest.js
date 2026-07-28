import fs from "fs";
import path from "path";
import { getAddress } from "ethers";
import {
    canonicalManifestPath,
    isLocalDevelopmentNetwork,
} from "./deployment-output.js";

export function manifestPath(network) {
    const deploymentsDirectory = path.join(
        process.cwd(),
        "deployments"
    );
    const canonical = canonicalManifestPath(
        deploymentsDirectory,
        network
    );
    if (fs.existsSync(canonical)) return canonical;
    return path.join(
        deploymentsDirectory,
        `${network}-factory.json`
    );
}

export function loadDeploymentManifest(network) {
    const file = manifestPath(network);
    if (!fs.existsSync(file)) {
        throw new Error(
            `missing ${file}; run the complete V3 deployment first`
        );
    }
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.network !== network) {
        throw new Error(
            `manifest network ${manifest.network} does not match ${network}`
        );
    }
    return { file, manifest };
}

export function requiredAddress(value, label) {
    if (!value) throw new Error(`missing ${label}`);
    return getAddress(value);
}

export function environmentAddress(name) {
    return requiredAddress(process.env[name], `${name} environment variable`);
}

export function requireLocalMutation(network) {
    if (
        !isLocalDevelopmentNetwork(network) &&
        process.env.ALLOW_PUBLIC_SESSION_MUTATION !== "1"
    ) {
        throw new Error(
            "refusing a public-network session mutation; set " +
                "ALLOW_PUBLIC_SESSION_MUTATION=1 after reviewing the target"
        );
    }
}
