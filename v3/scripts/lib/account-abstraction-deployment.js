import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const ENTRY_POINT_ARTIFACT = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const SIMPLE_ACCOUNT_ARTIFACT = require(
    "@account-abstraction/contracts/artifacts/SimpleAccount.json"
);
const SIMPLE_ACCOUNT_FACTORY_ARTIFACT = require(
    "@account-abstraction/contracts/artifacts/SimpleAccountFactory.json"
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V3_DIR = path.resolve(__dirname, "..", "..");

export const ENTRY_POINT_ADDRESS =
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const DETERMINISTIC_DEPLOYER =
    "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const ENTRY_POINT_SALT =
    "0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9";
export const LOCAL_SIMPLE_ACCOUNT_FACTORY =
    "0xdaeCF91A87e14dfB1a836186437cA6424EFCaba2";

const DEPLOYER_SIGNER =
    "0x3fAB184622Dc19b6109349B94811493BF2a45362";
const DEPLOYER_INIT_CODE =
    "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffff" +
    "ffffffffffffffffffffffffffffe03601600081602082378035828234f580151" +
    "56039578182fd5b8082525050506014600cf3";

export const accountAbstractionArtifacts = Object.freeze({
    EntryPoint: ENTRY_POINT_ARTIFACT,
    SimpleAccount: SIMPLE_ACCOUNT_ARTIFACT,
    SimpleAccountFactory: SIMPLE_ACCOUNT_FACTORY_ARTIFACT,
});

async function ensureDeterministicDeployer(hre, signer) {
    const existing = await hre.ethers.provider.getCode(
        DETERMINISTIC_DEPLOYER
    );
    if (existing !== "0x") return;

    await (
        await signer.sendTransaction({
            to: DEPLOYER_SIGNER,
            value: hre.ethers.parseEther("0.1"),
        })
    ).wait();
    const repeatedSignatureWord = `0x${"22".repeat(32)}`;
    const rawTransaction = hre.ethers.Transaction.from({
        type: 0,
        nonce: 0,
        gasPrice: 100_000_000_000n,
        gasLimit: 100_000n,
        to: null,
        value: 0,
        data: DEPLOYER_INIT_CODE,
        signature: hre.ethers.Signature.from({
            r: repeatedSignatureWord,
            s: repeatedSignatureWord,
            v: 27,
        }),
    }).serialized;
    await (
        await hre.ethers.provider.broadcastTransaction(rawTransaction)
    ).wait();

    const deployed = await hre.ethers.provider.getCode(
        DETERMINISTIC_DEPLOYER
    );
    if (deployed === "0x") {
        throw new Error("deterministic deployment proxy bootstrap failed");
    }
}

async function deployCreate2(
    hre,
    signer,
    creationCode,
    salt,
    expectedAddress
) {
    const currentCode = await hre.ethers.provider.getCode(expectedAddress);
    if (currentCode !== "0x") return;

    const predicted = hre.ethers.getCreate2Address(
        DETERMINISTIC_DEPLOYER,
        salt,
        hre.ethers.keccak256(creationCode)
    );
    if (predicted !== hre.ethers.getAddress(expectedAddress)) {
        throw new Error(
            `unexpected CREATE2 address ${predicted}; expected ${expectedAddress}`
        );
    }
    await (
        await signer.sendTransaction({
            to: DETERMINISTIC_DEPLOYER,
            data: hre.ethers.concat([salt, creationCode]),
            gasLimit: 20_000_000,
        })
    ).wait();

    const deployed = await hre.ethers.provider.getCode(expectedAddress);
    if (deployed === "0x") {
        throw new Error(`CREATE2 deployment failed for ${expectedAddress}`);
    }
}

function factoryCreationCode(hre) {
    return hre.ethers.concat([
        SIMPLE_ACCOUNT_FACTORY_ARTIFACT.bytecode,
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ["address"],
            [ENTRY_POINT_ADDRESS]
        ),
    ]);
}

export async function deployLocalAccountAbstraction(
    hre,
    { signer, writeManifest = false } = {}
) {
    const deploymentSigner =
        signer ?? (await hre.ethers.getSigners())[0];
    await ensureDeterministicDeployer(hre, deploymentSigner);
    await deployCreate2(
        hre,
        deploymentSigner,
        ENTRY_POINT_ARTIFACT.bytecode,
        ENTRY_POINT_SALT,
        ENTRY_POINT_ADDRESS
    );
    await deployCreate2(
        hre,
        deploymentSigner,
        factoryCreationCode(hre),
        ENTRY_POINT_SALT,
        LOCAL_SIMPLE_ACCOUNT_FACTORY
    );

    const entryPoint = new hre.ethers.Contract(
        ENTRY_POINT_ADDRESS,
        ENTRY_POINT_ARTIFACT.abi,
        deploymentSigner
    );
    const accountFactory = new hre.ethers.Contract(
        LOCAL_SIMPLE_ACCOUNT_FACTORY,
        SIMPLE_ACCOUNT_FACTORY_ARTIFACT.abi,
        deploymentSigner
    );
    const senderCreator = await entryPoint.senderCreator();
    const accountImplementation =
        await accountFactory.accountImplementation();
    if (
        (await hre.ethers.provider.getCode(senderCreator)) === "0x" ||
        (await hre.ethers.provider.getCode(accountImplementation)) ===
            "0x"
    ) {
        throw new Error(
            "EntryPoint SenderCreator or SimpleAccount implementation is missing"
        );
    }
    if (
        (await accountFactory.senderCreator()) !==
        hre.ethers.getAddress(senderCreator)
    ) {
        throw new Error("SimpleAccountFactory SenderCreator mismatch");
    }

    const network = await hre.ethers.provider.getNetwork();
    const manifest = {
        schemaVersion: 1,
        network: hre.network.name,
        chainId: network.chainId.toString(),
        entryPoint: ENTRY_POINT_ADDRESS,
        deterministicDeployer: DETERMINISTIC_DEPLOYER,
        salt: ENTRY_POINT_SALT,
        simpleAccountFactory: LOCAL_SIMPLE_ACCOUNT_FACTORY,
        simpleAccountImplementation: accountImplementation,
        senderCreator,
    };
    if (writeManifest) {
        const output = path.join(
            V3_DIR,
            "deployments",
            `${hre.network.name}-account-abstraction.json`
        );
        fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return {
        ...manifest,
        entryPoint,
        accountFactory,
        artifacts: accountAbstractionArtifacts,
    };
}
