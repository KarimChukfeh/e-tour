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

        it("Should have 4 tiers configured", async function () {
            expect(await game.tierCount()).to.equal(4);
        });

        it("Should have correct tier configurations", async function () {
            // Tier 0: 2-player
            const tier0 = await game.tierConfigs(0);
            expect(tier0.playerCount).to.equal(2);
            expect(tier0.instanceCount).to.equal(100);
            expect(tier0.entryFee).to.equal(TIER_0_FEE);

            // Tier 1: 4-player
            const tier1 = await game.tierConfigs(1);
            expect(tier1.playerCount).to.equal(4);
            expect(tier1.instanceCount).to.equal(50);
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
            expect(match.common.status).to.equal(1); // InProgress
            expect(match.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.player2).to.not.equal(hre.ethers.ZeroAddress);
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
            expect(match.currentTurn).to.be.oneOf([match.common.player1, match.common.player2]);
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

            const winnerEarnings = await game.connect(firstPlayer).getPlayerStats();
            expect(winnerEarnings).to.be.gt(0); // Winner should have positive earnings
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
            // Move time forward past timeout (5 minutes + 1 sec)
            await hre.ethers.provider.send("evm_increaseTime", [301]); // 5 min + 1 sec
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Opponent has not run out of time");
        });
    });

    describe("View Functions", function () {
        it("Should return match data correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.status).to.equal(1);
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

    describe("Round-Based Prize Distribution (8-Player Tournament)", function () {
        // Tier 2: 8-player tournament
        // Prize distribution: 1st=80%, 2nd=20%, 3rd-8th=0%
        // Winner-takes-most approach: Only top 2 places receive prizes

        const TIER_2_ID = 2;
        const TIER_2_FEE = hre.ethers.parseEther("0.008");
        let players;

        beforeEach(async function () {
            // Get 8 unique signers for the tournament
            const signers = await hre.ethers.getSigners();
            players = signers.slice(0, 8);
        });

        // Helper function to play a match to completion (first player wins with horizontal connect 4)
        async function playMatchToWin(tierId, instanceId, roundNumber, matchNumber) {
            const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            // Normalize addresses for comparison (player1 and player2 are in common property)
            const currentTurn = match.currentTurn?.toLowerCase();
            const player1 = match.common.player1?.toLowerCase();
            const player2 = match.common.player2?.toLowerCase();

            const firstPlayer = players.find(p => p.address.toLowerCase() === currentTurn);
            const secondPlayer = players.find(p =>
                (p.address.toLowerCase() === player1 || p.address.toLowerCase() === player2) &&
                p.address.toLowerCase() !== currentTurn
            );

            // Play horizontal win: first player drops in columns 0,1,2,3 at bottom row
            // Second player drops on top of first player's pieces
            await game.connect(firstPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 3);

            return { winner: firstPlayer, loser: secondPlayer };
        }

        it("Should have correct tier 2 configuration (8-player)", async function () {
            const tier2 = await game.tierConfigs(TIER_2_ID);
            expect(tier2.playerCount).to.equal(8);
            expect(tier2.instanceCount).to.equal(30);
            expect(tier2.entryFee).to.equal(TIER_2_FEE);
        });

        it("Should start 8-player tournament with correct bracket structure", async function () {
            const instanceId = 0;

            // Enroll all 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_2_ID, instanceId, { value: TIER_2_FEE });
            }

            // Tournament should be in progress
            const tournament = await game.tournaments(TIER_2_ID, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Round 0 should have 4 matches (8 players / 2)
            const round0 = await game.rounds(TIER_2_ID, instanceId, 0);
            expect(round0.totalMatches).to.equal(4);
        });

        it("Should award 0% to semi-final losers (3rd and 4th place)", async function () {
            const instanceId = 1;

            // Enroll all 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_2_ID, instanceId, { value: TIER_2_FEE });
            }

            // Get initial prize pool and balances
            const tournament = await game.tournaments(TIER_2_ID, instanceId);
            const prizePool = tournament.prizePool;

            // Track semi-final losers and their balances before tournament
            const semifinalLoserBalancesBefore = {};

            // ===== ROUND 0: 4 matches =====
            for (let matchNum = 0; matchNum < 4; matchNum++) {
                await playMatchToWin(TIER_2_ID, instanceId, 0, matchNum);
            }

            // Verify round 0 is complete
            const round0 = await game.rounds(TIER_2_ID, instanceId, 0);
            expect(round0.completedMatches).to.equal(4);

            // ===== ROUND 1 (Semi-finals): 2 matches =====
            // Get balances before semi-finals complete
            const sf0Match = await game.getMatch(TIER_2_ID, instanceId, 1, 0);
            const sf1Match = await game.getMatch(TIER_2_ID, instanceId, 1, 1);

            semifinalLoserBalancesBefore[sf0Match.common.player1] = await hre.ethers.provider.getBalance(sf0Match.common.player1);
            semifinalLoserBalancesBefore[sf0Match.common.player2] = await hre.ethers.provider.getBalance(sf0Match.common.player2);
            semifinalLoserBalancesBefore[sf1Match.common.player1] = await hre.ethers.provider.getBalance(sf1Match.common.player1);
            semifinalLoserBalancesBefore[sf1Match.common.player2] = await hre.ethers.provider.getBalance(sf1Match.common.player2);

            // Track semi-final losers
            const sf0Result = await playMatchToWin(TIER_2_ID, instanceId, 1, 0);
            const sf1Result = await playMatchToWin(TIER_2_ID, instanceId, 1, 1);

            // Verify round 1 is complete
            const round1 = await game.rounds(TIER_2_ID, instanceId, 1);
            expect(round1.completedMatches).to.equal(2);

            // ===== ROUND 2 (Finals): 1 match =====
            // Play the final
            await playMatchToWin(TIER_2_ID, instanceId, 2, 0);

            // Tournament should be complete and reset
            const finalTournament = await game.tournaments(TIER_2_ID, instanceId);
            expect(finalTournament.status).to.equal(0); // Enrolling (reset)

            // ===== VERIFY NO PRIZES FOR SEMI-FINAL LOSERS =====
            // Semi-final losers should receive 0% prize
            const semifinalLosers = [sf0Result.loser, sf1Result.loser];

            for (const loser of semifinalLosers) {
                const balanceAfter = await hre.ethers.provider.getBalance(loser.address);
                const balanceBefore = semifinalLoserBalancesBefore[loser.address];

                // Balance should be lower (lost entry fee + gas), no prize payout
                expect(balanceAfter).to.be.lte(balanceBefore);
            }
        });

        it("Should award 0% to round 0 losers (5th-8th place)", async function () {
            const instanceId = 2;

            // Enroll all 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_2_ID, instanceId, { value: TIER_2_FEE });
            }

            // Track round 0 losers and their balances
            const round0Losers = [];
            const round0LoserBalancesBefore = {};

            // Get all round 0 match participants before playing
            for (let matchNum = 0; matchNum < 4; matchNum++) {
                const match = await game.getMatch(TIER_2_ID, instanceId, 0, matchNum);
                const p1 = players.find(p => p.address.toLowerCase() === match.common.player1?.toLowerCase());
                const p2 = players.find(p => p.address.toLowerCase() === match.common.player2?.toLowerCase());
                round0LoserBalancesBefore[p1.address] = await hre.ethers.provider.getBalance(p1.address);
                round0LoserBalancesBefore[p2.address] = await hre.ethers.provider.getBalance(p2.address);
            }

            // Play round 0 and track losers
            for (let matchNum = 0; matchNum < 4; matchNum++) {
                const result = await playMatchToWin(TIER_2_ID, instanceId, 0, matchNum);
                round0Losers.push(result.loser);
            }

            // Play remaining rounds to complete tournament
            await playMatchToWin(TIER_2_ID, instanceId, 1, 0);
            await playMatchToWin(TIER_2_ID, instanceId, 1, 1);
            await playMatchToWin(TIER_2_ID, instanceId, 2, 0);

            // Verify tournament completed
            const tournament = await game.tournaments(TIER_2_ID, instanceId);
            expect(tournament.status).to.equal(0);

            // Verify round 0 losers received 0% prize (only lost gas costs)
            for (const loser of round0Losers) {
                const balanceAfter = await hre.ethers.provider.getBalance(loser.address);
                const balanceBefore = round0LoserBalancesBefore[loser.address];

                // Balance should be lower (lost entry fee + gas) or at most equal (if no prize)
                // They should NOT have received any prize payout
                expect(balanceAfter).to.be.lte(balanceBefore);
            }
        });
    });

    describe("Round-Based Prize Distribution (16-Player Tournament)", function () {
        // Tier 3: 16-player tournament
        // Prize distribution: 1st=75%, 2nd=25%, 3rd-16th=0%
        // Winner-takes-most approach: Only top 2 places receive prizes

        const TIER_3_ID = 3;
        const TIER_3_FEE = hre.ethers.parseEther("0.01");

        it("Should have correct tier 3 configuration (16-player)", async function () {
            const tier3 = await game.tierConfigs(TIER_3_ID);
            expect(tier3.playerCount).to.equal(16);
            expect(tier3.instanceCount).to.equal(20);
            expect(tier3.entryFee).to.equal(TIER_3_FEE);
        });

        it("Should have correct prize distribution percentages for 16-player tier", async function () {
            // Verify the prize distribution array values
            // Winner-takes-most: Only top 2 places get prizes
            const prizeDistribution = await game.getTierPrizeDistribution(TIER_3_ID);

            // 1st place: 75%
            expect(prizeDistribution[0]).to.equal(75);
            // 2nd place: 25%
            expect(prizeDistribution[1]).to.equal(25);
            // 3rd-16th: 0%
            for (let i = 2; i < 16; i++) {
                expect(prizeDistribution[i]).to.equal(0);
            }
        });

        it("Should start 16-player tournament with correct bracket structure", async function () {
            const signers = await hre.ethers.getSigners();
            // Need at least 16 signers
            if (signers.length < 16) {
                this.skip();
            }

            const instanceId = 0;
            const players16 = signers.slice(0, 16);

            // Enroll all 16 players
            for (let i = 0; i < 16; i++) {
                await game.connect(players16[i]).enrollInTournament(TIER_3_ID, instanceId, { value: TIER_3_FEE });
            }

            // Tournament should be in progress
            const tournament = await game.tournaments(TIER_3_ID, instanceId);
            expect(tournament.status).to.equal(1);

            // Round 0 should have 8 matches (16 players / 2)
            const round0 = await game.rounds(TIER_3_ID, instanceId, 0);
            expect(round0.totalMatches).to.equal(8);

            // Round 1 (quarter-finals) should have 4 matches
            const round1 = await game.rounds(TIER_3_ID, instanceId, 1);
            expect(round1.totalMatches).to.equal(4);

            // Round 2 (semi-finals) should have 2 matches
            const round2 = await game.rounds(TIER_3_ID, instanceId, 2);
            expect(round2.totalMatches).to.equal(2);

            // Round 3 (finals) should have 1 match
            const round3 = await game.rounds(TIER_3_ID, instanceId, 3);
            expect(round3.totalMatches).to.equal(1);
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
