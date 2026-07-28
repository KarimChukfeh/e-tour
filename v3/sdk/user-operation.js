import { createRequire } from "module";
import {
    AbiCoder,
    Interface,
    TypedDataEncoder,
    concat,
    dataLength,
    dataSlice,
    getAddress,
    hexlify,
    isHexString,
    toBeHex,
} from "ethers";

const require = createRequire(import.meta.url);
const SIMPLE_ACCOUNT_ARTIFACT = require(
    "@account-abstraction/contracts/artifacts/SimpleAccount.json"
);
const SIMPLE_ACCOUNT_FACTORY_ARTIFACT = require(
    "@account-abstraction/contracts/artifacts/SimpleAccountFactory.json"
);

export const simpleAccountInterface = new Interface(
    SIMPLE_ACCOUNT_ARTIFACT.abi
);
export const simpleAccountFactoryInterface = new Interface(
    SIMPLE_ACCOUNT_FACTORY_ARTIFACT.abi
);
export const PACKED_USER_OPERATION_TYPES = Object.freeze({
    PackedUserOperation: [
        { name: "sender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "initCode", type: "bytes" },
        { name: "callData", type: "bytes" },
        { name: "accountGasLimits", type: "bytes32" },
        { name: "preVerificationGas", type: "uint256" },
        { name: "gasFees", type: "bytes32" },
        { name: "paymasterAndData", type: "bytes" },
    ],
});

const MAX_UINT128 = (1n << 128n) - 1n;

function asBigInt(value, label) {
    try {
        return BigInt(value);
    } catch {
        throw new TypeError(`${label} must be bigint-compatible`);
    }
}

export function packUint128Pair(high, low) {
    const highValue = asBigInt(high, "high");
    const lowValue = asBigInt(low, "low");
    if (
        highValue < 0n ||
        lowValue < 0n ||
        highValue > MAX_UINT128 ||
        lowValue > MAX_UINT128
    ) {
        throw new RangeError("packed values must fit uint128");
    }
    return toBeHex((highValue << 128n) | lowValue, 32);
}

export function unpackUint128Pair(value) {
    const packed = asBigInt(value, "packed value");
    return {
        high: packed >> 128n,
        low: packed & MAX_UINT128,
    };
}

export function buildFactoryData(owner, salt) {
    return simpleAccountFactoryInterface.encodeFunctionData(
        "createAccount",
        [getAddress(owner), asBigInt(salt, "salt")]
    );
}

export function buildInitCode(factory, owner, salt) {
    return concat([
        getAddress(factory),
        buildFactoryData(owner, salt),
    ]);
}

export function encodeAccountExecute(target, data, value = 0n) {
    return simpleAccountInterface.encodeFunctionData("execute", [
        getAddress(target),
        asBigInt(value, "value"),
        data,
    ]);
}

export function buildPaymasterAndData(
    paymaster,
    {
        verificationGasLimit = 300_000n,
        postOpGasLimit = 50_000n,
        data = "0x",
    } = {}
) {
    return concat([
        getAddress(paymaster),
        toBeHex(
            asBigInt(
                verificationGasLimit,
                "paymaster verification gas"
            ),
            16
        ),
        toBeHex(
            asBigInt(postOpGasLimit, "paymaster post-op gas"),
            16
        ),
        hexlify(data),
    ]);
}

export async function getUserOperationNonce(
    entryPoint,
    sender,
    key = 0n
) {
    return entryPoint.getNonce(
        getAddress(sender),
        asBigInt(key, "nonce key")
    );
}

export function buildPackedUserOperation({
    sender,
    nonce,
    initCode = "0x",
    callData,
    verificationGasLimit = 2_000_000n,
    callGasLimit = 2_000_000n,
    preVerificationGas = 100_000n,
    maxPriorityFeePerGas = 1_000_000_000n,
    maxFeePerGas = 1_000_000_000n,
    paymasterAndData = "0x",
    signature = "0x",
}) {
    return {
        sender: getAddress(sender),
        nonce: asBigInt(nonce, "nonce"),
        initCode: hexlify(initCode),
        callData: hexlify(callData),
        accountGasLimits: packUint128Pair(
            verificationGasLimit,
            callGasLimit
        ),
        preVerificationGas: asBigInt(
            preVerificationGas,
            "preVerificationGas"
        ),
        gasFees: packUint128Pair(
            maxPriorityFeePerGas,
            maxFeePerGas
        ),
        paymasterAndData: hexlify(paymasterAndData),
        signature: hexlify(signature),
    };
}

export function userOperationDomain(entryPoint, chainId) {
    return {
        name: "ERC4337",
        version: "1",
        chainId: asBigInt(chainId, "chainId"),
        verifyingContract: getAddress(entryPoint),
    };
}

export function hashUserOperation(userOperation, entryPoint, chainId) {
    return TypedDataEncoder.hash(
        userOperationDomain(entryPoint, chainId),
        PACKED_USER_OPERATION_TYPES,
        userOperation
    );
}

export async function signUserOperation(
    userOperation,
    ownerSigner,
    entryPoint,
    chainId
) {
    const signature = await ownerSigner.signTypedData(
        userOperationDomain(entryPoint, chainId),
        PACKED_USER_OPERATION_TYPES,
        userOperation
    );
    return { ...userOperation, signature };
}

export function toRpcQuantity(value) {
    return toBeHex(asBigInt(value, "RPC quantity"));
}

export function toRpcUserOperation(userOperation) {
    const accountGas = unpackUint128Pair(
        userOperation.accountGasLimits
    );
    const fees = unpackUint128Pair(userOperation.gasFees);
    const rpc = {
        sender: getAddress(userOperation.sender),
        nonce: toRpcQuantity(userOperation.nonce),
        callData: userOperation.callData,
        callGasLimit: toRpcQuantity(accountGas.low),
        verificationGasLimit: toRpcQuantity(accountGas.high),
        preVerificationGas: toRpcQuantity(
            userOperation.preVerificationGas
        ),
        maxPriorityFeePerGas: toRpcQuantity(fees.high),
        maxFeePerGas: toRpcQuantity(fees.low),
        signature: userOperation.signature,
    };
    if (dataLength(userOperation.initCode) > 0) {
        rpc.factory = getAddress(
            dataSlice(userOperation.initCode, 0, 20)
        );
        rpc.factoryData = dataSlice(userOperation.initCode, 20);
    }
    if (dataLength(userOperation.paymasterAndData) > 0) {
        if (dataLength(userOperation.paymasterAndData) < 52) {
            throw new Error("malformed paymasterAndData");
        }
        rpc.paymaster = getAddress(
            dataSlice(userOperation.paymasterAndData, 0, 20)
        );
        rpc.paymasterVerificationGasLimit = toRpcQuantity(
            BigInt(dataSlice(userOperation.paymasterAndData, 20, 36))
        );
        rpc.paymasterPostOpGasLimit = toRpcQuantity(
            BigInt(dataSlice(userOperation.paymasterAndData, 36, 52))
        );
        rpc.paymasterData = dataSlice(
            userOperation.paymasterAndData,
            52
        );
    }
    return rpc;
}

export function fromRpcUserOperation(rpc) {
    const initCode = rpc.factory
        ? concat([getAddress(rpc.factory), rpc.factoryData ?? "0x"])
        : "0x";
    let paymasterAndData = "0x";
    if (rpc.paymaster) {
        paymasterAndData = concat([
            getAddress(rpc.paymaster),
            toBeHex(
                asBigInt(
                    rpc.paymasterVerificationGasLimit,
                    "paymasterVerificationGasLimit"
                ),
                16
            ),
            toBeHex(
                asBigInt(
                    rpc.paymasterPostOpGasLimit,
                    "paymasterPostOpGasLimit"
                ),
                16
            ),
            rpc.paymasterData ?? "0x",
        ]);
    }
    return buildPackedUserOperation({
        sender: rpc.sender,
        nonce: rpc.nonce,
        initCode,
        callData: rpc.callData,
        verificationGasLimit: rpc.verificationGasLimit,
        callGasLimit: rpc.callGasLimit,
        preVerificationGas: rpc.preVerificationGas,
        maxPriorityFeePerGas: rpc.maxPriorityFeePerGas,
        maxFeePerGas: rpc.maxFeePerGas,
        paymasterAndData,
        signature: rpc.signature,
    });
}

export function decodeRevertData(data) {
    if (!isHexString(data) || dataLength(data) < 4) return null;
    const selector = dataSlice(data, 0, 4);
    if (selector === "0x08c379a0") {
        return AbiCoder.defaultAbiCoder().decode(
            ["string"],
            dataSlice(data, 4)
        )[0];
    }
    if (selector === "0x4e487b71") {
        const code = AbiCoder.defaultAbiCoder().decode(
            ["uint256"],
            dataSlice(data, 4)
        )[0];
        return `Panic(${code})`;
    }
    return data;
}

export async function estimateUserOperationGas(
    rpcClient,
    rpcUserOperation,
    entryPoint
) {
    return rpcClient.request({
        method: "eth_estimateUserOperationGas",
        params: [rpcUserOperation, getAddress(entryPoint)],
    });
}

export async function submitUserOperation(
    rpcClient,
    rpcUserOperation,
    entryPoint
) {
    return rpcClient.request({
        method: "eth_sendUserOperation",
        params: [rpcUserOperation, getAddress(entryPoint)],
    });
}

export async function getUserOperationReceipt(
    rpcClient,
    userOperationHash
) {
    if (!isHexString(userOperationHash, 32)) {
        throw new TypeError("userOperationHash must be bytes32");
    }
    return rpcClient.request({
        method: "eth_getUserOperationReceipt",
        params: [userOperationHash],
    });
}
