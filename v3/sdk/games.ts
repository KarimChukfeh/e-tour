import {
    AbiCoder,
    Interface,
    getAddress,
    isAddress,
} from "ethers";
import type {
    Address,
    CryptoSource,
    GameKind,
    Hex,
    MoveRequest,
} from "./types.js";
import { randomUint256 } from "./session-crypto.js";

const STANDARD_GAME = new Interface([
    "function makeMove(uint8 roundNumber,uint8 matchNumber,uint8 move)",
]);
const CHESS_GAME = new Interface([
    "function makeMove(uint8 roundNumber,uint8 matchNumber,uint8 fromSquare,uint8 toSquare,uint8 promotionPiece)",
]);
const SESSION_ACCOUNT_FACTORY = new Interface([
    "function getAddress(address owner,uint256 salt) view returns (address)",
]);

function uint8(value: number | undefined, label: string): number {
    if (
        !Number.isInteger(value) ||
        value === undefined ||
        value < 0 ||
        value > 255
    ) {
        throw new RangeError(`${label} must fit uint8`);
    }
    return value;
}

export function encodeGameMove(request: MoveRequest): Hex {
    const round = uint8(request.roundNumber, "roundNumber");
    const match = uint8(request.matchNumber, "matchNumber");
    if (request.game === "chess") {
        return CHESS_GAME.encodeFunctionData("makeMove", [
            round,
            match,
            uint8(request.fromSquare, "fromSquare"),
            uint8(request.toSquare, "toSquare"),
            uint8(
                request.promotionPiece ?? 0,
                "promotionPiece"
            ),
        ]) as Hex;
    }
    const move =
        request.game === "connectfour"
            ? request.column
            : request.cellIndex;
    return STANDARD_GAME.encodeFunctionData("makeMove", [
        round,
        match,
        uint8(move, request.game === "connectfour" ? "column" : "cellIndex"),
    ]) as Hex;
}

export function createInstanceArguments({
    playerCount,
    entryFee,
    enrollmentWindow,
    matchTimePerPlayer,
    timeIncrementPerMove,
    sessionExecutor,
}: {
    playerCount: number;
    entryFee: bigint;
    enrollmentWindow: bigint;
    matchTimePerPlayer: bigint;
    timeIncrementPerMove: bigint;
    sessionExecutor?: Address;
}): readonly [
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    Address,
] {
    return [
        playerCount,
        entryFee,
        enrollmentWindow,
        matchTimePerPlayer,
        timeIncrementPerMove,
        (sessionExecutor ??
            "0x0000000000000000000000000000000000000000") as Address,
    ];
}

export function enrollmentArguments(
    sessionExecutor?: Address
): readonly [Address] {
    return [
        (sessionExecutor ??
            "0x0000000000000000000000000000000000000000") as Address,
    ];
}

export function generateSessionSalt(
    crypto?: CryptoSource
): bigint {
    return randomUint256(crypto);
}

export async function deriveSessionExecutor({
    provider,
    factory,
    owner,
    salt,
}: {
    provider: {
        call(transaction: {
            to: Address;
            data: Hex;
        }): Promise<string>;
    };
    factory: Address;
    owner: Address;
    salt: bigint;
}): Promise<Address> {
    if (!isAddress(factory) || !isAddress(owner)) {
        throw new TypeError("factory and owner must be addresses");
    }
    const data = SESSION_ACCOUNT_FACTORY.encodeFunctionData(
        "getAddress",
        [getAddress(owner), salt]
    ) as Hex;
    const result = await provider.call({
        to: getAddress(factory) as Address,
        data,
    });
    const [account] = AbiCoder.defaultAbiCoder().decode(
        ["address"],
        result
    );
    return getAddress(account) as Address;
}

export function gameKindFromType(gameType: number): GameKind {
    if (gameType === 0) return "tictactoe";
    if (gameType === 1) return "connectfour";
    if (gameType === 2) return "chess";
    throw new RangeError(`unsupported game type ${gameType}`);
}
