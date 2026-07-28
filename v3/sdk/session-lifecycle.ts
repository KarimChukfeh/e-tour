import {
    Contract,
    Interface,
    getAddress,
    type ContractRunner,
} from "ethers";
import type {
    Address,
    SessionInspection,
    TransactionRequest,
} from "./types.js";

const ZERO =
    "0x0000000000000000000000000000000000000000" as Address;
const REGISTRY_ABI = [
    "function getSession(address instance,address player) view returns ((address executor,uint48 issuedAt,uint48 validUntil,uint64 generation))",
    "function isSessionActive(address instance,address player,address executor) view returns (bool)",
    "function refreshSession(address instance,address newExecutor)",
    "function revokeSession(address instance)",
];
const REGISTRY_INTERFACE = new Interface(REGISTRY_ABI);

export interface SessionRegistryReader {
    getSession(
        instance: Address,
        primary: Address
    ): Promise<{
        executor: string;
        issuedAt: bigint;
        validUntil: bigint;
        generation: bigint;
    }>;
    isSessionActive(
        instance: Address,
        primary: Address,
        executor: Address
    ): Promise<boolean>;
}

export async function inspectSession({
    registry,
    instance,
    primary,
    requestedExecutor,
    now = BigInt(Math.floor(Date.now() / 1_000)),
}: {
    registry: SessionRegistryReader;
    instance: Address;
    primary: Address;
    requestedExecutor?: Address;
    now?: bigint;
}): Promise<SessionInspection> {
    const record = await registry.getSession(instance, primary);
    const executor = getAddress(record.executor) as Address;
    const issuedAt = BigInt(record.issuedAt);
    const validUntil = BigInt(record.validUntil);
    const generation = BigInt(record.generation);
    if (executor === ZERO) {
        return {
            status: generation === 0n ? "missing" : "revoked",
            executor,
            requestedExecutor,
            issuedAt,
            validUntil,
            generation,
            secondsRemaining: 0n,
        };
    }
    if (
        requestedExecutor &&
        executor !== getAddress(requestedExecutor)
    ) {
        return {
            status: "rotated",
            executor,
            requestedExecutor:
                getAddress(requestedExecutor) as Address,
            issuedAt,
            validUntil,
            generation,
            secondsRemaining:
                validUntil > now ? validUntil - now : 0n,
        };
    }
    if (validUntil <= now) {
        return {
            status: "expired",
            executor,
            requestedExecutor,
            issuedAt,
            validUntil,
            generation,
            secondsRemaining: 0n,
        };
    }
    const active = await registry.isSessionActive(
        instance,
        primary,
        executor
    );
    return {
        status: active ? "active" : "inactive",
        executor,
        requestedExecutor,
        issuedAt,
        validUntil,
        generation,
        secondsRemaining: validUntil - now,
    };
}

export async function inspectSessionOnChain({
    runner,
    registryAddress,
    ...request
}: {
    runner: ContractRunner;
    registryAddress: Address;
    instance: Address;
    primary: Address;
    requestedExecutor?: Address;
    now?: bigint;
}): Promise<SessionInspection> {
    const registry = new Contract(
        registryAddress,
        REGISTRY_ABI,
        runner
    ) as unknown as SessionRegistryReader;
    return inspectSession({ registry, ...request });
}

export function prepareRefreshSession(
    registry: Address,
    instance: Address,
    newExecutor: Address
): TransactionRequest {
    return {
        to: getAddress(registry) as Address,
        data: REGISTRY_INTERFACE.encodeFunctionData(
            "refreshSession",
            [getAddress(instance), getAddress(newExecutor)]
        ) as `0x${string}`,
        value: 0n,
    };
}

export function prepareRevokeSession(
    registry: Address,
    instance: Address
): TransactionRequest {
    return {
        to: getAddress(registry) as Address,
        data: REGISTRY_INTERFACE.encodeFunctionData(
            "revokeSession",
            [getAddress(instance)]
        ) as `0x${string}`,
        value: 0n,
    };
}

export class SessionLifecycleMonitor {
    readonly read: () => Promise<SessionInspection>;
    readonly intervalMs: number;
    readonly onChange: (inspection: SessionInspection) => void;
    readonly onError: (error: unknown) => void;
    #timer?: ReturnType<typeof setTimeout>;
    #last?: string;
    #running = false;

    constructor({
        read,
        onChange,
        onError = () => {},
        intervalMs = 15_000,
    }: {
        read: () => Promise<SessionInspection>;
        onChange: (inspection: SessionInspection) => void;
        onError?: (error: unknown) => void;
        intervalMs?: number;
    }) {
        this.read = read;
        this.onChange = onChange;
        this.onError = onError;
        this.intervalMs = intervalMs;
    }

    start(): void {
        if (this.#running) return;
        this.#running = true;
        void this.#poll();
    }

    stop(): void {
        this.#running = false;
        if (this.#timer) clearTimeout(this.#timer);
    }

    async #poll(): Promise<void> {
        if (!this.#running) return;
        try {
            const current = await this.read();
            const fingerprint = [
                current.status,
                current.executor,
                current.validUntil,
                current.generation,
            ].join(":");
            if (fingerprint !== this.#last) {
                this.#last = fingerprint;
                this.onChange(current);
            }
        } catch (error) {
            this.onError(error);
        } finally {
            if (this.#running) {
                this.#timer = setTimeout(
                    () => void this.#poll(),
                    this.intervalMs
                );
            }
        }
    }
}
