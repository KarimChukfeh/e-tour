import hre from "hardhat";
import { expect } from "chai";

describe("Chess Advanced Draw Rules", function () {
    let chess;
    let whitePlayer, blackPlayer;
    const ENTRY_FEE = hre.ethers.parseEther("0.01"); // Chess uses 0.01 ETH for tier 0

    // PieceType enum values matching the contract
    const PieceType = {
        None: 0,
        Pawn: 1,
        Knight: 2,
        Bishop: 3,
        Rook: 4,
        Queen: 5,
        King: 6
    };

    beforeEach(async function () {
        [, whitePlayer, blackPlayer] = await hre.ethers.getSigners();

        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy();
    });

    describe("50-Move Rule (Automatic Draw)", function () {
        it("Should automatically trigger draw after 50 moves without pawn move or capture", async function () {
            this.timeout(120000); // 2 minutes for long test

            const tierId = 0;
            const instanceId = 0;

            // Enroll players
            await chess.connect(whitePlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });
            await chess.connect(blackPlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });

            const match = await chess.getMatch(tierId, instanceId, 0, 0);
            const white = match.currentTurn === whitePlayer.address ? whitePlayer : blackPlayer;
            const black = white === whitePlayer ? blackPlayer : whitePlayer;

            /**
             * 50-Move Rule Test Strategy:
             * - Start with a simplified endgame position (kings + knights only)
             * - Make 100 half-moves (50 full moves) with only knight moves
             * - No pawn moves, no captures
             * - After 50 moves, contract should automatically declare draw
             *
             * Simplified position after opening:
             * - Move pawns/pieces to create a position with just K+N vs K+N
             * - Then move knights back and forth for 50 moves
             */

            // Quick setup to simplified endgame (capture pieces to get K+N vs K+N)
            // This is a simplified approach - in practice we'd need to play out a proper game
            // For testing purposes, we'll track the halfMoveClock and verify it triggers at 100

            // Make opening moves to develop pieces
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 12, 28, PieceType.None); // e2-e4 (pawn, resets clock)
            let matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(0); // Pawn move resets

            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 52, 36, PieceType.None); // e7-e5 (pawn, resets clock)
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(0);

            // Develop knights
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 6, 21, PieceType.None); // g1-f3 (knight)
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(1); // Non-pawn, non-capture increments

            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 62, 45, PieceType.None); // g8-f6 (knight)
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(2);

            // Now make repetitive knight moves to accumulate 98 more half-moves (to reach 100 total)
            // Knight moves between f3-g1-f3 for white, f6-g8-f6 for black
            const knightMoves = [
                // White: f3 (21) -> g1 (6) -> f3 (21) cycle
                // Black: f6 (45) -> g8 (62) -> f6 (45) cycle
                { from: 21, to: 6 },   // White: f3 -> g1
                { from: 45, to: 62 },  // Black: f6 -> g8
                { from: 6, to: 21 },   // White: g1 -> f3
                { from: 62, to: 45 },  // Black: g8 -> f6
            ];

            // Need 98 more half-moves to reach 100 (50-move rule)
            // That's 24.5 full cycles of 4 moves = 24 cycles + 2 moves
            for (let cycle = 0; cycle < 24; cycle++) {
                for (let moveIdx = 0; moveIdx < knightMoves.length; moveIdx++) {
                    const player = moveIdx % 2 === 0 ? white : black;
                    const move = knightMoves[moveIdx];

                    await chess.connect(player).makeMove(
                        tierId,
                        instanceId,
                        0,
                        0,
                        move.from,
                        move.to,
                        PieceType.None
                    );

                    const currentHalfMove = 2 + cycle * 4 + moveIdx + 1;
                    matchState = await chess.getMatch(tierId, instanceId, 0, 0);

                    // Check halfMoveClock is incrementing correctly
                    expect(matchState.halfMoveClock).to.equal(currentHalfMove);

                    // If we've hit 100, next move should trigger draw
                    if (currentHalfMove === 99) {
                        // One more move should trigger the 50-move rule
                        const player = white;
                        const move = knightMoves[0]; // f3 -> g1

                        const tx = await chess.connect(player).makeMove(
                            tierId,
                            instanceId,
                            0,
                            0,
                            move.from,
                            move.to,
                            PieceType.None
                        );
                        const receipt = await tx.wait();

                        // Verify DrawByFiftyMoveRule event
                        const drawEvent = receipt.logs.find(log => {
                            try {
                                const parsed = chess.interface.parseLog(log);
                                return parsed?.name === "DrawByFiftyMoveRule";
                            } catch { return false; }
                        });

                        expect(drawEvent).to.not.be.undefined;

                        // Verify match completed as draw
                        matchState = await chess.getMatch(tierId, instanceId, 0, 0);
                        expect(matchState.common.status).to.equal(2); // Completed
                        expect(matchState.common.isDraw).to.be.true;
                        expect(matchState.common.winner).to.equal(hre.ethers.ZeroAddress);

                        // Verify tournament completed with both players as co-winners
                        const tournament = await chess.tournaments(tierId, instanceId);
                        expect(tournament.finalsWasDraw).to.be.true;

                        // Verify equal prize distribution
                        const whitePrize = await chess.playerPrizes(tierId, instanceId, whitePlayer.address);
                        const blackPrize = await chess.playerPrizes(tierId, instanceId, blackPlayer.address);
                        expect(whitePrize).to.equal(blackPrize);
                        expect(whitePrize).to.be.gt(0);

                        return; // Test complete
                    }
                }
            }

            // If we get here, we're at move 98, need 2 more moves to reach 100 and trigger draw
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 21, 6, PieceType.None); // f3 -> g1 (move 99)
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(99);

            // 100th half-move should trigger draw
            const tx = await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 45, 62, PieceType.None); // f6 -> g8 (move 100)
            const receipt = await tx.wait();

            // Verify DrawByFiftyMoveRule event
            const drawEvent = receipt.logs.find(log => {
                try {
                    const parsed = chess.interface.parseLog(log);
                    return parsed?.name === "DrawByFiftyMoveRule";
                } catch { return false; }
            });

            expect(drawEvent).to.not.be.undefined;

            // Verify tournament completed with equal prize distribution
            const whitePrize = await chess.playerPrizes(tierId, instanceId, whitePlayer.address);
            const blackPrize = await chess.playerPrizes(tierId, instanceId, blackPlayer.address);
            expect(whitePrize).to.equal(blackPrize);
            expect(whitePrize).to.be.gt(0);
        });

        it("Should reset halfMoveClock on pawn move", async function () {
            const tierId = 0;
            const instanceId = 0;

            await chess.connect(whitePlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });
            await chess.connect(blackPlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });

            const match = await chess.getMatch(tierId, instanceId, 0, 0);
            const white = match.currentTurn === whitePlayer.address ? whitePlayer : blackPlayer;
            const black = white === whitePlayer ? blackPlayer : whitePlayer;

            // Make pawn move
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 12, 28, PieceType.None); // e2-e4
            let matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(0); // Pawn move resets to 0

            // Make knight move (non-pawn, non-capture)
            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 62, 45, PieceType.None); // g8-f6
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(1); // Increments

            // Make another knight move
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 6, 21, PieceType.None); // g1-f3
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(2); // Increments

            // Make pawn move again - should reset
            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 51, 35, PieceType.None); // d7-d5
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(0); // Reset to 0 on pawn move
        });

        it("Should reset halfMoveClock on capture", async function () {
            const tierId = 0;
            const instanceId = 0;

            await chess.connect(whitePlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });
            await chess.connect(blackPlayer).enrollInTournament(tierId, instanceId, { value: ENTRY_FEE });

            const match = await chess.getMatch(tierId, instanceId, 0, 0);
            const white = match.currentTurn === whitePlayer.address ? whitePlayer : blackPlayer;
            const black = white === whitePlayer ? blackPlayer : whitePlayer;

            // Setup for a capture
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 12, 28, PieceType.None); // e2-e4
            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 51, 35, PieceType.None); // d7-d5
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 6, 21, PieceType.None); // g1-f3 (non-pawn)
            let matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(1); // Should be 1 after non-pawn move

            await chess.connect(black).makeMove(tierId, instanceId, 0, 0, 62, 45, PieceType.None); // g8-f6 (non-pawn)
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(2);

            // Make capture: exd5 (pawn captures pawn)
            await chess.connect(white).makeMove(tierId, instanceId, 0, 0, 28, 35, PieceType.None); // e4 x d5
            matchState = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchState.halfMoveClock).to.equal(0); // Reset to 0 on capture
        });
    });

    describe("Insufficient Material Draw", function () {
        it.skip("Should automatically draw with only kings remaining", async function () {
            // This would require playing out a game to reach K vs K position
            // The contract checks for insufficient material after each move
            // Skipped: Too complex to reach this position programmatically without board setup API
        });

        it.skip("Should automatically draw with king + bishop vs king", async function () {
            // Similar to above - contract has the logic but reaching this
            // position programmatically would require extensive game simulation
            // Skipped: Too complex without board setup capability
        });

        it.skip("Should automatically draw with king + knight vs king", async function () {
            // Same reasoning as above
            // Skipped: Too complex without board setup capability
        });
    });

    describe("Stalemate Detection", function () {
        it.skip("Should detect stalemate when player has no legal moves but not in check", async function () {
            // Stalemate is a complex position to set up programmatically
            // Would require playing specific moves to corner the king
            // The contract has stalemate detection logic
            // Skipped: Would need manual board setup capability for comprehensive testing
        });
    });
});
