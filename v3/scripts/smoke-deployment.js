import hre from "hardhat";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

const { file, manifest } = loadDeploymentManifest(
    hre.network.name
);
const expectedChainId = BigInt(manifest.chainId);
const actualChainId = (
    await hre.ethers.provider.getNetwork()
).chainId;
if (expectedChainId !== actualChainId) {
    throw new Error(
        `manifest chain ${expectedChainId} does not match RPC chain ${actualChainId}`
    );
}

const addresses = flattenAddresses({
    ...manifest.modules,
    ...manifest.playerProfile,
    ...manifest.sessionAuthorization,
    ...manifest.accountAbstraction,
    ...manifest.factories,
    ...manifest.implementations,
});
const missingCode = [];
for (const [label, value] of addresses) {
    if (
        label === "paymasterFundingAddress" ||
        label === "paymasterOwner" ||
        label === "paymasterDeposit"
    ) {
        continue;
    }
    const address = requiredAddress(value, label);
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
        missingCode.push({ label, address });
    }
}
if (missingCode.length > 0) {
    throw new Error(
        `manifest addresses without code: ${JSON.stringify(missingCode)}`
    );
}

const registryAddress = requiredAddress(
    manifest.playerProfile.PlayerRegistry,
    "PlayerRegistry"
);
const sessionRegistryAddress = requiredAddress(
    manifest.sessionAuthorization.SessionKeyRegistry,
    "SessionKeyRegistry"
);
const registry = await hre.ethers.getContractAt(
    "contracts/PlayerRegistry.sol:PlayerRegistry",
    registryAddress
);
const sessionRegistry = await hre.ethers.getContractAt(
    "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
    sessionRegistryAddress
);
const factories = [
    [
        "TicTacChainFactory",
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        manifest.factories.TicTacChainFactory,
        manifest.implementations.TicTacInstance,
    ],
    [
        "ConnectFourFactory",
        "contracts/ConnectFourFactory.sol:ConnectFourFactory",
        manifest.factories.ConnectFourFactory,
        manifest.implementations.ConnectFourInstance,
    ],
    [
        "ChessOnChainFactory",
        "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
        manifest.factories.ChessOnChainFactory,
        manifest.implementations.ChessInstance,
    ],
];
const factoryChecks = [];
for (const [name, artifact, factoryAddress, implementation] of factories) {
    const factory = await hre.ethers.getContractAt(
        artifact,
        factoryAddress
    );
    const actual = {
        name,
        address: await factory.getAddress(),
        authorized:
            await registry.authorizedFactories(factoryAddress),
        implementation: await factory.implementation(),
        playerRegistry: await factory.PLAYER_REGISTRY(),
        sessionRegistry: await factory.SESSION_REGISTRY(),
    };
    if (
        !actual.authorized ||
        actual.implementation !==
            hre.ethers.getAddress(implementation) ||
        actual.playerRegistry !== registryAddress ||
        actual.sessionRegistry !== sessionRegistryAddress
    ) {
        throw new Error(
            `factory wiring mismatch: ${JSON.stringify(actual)}`
        );
    }
    factoryChecks.push(actual);
}
if (
    (await sessionRegistry.PLAYER_REGISTRY()) !==
    registryAddress
) {
    throw new Error("session registry player-registry anchor mismatch");
}

let instanceCheck = null;
if (process.env.INSTANCE) {
    const instanceAddress = requiredAddress(
        process.env.INSTANCE,
        "INSTANCE"
    );
    const instance = await hre.ethers.getContractAt(
        "contracts/ETourInstance_Base.sol:ETourInstance_Base",
        instanceAddress
    );
    const [tournament, players] = await Promise.all([
        instance.tournament(),
        instance.getPlayers(),
    ]);
    instanceCheck = {
        address: instanceAddress,
        factory: await instance.factory(),
        creator: await instance.creator(),
        sessionRegistry: await instance.SESSION_REGISTRY(),
        players,
        enrolledCount: tournament.enrolledCount.toString(),
        status: tournament.status.toString(),
    };
}

console.log(
    JSON.stringify(
        {
            status: "healthy",
            network: hre.network.name,
            chainId: actualChainId.toString(),
            manifest: file,
            checkedCodeAddresses: addresses.length,
            playerRegistry: registryAddress,
            sessionRegistry: sessionRegistryAddress,
            factories: factoryChecks,
            instance: instanceCheck,
        },
        null,
        2
    )
);

function flattenAddresses(object) {
    return Object.entries(object).filter(
        ([, value]) =>
            typeof value === "string" &&
            /^0x[0-9a-fA-F]{40}$/.test(value)
    );
}
