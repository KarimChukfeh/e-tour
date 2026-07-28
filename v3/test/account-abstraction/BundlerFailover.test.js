import { expect } from "chai";
import {
    AmbiguousUserOperationSubmissionError,
    FailoverBundler,
} from "../../sdk/bundler-client.js";

const ENTRY_POINT =
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const HASH = `0x${"12".repeat(32)}`;

function provider(name, handler) {
    return {
        name,
        calls: [],
        async request(request) {
            this.calls.push(request);
            return handler(request);
        },
    };
}

describe("V3 multi-bundler safety", function () {
    it("health-checks two providers and fails over read-only RPC", async function () {
        const first = provider("first", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            throw new Error("read outage");
        });
        const second = provider("second", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            return { ok: true };
        });
        const client = new FailoverBundler({
            providers: [first, second],
            entryPoint: ENTRY_POINT,
        });

        expect(
            await client.request({
                method: "eth_estimateUserOperationGas",
                params: [{}, ENTRY_POINT],
            })
        ).to.deep.equal({ ok: true });
        expect(
            first.calls.some(
                (call) =>
                    call.method ===
                    "eth_estimateUserOperationGas"
            )
        ).to.equal(true);
        expect(
            second.calls.some(
                (call) =>
                    call.method ===
                    "eth_estimateUserOperationGas"
            )
        ).to.equal(true);
    });

    it("never automatically resubmits an ambiguous nonce to a second bundler", async function () {
        const first = provider("first", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            throw new Error("connection closed after request");
        });
        const second = provider("second", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            return HASH;
        });
        const client = new FailoverBundler({
            providers: [first, second],
            entryPoint: ENTRY_POINT,
        });

        try {
            await client.sendUserOperation({}, ENTRY_POINT);
            expect.fail("expected ambiguous submission");
        } catch (error) {
            expect(error).to.be.instanceOf(
                AmbiguousUserOperationSubmissionError
            );
            expect(error.provider).to.equal("first");
        }
        expect(
            second.calls.filter(
                (call) =>
                    call.method === "eth_sendUserOperation"
            )
        ).to.have.length(0);
    });

    it("polls all providers for inclusion without resubmitting", async function () {
        const receipt = {
            userOpHash: HASH,
            success: true,
        };
        const first = provider("first", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            return null;
        });
        const second = provider("second", ({ method }) => {
            if (method === "eth_supportedEntryPoints") {
                return [ENTRY_POINT];
            }
            return receipt;
        });
        const client = new FailoverBundler({
            providers: [first, second],
            entryPoint: ENTRY_POINT,
            receiptPollMs: 1,
        });

        expect(
            await client.waitForReceipt(HASH, {
                timeoutMs: 100,
            })
        ).to.deep.equal(receipt);
        for (const bundler of [first, second]) {
            expect(
                bundler.calls.some(
                    (call) =>
                        call.method ===
                        "eth_sendUserOperation"
                )
            ).to.equal(false);
        }
    });
});
