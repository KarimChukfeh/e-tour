import type { TypedDataDomain, TypedDataField } from "ethers";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type GameKind = "tictactoe" | "connectfour" | "chess";
export type SessionStatus =
    | "active"
    | "expired"
    | "revoked"
    | "rotated"
    | "missing"
    | "inactive";

export interface CryptoSource {
    readonly subtle: SubtleCrypto;
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    randomUUID?(): string;
}

export interface SessionIdentity {
    chainId: bigint;
    instance: Address;
    primary: Address;
}

export interface StoredSessionMetadata extends SessionIdentity {
    account: Address;
    owner: Address;
    salt: bigint;
    createdAt: number;
    updatedAt: number;
}

export interface SessionInspection {
    status: SessionStatus;
    executor: Address;
    requestedExecutor?: Address;
    issuedAt: bigint;
    validUntil: bigint;
    generation: bigint;
    secondsRemaining: bigint;
}

export interface PackedUserOperation {
    sender: Address;
    nonce: bigint;
    initCode: Hex;
    callData: Hex;
    accountGasLimits: Hex;
    preVerificationGas: bigint;
    gasFees: Hex;
    paymasterAndData: Hex;
    signature: Hex;
}

export interface RpcUserOperation {
    sender: Address;
    nonce: Hex;
    callData: Hex;
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
    maxPriorityFeePerGas: Hex;
    maxFeePerGas: Hex;
    signature: Hex;
    factory?: Address;
    factoryData?: Hex;
    paymaster?: Address;
    paymasterVerificationGasLimit?: Hex;
    paymasterPostOpGasLimit?: Hex;
    paymasterData?: Hex;
}

export interface RpcClient {
    request(request: {
        method: string;
        params?: readonly unknown[];
    }): Promise<unknown>;
}

export interface SessionSigner {
    readonly address: Address;
    signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataField[]>,
        value: Record<string, unknown>
    ): Promise<string>;
}

export interface TransactionRequest {
    to: Address;
    data: Hex;
    value: bigint;
}

export interface PrimarySigner {
    sendTransaction(
        transaction: TransactionRequest
    ): Promise<{ wait(): Promise<unknown> }>;
}

export interface MoveRequest {
    game: GameKind;
    roundNumber: number;
    matchNumber: number;
    cellIndex?: number;
    column?: number;
    fromSquare?: number;
    toSquare?: number;
    promotionPiece?: number;
}

export interface UserOperationGasOptions {
    verificationGasLimit?: bigint;
    callGasLimit?: bigint;
    preVerificationGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    maxFeePerGas?: bigint;
}

export interface V3ErrorDescriptor {
    code: string;
    message: string;
    retryable: boolean;
    directFallbackRecommended: boolean;
    contractError?: string;
}
