import {
    Wallet,
    getAddress,
    getBytes,
    hexlify,
    type TypedDataDomain,
    type TypedDataField,
} from "ethers";
import type {
    Address,
    CryptoSource,
    Hex,
    SessionSigner,
} from "./types.js";

const SECP256K1_ORDER =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function requireCrypto(source?: CryptoSource): CryptoSource {
    const selected = source ?? globalThis.crypto;
    if (!selected?.getRandomValues || !selected?.subtle) {
        throw new Error(
            "Web Crypto getRandomValues and subtle are required"
        );
    }
    return selected;
}

function privateScalar(bytes: Uint8Array): bigint {
    return BigInt(hexlify(bytes));
}

export function randomUint256(source?: CryptoSource): bigint {
    const crypto = requireCrypto(source);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return BigInt(hexlify(bytes));
}

/**
 * Browser-generated session key. JSON serialization intentionally exposes
 * only the public address.
 */
export class BrowserSessionKey implements SessionSigner {
    readonly address: Address;
    #wallet: Wallet | null;
    #privateKey: Hex | null;
    #crypto: CryptoSource;

    private constructor(
        privateKey: Hex,
        crypto: CryptoSource
    ) {
        this.#wallet = new Wallet(privateKey);
        this.#privateKey = privateKey;
        this.#crypto = crypto;
        this.address = getAddress(
            this.#wallet.address
        ) as Address;
    }

    static generate(source?: CryptoSource): BrowserSessionKey {
        const crypto = requireCrypto(source);
        for (;;) {
            const candidate = new Uint8Array(32);
            crypto.getRandomValues(candidate);
            const scalar = privateScalar(candidate);
            if (scalar > 0n && scalar < SECP256K1_ORDER) {
                const key = new BrowserSessionKey(
                    hexlify(candidate) as Hex,
                    crypto
                );
                candidate.fill(0);
                return key;
            }
            candidate.fill(0);
        }
    }

    static fromPrivateKey(
        privateKey: Uint8Array | Hex
    ): BrowserSessionKey {
        const value =
            typeof privateKey === "string"
                ? privateKey
                : (hexlify(privateKey) as Hex);
        return new BrowserSessionKey(
            value,
            requireCrypto()
        );
    }

    async signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataField[]>,
        value: Record<string, unknown>
    ): Promise<string> {
        if (!this.#wallet) {
            throw new Error("session key has been destroyed");
        }
        return this.#wallet.signTypedData(domain, types, value);
    }

    /**
     * Encrypts the private scalar without exposing it through the public API.
     * The temporary byte copy is overwritten before this method returns.
     */
    async sealForVault(
        wrappingKey: CryptoKey,
        algorithm: AesGcmParams
    ): Promise<ArrayBuffer> {
        if (!this.#privateKey) {
            throw new Error("session key has been destroyed");
        }
        const secret = Uint8Array.from(getBytes(this.#privateKey));
        try {
            return await this.#crypto.subtle.encrypt(
                algorithm,
                wrappingKey,
                secret
            );
        } finally {
            secret.fill(0);
        }
    }

    destroy(): void {
        this.#wallet = null;
        this.#privateKey = null;
    }

    toJSON(): { address: Address } {
        return { address: this.address };
    }

    toString(): string {
        return `[BrowserSessionKey ${this.address}]`;
    }
}

export function generateBrowserSessionKey(
    source?: CryptoSource
): BrowserSessionKey {
    return BrowserSessionKey.generate(source);
}
