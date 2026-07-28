import {
    Contract,
    getAddress,
    type Provider,
} from "ethers";
import {
    buildInitCode,
    buildPackedUserOperation,
    buildPaymasterAndData,
    encodeAccountExecute,
    estimateUserOperationGas,
    getUserOperationNonce,
    signUserOperation,
    submitUserOperation,
    toRpcUserOperation,
} from "./user-operation.js";
import {
    BrowserSessionKey,
    generateBrowserSessionKey,
} from "./session-crypto.js";
import {
    deriveSessionExecutor,
    encodeGameMove,
    enrollmentArguments,
    generateSessionSalt,
} from "./games.js";
import {
    SessionKeyVault,
} from "./session-storage.js";
import {
    SessionCoordinator,
} from "./session-coordinator.js";
import {
    inspectSessionOnChain,
    prepareRefreshSession,
    prepareRevokeSession,
} from "./session-lifecycle.js";
import {
    SessionUnavailableError,
    UserOperationExecutionError,
    mapV3Error,
} from "./errors.js";
import type {
    Address,
    CryptoSource,
    MoveRequest,
    PrimarySigner,
    RpcClient,
    SessionIdentity,
    StoredSessionMetadata,
    UserOperationGasOptions,
    V3ErrorDescriptor,
} from "./types.js";

const ENTRY_POINT_ABI = [
    "function getNonce(address sender,uint192 key) view returns (uint256)",
];

export interface V3SessionAddresses {
    entryPoint: Address;
    sessionRegistry: Address;
    sessionAccountFactory: Address;
    paymaster?: Address;
}

export interface BuiltSessionMove {
    metadata: StoredSessionMetadata;
    packed: Record<string, unknown>;
    rpc: Record<string, unknown>;
}

export interface SubmittedSessionMove extends BuiltSessionMove {
    estimate: unknown;
    userOperationHash: string;
    receipt: Record<string, unknown>;
}

export class V3SessionClient {
    readonly provider: Provider;
    readonly bundler: RpcClient & {
        waitForReceipt?: (
            hash: string,
            options?: { timeoutMs?: number }
        ) => Promise<unknown>;
    };
    readonly addresses: V3SessionAddresses;
    readonly vault: SessionKeyVault;
    readonly coordinator: SessionCoordinator;
    readonly crypto: CryptoSource;

    constructor({
        provider,
        bundler,
        addresses,
        vault = new SessionKeyVault(),
        coordinator = new SessionCoordinator(),
        crypto = globalThis.crypto,
    }: {
        provider: Provider;
        bundler: RpcClient & {
            waitForReceipt?: (
                hash: string,
                options?: { timeoutMs?: number }
            ) => Promise<unknown>;
        };
        addresses: V3SessionAddresses;
        vault?: SessionKeyVault;
        coordinator?: SessionCoordinator;
        crypto?: CryptoSource;
    }) {
        this.provider = provider;
        this.bundler = bundler;
        this.addresses = {
            entryPoint: getAddress(addresses.entryPoint) as Address,
            sessionRegistry: getAddress(
                addresses.sessionRegistry
            ) as Address,
            sessionAccountFactory: getAddress(
                addresses.sessionAccountFactory
            ) as Address,
            paymaster: addresses.paymaster
                ? (getAddress(addresses.paymaster) as Address)
                : undefined,
        };
        this.vault = vault;
        this.coordinator = coordinator;
        this.crypto = crypto;
    }

    async createSession(
        identity: SessionIdentity,
        { replace = false }: { replace?: boolean } = {}
    ): Promise<StoredSessionMetadata> {
        const current = await this.vault.load(identity);
        if (current) {
            current.key.destroy();
            if (!replace) {
                throw new Error(
                    "a fresh session already exists for this tournament"
                );
            }
        }
        const key = generateBrowserSessionKey(this.crypto);
        const salt = generateSessionSalt(this.crypto);
        try {
            const account = await deriveSessionExecutor({
                provider: this.provider,
                factory: this.addresses.sessionAccountFactory,
                owner: key.address,
                salt,
            });
            const metadata = await this.vault.save(
                identity,
                key,
                { account, salt, replace }
            );
            this.coordinator.publish({
                type: "session-saved",
                sessionId: this.#sessionId(identity),
                account,
            });
            return metadata;
        } finally {
            key.destroy();
        }
    }

    async loadSession(identity: SessionIdentity) {
        return this.vault.load(identity);
    }

    enrollmentArguments(
        metadata?: StoredSessionMetadata
    ): readonly [Address] {
        return enrollmentArguments(metadata?.account);
    }

    async inspect(identity: SessionIdentity) {
        const stored = await this.vault.load(identity);
        try {
            return inspectSessionOnChain({
                runner: this.provider,
                registryAddress: this.addresses.sessionRegistry,
                instance: identity.instance,
                primary: identity.primary,
                requestedExecutor: stored?.metadata.account,
            });
        } finally {
            stored?.key.destroy();
        }
    }

    async buildMove(
        identity: SessionIdentity,
        move: MoveRequest,
        gas: UserOperationGasOptions = {}
    ): Promise<BuiltSessionMove> {
        const stored = await this.vault.load(identity);
        if (!stored) throw new SessionUnavailableError("missing");
        try {
            const inspection = await inspectSessionOnChain({
                runner: this.provider,
                registryAddress: this.addresses.sessionRegistry,
                instance: identity.instance,
                primary: identity.primary,
                requestedExecutor: stored.metadata.account,
            });
            if (inspection.status !== "active") {
                throw new SessionUnavailableError(
                    inspection.status
                );
            }
            const code = await this.provider.getCode(
                stored.metadata.account
            );
            const initCode =
                code === "0x"
                    ? buildInitCode(
                          this.addresses.sessionAccountFactory,
                          stored.metadata.owner,
                          stored.metadata.salt
                      )
                    : "0x";
            const gameCall = encodeGameMove(move);
            const callData = encodeAccountExecute(
                identity.instance,
                gameCall
            );
            const entryPoint = new Contract(
                this.addresses.entryPoint,
                ENTRY_POINT_ABI,
                this.provider
            );
            const nonce = await getUserOperationNonce(
                entryPoint,
                stored.metadata.account
            );
            const unsigned = buildPackedUserOperation({
                sender: stored.metadata.account,
                nonce,
                initCode,
                callData,
                ...gas,
                paymasterAndData: this.addresses.paymaster
                    ? buildPaymasterAndData(
                          this.addresses.paymaster
                      )
                    : "0x",
            });
            const signed = await signUserOperation(
                unsigned,
                stored.key,
                this.addresses.entryPoint,
                identity.chainId
            );
            return {
                metadata: stored.metadata,
                packed: signed,
                rpc: toRpcUserOperation(signed),
            };
        } finally {
            stored.key.destroy();
        }
    }

    async submitMove(
        identity: SessionIdentity,
        move: MoveRequest,
        {
            gas,
            receiptTimeoutMs = 60_000,
        }: {
            gas?: UserOperationGasOptions;
            receiptTimeoutMs?: number;
        } = {}
    ): Promise<SubmittedSessionMove> {
        const publicRecord = (await this.vault.list()).find(
            (record) =>
                this.#sessionId(record) ===
                this.#sessionId(identity)
        );
        if (!publicRecord) {
            throw new SessionUnavailableError("missing");
        }
        return this.coordinator.withNonceLock(
            publicRecord.account,
            async () => {
                const built = await this.buildMove(
                    identity,
                    move,
                    gas
                );
                const estimate = await estimateUserOperationGas(
                    this.bundler,
                    built.rpc,
                    this.addresses.entryPoint
                );
                const userOperationHash =
                    await submitUserOperation(
                        this.bundler,
                        built.rpc,
                        this.addresses.entryPoint
                    );
                const receipt = await this.#waitForReceipt(
                    userOperationHash,
                    receiptTimeoutMs
                );
                if (!receipt.success) {
                    throw new UserOperationExecutionError(receipt);
                }
                this.coordinator.publish({
                    type: "nonce-updated",
                    account: built.metadata.account,
                    nonce: String(
                        (built.packed as { nonce: bigint }).nonce + 1n
                    ),
                });
                return {
                    ...built,
                    estimate,
                    userOperationHash,
                    receipt,
                };
            }
        );
    }

    async submitMoveWithFallback<T>(
        identity: SessionIdentity,
        move: MoveRequest,
        directPrimaryMove: () => Promise<T>
    ): Promise<
        | { mode: "session"; result: SubmittedSessionMove }
        | {
              mode: "primary";
              result: T;
              sessionError: V3ErrorDescriptor;
          }
    > {
        try {
            return {
                mode: "session",
                result: await this.submitMove(identity, move),
            };
        } catch (error) {
            const descriptor = mapV3Error(error);
            if (!descriptor.directFallbackRecommended) throw error;
            return {
                mode: "primary",
                result: await directPrimaryMove(),
                sessionError: descriptor,
            };
        }
    }

    async refreshSession(
        identity: SessionIdentity,
        primarySigner: PrimarySigner
    ): Promise<StoredSessionMetadata> {
        const candidate = generateBrowserSessionKey(this.crypto);
        const salt = generateSessionSalt(this.crypto);
        try {
            const account = await deriveSessionExecutor({
                provider: this.provider,
                factory: this.addresses.sessionAccountFactory,
                owner: candidate.address,
                salt,
            });
            await this.vault.stageRefresh(
                identity,
                candidate,
                { account, salt, replace: true }
            );
            const transaction = prepareRefreshSession(
                this.addresses.sessionRegistry,
                identity.instance,
                account
            );
            try {
                const response =
                    await primarySigner.sendTransaction(transaction);
                await response.wait();
            } catch (error) {
                await this.vault.discardStagedRefresh(identity);
                throw error;
            }
            const metadata =
                await this.vault.commitStagedRefresh(identity);
            this.coordinator.publish({
                type: "session-rotated",
                sessionId: this.#sessionId(identity),
                account,
            });
            return metadata;
        } finally {
            candidate.destroy();
        }
    }

    async recoverPendingRefresh(
        identity: SessionIdentity
    ): Promise<StoredSessionMetadata | null> {
        const staged =
            await this.vault.loadStagedRefresh(identity);
        if (!staged) return null;
        try {
            const inspection = await inspectSessionOnChain({
                runner: this.provider,
                registryAddress: this.addresses.sessionRegistry,
                instance: identity.instance,
                primary: identity.primary,
                requestedExecutor:
                    staged.metadata.account,
            });
            if (
                inspection.executor !==
                staged.metadata.account
            ) {
                await this.vault.discardStagedRefresh(identity);
                return null;
            }
            const metadata =
                await this.vault.commitStagedRefresh(identity);
            this.coordinator.publish({
                type: "session-rotated",
                sessionId: this.#sessionId(identity),
                account: metadata.account,
            });
            return metadata;
        } finally {
            staged.key.destroy();
        }
    }

    async revokeSession(
        identity: SessionIdentity,
        primarySigner: PrimarySigner
    ): Promise<void> {
        const response = await primarySigner.sendTransaction(
            prepareRevokeSession(
                this.addresses.sessionRegistry,
                identity.instance
            )
        );
        await response.wait();
        await this.vault.remove(identity);
        this.coordinator.publish({
            type: "session-removed",
            sessionId: this.#sessionId(identity),
        });
    }

    close(): void {
        this.coordinator.close();
    }

    async #waitForReceipt(
        hash: string,
        timeoutMs: number
    ): Promise<Record<string, unknown>> {
        if (this.bundler.waitForReceipt) {
            return (await this.bundler.waitForReceipt(hash, {
                timeoutMs,
            })) as Record<string, unknown>;
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const receipt = await this.bundler.request({
                method: "eth_getUserOperationReceipt",
                params: [hash],
            });
            if (receipt) {
                return receipt as Record<string, unknown>;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, 500)
            );
        }
        throw new Error(
            "UserOperation receipt timed out without nonce reuse"
        );
    }

    #sessionId(identity: SessionIdentity): string {
        return [
            BigInt(identity.chainId).toString(),
            getAddress(identity.instance).toLowerCase(),
            getAddress(identity.primary).toLowerCase(),
        ].join(":");
    }
}
