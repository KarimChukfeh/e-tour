import { getAddress, isHexString } from "ethers";

export class BundlerRpcError extends Error {
    constructor(message, { code, data, provider } = {}) {
        super(message);
        this.name = "BundlerRpcError";
        this.code = code;
        this.data = data;
        this.provider = provider;
    }
}

export class BundlerTransportError extends Error {
    constructor(message, { cause, provider } = {}) {
        super(message, { cause });
        this.name = "BundlerTransportError";
        this.provider = provider;
    }
}

export class AmbiguousUserOperationSubmissionError extends Error {
    constructor(provider, cause) {
        super(
            `UserOperation submission to ${provider} had no hash; ` +
                "automatic resubmission is disabled to prevent unsafe nonce reuse",
            { cause }
        );
        this.name = "AmbiguousUserOperationSubmissionError";
        this.provider = provider;
    }
}

export class JsonRpcBundler {
    constructor({
        name,
        url,
        fetchImpl = globalThis.fetch,
        timeoutMs = 10_000,
        onMetric = () => {},
    }) {
        if (!name || !url || typeof fetchImpl !== "function") {
            throw new TypeError(
                "bundler name, URL, and fetch implementation are required"
            );
        }
        this.name = name;
        this.url = url;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.onMetric = onMetric;
        this.nextId = 1;
    }

    async request({ method, params = [] }) {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            this.timeoutMs
        );
        try {
            const response = await this.fetchImpl(this.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: this.nextId++,
                    method,
                    params,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new BundlerTransportError(
                    `HTTP ${response.status} from ${this.name}`,
                    { provider: this.name }
                );
            }
            const payload = await response.json();
            if (payload.error) {
                throw new BundlerRpcError(
                    payload.error.message ?? "bundler RPC error",
                    {
                        code: payload.error.code,
                        data: payload.error.data,
                        provider: this.name,
                    }
                );
            }
            this.onMetric({
                provider: this.name,
                method,
                outcome: "success",
                latencyMs: Date.now() - startedAt,
            });
            return payload.result;
        } catch (error) {
            this.onMetric({
                provider: this.name,
                method,
                outcome: "error",
                latencyMs: Date.now() - startedAt,
                error: error.name,
            });
            if (
                error instanceof BundlerRpcError ||
                error instanceof BundlerTransportError
            ) {
                throw error;
            }
            throw new BundlerTransportError(
                `request to ${this.name} failed`,
                { cause: error, provider: this.name }
            );
        } finally {
            clearTimeout(timeout);
        }
    }
}

export class FailoverBundler {
    constructor({
        providers,
        entryPoint,
        receiptPollMs = 1_000,
        onMetric = () => {},
    }) {
        if (!Array.isArray(providers) || providers.length < 2) {
            throw new TypeError(
                "at least two bundler providers are required"
            );
        }
        this.providers = providers;
        this.entryPoint = getAddress(entryPoint);
        this.receiptPollMs = receiptPollMs;
        this.onMetric = onMetric;
    }

    async healthCheck() {
        return Promise.all(
            this.providers.map(async (provider) => {
                const startedAt = Date.now();
                try {
                    const supported = await provider.request({
                        method: "eth_supportedEntryPoints",
                        params: [],
                    });
                    const compatible = supported
                        .map(getAddress)
                        .includes(this.entryPoint);
                    const result = {
                        name: provider.name,
                        healthy: compatible,
                        supportedEntryPoints: supported,
                        latencyMs: Date.now() - startedAt,
                    };
                    this.onMetric({
                        provider: provider.name,
                        method: "health",
                        outcome: compatible
                            ? "success"
                            : "incompatible",
                        latencyMs: result.latencyMs,
                    });
                    return result;
                } catch (error) {
                    return {
                        name: provider.name,
                        healthy: false,
                        error,
                        latencyMs: Date.now() - startedAt,
                    };
                }
            })
        );
    }

    async _orderedHealthyProviders() {
        const health = await this.healthCheck();
        const healthyNames = new Set(
            health
                .filter((item) => item.healthy)
                .map((item) => item.name)
        );
        return this.providers.filter((provider) =>
            healthyNames.has(provider.name)
        );
    }

    async request({ method, params = [] }) {
        if (method === "eth_sendUserOperation") {
            return this.sendUserOperation(params[0], params[1]);
        }
        let lastError;
        const providers = await this._orderedHealthyProviders();
        for (const provider of providers) {
            try {
                return await provider.request({ method, params });
            } catch (error) {
                lastError = error;
            }
        }
        throw (
            lastError ??
            new BundlerTransportError(
                "no compatible bundler is healthy"
            )
        );
    }

    async sendUserOperation(userOperation, entryPoint) {
        if (getAddress(entryPoint) !== this.entryPoint) {
            throw new TypeError("unsupported EntryPoint");
        }
        const providers = await this._orderedHealthyProviders();
        if (providers.length === 0) {
            throw new BundlerTransportError(
                "no compatible bundler is healthy"
            );
        }
        const provider = providers[0];
        const startedAt = Date.now();
        try {
            const hash = await provider.request({
                method: "eth_sendUserOperation",
                params: [userOperation, this.entryPoint],
            });
            if (!isHexString(hash, 32)) {
                throw new BundlerRpcError(
                    "bundler returned an invalid UserOperation hash",
                    { provider: provider.name }
                );
            }
            this.onMetric({
                provider: provider.name,
                method: "eth_sendUserOperation",
                outcome: "submitted",
                latencyMs: Date.now() - startedAt,
                userOperationHash: hash,
            });
            return hash;
        } catch (error) {
            this.onMetric({
                provider: provider.name,
                method: "eth_sendUserOperation",
                outcome: "ambiguous",
                latencyMs: Date.now() - startedAt,
                error: error.name,
            });
            throw new AmbiguousUserOperationSubmissionError(
                provider.name,
                error
            );
        }
    }

    async waitForReceipt(
        userOperationHash,
        { timeoutMs = 60_000 } = {}
    ) {
        if (!isHexString(userOperationHash, 32)) {
            throw new TypeError(
                "userOperationHash must be bytes32"
            );
        }
        const deadline = Date.now() + timeoutMs;
        const startedAt = Date.now();
        let lastError;
        while (Date.now() < deadline) {
            for (const provider of this.providers) {
                try {
                    const receipt = await provider.request({
                        method: "eth_getUserOperationReceipt",
                        params: [userOperationHash],
                    });
                    if (receipt) {
                        this.onMetric({
                            provider: provider.name,
                            method:
                                "eth_getUserOperationReceipt",
                            outcome: receipt.success
                                ? "included"
                                : "reverted",
                            latencyMs: Date.now() - startedAt,
                            userOperationHash,
                            revertReason:
                                receipt.revertReason ?? null,
                        });
                        return receipt;
                    }
                } catch (error) {
                    lastError = error;
                }
            }
            await new Promise((resolve) =>
                setTimeout(resolve, this.receiptPollMs)
            );
        }
        this.onMetric({
            provider: null,
            method: "eth_getUserOperationReceipt",
            outcome: "timeout",
            latencyMs: Date.now() - startedAt,
            userOperationHash,
        });
        throw new BundlerTransportError(
            "UserOperation inclusion timed out; the nonce was not reused",
            { cause: lastError }
        );
    }
}
