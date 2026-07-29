import { expect } from "chai";
import {
    AbiCoder,
    Interface,
    Wallet,
    getAddress,
} from "ethers";
import {
    BrowserSessionKey,
    MemoryKeyValueStore,
    SessionCoordinator,
    SessionKeyVault,
    SessionUnavailableError,
    UserOperationExecutionError,
    V3SessionClient,
    deriveSessionExecutor,
    encodeGameMove,
    encryptedRecordContainsSecret,
    generateBrowserSessionKey,
    inspectSession,
    mapV3Error,
    prepareRefreshSession,
    prepareRevokeSession,
    sessionStorageKey,
} from "../../sdk/dist/index.js";

const address = (suffix) =>
    getAddress(`0x${suffix.padStart(40, "0")}`);

const ADDRESSES = Object.freeze({
    entryPoint: address("1001"),
    registry: address("1002"),
    factory: address("1003"),
    paymaster: address("1004"),
    instance: address("2001"),
    secondInstance: address("2002"),
    primary: address("3001"),
    executor: address("4001"),
});

function identity(instance = ADDRESSES.instance) {
    return {
        chainId: 42161n,
        instance,
        primary: ADDRESSES.primary,
    };
}

function fakeChannel() {
    return {
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        close() {},
    };
}

function fakeDerivationProvider() {
    return {
        async call(transaction) {
            const parsed = new Interface([
                "function getAddress(address owner,uint256 salt) view returns (address)",
            ]).decodeFunctionData("getAddress", transaction.data);
            const owner = BigInt(parsed.owner);
            const salt = BigInt(parsed.salt);
            const derived = address(
                ((owner ^ salt) & ((1n << 160n) - 1n))
                    .toString(16)
                    .padStart(40, "0")
            );
            return AbiCoder.defaultAbiCoder().encode(
                ["address"],
                [derived]
            );
        },
    };
}

describe("V3 browser session SDK", function () {
    describe("browser key generation and encrypted persistence", function () {
        it("uses getRandomValues, never a primary-wallet signature", function () {
            let calls = 0;
            const cryptoSource = {
                subtle: globalThis.crypto.subtle,
                getRandomValues(bytes) {
                    calls += 1;
                    return globalThis.crypto.getRandomValues(bytes);
                },
            };
            const first = generateBrowserSessionKey(cryptoSource);
            const second = generateBrowserSessionKey(cryptoSource);

            expect(calls).to.equal(2);
            expect(first.address).not.to.equal(second.address);
            expect(first).not.to.have.property("signMessage");
            expect(first).not.to.have.property("copySecretForVault");
            expect(JSON.stringify(first)).to.equal(
                JSON.stringify({ address: first.address })
            );
            expect(String(first)).not.to.include("private");

            first.destroy();
            second.destroy();
        });

        it("persists only AES-GCM ciphertext under a non-extractable wrapping key", async function () {
            const store = new MemoryKeyValueStore();
            const vault = new SessionKeyVault({ store });
            const raw = new Uint8Array(32);
            raw[31] = 7;
            const sessionKey =
                BrowserSessionKey.fromPrivateKey(raw);

            await vault.save(identity(), sessionKey, {
                account: ADDRESSES.executor,
                salt: 9n,
            });

            const wrappingKey = store.values.get(
                vault.keyName
            );
            const record = store.values.get(
                sessionStorageKey(identity())
            );
            expect(wrappingKey.extractable).to.equal(false);
            expect(wrappingKey.algorithm.name).to.equal("AES-GCM");
            expect(record).to.have.property("ciphertext");
            expect(record).not.to.have.property("privateKey");
            expect(
                encryptedRecordContainsSecret(record, raw)
            ).to.equal(false);

            const loaded = await vault.load(identity());
            expect(loaded.metadata.owner).to.equal(
                sessionKey.address
            );
            expect(loaded.metadata.account).to.equal(
                ADDRESSES.executor
            );
            loaded.key.destroy();
            sessionKey.destroy();
        });

        it("rejects ciphertext tampering instead of loading a corrupted key", async function () {
            const store = new MemoryKeyValueStore();
            const vault = new SessionKeyVault({ store });
            const sessionKey = generateBrowserSessionKey();
            await vault.save(identity(), sessionKey, {
                account: ADDRESSES.executor,
                salt: 11n,
            });
            const key = sessionStorageKey(identity());
            const record = store.values.get(key);
            store.values.set(key, {
                ...record,
                ciphertext: `${record.ciphertext.slice(0, -2)}AA`,
            });

            await expect(vault.load(identity())).to.be.rejected;
            sessionKey.destroy();
        });
    });

    describe("cross-tab state and nonce coordination", function () {
        it("delivers only public session state to local subscribers", function () {
            const coordinator = new SessionCoordinator({
                channelFactory: fakeChannel,
            });
            const received = [];
            coordinator.subscribe((event) => received.push(event));
            coordinator.publish({
                type: "session-saved",
                sessionId: "42161:instance:primary",
                account: ADDRESSES.executor,
            });

            expect(received).to.have.length(1);
            expect(received[0].account).to.equal(
                ADDRESSES.executor
            );
            expect(received[0]).not.to.have.property("key");
            expect(received[0]).not.to.have.property("signature");
            coordinator.close();
        });

        it("serializes concurrent nonce work with a shared browser lease", async function () {
            const values = new Map();
            const storage = {
                getItem: (key) => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, value),
                removeItem: (key) => values.delete(key),
            };
            const options = {
                channelFactory: fakeChannel,
                locks: undefined,
                localStorage: storage,
                leaseMs: 100,
            };
            const first = new SessionCoordinator(options);
            const second = new SessionCoordinator(options);
            const events = [];

            await Promise.all([
                first.withNonceLock(
                    ADDRESSES.executor,
                    async () => {
                        events.push("first:start");
                        await new Promise((resolve) =>
                            setTimeout(resolve, 30)
                        );
                        events.push("first:end");
                    }
                ),
                second.withNonceLock(
                    ADDRESSES.executor,
                    async () => {
                        events.push("second:start");
                        events.push("second:end");
                    }
                ),
            ]);

            expect(events).to.deep.equal([
                "first:start",
                "first:end",
                "second:start",
                "second:end",
            ]);
            first.close();
            second.close();
        });
    });

    describe("move and lifecycle helpers", function () {
        it("encodes all three canonical move shapes and validates uint8 inputs", function () {
            const standard = new Interface([
                "function makeMove(uint8,uint8,uint8)",
            ]);
            const chess = new Interface([
                "function makeMove(uint8,uint8,uint8,uint8,uint8)",
            ]);
            expect(
                standard.decodeFunctionData(
                    "makeMove",
                    encodeGameMove({
                        game: "tictactoe",
                        roundNumber: 1,
                        matchNumber: 2,
                        cellIndex: 8,
                    })
                )
            ).to.deep.equal([1n, 2n, 8n]);
            expect(
                standard.decodeFunctionData(
                    "makeMove",
                    encodeGameMove({
                        game: "connectfour",
                        roundNumber: 3,
                        matchNumber: 4,
                        column: 6,
                    })
                )
            ).to.deep.equal([3n, 4n, 6n]);
            expect(
                chess.decodeFunctionData(
                    "makeMove",
                    encodeGameMove({
                        game: "chess",
                        roundNumber: 5,
                        matchNumber: 6,
                        fromSquare: 12,
                        toSquare: 28,
                        promotionPiece: 0,
                    })
                )
            ).to.deep.equal([5n, 6n, 12n, 28n, 0n]);
            expect(() =>
                encodeGameMove({
                    game: "connectfour",
                    roundNumber: 0,
                    matchNumber: 0,
                    column: 256,
                })
            ).to.throw("column must fit uint8");
        });

        it("computes the counterfactual executor through the pinned factory", async function () {
            const owner = Wallet.createRandom().address;
            const provider = fakeDerivationProvider();
            const result = await deriveSessionExecutor({
                provider,
                factory: ADDRESSES.factory,
                owner,
                salt: 17n,
            });
            expect(result).to.match(/^0x[0-9A-Fa-f]{40}$/);
        });

        it("classifies missing, revoked, rotated, expired, inactive, and active records", async function () {
            const makeRegistry = (record, active = true) => ({
                async getSession() {
                    return record;
                },
                async isSessionActive() {
                    return active;
                },
            });
            const base = {
                executor: ADDRESSES.executor,
                issuedAt: 100n,
                validUntil: 200n,
                generation: 1n,
            };
            const inspect = (record, options = {}) =>
                inspectSession({
                    registry: makeRegistry(
                        record,
                        options.active
                    ),
                    instance: ADDRESSES.instance,
                    primary: ADDRESSES.primary,
                    requestedExecutor:
                        options.requestedExecutor,
                    now: options.now ?? 150n,
                });

            expect(
                (
                    await inspect({
                        ...base,
                        executor: address("0"),
                        generation: 0n,
                    })
                ).status
            ).to.equal("missing");
            expect(
                (
                    await inspect({
                        ...base,
                        executor: address("0"),
                        generation: 2n,
                    })
                ).status
            ).to.equal("revoked");
            expect(
                (
                    await inspect(base, {
                        requestedExecutor: address("4002"),
                    })
                ).status
            ).to.equal("rotated");
            expect(
                (await inspect(base, { now: 200n })).status
            ).to.equal("expired");
            expect(
                (await inspect(base, { active: false })).status
            ).to.equal("inactive");
            expect((await inspect(base)).status).to.equal(
                "active"
            );
        });

        it("builds refresh and revoke transactions for primary-wallet recovery", function () {
            const registry = new Interface([
                "function refreshSession(address,address)",
                "function revokeSession(address)",
            ]);
            const refresh = prepareRefreshSession(
                ADDRESSES.registry,
                ADDRESSES.instance,
                ADDRESSES.executor
            );
            const revoke = prepareRevokeSession(
                ADDRESSES.registry,
                ADDRESSES.instance
            );
            expect(refresh.to).to.equal(ADDRESSES.registry);
            expect(refresh.value).to.equal(0n);
            expect(
                registry.decodeFunctionData(
                    "refreshSession",
                    refresh.data
                )
            ).to.deep.equal([
                ADDRESSES.instance,
                ADDRESSES.executor,
            ]);
            expect(
                registry.decodeFunctionData(
                    "revokeSession",
                    revoke.data
                )
            ).to.deep.equal([ADDRESSES.instance]);
        });
    });

    describe("high-level client recovery and fallback", function () {
        function createClient() {
            const store = new MemoryKeyValueStore();
            const vault = new SessionKeyVault({ store });
            const coordinator = new SessionCoordinator({
                channelFactory: fakeChannel,
            });
            const client = new V3SessionClient({
                provider: fakeDerivationProvider(),
                bundler: {
                    async request() {
                        throw new Error("not used");
                    },
                },
                addresses: {
                    entryPoint: ADDRESSES.entryPoint,
                    sessionRegistry: ADDRESSES.registry,
                    sessionAccountFactory: ADDRESSES.factory,
                    paymaster: ADDRESSES.paymaster,
                },
                vault,
                coordinator,
            });
            return { client, vault };
        }

        it("creates a fresh executor per instance and rotates only after wallet confirmation", async function () {
            const { client, vault } = createClient();
            const first = await client.createSession(identity());
            const second = await client.createSession(
                identity(ADDRESSES.secondInstance)
            );
            expect(first.owner).not.to.equal(second.owner);
            expect(first.account).not.to.equal(second.account);

            let submitted;
            const signer = {
                async sendTransaction(transaction) {
                    submitted = transaction;
                    return { async wait() {} };
                },
            };
            const rotated = await client.refreshSession(
                identity(),
                signer
            );
            expect(rotated.owner).not.to.equal(first.owner);
            expect(rotated.account).not.to.equal(first.account);
            expect(submitted.to).to.equal(ADDRESSES.registry);
            expect((await vault.list())).to.have.length(2);

            await client.revokeSession(identity(), signer);
            expect(await vault.load(identity())).to.equal(null);
            expect((await vault.list())).to.have.length(1);
            client.close();
        });

        it("stages refresh encryption and preserves the active key when the wallet rejects", async function () {
            const { client, vault } = createClient();
            const active = await client.createSession(identity());

            await expect(
                client.refreshSession(identity(), {
                    async sendTransaction() {
                        throw new Error("user rejected");
                    },
                })
            ).to.be.rejectedWith("user rejected");

            const retained = await vault.load(identity());
            expect(retained.metadata.account).to.equal(
                active.account
            );
            retained.key.destroy();
            expect(
                await vault.loadStagedRefresh(identity())
            ).to.equal(null);
            client.close();
        });

        it("uses direct primary-wallet fallback only for session transport failures", async function () {
            const { client } = createClient();
            client.submitMove = async () => {
                throw new SessionUnavailableError("expired");
            };
            const result = await client.submitMoveWithFallback(
                identity(),
                {
                    game: "tictactoe",
                    roundNumber: 0,
                    matchNumber: 0,
                    cellIndex: 0,
                },
                async () => "primary-receipt"
            );
            expect(result.mode).to.equal("primary");
            expect(result.result).to.equal("primary-receipt");
            expect(result.sessionError.code).to.equal(
                "SESSION_EXPIRED"
            );

            client.submitMove = async () => {
                throw new UserOperationExecutionError({
                    revertReason: "execution reverted: CO",
                });
            };
            await expect(
                client.submitMoveWithFallback(
                    identity(),
                    {
                        game: "tictactoe",
                        roundNumber: 0,
                        matchNumber: 0,
                        cellIndex: 0,
                    },
                    async () => "must-not-run"
                )
            ).to.be.rejected;
            client.close();
        });
    });

    describe("client-facing error map", function () {
        it("decodes reviewed custom errors and terse game reasons", function () {
            const errors = new Interface([
                "error InactiveSession()",
                "error InvalidColumn()",
            ]);
            expect(
                mapV3Error(
                    errors.encodeErrorResult(
                        "InactiveSession"
                    )
                )
            ).to.include({
                code: "SESSION_INACTIVE",
                directFallbackRecommended: true,
            });
            expect(
                mapV3Error(
                    errors.encodeErrorResult("InvalidColumn")
                )
            ).to.include({
                code: "INVALID_COLUMN",
                directFallbackRecommended: false,
            });
            expect(
                mapV3Error("execution reverted: OT")
            ).to.include({
                code: "NOT_YOUR_TURN",
                directFallbackRecommended: false,
            });
        });

        it("recommends primary fallback for transport failures but not reverted moves", function () {
            expect(
                mapV3Error(
                    new Error("bundler network timed out")
                )
            ).to.include({
                code: "SESSION_TRANSPORT_UNAVAILABLE",
                directFallbackRecommended: true,
            });
            expect(
                mapV3Error(
                    new UserOperationExecutionError({
                        revertReason: "execution reverted: CO",
                    })
                )
            ).to.include({
                code: "CELL_OCCUPIED",
                directFallbackRecommended: false,
            });
        });

        it("does not misclassify bundler validation responses as transport failures", function () {
            expect(
                mapV3Error({
                    name: "BundlerRpcError",
                    message:
                        "UserOperation validation simulation failed",
                    data: "execution reverted: OT",
                    provider: "primary",
                })
            ).to.include({
                code: "NOT_YOUR_TURN",
                directFallbackRecommended: false,
            });
            expect(
                mapV3Error({
                    name: "BundlerRpcError",
                    message:
                        "UserOperation validation simulation failed",
                    data: "execution reverted without a reason",
                    provider: "primary",
                })
            ).to.include({
                code: "TRANSACTION_FAILED",
                directFallbackRecommended: false,
            });
        });
    });
});
