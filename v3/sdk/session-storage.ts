import { getAddress, hexlify } from "ethers";
import {
    BrowserSessionKey,
} from "./session-crypto.js";
import type {
    Address,
    CryptoSource,
    SessionIdentity,
    StoredSessionMetadata,
} from "./types.js";

export interface AsyncKeyValueStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

export class MemoryKeyValueStore implements AsyncKeyValueStore {
    readonly values = new Map<string, unknown>();

    async get(key: string): Promise<unknown> {
        return this.values.get(key);
    }

    async set(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
    }

    async keys(): Promise<string[]> {
        return [...this.values.keys()];
    }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

export class IndexedDbKeyValueStore implements AsyncKeyValueStore {
    readonly databaseName: string;
    readonly storeName: string;
    #database?: Promise<IDBDatabase>;

    constructor(
        databaseName = "etour-v3-session-vault",
        storeName = "key-value"
    ) {
        this.databaseName = databaseName;
        this.storeName = storeName;
    }

    async #open(): Promise<IDBDatabase> {
        if (!globalThis.indexedDB) {
            throw new Error("IndexedDB is unavailable");
        }
        if (!this.#database) {
            this.#database = new Promise((resolve, reject) => {
                const request = globalThis.indexedDB.open(
                    this.databaseName,
                    1
                );
                request.onupgradeneeded = () => {
                    if (
                        !request.result.objectStoreNames.contains(
                            this.storeName
                        )
                    ) {
                        request.result.createObjectStore(
                            this.storeName
                        );
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () =>
                    reject(
                        request.error ??
                            new Error("IndexedDB open failed")
                    );
            });
        }
        return this.#database;
    }

    async #store(
        mode: IDBTransactionMode
    ): Promise<IDBObjectStore> {
        const database = await this.#open();
        return database
            .transaction(this.storeName, mode)
            .objectStore(this.storeName);
    }

    async get(key: string): Promise<unknown> {
        return requestResult((await this.#store("readonly")).get(key));
    }

    async set(key: string, value: unknown): Promise<void> {
        await requestResult(
            (await this.#store("readwrite")).put(value, key)
        );
    }

    async delete(key: string): Promise<void> {
        await requestResult(
            (await this.#store("readwrite")).delete(key)
        );
    }

    async keys(): Promise<string[]> {
        const keys = await requestResult(
            (await this.#store("readonly")).getAllKeys()
        );
        return keys.map(String);
    }
}

interface EncryptedSessionRecord {
    version: 1;
    metadata: Omit<StoredSessionMetadata, "chainId" | "salt"> & {
        chainId: string;
        salt: string;
    };
    iv: string;
    ciphertext: string;
}

function sourceOrThrow(source?: CryptoSource): CryptoSource {
    const selected = source ?? globalThis.crypto;
    if (!selected?.subtle || !selected?.getRandomValues) {
        throw new Error("Web Crypto is required for session persistence");
    }
    return selected;
}

function base64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
    );
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer;
}

function normalizedIdentity(identity: SessionIdentity): SessionIdentity {
    return {
        chainId: BigInt(identity.chainId),
        instance: getAddress(identity.instance) as Address,
        primary: getAddress(identity.primary) as Address,
    };
}

export function sessionStorageKey(identity: SessionIdentity): string {
    const normalized = normalizedIdentity(identity);
    return [
        "session",
        normalized.chainId.toString(),
        normalized.instance.toLowerCase(),
        normalized.primary.toLowerCase(),
    ].join(":");
}

export function pendingRefreshStorageKey(
    identity: SessionIdentity
): string {
    return sessionStorageKey(identity).replace(
        /^session:/,
        "pending-refresh:"
    );
}

export class SessionKeyVault {
    readonly store: AsyncKeyValueStore;
    readonly crypto: CryptoSource;
    readonly keyName = "vault:aes-gcm:v1";

    constructor({
        store = new IndexedDbKeyValueStore(),
        crypto,
    }: {
        store?: AsyncKeyValueStore;
        crypto?: CryptoSource;
    } = {}) {
        this.store = store;
        this.crypto = sourceOrThrow(crypto);
    }

    async #wrappingKey(): Promise<CryptoKey> {
        const current = await this.store.get(this.keyName);
        if (current) return current as CryptoKey;
        const key = await this.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
        await this.store.set(this.keyName, key);
        return key;
    }

    async save(
        identity: SessionIdentity,
        sessionKey: BrowserSessionKey,
        {
            account,
            salt,
            replace = false,
            now = Date.now(),
        }: {
            account: Address;
            salt: bigint;
            replace?: boolean;
            now?: number;
        }
    ): Promise<StoredSessionMetadata> {
        return this.#saveAt(
            sessionStorageKey(identity),
            identity,
            sessionKey,
            { account, salt, replace, now }
        );
    }

    async stageRefresh(
        identity: SessionIdentity,
        sessionKey: BrowserSessionKey,
        {
            account,
            salt,
            replace = false,
            now = Date.now(),
        }: {
            account: Address;
            salt: bigint;
            replace?: boolean;
            now?: number;
        }
    ): Promise<StoredSessionMetadata> {
        return this.#saveAt(
            pendingRefreshStorageKey(identity),
            identity,
            sessionKey,
            { account, salt, replace, now }
        );
    }

    async #saveAt(
        recordKey: string,
        identity: SessionIdentity,
        sessionKey: BrowserSessionKey,
        {
            account,
            salt,
            replace,
            now,
        }: {
            account: Address;
            salt: bigint;
            replace: boolean;
            now: number;
        }
    ): Promise<StoredSessionMetadata> {
        const normalized = normalizedIdentity(identity);
        const existing = await this.store.get(recordKey);
        if (existing && !replace) {
            throw new Error(
                "a session key already exists for this tournament"
            );
        }
        const current =
            (await this.store.get(
                sessionStorageKey(normalized)
            )) as EncryptedSessionRecord | undefined;
        const existingMetadata = current
            ? this.#metadata(current)
            : existing
              ? this.#metadata(existing as EncryptedSessionRecord)
              : null;
        const metadata: StoredSessionMetadata = {
            ...normalized,
            account: getAddress(account) as Address,
            owner: sessionKey.address,
            salt: BigInt(salt),
            createdAt: existingMetadata?.createdAt ?? now,
            updatedAt: now,
        };
        const iv = new Uint8Array(12);
        this.crypto.getRandomValues(iv);
        const ciphertext = await sessionKey.sealForVault(
            await this.#wrappingKey(),
            {
                name: "AES-GCM",
                iv: ownedBuffer(iv),
                additionalData: ownedBuffer(
                    new TextEncoder().encode(
                        sessionStorageKey(normalized)
                    )
                ),
            }
        );
        const record: EncryptedSessionRecord = {
            version: 1,
            metadata: {
                ...metadata,
                chainId: metadata.chainId.toString(),
                salt: metadata.salt.toString(),
            },
            iv: base64(iv),
            ciphertext: base64(
                new Uint8Array(ciphertext)
            ),
        };
        await this.store.set(recordKey, record);
        return metadata;
    }

    async load(identity: SessionIdentity): Promise<{
        key: BrowserSessionKey;
        metadata: StoredSessionMetadata;
    } | null> {
        return this.#loadAt(
            sessionStorageKey(identity),
            identity
        );
    }

    async loadStagedRefresh(
        identity: SessionIdentity
    ): Promise<{
        key: BrowserSessionKey;
        metadata: StoredSessionMetadata;
    } | null> {
        return this.#loadAt(
            pendingRefreshStorageKey(identity),
            identity
        );
    }

    async #loadAt(
        recordKey: string,
        identity: SessionIdentity
    ): Promise<{
        key: BrowserSessionKey;
        metadata: StoredSessionMetadata;
    } | null> {
        const value = await this.store.get(recordKey);
        if (!value) return null;
        const record = value as EncryptedSessionRecord;
        if (record.version !== 1) {
            throw new Error("unsupported session vault record");
        }
        const plaintext = new Uint8Array(
            await this.crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: ownedBuffer(fromBase64(record.iv)),
                    additionalData: ownedBuffer(
                        new TextEncoder().encode(
                            sessionStorageKey(identity)
                        )
                    ),
                },
                await this.#wrappingKey(),
                ownedBuffer(fromBase64(record.ciphertext))
            )
        );
        try {
            const key = BrowserSessionKey.fromPrivateKey(plaintext);
            const metadata = this.#metadata(record);
            if (key.address !== metadata.owner) {
                key.destroy();
                throw new Error("session vault integrity mismatch");
            }
            return { key, metadata };
        } finally {
            plaintext.fill(0);
        }
    }

    async remove(identity: SessionIdentity): Promise<void> {
        await this.store.delete(sessionStorageKey(identity));
        await this.discardStagedRefresh(identity);
    }

    async commitStagedRefresh(
        identity: SessionIdentity
    ): Promise<StoredSessionMetadata> {
        const pendingKey = pendingRefreshStorageKey(identity);
        const record = await this.store.get(pendingKey);
        if (!record) {
            throw new Error("no staged session refresh exists");
        }
        await this.store.set(
            sessionStorageKey(identity),
            record
        );
        await this.store.delete(pendingKey);
        return this.#metadata(record as EncryptedSessionRecord);
    }

    async discardStagedRefresh(
        identity: SessionIdentity
    ): Promise<void> {
        await this.store.delete(
            pendingRefreshStorageKey(identity)
        );
    }

    async list(): Promise<StoredSessionMetadata[]> {
        const records: StoredSessionMetadata[] = [];
        for (const key of await this.store.keys()) {
            if (!key.startsWith("session:")) continue;
            const value = await this.store.get(key);
            if (value) {
                records.push(
                    this.#metadata(value as EncryptedSessionRecord)
                );
            }
        }
        return records;
    }

    #metadata(
        record: EncryptedSessionRecord
    ): StoredSessionMetadata {
        return {
            ...record.metadata,
            chainId: BigInt(record.metadata.chainId),
            salt: BigInt(record.metadata.salt),
            instance: getAddress(
                record.metadata.instance
            ) as Address,
            primary: getAddress(
                record.metadata.primary
            ) as Address,
            account: getAddress(
                record.metadata.account
            ) as Address,
            owner: getAddress(record.metadata.owner) as Address,
        };
    }
}

export function encryptedRecordContainsSecret(
    storedValue: unknown,
    privateKeyBytes: Uint8Array
): boolean {
    return JSON.stringify(storedValue)
        .toLowerCase()
        .includes(hexlify(privateKeyBytes).slice(2).toLowerCase());
}
