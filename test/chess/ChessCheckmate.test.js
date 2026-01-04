// test/ChessCheckmate.test.js
// Comprehensive tests for checkmate detection and tournament completion

import { expect } from "chai";
import hre from "hardhat";

describe("Chess Checkmate & Match Completion Tests", function () {
    let chess;
    let owner, player1, player2, player3, player4;

    const PieceType = {
        None: 0,
        Pawn: 1,
        Knight: 2,
        Bishop: 3,
        Rook: 4,
        Queen: 5,
        King: 6
    };

    // Tournament statuses
    const TournamentStatus = {
        Enrolling: 0,
        InProgress: 1,
        Completed: 2,
        Abandoned: 3
    };

    // Match statuses
    const MatchStatus = {
        NotStarted: 0,
        InProgress: 1,
        Completed: 2
    };

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        // Deploy all modules
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

        // Deploy ChessOnChain
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
    });

    describe("Checkmate Detection", function () {
        const tierId = 0;
        const instanceId = 0;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        it("Should detect Scholar's Mate and mark match as completed", async function () {
            // Enroll players
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Determine white and black players
            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = matchData.common.player1 === player1.address ? player1 : player2;
            const blackPlayer = matchData.common.player1 === player1.address ? player2 : player1;

            const sq = {
                e2: 12, e4: 28,
                e7: 52, e5: 36,
                f1: 5, c4: 26,
                b8: 57, c6: 42,
                d1: 3, h5: 39,
                g8: 62, f6: 45,
                f7: 53
            };

            // Scholar's Mate sequence
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e2, sq.e4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e7, sq.e5, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.f1, sq.c4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.b8, sq.c6, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.d1, sq.h5, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g8, sq.f6, PieceType.None);

            // Checkmate move
            const tx = await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h5, sq.f7, PieceType.None);

            // Verify checkmate was detected
            await expect(tx).to.emit(chess, "CheckmateDeclared");

            // Verify match is completed
            const matchInfo = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchInfo.common.status).to.equal(MatchStatus.Completed);
            expect(matchInfo.common.winner).to.equal(whitePlayer.address);
            expect(matchInfo.common.isDraw).to.be.false;

            // Verify tournament is completed (2-player tournament ends after 1 match)
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(TournamentStatus.Completed);
            expect(tournament.winner).to.equal(whitePlayer.address);
        });

        it("Should detect Back Rank Mate", async function () {
            // Use different instance
            const instanceId = 1;

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = matchData.common.player1 === player1.address ? player1 : player2;
            const blackPlayer = matchData.common.player1 === player1.address ? player2 : player1;

            // Set up a simplified back rank mate scenario
            // Note: This is a simplified sequence - in real game would need more moves
            const sq = {
                e2: 12, e4: 28,
                e7: 52, e5: 36,
                g1: 6, f3: 21,
                b8: 57, c6: 42,
                f1: 5, c4: 26,
                g8: 62, f6: 45,
                d2: 11, d3: 19,
                d8: 59, h4: 31
            };

            // Play some moves
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e2, sq.e4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e7, sq.e5, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g1, sq.f3, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.d8, sq.h4, PieceType.None);

            // Verify match can continue (not checkmate yet)
            const matchInfo = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchInfo.common.status).to.equal(MatchStatus.InProgress);
        });

        it("Should detect checkmate and emit MatchCompleted event", async function () {
            const instanceId = 2;

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const matchData = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const whitePlayer = matchData.common.player1 === player1.address ? player1 : player2;
            const blackPlayer = matchData.common.player1 === player1.address ? player2 : player1;

            const sq = {
                e2: 12, e4: 28, e7: 52, e5: 36,
                f1: 5, c4: 26, b8: 57, c6: 42,
                d1: 3, h5: 39, g8: 62, f6: 45, f7: 53
            };

            // Scholar's Mate
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e2, sq.e4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.e7, sq.e5, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.f1, sq.c4, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.b8, sq.c6, PieceType.None);
            await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.d1, sq.h5, PieceType.None);
            await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.g8, sq.f6, PieceType.None);

            const tx = await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, sq.h5, sq.f7, PieceType.None);

            // Verify all events are emitted
            await expect(tx)
                .to.emit(chess, "CheckmateDeclared")
                .and.to.emit(chess, "MatchCompleted")
                .and.to.emit(chess, "TournamentCompleted");
        });
    });

    describe("Timeout Victory Match Completion", function () {
        const tierId = 0;
        const roundNumber = 0;
        const matchNumber = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        it("Should complete match after timeout claim", async function () {
            const instanceId = 3;

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
            const waitingPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Fast forward past timeout
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout win
            const tx = await chess.connect(waitingPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber);

            // Verify events
            await expect(tx)
                .to.emit(chess, "TimeoutVictoryClaimed")
                .and.to.emit(chess, "MatchCompleted")
                .and.to.emit(chess, "TournamentCompleted");

            // Verify match completion
            const matchInfo = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchInfo.common.status).to.equal(MatchStatus.Completed);
            expect(matchInfo.common.winner).to.equal(waitingPlayer.address);
            expect(matchInfo.common.isDraw).to.be.false;

            // Verify tournament completion
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(TournamentStatus.Completed);
            expect(tournament.winner).to.equal(waitingPlayer.address);
        });

        it("Should update player stats after timeout victory", async function () {
            const instanceId = 4;

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const waitingPlayer = match.currentTurn === player1.address ? player2 : player1;

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await chess.connect(waitingPlayer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber);

            // Verify player stats updated
            const stats1 = await chess.playerStats(player1.address);
            const stats2 = await chess.playerStats(player2.address);

            expect(stats1.matchesPlayed).to.equal(1n);
            expect(stats2.matchesPlayed).to.equal(1n);

            // Winner should have 1 win
            if (waitingPlayer.address === player1.address) {
                expect(stats1.matchesWon).to.equal(1n);
                expect(stats2.matchesWon).to.equal(0n);
            } else {
                expect(stats1.matchesWon).to.equal(0n);
                expect(stats2.matchesWon).to.equal(1n);
            }
        });
    });

    describe("4-Player Tournament Progression", function () {
        const tierId = 1;
        const instanceId = 0;
        const entryFee = hre.ethers.parseEther("0.02");

        it("Should advance winners to finals after round 0 completion", async function () {
            // Enroll 4 players
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player3).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player4).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Verify tournament started
            const tournament = await chess.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(TournamentStatus.InProgress);

            // Verify round 0 has 2 matches
            const round0 = await chess.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(2);
            expect(round0.completedMatches).to.equal(0);

            // Get match 0 players
            const match0 = await chess.getMatch(tierId, instanceId, 0, 0);
            const match0White = match0.currentTurn === match0.common.player1 ? match0.common.player1 : match0.common.player2;
            const match0Black = match0.currentTurn === match0.common.player1 ? match0.common.player2 : match0.common.player1;

            const whitePlayer0 = await hre.ethers.getSigner(match0White);
            const blackPlayer0 = await hre.ethers.getSigner(match0Black);

            // Play Scholar's Mate in match 0
            const sq = {
                e2: 12, e4: 28, e7: 52, e5: 36,
                f1: 5, c4: 26, b8: 57, c6: 42,
                d1: 3, h5: 39, g8: 62, f6: 45, f7: 53
            };

            await chess.connect(whitePlayer0).makeMove(tierId, instanceId, 0, 0, sq.e2, sq.e4, PieceType.None);
            await chess.connect(blackPlayer0).makeMove(tierId, instanceId, 0, 0, sq.e7, sq.e5, PieceType.None);
            await chess.connect(whitePlayer0).makeMove(tierId, instanceId, 0, 0, sq.f1, sq.c4, PieceType.None);
            await chess.connect(blackPlayer0).makeMove(tierId, instanceId, 0, 0, sq.b8, sq.c6, PieceType.None);
            await chess.connect(whitePlayer0).makeMove(tierId, instanceId, 0, 0, sq.d1, sq.h5, PieceType.None);
            await chess.connect(blackPlayer0).makeMove(tierId, instanceId, 0, 0, sq.g8, sq.f6, PieceType.None);
            await chess.connect(whitePlayer0).makeMove(tierId, instanceId, 0, 0, sq.h5, sq.f7, PieceType.None);

            // Verify match 0 completed
            const match0After = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(match0After.common.status).to.equal(MatchStatus.Completed);
            expect(match0After.common.winner).to.equal(match0White);

            // Verify round 0 shows 1 completed match
            const round0After = await chess.rounds(tierId, instanceId, 0);
            expect(round0After.completedMatches).to.equal(1);

            // Get match 1 players and complete it via timeout
            const match1 = await chess.getMatch(tierId, instanceId, 0, 1);
            const waitingPlayer1 = match1.currentTurn === match1.common.player1 ?
                await hre.ethers.getSigner(match1.common.player2) :
                await hre.ethers.getSigner(match1.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await chess.connect(waitingPlayer1).claimTimeoutWin(tierId, instanceId, 0, 1);

            // Verify match 1 completed
            const match1After = await chess.getMatch(tierId, instanceId, 0, 1);
            expect(match1After.common.status).to.equal(MatchStatus.Completed);

            // Verify round 0 is complete
            const round0Final = await chess.rounds(tierId, instanceId, 0);
            expect(round0Final.completedMatches).to.equal(2);

            // Verify round 1 (finals) was initialized
            const round1 = await chess.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
            expect(round1.totalMatches).to.equal(1);

            // Verify tournament is still in progress (finals not complete)
            const tournamentAfterR0 = await chess.tournaments(tierId, instanceId);
            expect(tournamentAfterR0.status).to.equal(TournamentStatus.InProgress);
            expect(tournamentAfterR0.currentRound).to.equal(1);
        });

        it("Should complete tournament after finals match", async function () {
            const instanceId = 1; // Different instance

            // Enroll 4 players
            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player3).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player4).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Complete semifinal matches via timeout
            const match0 = await chess.getMatch(tierId, instanceId, 0, 0);
            const waitingPlayer0 = match0.currentTurn === match0.common.player1 ?
                await hre.ethers.getSigner(match0.common.player2) :
                await hre.ethers.getSigner(match0.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);
            await chess.connect(waitingPlayer0).claimTimeoutWin(tierId, instanceId, 0, 0);

            const match1 = await chess.getMatch(tierId, instanceId, 0, 1);
            const waitingPlayer1 = match1.currentTurn === match1.common.player1 ?
                await hre.ethers.getSigner(match1.common.player2) :
                await hre.ethers.getSigner(match1.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);
            await chess.connect(waitingPlayer1).claimTimeoutWin(tierId, instanceId, 0, 1);

            // Now complete finals match
            const finalsMatch = await chess.getMatch(tierId, instanceId, 1, 0);
            const finalsWaiting = finalsMatch.currentTurn === finalsMatch.common.player1 ?
                await hre.ethers.getSigner(finalsMatch.common.player2) :
                await hre.ethers.getSigner(finalsMatch.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            const tx = await chess.connect(finalsWaiting).claimTimeoutWin(tierId, instanceId, 1, 0);

            // Verify tournament completed
            await expect(tx).to.emit(chess, "TournamentCompleted");

            const tournamentFinal = await chess.tournaments(tierId, instanceId);
            expect(tournamentFinal.status).to.equal(TournamentStatus.Completed);
            expect(tournamentFinal.winner).to.equal(finalsWaiting.address);
        });
    });

    describe("Round Completion Logic", function () {
        const tierId = 0;
        const entryFee = hre.ethers.parseEther("0.01");

        it("Should mark round as complete when all matches finish", async function () {
            const instanceId = 5;

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Verify round starts with 0 completed
            const roundBefore = await chess.rounds(tierId, instanceId, 0);
            expect(roundBefore.completedMatches).to.equal(0);
            expect(roundBefore.totalMatches).to.equal(1);

            // Complete match via timeout
            const match = await chess.getMatch(tierId, instanceId, 0, 0);
            const waitingPlayer = match.currentTurn === match.common.player1 ?
                await hre.ethers.getSigner(match.common.player2) :
                await hre.ethers.getSigner(match.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);
            await chess.connect(waitingPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Verify round is complete
            const roundAfter = await chess.rounds(tierId, instanceId, 0);
            expect(roundAfter.completedMatches).to.equal(1);
        });

        it("Should increment completed matches count for each finished match", async function () {
            const instanceId = 6;
            const tierId = 1; // 4-player tournament
            const entryFee = hre.ethers.parseEther("0.02");

            await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player3).enrollInTournament(tierId, instanceId, { value: entryFee });
            await chess.connect(player4).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Complete first match
            const match0 = await chess.getMatch(tierId, instanceId, 0, 0);
            const waitingPlayer0 = match0.currentTurn === match0.common.player1 ?
                await hre.ethers.getSigner(match0.common.player2) :
                await hre.ethers.getSigner(match0.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);
            await chess.connect(waitingPlayer0).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check count
            const roundAfterFirst = await chess.rounds(tierId, instanceId, 0);
            expect(roundAfterFirst.completedMatches).to.equal(1);
            expect(roundAfterFirst.totalMatches).to.equal(2);

            // Complete second match
            const match1 = await chess.getMatch(tierId, instanceId, 0, 1);
            const waitingPlayer1 = match1.currentTurn === match1.common.player1 ?
                await hre.ethers.getSigner(match1.common.player2) :
                await hre.ethers.getSigner(match1.common.player1);

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);
            await chess.connect(waitingPlayer1).claimTimeoutWin(tierId, instanceId, 0, 1);

            // Check count again
            const roundAfterBoth = await chess.rounds(tierId, instanceId, 0);
            expect(roundAfterBoth.completedMatches).to.equal(2);
        });
    });
});
