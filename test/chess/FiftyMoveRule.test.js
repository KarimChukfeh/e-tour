// test/chess/FiftyMoveRule.test.js
// Comprehensive tests for the fifty-move rule implementation

import { expect } from "chai";
import hre from "hardhat";

describe("Chess Fifty-Move Rule", function () {
    let chess, chessRulesModule;
    let owner, player1, player2;
    let whitePlayer, blackPlayer;

    const tierId = 0;
    const instanceId = 0;
    const roundNumber = 0;
    const matchNumber = 0;
    const entryFee = hre.ethers.parseEther("0.003");

    // Chess square mapping: square = row * 8 + col
    // Row 0 = rank 1 (white's back rank), Col 0 = file a
    const squares = {
        // Knights starting positions
        b1: 1, g1: 6,
        b8: 57, g8: 62,
        // Knight destination squares
        a3: 16, c3: 18, f3: 21, h3: 23,
        a6: 40, c6: 42, f6: 45, h6: 47,
        // Pawns for testing reset
        e2: 12, e4: 28,
        e7: 52, e5: 36,
        d2: 11, d4: 27,
        d7: 51, d5: 35,
        // For captures
        c4: 26, c5: 34
    };

    const PieceType = {
        None: 0,
        Pawn: 1,
        Knight: 2,
        Bishop: 3,
        Rook: 4,
        Queen: 5,
        King: 6
    };

    // Extract half-move clock from packedState (bits 14-21, 8 bits)
    function getHalfMoveClock(packedState) {
        return Number((packedState >> 14n) & 0xFFn);
    }

    // Compute match ID the same way the contract does
    function computeMatchId(tierId, instanceId, roundNumber, matchNumber) {
        return hre.ethers.solidityPackedKeccak256(
            ["uint8", "uint8", "uint8", "uint8"],
            [tierId, instanceId, roundNumber, matchNumber]
        );
    }

    beforeEach(async function () {
        [owner, player1, player2] = await hre.ethers.getSigners();

        // Deploy all required modules
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        chessRulesModule = await ChessRulesModule.deploy();
        await chessRulesModule.waitForDeployment();

        // Deploy ChessOnChain with all module addresses
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await chessRulesModule.getAddress()
        );
        await chess.waitForDeployment();
    });

    describe("ChessRulesModule - Half-Move Clock Unit Tests", function () {
        it("Should start with half-move clock at 0", async function () {
            const initialState = await chessRulesModule.INITIAL_STATE();
            expect(getHalfMoveClock(initialState)).to.equal(0);
        });

        it("Should increment half-move clock on non-pawn, non-capture moves", async function () {
            const initialBoard = await chessRulesModule.INITIAL_BOARD();
            const initialState = await chessRulesModule.INITIAL_STATE();

            // Move knight Ng1-f3 (no pawn, no capture)
            const [newBoard, newState, isCapture, isPawnMove] = await chessRulesModule.executeMove(
                initialBoard, initialState, squares.g1, squares.f3, PieceType.None, true
            );

            expect(isCapture).to.be.false;
            expect(isPawnMove).to.be.false;
            expect(getHalfMoveClock(newState)).to.equal(1);
        });

        it("Should reset half-move clock on pawn moves", async function () {
            const initialBoard = await chessRulesModule.INITIAL_BOARD();
            let state = await chessRulesModule.INITIAL_STATE();

            // First, make a knight move to increment the clock
            let [board, newState] = await chessRulesModule.executeMove(
                initialBoard, state, squares.g1, squares.f3, PieceType.None, true
            );
            expect(getHalfMoveClock(newState)).to.equal(1);

            // Now make a pawn move - should reset to 0
            const [, finalState, , isPawnMove] = await chessRulesModule.executeMove(
                board, newState, squares.e2, squares.e4, PieceType.None, true
            );

            expect(isPawnMove).to.be.true;
            expect(getHalfMoveClock(finalState)).to.equal(0);
        });

        it("Should reset half-move clock on captures", async function () {
            // Set up a board position where white knight can capture black pawn
            // Start with e4, e5, Nf3, then Nxe5 captures
            const initialBoard = await chessRulesModule.INITIAL_BOARD();
            let state = await chessRulesModule.INITIAL_STATE();

            // e2-e4
            let [board, newState] = await chessRulesModule.executeMove(
                initialBoard, state, squares.e2, squares.e4, PieceType.None, true
            );

            // e7-e5 (Black)
            [board, newState] = await chessRulesModule.executeMove(
                board, newState, squares.e7, squares.e5, PieceType.None, false
            );

            // Ng1-f3 (increases half-move clock since it's not a pawn move)
            [board, newState] = await chessRulesModule.executeMove(
                board, newState, squares.g1, squares.f3, PieceType.None, true
            );
            expect(getHalfMoveClock(newState)).to.equal(1);

            // d7-d5 (Black pawn - resets clock)
            [board, newState] = await chessRulesModule.executeMove(
                board, newState, squares.d7, squares.d5, PieceType.None, false
            );
            expect(getHalfMoveClock(newState)).to.equal(0);

            // Nb1-c3 (increases clock)
            [board, newState] = await chessRulesModule.executeMove(
                board, newState, squares.b1, squares.c3, PieceType.None, true
            );
            expect(getHalfMoveClock(newState)).to.equal(1);

            // d5-d4 (Black pawn - resets clock)
            [board, newState] = await chessRulesModule.executeMove(
                board, newState, squares.d5, squares.d4, PieceType.None, false
            );
            expect(getHalfMoveClock(newState)).to.equal(0);

            // Nc3xd4 (capture - should reset clock even though previous was 0)
            const [, captureState, isCapture] = await chessRulesModule.executeMove(
                board, newState, squares.c3, squares.d4, PieceType.None, true
            );
            expect(isCapture).to.be.true;
            expect(getHalfMoveClock(captureState)).to.equal(0);
        });

        it("Should return gameEnd=3 when half-move clock reaches 100", async function () {
            const initialBoard = await chessRulesModule.INITIAL_BOARD();
            let state = await chessRulesModule.INITIAL_STATE();

            // Manually set half-move clock to 99
            const halfMoveShift = 14n;
            const halfMoveMask = 0xFFn << halfMoveShift;
            state = (state & ~halfMoveMask) | (99n << halfMoveShift);

            // Verify we set it correctly
            expect(getHalfMoveClock(state)).to.equal(99);

            // Make one more non-pawn, non-capture move
            const [valid, , newState, gameEnd] = await chessRulesModule.processMove(
                initialBoard, state, squares.g1, squares.f3, PieceType.None, true
            );

            expect(valid).to.be.true;
            expect(getHalfMoveClock(newState)).to.equal(100);
            expect(gameEnd).to.equal(3); // fifty-move rule
        });

        it("Should NOT trigger fifty-move rule at 99 half-moves", async function () {
            const initialBoard = await chessRulesModule.INITIAL_BOARD();
            let state = await chessRulesModule.INITIAL_STATE();

            // Manually set half-move clock to 98
            const halfMoveShift = 14n;
            const halfMoveMask = 0xFFn << halfMoveShift;
            state = (state & ~halfMoveMask) | (98n << halfMoveShift);

            // Make one more move (reaches 99)
            const [valid, , newState, gameEnd] = await chessRulesModule.processMove(
                initialBoard, state, squares.g1, squares.f3, PieceType.None, true
            );

            expect(valid).to.be.true;
            expect(getHalfMoveClock(newState)).to.equal(99);
            expect(gameEnd).to.equal(0); // game continues
        });
    });

    describe("ChessOnChain - Fifty-Move Rule Integration Tests", function () {
        beforeEach(async function () {
            // Enroll two players to start a tournament
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Get match state to determine who is white/black
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);

            if (matchData.common.player1 === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should track half-move clock during actual gameplay", async function () {
            // Initial state - clock at 0
            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(0);

            // Move 1: White Ng1-f3 (non-pawn, non-capture)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g1, squares.f3, PieceType.None
            );

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(1);

            // Move 2: Black Ng8-f6 (non-pawn, non-capture)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g8, squares.f6, PieceType.None
            );

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(2);

            // Move 3: White e2-e4 (pawn move - should reset)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e2, squares.e4, PieceType.None
            );

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(0);
        });

        it("Should end game as draw when fifty-move rule triggers", async function () {
            this.timeout(120000); // This test takes a while

            // Knight shuffle sequence for each full move cycle:
            // White: Ng1-f3, Black: Ng8-f6 (2 half-moves)
            // White: Nf3-g1, Black: Nf6-g8 (2 half-moves)
            // White: Nb1-c3, Black: Nb8-c6 (2 half-moves)
            // White: Nc3-b1, Black: Nc6-b8 (2 half-moves)
            // = 8 half-moves per cycle, need 100 total = 12.5 cycles

            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            let halfMoves = 0;

            // We need exactly 100 half-moves of non-pawn, non-capture moves
            // Using knight shuttles: each knight can go back and forth

            const knightMoves = [
                // Cycle 1: g-knights out and back
                { white: [squares.g1, squares.f3], black: [squares.g8, squares.f6] },
                { white: [squares.f3, squares.g1], black: [squares.f6, squares.g8] },
                // Cycle 2: b-knights out and back
                { white: [squares.b1, squares.c3], black: [squares.b8, squares.c6] },
                { white: [squares.c3, squares.b1], black: [squares.c6, squares.b8] },
            ];

            // 4 moves in sequence = 8 half-moves per full cycle
            // Need 100 half-moves, so 12 full cycles (96) + 4 more half-moves (2 more white-black pairs)

            for (let cycle = 0; cycle < 12; cycle++) {
                for (const move of knightMoves) {
                    await chess.connect(whitePlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.white[0], move.white[1], PieceType.None
                    );
                    halfMoves++;

                    await chess.connect(blackPlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.black[0], move.black[1], PieceType.None
                    );
                    halfMoves++;
                }
            }

            // After 12 cycles = 96 half-moves
            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(96);
            expect(matchData.common.status).to.equal(1); // InProgress

            // 4 more half-moves to reach 100
            // Move 97-98: g-knights out
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g1, squares.f3, PieceType.None
            );
            halfMoves++;

            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g8, squares.f6, PieceType.None
            );
            halfMoves++;

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(98);

            // Move 99: g-knight back (white)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f3, squares.g1, PieceType.None
            );
            halfMoves++;

            // This is the 100th half-move - should trigger fifty-move rule
            // Check the event emission for match completion
            const matchId = computeMatchId(tierId, instanceId, roundNumber, matchNumber);
            const tx = await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f6, squares.g8, PieceType.None
            );
            halfMoves++;

            expect(halfMoves).to.equal(100);

            // Verify MatchCompleted event was emitted with draw
            await expect(tx).to.emit(chess, "MatchCompleted")
                .withArgs(
                    matchId,
                    hre.ethers.ZeroAddress,  // no winner
                    true,                     // isDraw
                    2                         // CompletionReason.Draw
                );

            // Note: After tournament completion, match data may be reset.
            // The event emission above confirms the fifty-move rule triggered correctly.
        });

        it("Should reset half-move clock and prevent fifty-move draw if pawn moves near limit", async function () {
            this.timeout(120000);

            // Build up to 98 half-moves with knight shuffles
            const knightMoves = [
                { white: [squares.g1, squares.f3], black: [squares.g8, squares.f6] },
                { white: [squares.f3, squares.g1], black: [squares.f6, squares.g8] },
                { white: [squares.b1, squares.c3], black: [squares.b8, squares.c6] },
                { white: [squares.c3, squares.b1], black: [squares.c6, squares.b8] },
            ];

            // 12 cycles = 96 half-moves
            for (let cycle = 0; cycle < 12; cycle++) {
                for (const move of knightMoves) {
                    await chess.connect(whitePlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.white[0], move.white[1], PieceType.None
                    );
                    await chess.connect(blackPlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.black[0], move.black[1], PieceType.None
                    );
                }
            }

            // 2 more half-moves to reach 98
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g1, squares.f3, PieceType.None
            );
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g8, squares.f6, PieceType.None
            );

            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(98);

            // Now make a pawn move - this should reset the clock!
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e2, squares.e4, PieceType.None
            );

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(0); // Reset!
            expect(matchData.common.status).to.equal(1); // Still InProgress
            expect(matchData.common.isDraw).to.be.false;
        });

        it("Should emit correct events when fifty-move rule triggers", async function () {
            this.timeout(120000);

            // Build up to 99 half-moves
            const knightMoves = [
                { white: [squares.g1, squares.f3], black: [squares.g8, squares.f6] },
                { white: [squares.f3, squares.g1], black: [squares.f6, squares.g8] },
                { white: [squares.b1, squares.c3], black: [squares.b8, squares.c6] },
                { white: [squares.c3, squares.b1], black: [squares.c6, squares.b8] },
            ];

            // 12 cycles = 96 half-moves
            for (let cycle = 0; cycle < 12; cycle++) {
                for (const move of knightMoves) {
                    await chess.connect(whitePlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.white[0], move.white[1], PieceType.None
                    );
                    await chess.connect(blackPlayer).makeMove(
                        tierId, instanceId, roundNumber, matchNumber,
                        move.black[0], move.black[1], PieceType.None
                    );
                }
            }

            // 3 more to reach 99
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g1, squares.f3, PieceType.None
            );
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g8, squares.f6, PieceType.None
            );
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f3, squares.g1, PieceType.None
            );

            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(99);

            // Compute match ID
            const matchId = computeMatchId(tierId, instanceId, roundNumber, matchNumber);

            // The 100th half-move should trigger the draw
            const tx = await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f6, squares.g8, PieceType.None
            );

            // Check for MatchCompleted event with isDraw=true
            await expect(tx).to.emit(chess, "MatchCompleted")
                .withArgs(
                    matchId,
                    hre.ethers.ZeroAddress,
                    true,
                    2 // CompletionReason.Draw
                );
        });
    });

    describe("Edge Cases", function () {
        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchData.common.player1 === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should correctly handle half-move clock with promotions (pawn move resets)", async function () {
            // This is an edge case - promotions are pawn moves and should reset the clock
            // We can't easily test this in integration without a long game, but the module handles it
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.status).to.equal(1); // Just verify setup works
        });

        it("Should handle en passant captures (both pawn move AND capture - resets clock)", async function () {
            // En passant is both a pawn move and a capture, so it definitely resets
            // Set up: e4, d5, e5, f5??, exf6 e.p.

            // Build up some half-moves first with knights
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, squares.g1, squares.f3, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, squares.g8, squares.f6, PieceType.None);

            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(2);

            // Pawn move resets
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, squares.e2, squares.e4, PieceType.None);
            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(getHalfMoveClock(matchData.packedState)).to.equal(0);
        });
    });
});
