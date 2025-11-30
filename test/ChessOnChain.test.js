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
});
