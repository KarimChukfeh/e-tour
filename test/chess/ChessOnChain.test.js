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

    // Helper to extract check status from packedState
    // Bit 12: whiteInCheck, Bit 13: blackInCheck
    function isWhiteInCheck(packedState) {
        return ((packedState >> 12n) & 1n) === 1n;
    }
    function isBlackInCheck(packedState) {
        return ((packedState >> 13n) & 1n) === 1n;
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

        const GameCacheModule = await hre.ethers.getContractFactory("GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();
        await moduleGameCache.waitForDeployment();

        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        const chessRulesModule = await ChessRulesModule.deploy();
        await chessRulesModule.waitForDeployment();

        // Deploy ChessOnChain with all module addresses
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress(),
            await chessRulesModule.getAddress()
        );
        await chess.waitForDeployment();
        // Tiers are now initialized in constructor
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
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);

            // matchData.common.player1 is White, matchData.common.player2 is Black
            if (matchData.common.player1 === player1.address) {
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
            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(isWhiteInCheck(matchData.packedState)).to.be.true;

            // Move 7: White Bf1-e2 (blocks check)
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.f1, squares.e2, PieceType.None
            );

            // THE BUG: Before the fix, whiteInCheck would still be true here
            // After the fix, whiteInCheck should be false immediately
            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(isWhiteInCheck(matchData.packedState)).to.be.false;
        });

        it("Should correctly track check status throughout a game", async function () {
            // Initial state - no one in check
            let matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(isWhiteInCheck(matchData.packedState)).to.be.false;
            expect(isBlackInCheck(matchData.packedState)).to.be.false;

            // After a regular move, still no check
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                squares.e2, squares.e4, PieceType.None
            );

            matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(isWhiteInCheck(matchData.packedState)).to.be.false;
            expect(isBlackInCheck(matchData.packedState)).to.be.false;
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

    describe("1v1 Duel Match Initialization", function () {
        const tierId = 0;
        const instanceId = 10;  // Fresh instance for this test
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        it("Should start match immediately after 2 players enroll in 1v1 duel", async function () {
            // First player enrolls - tournament should still be in Enrolling state
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });

            let tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling
            expect(tournament.enrolledCount).to.equal(1);

            // Second player enrolls - should trigger tournament start AND match creation
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Tournament should be InProgress
            tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(2);
            expect(tournament.currentRound).to.equal(0);

            // Round should be initialized with 1 match
            const round = await chess.rounds(tierId, instanceId, roundNumber);
            expect(round.initialized).to.be.true;
            expect(round.totalMatches).to.equal(1);
            expect(round.completedMatches).to.equal(0);

            // Match should exist and be InProgress
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.status).to.equal(1); // InProgress (not NotStarted)
            expect(matchData.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.player2).to.not.equal(hre.ethers.ZeroAddress);

            // Both enrolled players should be in the match
            const matchPlayers = [matchData.common.player1, matchData.common.player2];
            expect(matchPlayers).to.include(player1.address);
            expect(matchPlayers).to.include(player2.address);

            // Match should have proper timing initialized
            expect(matchData.common.startTime).to.be.gt(0);
            expect(matchData.common.lastMoveTime).to.be.gt(0);

            // Time remaining should be set (600 seconds per player for tier 0)
            expect(matchData.player1TimeRemaining).to.equal(600);
            expect(matchData.player2TimeRemaining).to.equal(600);

            // Board should be initialized (initial chess position)
            expect(matchData.packedBoard).to.not.equal(0);

            // Current turn should be set to player1 (white)
            expect(matchData.currentTurn).to.equal(matchData.common.player1);
            expect(matchData.firstPlayer).to.equal(matchData.common.player1);
        });

        it("Should allow immediate gameplay after match starts in 1v1 duel", async function () {
            const freshInstanceId = 11;

            // Enroll both players
            await chess.connect(player1).enrollInTournament(tierId, freshInstanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, freshInstanceId, { value: entryFee });

            // Get match data to determine who is white
            const matchData = await chess.getMatch(tierId, freshInstanceId, roundNumber, matchNumber);
            const whitePlayer = matchData.common.player1 === player1.address ? player1 : player2;

            // White should be able to make a move immediately (e2-e4)
            const e2 = 12;
            const e4 = 28;
            await expect(
                chess.connect(whitePlayer).makeMove(tierId, freshInstanceId, roundNumber, matchNumber, e2, e4, 0)
            ).to.emit(chess, "MoveMade");

            // Verify the board state changed
            const board = await chess.getBoard(tierId, freshInstanceId, roundNumber, matchNumber);
            expect(Number(board[e4])).to.equal(1); // White pawn now on e4
            expect(Number(board[e2])).to.equal(0); // e2 is empty
        });

        it("Should return correct status from all view functions after 1v1 duel starts", async function () {
            const freshInstanceId = 12;

            // Enroll both players
            await chess.connect(player1).enrollInTournament(tierId, freshInstanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, freshInstanceId, { value: entryFee });

            // Check via getMatch() - returns ChessMatchData struct
            const matchData = await chess.getMatch(tierId, freshInstanceId, roundNumber, matchNumber);
            expect(matchData.common.status).to.equal(1); // InProgress

            // Check via getRoundInfo() - returns (totalMatches, completedMatches, initialized)
            const roundInfo = await chess.getRoundInfo(tierId, freshInstanceId, roundNumber);
            expect(roundInfo[0]).to.equal(1);    // totalMatches = 1
            expect(roundInfo[1]).to.equal(0);    // completedMatches = 0
            expect(roundInfo[2]).to.be.true;     // initialized = true

            // Check via getTournamentInfo() - returns (status, currentRound, enrolledCount, prizePool, winner)
            const tournamentInfo = await chess.getTournamentInfo(tierId, freshInstanceId);
            expect(tournamentInfo[0]).to.equal(1); // TournamentStatus.InProgress
            expect(tournamentInfo[1]).to.equal(0); // currentRound = 0
            expect(tournamentInfo[2]).to.equal(2); // enrolledCount = 2

            // Check via raw matches mapping - returns Match struct fields
            // Compute matchId: keccak256(abi.encodePacked(tierId, instanceId, roundNumber, matchNumber))
            const matchId = hre.ethers.solidityPackedKeccak256(
                ["uint8", "uint8", "uint8", "uint8"],
                [tierId, freshInstanceId, roundNumber, matchNumber]
            );
            const rawMatch = await chess.matches(matchId);

            // rawMatch returns: (player1, player2, winner, currentTurn, firstPlayer, status, isDraw, packedBoard, packedState, startTime, lastMoveTime, player1TimeRemaining, player2TimeRemaining)
            expect(rawMatch.status).to.equal(1);      // MatchStatus.InProgress
            expect(rawMatch.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(rawMatch.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(rawMatch.startTime).to.be.gt(0);

            // Also verify via tournaments mapping
            const tournament = await chess.tournaments(tierId, freshInstanceId);
            expect(tournament.status).to.equal(1); // TournamentStatus.InProgress

            // Also verify via rounds mapping
            const round = await chess.rounds(tierId, freshInstanceId, roundNumber);
            expect(round.initialized).to.be.true;
            expect(round.totalMatches).to.equal(1);
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

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchData.common.player1 === player1.address) {
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
            await chess.connect(whitePlayer).makeMove(
                tierId, instanceId, roundNumber, matchNumber,
                sq.g7, sq.g8, PieceType.Queen
            );

            // Verify the pawn is now a queen (5 = White Queen)
            const board = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(Number(board[sq.g8])).to.equal(5); // White Queen
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

            // Try to promote with PieceType.None - should fail with "IM" (Invalid Move)
            await expect(
                chess.connect(whitePlayer).makeMove(
                    tierId, instanceId, roundNumber, matchNumber,
                    sq.g7, sq.g8, PieceType.None
                )
            ).to.be.revertedWith("IM");
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

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchData.common.player1 === player1.address) {
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
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e1, sq.g1, PieceType.None);

            // Verify king and rook positions after castling
            // King should be on g1 (6), Rook should be on f1 (5)
            const boardAfter = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(Number(boardAfter[sq.g1])).to.equal(6); // White King on g1
            expect(Number(boardAfter[5])).to.equal(4);    // White Rook on f1
        });
    });

    describe("Timeout Claims", function () {
        const tierId = 0;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        it("Should allow timeout claim after timeout period", async function () {
            const instanceId = 6; // Unique instance ID
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Get match to determine whose turn it is
            const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = match.currentTurn === player1.address ? player1 : player2;
            const blackPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Fast forward past timeout (10 minutes)
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                chess.connect(blackPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.emit(chess, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            const instanceId = 8; // Unique instance ID
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Get match to determine whose turn it is
            const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = match.currentTurn === player1.address ? player1 : player2;
            const blackPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Wait a small amount (10 seconds) - still well under the 600 second timeout
            await hre.ethers.provider.send("evm_increaseTime", [10]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                chess.connect(blackPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("TO");
        });

        it("Should reject timeout claim on your own turn", async function () {
            const instanceId = 9; // Unique instance ID
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Get match to determine whose turn it is
            const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = match.currentTurn === player1.address ? player1 : player2;
            const blackPlayer = match.currentTurn === player1.address ? player2 : player1;

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                chess.connect(whitePlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("OT");
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
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.status).to.equal(1); // InProgress
            // fullMoveNumber is encoded in packedState bits 22-31
        });

        it("Should return board state", async function () {
            const board = await chess.getBoard(tierId, instanceId, roundNumber, matchNumber);
            expect(board.length).to.equal(64);

            // Check initial position - white king on e1 (square 4)
            // Board returns raw uint8 values: 6 = White King, 12 (0xC) = Black King
            expect(Number(board[4])).to.equal(6); // White King
            // Black king on e8 (square 60)
            expect(Number(board[60])).to.equal(12); // Black King (0xC)
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

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            if (matchData.common.player1 === player1.address) {
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
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h5, sq.f7, PieceType.None);

            // Verify game ended - match should be completed with white as winner
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.status).to.equal(2); // Completed
            expect(matchData.common.winner).to.equal(whitePlayer.address);
        });
    });

    describe("4-Player Tournament", function () {
        const tierId = 5; // Tier 5 is a 4-player tier
        const instanceId = 0;
        const entryFee = hre.ethers.parseEther("0.025"); // Tier 5 entry fee

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
});
