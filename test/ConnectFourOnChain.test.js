// test/ConnectFourOnChain.test.js
// Compatibility tests for ConnectFourOnChain with ETour protocol

import { expect } from "chai";
import hre from "hardhat";

describe("ConnectFourOnChain ETour Compatibility Tests", function () {
    let game;
    let owner, player1, player2, player3, player4;

    const TIER_0_FEE = hre.ethers.parseEther("0.002");
    const TIER_1_FEE = hre.ethers.parseEther("0.004");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy();
        await game.waitForDeployment();
    });

    describe("Deployment and Tier Configuration", function () {
        it("Should deploy successfully as ETour implementation", async function () {
            expect(await game.getAddress()).to.not.equal(hre.ethers.ZeroAddress);
        });

        it("Should have correct owner", async function () {
            expect(await game.owner()).to.equal(owner.address);
        });

        it("Should have 5 tiers configured", async function () {
            expect(await game.tierCount()).to.equal(5);
        });

        it("Should have correct tier configurations", async function () {
            // Tier 0: 2-player
            const tier0 = await game.tierConfigs(0);
            expect(tier0.playerCount).to.equal(2);
            expect(tier0.instanceCount).to.equal(12);
            expect(tier0.entryFee).to.equal(TIER_0_FEE);

            // Tier 1: 4-player
            const tier1 = await game.tierConfigs(1);
            expect(tier1.playerCount).to.equal(4);
            expect(tier1.instanceCount).to.equal(10);
            expect(tier1.entryFee).to.equal(TIER_1_FEE);
        });

        it("Should have correct game constants", async function () {
            expect(await game.ROWS()).to.equal(6);
            expect(await game.COLS()).to.equal(7);
            expect(await game.TOTAL_CELLS()).to.equal(42);
            expect(await game.CONNECT_COUNT()).to.equal(4);
        });
    });

    describe("Tournament Enrollment (ETour Integration)", function () {
        it("Should allow player enrollment", async function () {
            const tierId = 0;
            const instanceId = 0;

            await expect(game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "PlayerEnrolled");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.enrolledCount).to.equal(1);
        });

        it("Should auto-start 2-player tournament when full", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            await expect(game.connect(player2).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "TournamentStarted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });

        it("Should correctly split entry fees (90% prize pool)", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = (TIER_0_FEE * 9000n) / 10000n;
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });

        it("Should reject incorrect entry fee", async function () {
            const tierId = 0;
            const instanceId = 0;

            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, {
                    value: hre.ethers.parseEther("0.001")
                })
            ).to.be.revertedWith("Incorrect entry fee");
        });

        it("Should reject duplicate enrollment", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("Already enrolled");
        });
    });

    describe("Match Creation (ETour Integration)", function () {
        beforeEach(async function () {
            const tierId = 0;
            const instanceId = 0;
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
        });

        it("Should create match when tournament starts", async function () {
            const tierId = 0;
            const instanceId = 0;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.status).to.equal(1); // InProgress
            expect(match.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.player2).to.not.equal(hre.ethers.ZeroAddress);
        });

        it("Should initialize empty board", async function () {
            const tierId = 0;
            const instanceId = 0;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            // All cells should be empty (Cell.Empty = 0)
            for (let i = 0; i < 42; i++) {
                expect(match.board[i]).to.equal(0);
            }
        });

        it("Should set random first player", async function () {
            const tierId = 0;
            const instanceId = 0;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.currentTurn).to.be.oneOf([match.player1, match.player2]);
            expect(match.firstPlayer).to.equal(match.currentTurn);
        });
    });

    describe("Game Play (Connect Four Logic)", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should allow first player to make move", async function () {
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3))
                .to.emit(game, "MoveMade");
        });

        it("Should place piece at bottom of column (gravity)", async function () {
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            // Row 5 (bottom), column 3 = index 5*7+3 = 38
            const bottomCellIndex = 5 * 7 + 3;
            expect(match.board[bottomCellIndex]).to.not.equal(0); // Should be Red or Yellow
        });

        it("Should stack pieces correctly", async function () {
            // Both players drop in column 3
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            // Row 5, column 3 = index 38
            // Row 4, column 3 = index 31
            expect(match.board[38]).to.not.equal(0);
            expect(match.board[31]).to.not.equal(0);
        });

        it("Should switch turns after each move", async function () {
            let match = await game.getMatch(tierId, instanceId, 0, 0);
            const initialTurn = match.currentTurn;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.currentTurn).to.not.equal(initialTurn);
        });

        it("Should reject move when not your turn", async function () {
            await expect(
                game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0)
            ).to.be.revertedWith("Not your turn");
        });

        it("Should reject move to full column", async function () {
            // Fill column 0 (6 pieces)
            for (let i = 0; i < 3; i++) {
                await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
                await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            }

            // Column 0 is now full, try to add another piece
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0)
            ).to.be.revertedWith("Column is full");
        });

        it("Should reject invalid column", async function () {
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7)
            ).to.be.revertedWith("Invalid column");
        });
    });

    describe("Win Detection", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should detect horizontal win", async function () {
            // First player: columns 0, 1, 2, 3
            // Second player: columns 0, 1, 2 (on top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Winning move - check event with winner address (isDraw = false)
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            const receipt = await tx.wait();

            // Find MatchCompleted event
            const matchCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MatchCompleted"
            );
            expect(matchCompletedEvent).to.not.be.undefined;

            // Check winner and isDraw from event args
            const [matchId, winner, isDraw] = matchCompletedEvent.args;
            expect(winner).to.equal(firstPlayer.address);
            expect(isDraw).to.be.false;
        });

        it("Should detect vertical win", async function () {
            // First player: column 0 (4 pieces stacked)
            // Second player: column 1
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);

            // Winning move
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            const receipt = await tx.wait();

            // Find MatchCompleted event
            const matchCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MatchCompleted"
            );
            expect(matchCompletedEvent).to.not.be.undefined;

            const [matchId, winner, isDraw] = matchCompletedEvent.args;
            expect(winner).to.equal(firstPlayer.address);
        });

    });

    describe("Tournament Completion (ETour Integration)", function () {
        it("Should complete tournament and distribute prizes", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to a quick win (horizontal)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Winning move completes tournament
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3))
                .to.emit(game, "TournamentCompleted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling
        });

        it("Should update player stats after match", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to win
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);

            const winnerStats = await game.getPlayerStats(firstPlayer.address);
            expect(winnerStats.matchesWon).to.equal(1);
            expect(winnerStats.matchesPlayed).to.equal(1);
            expect(winnerStats.tournamentsWon).to.equal(1);
        });
    });

    describe("4-Player Tournament (Multi-Round)", function () {
        it("Should handle 4-player tournament bracket", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Check tournament started
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round 0 has 2 matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(2);
        });
    });

    describe("Timeout Functions (ETour Integration)", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should allow timeout claim after timeout period", async function () {
            // Move time forward past timeout
            await hre.ethers.provider.send("evm_increaseTime", [121]); // 2 min + 1 sec
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Tier 1 timeout not reached");
        });
    });

    describe("View Functions", function () {
        it("Should return match data correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.status).to.equal(1);
            expect(match.moveCount).to.equal(0);
        });

        it("Should check column availability", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // All columns should be available initially
            for (let col = 0; col < 7; col++) {
                expect(await game.isColumnAvailable(tierId, instanceId, 0, 0, col)).to.be.true;
            }
        });

        it("Should return RW3 compliance declaration", async function () {
            const declaration = await game.declareRW3();
            expect(declaration).to.include("ConnectFourOnChain");
            expect(declaration).to.include("RW3 COMPLIANCE");
        });
    });

    describe("ABI Compatibility with ETour", function () {
        it("Should have all ETour required functions", async function () {
            // Tournament management
            expect(game.enrollInTournament).to.exist;
            expect(game.forceStartTournament).to.exist;
            expect(game.claimAbandonedEnrollmentPool).to.exist;

            // View functions
            expect(game.tournaments).to.exist;
            expect(game.rounds).to.exist;
            expect(game.tierConfigs).to.exist;
            expect(game.playerStats).to.exist;
            expect(game.getEnrolledPlayers).to.exist;
            expect(game.getTournamentInfo).to.exist;
            expect(game.getRoundInfo).to.exist;
            expect(game.getPlayerStats).to.exist;

            // Timeout functions
            expect(game.claimTimeoutWin).to.exist;
        });

        it("Should have Connect Four specific functions", async function () {
            expect(game.makeMove).to.exist;
            expect(game.getMatch).to.exist;
            expect(game.isColumnAvailable).to.exist;
            expect(game.getCachedMatch).to.exist;
        });
    });
});
