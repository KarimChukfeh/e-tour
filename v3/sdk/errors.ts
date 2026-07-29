import { Interface, isHexString } from "ethers";
import type { V3ErrorDescriptor } from "./types.js";

const ERROR_INTERFACES = [
    new Interface([
        "error ZeroAddress()",
        "error ExecutorIsPrimary()",
        "error InvalidSessionHost()",
        "error PlayerNotEnrolled()",
        "error InstanceConcluded()",
        "error SessionAlreadyActive()",
        "error ExecutorAlreadyBound(address instance,address player)",
        "error SameExecutor()",
        "error NoSession()",
    ]),
    new Interface([
        "error UnauthorizedCaller()",
        "error SenderCreatorOnly()",
        "error CounterfactualAddressMismatch()",
        "error SponsorshipPaused()",
        "error InvalidAccount()",
        "error MalformedPaymasterData()",
        "error GasLimitExceeded()",
        "error MaxCostExceeded()",
        "error InvalidExecutionWrapper()",
        "error ValueNotZero()",
        "error InvalidMoveSelector()",
        "error InvalidInstance()",
        "error InactiveSession()",
    ]),
    new Interface([
        "error OnlySelfCall()",
        "error InvalidSessionRegistry()",
        "error InvalidColumn()",
        "error ColumnFull()",
    ]),
];

const CUSTOM_MESSAGES: Record<string, V3ErrorDescriptor> = {
    ExecutorIsPrimary: {
        code: "SESSION_EXECUTOR_IS_PRIMARY",
        message:
            "The temporary session account must differ from the primary wallet.",
        retryable: false,
        directFallbackRecommended: false,
    },
    PlayerNotEnrolled: {
        code: "PRIMARY_NOT_ENROLLED",
        message: "Only an enrolled primary wallet can manage this session.",
        retryable: false,
        directFallbackRecommended: false,
    },
    InstanceConcluded: {
        code: "TOURNAMENT_CONCLUDED",
        message: "This tournament has already concluded.",
        retryable: false,
        directFallbackRecommended: false,
    },
    SessionAlreadyActive: {
        code: "SESSION_ALREADY_ACTIVE",
        message: "This tournament already has an active session.",
        retryable: false,
        directFallbackRecommended: false,
    },
    ExecutorAlreadyBound: {
        code: "EXECUTOR_ALREADY_BOUND",
        message:
            "This session account is already active in another tournament.",
        retryable: false,
        directFallbackRecommended: false,
    },
    SameExecutor: {
        code: "SESSION_EXECUTOR_UNCHANGED",
        message: "Choose a new session account before refreshing.",
        retryable: false,
        directFallbackRecommended: false,
    },
    NoSession: {
        code: "SESSION_NOT_FOUND",
        message: "No session exists for this tournament.",
        retryable: false,
        directFallbackRecommended: true,
    },
    SponsorshipPaused: {
        code: "SPONSORSHIP_PAUSED",
        message:
            "Sponsored moves are temporarily paused. Use the primary wallet.",
        retryable: true,
        directFallbackRecommended: true,
    },
    InactiveSession: {
        code: "SESSION_INACTIVE",
        message:
            "The session expired, was revoked, or was replaced. Refresh it or use the primary wallet.",
        retryable: false,
        directFallbackRecommended: true,
    },
    InvalidAccount: {
        code: "SESSION_ACCOUNT_UNRECOGNIZED",
        message:
            "The configured session account is not recognized by the sponsor.",
        retryable: false,
        directFallbackRecommended: true,
    },
    GasLimitExceeded: {
        code: "SPONSORSHIP_GAS_LIMIT",
        message: "The sponsored move exceeds the allowed gas limits.",
        retryable: false,
        directFallbackRecommended: true,
    },
    MaxCostExceeded: {
        code: "SPONSORSHIP_COST_LIMIT",
        message: "The sponsored move exceeds the maximum cost policy.",
        retryable: true,
        directFallbackRecommended: true,
    },
    InvalidMoveSelector: {
        code: "UNSUPPORTED_SPONSORED_CALL",
        message: "Only canonical game moves can be sponsored.",
        retryable: false,
        directFallbackRecommended: false,
    },
    InvalidColumn: {
        code: "INVALID_COLUMN",
        message: "Choose a Connect Four column from 0 through 6.",
        retryable: false,
        directFallbackRecommended: false,
    },
    ColumnFull: {
        code: "COLUMN_FULL",
        message: "That Connect Four column is full.",
        retryable: false,
        directFallbackRecommended: false,
    },
};

const REASON_MESSAGES: Record<string, V3ErrorDescriptor> = {
    IC: {
        code: "INVALID_MOVE",
        message: "That move is outside the game board.",
        retryable: false,
        directFallbackRecommended: false,
    },
    CO: {
        code: "CELL_OCCUPIED",
        message: "That board position is already occupied.",
        retryable: false,
        directFallbackRecommended: false,
    },
    NP: {
        code: "NOT_A_MATCH_PLAYER",
        message: "The primary wallet is not a player in this match.",
        retryable: false,
        directFallbackRecommended: false,
    },
    OT: {
        code: "NOT_YOUR_TURN",
        message: "It is not your turn.",
        retryable: false,
        directFallbackRecommended: false,
    },
    IS: {
        code: "INVALID_CHESS_SQUARE",
        message: "Choose two different chess squares from 0 through 63.",
        retryable: false,
        directFallbackRecommended: false,
    },
    NYP: {
        code: "NOT_YOUR_CHESS_PIECE",
        message: "The selected chess piece is not yours.",
        retryable: false,
        directFallbackRecommended: false,
    },
    IM: {
        code: "INVALID_CHESS_MOVE",
        message: "That chess move is not legal in the current position.",
        retryable: false,
        directFallbackRecommended: false,
    },
};

export class SessionUnavailableError extends Error {
    readonly status: string;

    constructor(status: string) {
        super(`session is ${status}`);
        this.name = "SessionUnavailableError";
        this.status = status;
    }
}

export class UserOperationExecutionError extends Error {
    readonly receipt: Record<string, unknown>;

    constructor(receipt: Record<string, unknown>) {
        super(
            String(
                receipt.revertReason ??
                    "UserOperation execution reverted"
            )
        );
        this.name = "UserOperationExecutionError";
        this.receipt = receipt;
    }
}

function collect(
    value: unknown,
    data: string[],
    messages: string[],
    seen = new WeakSet<object>()
): void {
    if (typeof value === "string") {
        if (isHexString(value) && value.length >= 10) {
            data.push(value);
        } else if (value.trim()) {
            messages.push(value.trim());
        }
        return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
        return;
    }
    seen.add(value);
    if (value instanceof Error && value.message.trim()) {
        messages.push(value.message.trim());
    }
    for (const [key, child] of Object.entries(
        value as Record<string, unknown>
    )) {
        // Error class names such as BundlerRpcError describe where a
        // deterministic validation error was reported, not whether the
        // transport itself failed.
        if (key === "name") continue;
        collect(child, data, messages, seen);
    }
}

export function mapV3Error(error: unknown): V3ErrorDescriptor {
    if (error instanceof SessionUnavailableError) {
        return {
            code: `SESSION_${error.status.toUpperCase()}`,
            message:
                "The session expired, was revoked, or was replaced. Refresh it or use the primary wallet.",
            retryable: false,
            directFallbackRecommended: true,
        };
    }
    if (error instanceof UserOperationExecutionError) {
        const nested = mapV3Error(
            error.receipt.revertReason ?? error.message
        );
        return {
            ...nested,
            directFallbackRecommended: false,
        };
    }
    const data: string[] = [];
    const messages: string[] = [];
    collect(error, data, messages);
    for (const candidate of data) {
        for (const contractInterface of ERROR_INTERFACES) {
            try {
                const parsed = contractInterface.parseError(candidate);
                if (!parsed) continue;
                const known = CUSTOM_MESSAGES[parsed.name];
                if (known) {
                    return {
                        ...known,
                        contractError: parsed.name,
                    };
                }
                return {
                    code: parsed.name
                        .replace(/([a-z])([A-Z])/g, "$1_$2")
                        .toUpperCase(),
                    message: `The transaction was rejected by ${parsed.name}.`,
                    retryable: false,
                    directFallbackRecommended: false,
                    contractError: parsed.name,
                };
            } catch {
                // Try the next reviewed error interface.
            }
        }
    }
    const combined = messages.join(" ");
    for (const [reason, descriptor] of Object.entries(
        REASON_MESSAGES
    )) {
        if (
            combined === reason ||
            combined.includes(`reverted with reason string '${reason}'`) ||
            combined.includes(`execution reverted: ${reason}`)
        ) {
            return descriptor;
        }
    }
    const lower = combined.toLowerCase();
    if (
        lower.includes("user rejected") ||
        lower.includes("user denied")
    ) {
        return {
            code: "USER_REJECTED",
            message: "You cancelled the wallet request.",
            retryable: true,
            directFallbackRecommended: false,
        };
    }
    if (
        lower.includes("bundler") ||
        lower.includes("transport") ||
        lower.includes("timed out") ||
        lower.includes("network") ||
        lower.includes("paymaster")
    ) {
        return {
            code: "SESSION_TRANSPORT_UNAVAILABLE",
            message:
                "Session transport is unavailable. Use the primary wallet or retry later.",
            retryable: true,
            directFallbackRecommended: true,
        };
    }
    return {
        code: "TRANSACTION_FAILED",
        message: "The transaction failed. Review the wallet or RPC details.",
        retryable: false,
        directFallbackRecommended: false,
    };
}
