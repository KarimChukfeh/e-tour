import { getAddress, toBeHex } from "ethers";
import {
    decodeRevertData,
    fromRpcUserOperation,
    toRpcQuantity,
} from "./user-operation.js";

export class BundlerSimulationError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = "BundlerSimulationError";
        this.kind = "validation";
        this.code = -32500;
    }
}

export class LocalBundler {
    constructor({ entryPoint, bundlerSigner, beneficiary }) {
        this.entryPoint = entryPoint.connect(bundlerSigner);
        this.entryPointAddress = getAddress(entryPoint.target);
        this.beneficiary = getAddress(
            beneficiary ?? bundlerSigner.address
        );
        this.operations = new Map();
        this.receipts = new Map();
    }

    _requireEntryPoint(value) {
        if (getAddress(value) !== this.entryPointAddress) {
            throw new BundlerSimulationError(
                `unsupported EntryPoint ${value}`
            );
        }
    }

    _parseReceipt(userOperationHash, rpcOperation, receipt) {
        let operationEvent;
        let revertData;
        for (const log of receipt.logs) {
            try {
                const event = this.entryPoint.interface.parseLog(log);
                if (
                    event?.name === "UserOperationEvent" &&
                    event.args.userOpHash === userOperationHash
                ) {
                    operationEvent = event;
                }
                if (
                    event?.name === "UserOperationRevertReason" &&
                    event.args.userOpHash === userOperationHash
                ) {
                    revertData = event.args.revertReason;
                }
            } catch {
                // Non-EntryPoint log.
            }
        }
        if (!operationEvent) {
            throw new Error("UserOperationEvent not found");
        }
        return {
            userOpHash: userOperationHash,
            sender: operationEvent.args.sender,
            nonce: toRpcQuantity(operationEvent.args.nonce),
            actualGasCost: toRpcQuantity(
                operationEvent.args.actualGasCost
            ),
            actualGasUsed: toRpcQuantity(
                operationEvent.args.actualGasUsed
            ),
            success: operationEvent.args.success,
            revertData: revertData ?? null,
            revertReason: revertData
                ? decodeRevertData(revertData)
                : null,
            logs: receipt.logs,
            receipt,
            userOperation: rpcOperation,
            entryPoint: this.entryPointAddress,
        };
    }

    async _estimate(rpcOperation, entryPointAddress) {
        this._requireEntryPoint(entryPointAddress);
        const packed = fromRpcUserOperation(rpcOperation);
        try {
            const totalGas = await this.entryPoint.handleOps.estimateGas(
                [packed],
                this.beneficiary
            );
            return {
                preVerificationGas:
                    rpcOperation.preVerificationGas,
                verificationGasLimit:
                    rpcOperation.verificationGasLimit,
                callGasLimit: rpcOperation.callGasLimit,
                totalGasEstimate: toBeHex(totalGas),
            };
        } catch (error) {
            throw new BundlerSimulationError(
                "UserOperation validation simulation failed",
                error
            );
        }
    }

    async _send(rpcOperation, entryPointAddress) {
        this._requireEntryPoint(entryPointAddress);
        const packed = fromRpcUserOperation(rpcOperation);
        let userOperationHash;
        try {
            userOperationHash =
                await this.entryPoint.getUserOpHash(packed);
            const tx = await this.entryPoint.handleOps(
                [packed],
                this.beneficiary
            );
            const receipt = await tx.wait();
            const parsed = this._parseReceipt(
                userOperationHash,
                rpcOperation,
                receipt
            );
            this.operations.set(userOperationHash, {
                userOperation: rpcOperation,
                entryPoint: this.entryPointAddress,
                transactionHash: receipt.hash,
                blockHash: receipt.blockHash,
                blockNumber: toRpcQuantity(receipt.blockNumber),
            });
            this.receipts.set(userOperationHash, parsed);
            return userOperationHash;
        } catch (error) {
            if (error instanceof BundlerSimulationError) throw error;
            throw new BundlerSimulationError(
                "UserOperation submission failed validation",
                error
            );
        }
    }

    async request({ method, params = [] }) {
        switch (method) {
            case "eth_supportedEntryPoints":
                return [this.entryPointAddress];
            case "eth_estimateUserOperationGas":
                return this._estimate(params[0], params[1]);
            case "eth_sendUserOperation":
                return this._send(params[0], params[1]);
            case "eth_getUserOperationByHash":
                return this.operations.get(params[0]) ?? null;
            case "eth_getUserOperationReceipt":
                return this.receipts.get(params[0]) ?? null;
            default:
                throw new Error(`Unsupported local bundler method ${method}`);
        }
    }
}
