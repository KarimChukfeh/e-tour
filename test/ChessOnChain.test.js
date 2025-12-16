// test/ChessOnChain.test.js
// Tests for ChessOnChain contract, including check status regression test

import { expect } from "chai";
import hre from "hardhat";

describe("ChessOnChain Tests", function () {
    let chess;
    let owner, player1, player2;

    // Chess square mapping: square = row * 8 + col
    // Row 0 = rank 1 (white's back rank), Col 0 = file a
    const squares = {
        e2: 12, e4: 28, e5: 36, e7: 52,
        g1: 6, f3: 21,
        d8: 59, h4: 31,
        g2: 14, g3: 22,
        f1: 5,
        e1: 4, f2: 13  // King and f2 square
    };

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
        [owner, player1, player2] = await hre.ethers.getSigners();

        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy();
        await chess.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should deploy successfully", async function () {
            expect(await chess.getAddress()).to.be.properAddress;
        });

        it("Should have correct owner", async function () {
            expect(await chess.owner()).to.equal(owner.address);
        });
    });

    describe("Check Status Bug Fix", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 0;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        beforeEach(async function () {
            // Enroll two players to start a tournament
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Get match state to determine who is white/black (randomized in contract)
            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);

            // matchState[0] is player1 (White), matchState[1] is player2 (Black)
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should clear check status when player escapes check", async function () {
            // This test reproduces the bug where whiteInCheck stays true after White escapes check
            //
            // Sequence to get White in check:
            // 1. e2-e4 (White pawn)
            // 2. e7-e5 (Black pawn)
            // 3. Ng1-f3 (White knight)
            // 4. Qd8-h4 (Black queen threatens f2)
            // 5. g2-g3 (White pawn blocks)
            // 6. Qh4xe4+ (Black queen captures pawn, CHECK!)
            // 7. Bf1-e2 (White bishop blocks check)

            // Move 1: White e2-e4
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e2, squares.e4, PieceType.None
            );

            // Move 2: Black e7-e5
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e7, squares.e5, PieceType.None
            );

            // Move 3: White Ng1-f3
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g1, squares.f3, PieceType.None
            );

            // Move 4: Black Qd8-h4
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.d8, squares.h4, PieceType.None
            );

            // Move 5: White g2-g3
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.g2, squares.g3, PieceType.None
            );

            // Move 6: Black Qh4xe4+ (CHECK!)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.h4, squares.e4, PieceType.None
            );

            // Verify White is in check after Black's queen move
            let matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            const whiteInCheckAfterQueenMove = matchState[9];  // whiteInCheck is index 9
            expect(whiteInCheckAfterQueenMove).to.be.true;

            // Move 7: White Bf1-e2 (blocks check)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f1, squares.e2, PieceType.None
            );

            // THE BUG: Before the fix, whiteInCheck would still be true here
            // After the fix, whiteInCheck should be false immediately
            matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            const whiteInCheckAfterEscape = matchState[9];  // whiteInCheck is index 9

            expect(whiteInCheckAfterEscape).to.be.false;
        });

        it("Should correctly track check status throughout a game", async function () {
            // Initial state - no one in check
            let matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchState[9]).to.be.false;  // whiteInCheck
            expect(matchState[10]).to.be.false; // blackInCheck

            // After a regular move, still no check
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e2, squares.e4, PieceType.None
            );

            matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchState[9]).to.be.false;  // whiteInCheck
            expect(matchState[10]).to.be.false; // blackInCheck
        });
    });

    describe("Basic Game Flow", function () {
        it("Should allow a basic game to start", async function () {
            const tierId = 0;
            const instanceId = 1;  // Use different instance
            const entryFee = hre.ethers.parseEther("0.01");

            // Enroll players
            await expect(chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee }))
                .to.emit(chess, "PlayerEnrolled");

            await expect(chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee }))
                .to.emit(chess, "TournamentStarted");

            // Tournament should be in progress
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });
    });

    describe("Pawn Promotion", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 2;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        // Additional squares for promotion test
        const promoSquares = {
            // White pawns
            a2: 8, a4: 24, a5: 32, a6: 40, a7: 48, a8: 56,
            // Black pawns
            b7: 49, b5: 33, b6: 41,
            // Other pieces
            b8: 57,  // Black knight starting
            c6: 42,
            h7: 55, h5: 39, h6: 47,
        };

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should allow pawn promotion to Queen", async function () {
            // Strategy: Use h-file pawn, capture diagonally to g-file, promote on g8
            // g8 knight must move first so g8 is empty for promotion

            const sq = {
                h2: 15, h4: 31,  // white h-pawn
                g5: 38, g6: 46, g7: 54, g8: 62,  // g-file squares
                g7_pawn: 54,  // black g-pawn starts here
                g8_knight: 62, f6: 45, h5: 39,  // black knight g8 -> f6 -> h5
                a7: 48, a6: 40,  // black a-pawn for waste moves
            };

            // 1. h2-h4
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.h2, sq.h4, PieceType.None
            );

            // 2. g7-g5 (black g-pawn moves, opens diagonal for white)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.g7_pawn, sq.g5, PieceType.None
            );

            // 3. h4xg5 (white captures diagonally)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.h4, sq.g5, PieceType.None
            );

            // 4. Ng8-f6 (black knight moves away from g8!)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.g8_knight, sq.f6, PieceType.None
            );

            // 5. g5-g6
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.g5, sq.g6, PieceType.None
            );

            // 6. Nf6-h5 (black knight moves again)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.f6, sq.h5, PieceType.None
            );

            // 7. g6-g7
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.g6, sq.g7, PieceType.None
            );

            // 8. a7-a6 (black makes any move)
            await chess.connect(blackPlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.a7, sq.a6, PieceType.None
            );

            // 9. g7-g8=Q (PROMOTION! g8 is now empty since knight moved)
            await expect(
                chess.connect(whitePlayer).makeMove(
                    tierId, instanceId, roundNumber, matchNumber,
                    sq.g7, sq.g8, PieceType.Queen
                )
            ).to.emit(chess, "PawnPromoted");

            // Verify the pawn is now a queen
            const board = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(board[sq.g8].pieceType).to.equal(PieceType.Queen);
        });

        it("Should reject promotion with PieceType.None", async function () {
            // Same strategy as above - get pawn to g7
            const sq = {
                h2: 15, h4: 31,
                g5: 38, g6: 46, g7: 54, g8: 62,
                g7_pawn: 54,
                g8_knight: 62, f6: 45, h5: 39,
                a7: 48, a6: 40,
            };

            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h2, sq.h4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g7_pawn, sq.g5, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h4, sq.g5, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g8_knight, sq.f6, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g5, sq.g6, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.f6, sq.h5, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g6, sq.g7, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.a7, sq.a6, PieceType.None);

            // Try to promote with PieceType.None - should fail
            await expect(
                chess.connect(whitePlayer).makeMove(
                    tierId, instanceId, roundNumber, matchNumber,
                    sq.g7, sq.g8, PieceType.None
                )
            ).to.be.revertedWith("Invalid move");
        });
    });

    describe("Castling", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 3;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        // Square indices for castling
        const sq = {
            e1: 4, g1: 6, c1: 2,  // White king castling squares
            e2: 12, e4: 28,
            d2: 11, d4: 27,
            b1: 1, c3: 18,  // White knight moves
            f1: 5, c4: 26,  // White bishop moves
            d1: 3, f3: 21,  // White queen moves
            e7: 52, e5: 36,
            d7: 51, d6: 43,
            g8: 62, f6: 45,
        };

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should allow kingside castling", async function () {
            // Clear path for kingside castling: move knight and bishop
            // 1. e2-e4
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e2, sq.e4, PieceType.None);
            // 2. e7-e5
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e7, sq.e5, PieceType.None);
            // 3. Bf1-c4
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.f1, sq.c4, PieceType.None);
            // 4. d7-d6
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.d7, sq.d6, PieceType.None);
            // 5. Ng1-f3
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g1, sq.f3, PieceType.None);
            // 6. Ng8-f6
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g8, sq.f6, PieceType.None);

            // 7. O-O (kingside castling: e1-g1)
            await expect(
                chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e1, sq.g1, PieceType.None)
            ).to.emit(chess, "CastlingPerformed");

            // Verify king and rook positions
            const board = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(board[sq.g1].pieceType).to.equal(PieceType.King); // King on g1
            expect(board[5].pieceType).to.equal(PieceType.Rook);     // Rook on f1
        });

        it("Should report correct castling rights", async function () {
            const rights = await chess.getCastlingRights(tierId, instanceId, roundNumber, matchNumber);
            expect(rights.whiteKingSide).to.be.true;
            expect(rights.whiteQueenSide).to.be.true;
            expect(rights.blackKingSide).to.be.true;
            expect(rights.blackQueenSide).to.be.true;
        });
    });

    describe("Resignation", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 4;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should allow player to resign", async function () {
            await expect(
                chess.connect(whitePlayer).resign(tierId, instanceId, roundNumber, matchNumber)
            ).to.emit(chess, "Resignation")
             .and.to.emit(chess, "TournamentCompleted");

            // Tournament should reset after 2-player tournament completes
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling
        });

        it("Should declare opponent as winner on resignation", async function () {
            const tx = await chess.connect(whitePlayer).resign(tierId, instanceId, roundNumber, matchNumber);
            const receipt = await tx.wait();

            // Find Resignation event
            const resignEvent = receipt.logs.find(log => {
                try {
                    const parsed = chess.interface.parseLog(log);
                    return parsed?.name === "Resignation";
                } catch { return false; }
            });

            expect(resignEvent).to.not.be.undefined;
            const parsed = chess.interface.parseLog(resignEvent);
            expect(parsed.args.winner).to.equal(blackPlayer.address);
        });

        it("Should reject resignation from non-player", async function () {
            const [,,, nonPlayer] = await hre.ethers.getSigners();
            await expect(
                chess.connect(nonPlayer).resign(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("Not a player");
        });
    });

    describe("Draw by Agreement", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 5;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should allow opponent to accept draw", async function () {
            // Black can accept draw (since it's White's turn)
            await expect(
                chess.connect(blackPlayer).acceptDraw(tierId, instanceId, roundNumber, matchNumber)
            ).to.emit(chess, "TournamentCompleted");

            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset
        });

        it("Should reject draw acceptance from current turn player", async function () {
            await expect(
                chess.connect(whitePlayer).acceptDraw(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("Current turn player must wait for opponent");
        });
    });

    describe("Timeout Claims", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 6;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should allow timeout claim after timeout period", async function () {
            // Fast forward past timeout (1 minute)
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                chess.connect(blackPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.emit(chess, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            await expect(
                chess.connect(blackPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("Timeout not reached");
        });

        it("Should reject timeout claim on your own turn", async function () {
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                chess.connect(whitePlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("Cannot claim timeout on your own turn");
        });
    });

    describe("View Functions", function () {
        const tierId = 0;
        const instanceId = 7;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
        });

        it("Should return chess match data", async function () {
            const match = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(match.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.status).to.equal(1); // InProgress
            expect(match.fullMoveNumber).to.equal(1);
        });

        it("Should return board state", async function () {
            const board = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(board.length).to.equal(64);

            // Check initial position - white king on e1 (square 4)
            expect(board[4].pieceType).to.equal(PieceType.King);
            // Black king on e8 (square 60)
            expect(board[60].pieceType).to.equal(PieceType.King);
        });

        it("Should return move history", async function () {
            const history = await chess.getMoveHistory(tierId, instanceId, roundNumber, matchNumber);
            expect(history).to.equal("0x"); // Empty initially
        });

        it("Should return RW3 compliance declaration", async function () {
            const declaration = await chess.declareRW3();
            expect(declaration).to.include("ChessOnChain");
            expect(declaration).to.include("RW3 COMPLIANCE");
        });
    });

    describe("Scholar's Mate (Checkmate)", function () {
        let whitePlayer, blackPlayer;
        const tierId = 0;
        const instanceId = 8;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        // Squares for Scholar's Mate
        const sq = {
            e2: 12, e4: 28,
            e7: 52, e5: 36,
            f1: 5, c4: 26,
            b8: 57, c6: 42,
            d1: 3, h5: 39, f7: 53,
        };

        beforeEach(async function () {
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchState[0] === player1.address) {
                whitePlayer = player1;
                blackPlayer = player2;
            } else {
                whitePlayer = player2;
                blackPlayer = player1;
            }
        });

        it("Should detect checkmate (Scholar's Mate)", async function () {
            // Scholar's Mate sequence:
            // 1. e2-e4
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e2, sq.e4, PieceType.None);
            // 2. e7-e5
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e7, sq.e5, PieceType.None);
            // 3. Bf1-c4
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.f1, sq.c4, PieceType.None);
            // 4. Nb8-c6
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.b8, sq.c6, PieceType.None);
            // 5. Qd1-h5
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.d1, sq.h5, PieceType.None);
            // 6. Ng8-f6?? (blunder)
            const nf6 = 45;
            const g8 = 62;
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, g8, nf6, PieceType.None);

            // 7. Qh5xf7# (CHECKMATE!)
            await expect(
                chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h5, sq.f7, PieceType.None)
            ).to.emit(chess, "CheckmateDeclared")
             .and.to.emit(chess, "TournamentCompleted");

            // Tournament should be completed and reset
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset)
        });
    });

    describe("4-Player Tournament", function () {
        const tierId = 1;
        const instanceId = 0;
        const entryFee = hre.ethers.parseEther("0.02");

        it("Should handle 4-player tournament bracket", async function () {
            // Get fresh signers for this test
            const signers = await hre.ethers.getSigners();
            const p1 = signers[0];
            const p2 = signers[1];
            const p3 = signers[2];
            const p4 = signers[3];

            // Enroll 4 different players
            await chess.connect(p1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(p2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(p3).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(p4).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Check tournament started
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round 0 has 2 matches
            const round0 = await chess.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(2);
        });
    });

    describe("Player Stats", function () {
        it("Should track player statistics", async function () {
            const tierId = 0;
            const instanceId = 9;
            const entryFee = hre.ethers.parseEther("0.01");

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchState = await chess.getChessMatch(tierId, instanceId, 0, 0);
            const whitePlayer = matchState[0] === player1.address ? player1 : player2;

            // Resign to complete quickly
            await chess.connect(whitePlayer).resign(tierId, instanceId, 0, 0);

            const loser = whitePlayer;
            const winner = loser === player1 ? player2 : player1;

            const winnerStats = await chess.getPlayerStats(winner.address);
            expect(winnerStats.matchesWon).to.be.gte(1);
            expect(winnerStats.tournamentsWon).to.be.gte(1);
        });
    });
});
