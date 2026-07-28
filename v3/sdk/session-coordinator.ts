import type { Address, CryptoSource } from "./types.js";

interface BroadcastChannelLike {
    postMessage(message: unknown): void;
    addEventListener(
        type: "message",
        listener: (event: MessageEvent) => void
    ): void;
    removeEventListener(
        type: "message",
        listener: (event: MessageEvent) => void
    ): void;
    close(): void;
}

interface LockManagerLike {
    request<T>(
        name: string,
        callback: () => Promise<T>
    ): Promise<T>;
}

interface LocalStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface SessionCoordinationEvent {
    type:
        | "session-saved"
        | "session-removed"
        | "session-rotated"
        | "nonce-updated";
    sessionId?: string;
    account?: Address;
    nonce?: string;
    timestamp: number;
}

const inProcessLocks = new Map<string, Promise<void>>();

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) =>
        setTimeout(resolve, milliseconds)
    );
}

function browserLocks(): LockManagerLike | undefined {
    try {
        return (
            globalThis.navigator as Navigator & {
                locks?: LockManagerLike;
            }
        )?.locks;
    } catch {
        return undefined;
    }
}

function browserLocalStorage(): LocalStorageLike | undefined {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
}

export class SessionCoordinator {
    readonly channelName: string;
    readonly channel?: BroadcastChannelLike;
    readonly locks?: LockManagerLike;
    readonly localStorage?: LocalStorageLike;
    readonly crypto: CryptoSource;
    readonly leaseMs: number;
    readonly listeners =
        new Set<(event: SessionCoordinationEvent) => void>();
    #messageListener: (event: MessageEvent) => void;

    constructor({
        channelName = "etour-v3-session",
        channelFactory,
        locks = browserLocks(),
        localStorage = browserLocalStorage(),
        crypto = globalThis.crypto,
        leaseMs = 120_000,
    }: {
        channelName?: string;
        channelFactory?: (
            name: string
        ) => BroadcastChannelLike;
        locks?: LockManagerLike;
        localStorage?: LocalStorageLike;
        crypto?: CryptoSource;
        leaseMs?: number;
    } = {}) {
        if (!crypto?.getRandomValues || !crypto?.subtle) {
            throw new Error("Web Crypto is required");
        }
        this.channelName = channelName;
        this.locks = locks;
        this.localStorage = localStorage;
        this.crypto = crypto;
        this.leaseMs = leaseMs;
        const createChannel =
            channelFactory ??
            (globalThis.BroadcastChannel
                ? (name: string) =>
                      new BroadcastChannel(name)
                : undefined);
        this.channel = createChannel?.(channelName);
        this.#messageListener = (message) => {
            const event =
                message.data as SessionCoordinationEvent;
            for (const listener of this.listeners) {
                listener(event);
            }
        };
        this.channel?.addEventListener(
            "message",
            this.#messageListener
        );
    }

    subscribe(
        listener: (event: SessionCoordinationEvent) => void
    ): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish(
        event: Omit<SessionCoordinationEvent, "timestamp">
    ): void {
        const published = {
            ...event,
            timestamp: Date.now(),
        } as SessionCoordinationEvent;
        for (const listener of this.listeners) {
            listener(published);
        }
        this.channel?.postMessage(published);
    }

    async withNonceLock<T>(
        account: Address,
        task: () => Promise<T>
    ): Promise<T> {
        const name = `etour-v3:nonce:${account.toLowerCase()}`;
        if (this.locks) {
            return this.locks.request(name, task);
        }
        if (this.localStorage) {
            return this.#withStorageLease(name, task);
        }
        return this.#withInProcessLock(name, task);
    }

    async #withStorageLease<T>(
        name: string,
        task: () => Promise<T>
    ): Promise<T> {
        const leaseKey = `${name}:lease`;
        const bytes = new Uint8Array(16);
        this.crypto.getRandomValues(bytes);
        const owner = [...bytes]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        const deadline = Date.now() + this.leaseMs * 2;
        for (;;) {
            const now = Date.now();
            const currentRaw =
                this.localStorage?.getItem(leaseKey);
            let current: { owner: string; expiresAt: number } | null =
                null;
            try {
                current = currentRaw
                    ? JSON.parse(currentRaw)
                    : null;
            } catch {
                current = null;
            }
            if (!current || current.expiresAt <= now) {
                const lease = {
                    owner,
                    expiresAt: now + this.leaseMs,
                };
                this.localStorage?.setItem(
                    leaseKey,
                    JSON.stringify(lease)
                );
                const confirmed = JSON.parse(
                    this.localStorage?.getItem(leaseKey) ?? "{}"
                );
                if (confirmed.owner === owner) break;
            }
            if (now >= deadline) {
                throw new Error("session nonce lock timed out");
            }
            await delay(25);
        }
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
            heartbeat = setInterval(() => {
                const current =
                    this.localStorage?.getItem(leaseKey);
                if (!current) return;
                try {
                    const parsed = JSON.parse(current);
                    if (parsed.owner === owner) {
                        this.localStorage?.setItem(
                            leaseKey,
                            JSON.stringify({
                                owner,
                                expiresAt:
                                    Date.now() + this.leaseMs,
                            })
                        );
                    }
                } catch {
                    // Public coordination state can be reclaimed on expiry.
                }
            }, Math.max(50, Math.floor(this.leaseMs / 2)));
            return await task();
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            const current = this.localStorage?.getItem(leaseKey);
            if (current) {
                try {
                    if (JSON.parse(current).owner === owner) {
                        this.localStorage?.removeItem(leaseKey);
                    }
                } catch {
                    // A malformed public lease contains no key material.
                }
            }
        }
    }

    async #withInProcessLock<T>(
        name: string,
        task: () => Promise<T>
    ): Promise<T> {
        const previous =
            inProcessLocks.get(name) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const queued = previous.then(() => current);
        inProcessLocks.set(name, queued);
        await previous;
        try {
            return await task();
        } finally {
            release();
            if (inProcessLocks.get(name) === queued) {
                inProcessLocks.delete(name);
            }
        }
    }

    close(): void {
        this.channel?.removeEventListener(
            "message",
            this.#messageListener
        );
        this.channel?.close();
        this.listeners.clear();
    }
}
