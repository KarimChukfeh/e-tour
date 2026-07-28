import { createRequire } from "module";
import hre from "hardhat";
import { LocalBundler } from "../sdk/local-bundler.js";
import {
    buildInitCode,
    buildPackedUserOperation,
    buildPaymasterAndData,
    encodeAccountExecute,
    estimateUserOperationGas,
    getUserOperationNonce,
    getUserOperationReceipt,
    signUserOperation,
    submitUserOperation,
    toRpcUserOperation,
} from "../sdk/user-operation.js";
import {
    generateBrowserSessionKey,
    generateSessionSalt,
} from "../sdk/dist/index.js";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

if (hre.network.name !== "localhost") {
    throw new Error(
        "local-user-operation must run against --network localhost"
    );
}

const require = createRequire(import.meta.url);
const entryPointArtifact = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const { manifest } = loadDeploymentManifest(hre.network.name);
const entryPointAddress = requiredAddress(
    manifest.accountAbstraction?.entryPoint,
    "manifest accountAbstraction.entryPoint"
);
const accountFactoryAddress = requiredAddress(
    manifest.accountAbstraction?.sessionAccountFactory,
    "manifest accountAbstraction.sessionAccountFactory"
);
const paymasterAddress = requiredAddress(
    manifest.accountAbstraction?.sessionPaymaster,
    "manifest accountAbstraction.sessionPaymaster"
);
const gameFactoryAddress = requiredAddress(
    manifest.factories?.TicTacChainFactory,
    "manifest factories.TicTacChainFactory"
);
const [deployer, creator, joiner, bundlerSigner] =
    await hre.ethers.getSigners();
const creatorKey = generateBrowserSessionKey();
const joinerKey = generateBrowserSessionKey();

try {
    const accountFactory = await hre.ethers.getContractAt(
        "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
        accountFactoryAddress
    );
    const descriptors = new Map();
    for (const [primary, key] of [
        [creator, creatorKey],
        [joiner, joinerKey],
    ]) {
        const salt = generateSessionSalt();
        const account =
            await accountFactory["getAddress(address,uint256)"](
                key.address,
                salt
            );
        descriptors.set(primary.address.toLowerCase(), {
            primary,
            key,
            salt,
            account,
        });
    }

    const gameFactory = await hre.ethers.getContractAt(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        gameFactoryAddress
    );
    const entryFee = hre.ethers.parseEther("0.0001");
    const create = await gameFactory
        .connect(creator)
        .createInstance(
            2,
            entryFee,
            120,
            120,
            15,
            descriptors.get(creator.address.toLowerCase()).account,
            { value: entryFee }
        );
    const createReceipt = await create.wait();
    const deployedEvent = createReceipt.logs
        .map((log) => {
            try {
                return gameFactory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === "InstanceDeployed");
    if (!deployedEvent) {
        throw new Error("InstanceDeployed event not found");
    }
    const instanceAddress = deployedEvent.args.instance;
    const instance = await hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        instanceAddress
    );
    await (
        await instance
            .connect(joiner)
            .enrollInTournament(
                descriptors.get(joiner.address.toLowerCase())
                    .account,
                { value: entryFee }
            )
    ).wait();

    const matchId = hre.ethers.solidityPackedKeccak256(
        ["uint8", "uint8"],
        [0, 0]
    );
    const match = await instance.matches(matchId);
    const descriptor = descriptors.get(
        match.currentTurn.toLowerCase()
    );
    if (!descriptor) {
        throw new Error("current player has no local session descriptor");
    }

    const entryPoint = new hre.ethers.Contract(
        entryPointAddress,
        entryPointArtifact.abi,
        deployer
    );
    const bundler = new LocalBundler({
        entryPoint,
        bundlerSigner,
    });
    const initCode = buildInitCode(
        accountFactoryAddress,
        descriptor.key.address,
        descriptor.salt
    );
    const gameCall = instance.interface.encodeFunctionData(
        "makeMove",
        [0, 0, 0]
    );
    const callData = encodeAccountExecute(
        instanceAddress,
        gameCall
    );
    const nonce = await getUserOperationNonce(
        entryPoint,
        descriptor.account
    );
    const unsigned = buildPackedUserOperation({
        sender: descriptor.account,
        nonce,
        initCode,
        callData,
        verificationGasLimit: 2_000_000n,
        callGasLimit: 2_000_000n,
        preVerificationGas: 100_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 1_000_000_000n,
        paymasterAndData:
            buildPaymasterAndData(paymasterAddress),
    });
    const network = await hre.ethers.provider.getNetwork();
    const signed = await signUserOperation(
        unsigned,
        descriptor.key,
        entryPointAddress,
        network.chainId
    );
    const rpc = toRpcUserOperation(signed);
    const estimate = await estimateUserOperationGas(
        bundler,
        rpc,
        entryPointAddress
    );
    const userOperationHash = await submitUserOperation(
        bundler,
        rpc,
        entryPointAddress
    );
    const receipt = await getUserOperationReceipt(
        bundler,
        userOperationHash
    );
    if (!receipt?.success) {
        throw new Error(
            `local UserOperation reverted: ${receipt?.revertReason ?? "unknown"}`
        );
    }

    console.log(
        JSON.stringify(
            {
                network: hre.network.name,
                chainId: network.chainId.toString(),
                instance: instanceAddress,
                primary: descriptor.primary.address,
                sessionOwner: descriptor.key.address,
                sessionAccount: descriptor.account,
                accountWasCounterfactual: true,
                nonce: nonce.toString(),
                paymaster: paymasterAddress,
                estimate,
                userOperationHash,
                receipt: {
                    success: receipt.success,
                    sender: receipt.sender,
                    actualGasCost: receipt.actualGasCost,
                    actualGasUsed: receipt.actualGasUsed,
                    transactionHash:
                        receipt.receipt.hash,
                    blockNumber:
                        receipt.receipt.blockNumber,
                    revertReason: receipt.revertReason,
                },
            },
            null,
            2
        )
    );
} finally {
    creatorKey.destroy();
    joinerKey.destroy();
}
