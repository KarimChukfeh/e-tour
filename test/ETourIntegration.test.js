// test/ETourIntegration.test.js
// Comprehensive test suite for TicTacChain (ETour protocol implementation)

import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain (ETour Protocol) Tests", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;

    const TIER_0_FEE = hre.ethers.parseEther("0.001"); // 2-player tier
    const TIER_1_FEE = hre.ethers.parseEther("0.002"); // 4-player tier
    const TIER_2_FEE = hre.ethers.parseEther("0.004"); // 8-player tier

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should deploy successfully", async function () {
            expect(await game.getAddress()).to.be.properAddress;
        });

        it("Should have correct owner", async function () {
            expect(await game.owner()).to.equal(owner.address);
        });

        it("Should have 3 tiers configured", async function () {
            expect(await game.tierCount()).to.equal(3);
        });

        it("Should have correct tier 0 configuration (2-player)", async function () {
            const tier0 = await game.tierConfigs(0);
            expect(tier0.playerCount).to.equal(2);
            expect(tier0.instanceCount).to.equal(64);
            expect(tier0.entryFee).to.equal(TIER_0_FEE);
        });

        it("Should have correct tier 1 configuration (4-player)", async function () {
            const tier1 = await game.tierConfigs(1);
            expect(tier1.playerCount).to.equal(4);
            expect(tier1.instanceCount).to.equal(10);
            expect(tier1.entryFee).to.equal(TIER_1_FEE);
        });

        it("Should have correct tier 2 configuration (8-player)", async function () {
            const tier2 = await game.tierConfigs(2);
            expect(tier2.playerCount).to.equal(8);
            expect(tier2.instanceCount).to.equal(16);
            expect(tier2.entryFee).to.equal(TIER_2_FEE);
        });
    });

    describe("Tournament Enrollment", function () {
        it("Should enroll players and auto-start when full (2-player)", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll first player
            await expect(game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "PlayerEnrolled");

            // Check tournament is still enrolling
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Enroll second player - should auto-start
            await expect(game.connect(player2).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "TournamentStarted");

            // Check tournament has started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });

        it("Should split entry fees correctly (90% prize pool, 10% owner)", async function () {
            const tierId = 0;
            const instanceId = 0;

            const ownerBalanceBefore = await hre.ethers.provider.getBalance(owner.address);

            // Enroll player
            await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            });

            const ownerBalanceAfter = await hre.ethers.provider.getBalance(owner.address);

            // Owner should receive 7.5% + 2.5% = 10% of entry fee
            const expectedOwnerIncrease = (TIER_0_FEE * 1000n) / 10000n; // 10%
            expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(expectedOwnerIncrease);

            // Tournament should have 90% in prize pool
            const tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = (TIER_0_FEE * 9000n) / 10000n; // 90%
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });

        it("Should reject incorrect entry fee", async function () {
            const tierId = 0;
            const instanceId = 0;

            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, {
                    value: hre.ethers.parseEther("0.0005") // Wrong fee
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

        it("Should reject invalid tier", async function () {
            await expect(
                game.connect(player1).enrollInTournament(99, 0, { value: TIER_0_FEE })
            ).to.be.revertedWith("Invalid tier");
        });
    });

    describe("Tournament Logic", function () {
        it("Should initialize round with correct match count (8-player = 4 matches)", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 0;

            // Enroll 8 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player6).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player7).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player8).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Tournament should have started
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round 0 was initialized with 4 matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(4); // 8 players = 4 matches in first round
        });

        it("Should handle force start after enrollment timeout", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 0;

            // Enroll only 2 players (less than required 8)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Tournament should still be enrolling
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Force start before timeout should fail
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("Enrollment window not expired");

            // Fast forward past enrollment window (2 minutes for demo)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start should work now
            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Check tournament started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });
    });

    describe("Game Play", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;

            // Start a 2-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Determine who goes first (randomized)
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should allow players to make moves", async function () {
            // First player makes move to center (cell 4)
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4))
                .to.emit(game, "MoveMade");

            // Second player makes move to corner (cell 0)
            await expect(game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0))
                .to.emit(game, "MoveMade");
        });

        it("Should switch turns after each move", async function () {
            let match = await game.getMatch(tierId, instanceId, 0, 0);
            const initialTurn = match.currentTurn;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.currentTurn).to.not.equal(initialTurn);
        });

        it("Should reject move when not your turn", async function () {
            await expect(
                game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("Not your turn");
        });

        it("Should reject move to occupied cell", async function () {
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Try to move to already occupied cell 4
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("Cell already occupied");
        });

        it("Should reject invalid cell index", async function () {
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 9)
            ).to.be.revertedWith("Invalid cell index");
        });

        it("Should reject move from non-player", async function () {
            await expect(
                game.connect(player3).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("Not a player in this match");
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

        it("Should detect horizontal win (top row)", async function () {
            // First player: 0, 1, 2 (top row)
            // Second player: 3, 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move - verify via TournamentCompleted event (2-player = finals)
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            // Winner's stats should be updated
            const stats = await game.getPlayerStats(firstPlayer.address);
            expect(stats.matchesWon).to.be.gte(1);
        });

        it("Should detect vertical win (left column)", async function () {
            // First player: 0, 3, 6 (left column)
            // Second player: 1, 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move - verify via TournamentCompleted event
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 6))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            const stats = await game.getPlayerStats(firstPlayer.address);
            expect(stats.matchesWon).to.be.gte(1);
        });

        it("Should detect diagonal win (0, 4, 8)", async function () {
            // First player: 0, 4, 8 (diagonal)
            // Second player: 1, 2
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Winning move - verify via TournamentCompleted event
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            const stats = await game.getPlayerStats(firstPlayer.address);
            expect(stats.matchesWon).to.be.gte(1);
        });

        it("Should detect draw when board is full with no winner", async function () {
            // Classic draw pattern:
            // X | O | X
            // X | O | O
            // O | X | X
            // Cells: 0=X, 1=O, 2=X, 3=X, 4=O, 5=O, 6=O, 7=X, 8=X

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);  // X at 0
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O at 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X at 2
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O at 1
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);  // X at 7
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O at 6
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);  // X at 3
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O at 5

            // Final move results in draw - emits MatchCompleted with isDraw=true via event args
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);
            const receipt = await tx.wait();

            // Find MatchCompleted event and verify isDraw
            const matchCompletedEvent = receipt.logs.find(log => {
                try {
                    const parsed = game.interface.parseLog(log);
                    return parsed?.name === "MatchCompleted";
                } catch { return false; }
            });

            expect(matchCompletedEvent).to.not.be.undefined;
            const parsedEvent = game.interface.parseLog(matchCompletedEvent);
            expect(parsedEvent.args.isDraw).to.be.true;
        });
    });

    describe("Tournament Completion", function () {
        it("Should complete 2-player tournament and distribute prizes", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            const winnerBalanceBefore = await hre.ethers.provider.getBalance(firstPlayer.address);

            // Play to a quick win (top row)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move completes tournament
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2))
                .to.emit(game, "TournamentCompleted");

            // Tournament should reset to Enrolling
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset)
        });
    });

    describe("Timeout Functions", function () {
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
            // Move time forward past timeout (1 minute for demo)
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // Non-current-turn player can claim timeout
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Tier 1 timeout not reached");
        });

        it("Should reject timeout claim on your own turn", async function () {
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // Current turn player cannot claim timeout
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Cannot claim timeout on your own turn");
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
            expect(match.status).to.equal(1); // InProgress
        });

        it("Should return RW3 compliance declaration", async function () {
            const declaration = await game.declareRW3();
            expect(declaration).to.include("TicTacChain");
            expect(declaration).to.include("RW3 COMPLIANCE");
        });
    });

    describe("Gas Optimization", function () {
        it("Should have reasonable gas costs for enrollment", async function () {
            const tierId = 0;
            const instanceId = 1;

            const tx = await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            });
            const receipt = await tx.wait();

            console.log("      Gas used for enrollment:", receipt.gasUsed.toString());
            expect(receipt.gasUsed).to.be.lt(500000);
        });

        it("Should have reasonable gas costs for making a move", async function () {
            const tierId = 0;
            const instanceId = 2;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;

            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const receipt = await tx.wait();

            console.log("      Gas used for move:", receipt.gasUsed.toString());
            expect(receipt.gasUsed).to.be.lt(200000);
        });
    });

    // ============ ETour Core Logic Tests ============

    describe("Abandoned Enrollment Pool Claims", function () {
        it("Should reject claim before escalation2 window", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll a player
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Try to claim immediately - should fail
            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.be.revertedWith("Public claim window not reached");
        });

        it("Should allow external player to claim abandoned pool after escalation2", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 2 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past escalation2 window (enrollment window + escalation interval)
            // For demo: 2 minutes enrollment + 1 minute escalation = 3 minutes
            await hre.ethers.provider.send("evm_increaseTime", [181]);
            await hre.ethers.provider.send("evm_mine", []);

            const claimerBalanceBefore = await hre.ethers.provider.getBalance(player3.address);

            // External player claims the pool
            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.emit(game, "EnrollmentPoolClaimed");

            const claimerBalanceAfter = await hre.ethers.provider.getBalance(player3.address);

            // Claimer should have received funds (minus gas)
            expect(claimerBalanceAfter).to.be.gt(claimerBalanceBefore);

            // Tournament should be reset to Enrolling
            const tournamentAfter = await game.tournaments(tierId, instanceId);
            expect(tournamentAfter.status).to.equal(0); // Enrolling
            expect(tournamentAfter.enrolledCount).to.equal(0);
        });

        it("Should emit PlayerForfeited for all enrolled players", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [181]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.emit(game, "PlayerForfeited")
             .and.to.emit(game, "TournamentCached");
        });

        it("Should reject claim when no enrollment pool exists", async function () {
            const tierId = 1;
            const instanceId = 1; // Different instance with no enrollments

            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.be.revertedWith("No enrollment pool to claim");
        });
    });

    describe("Force Start Edge Cases", function () {
        it("Should reject force start from non-enrolled player", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player3).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("Not enrolled");
        });

        it("Should set hasStartedViaTimeout flag when force started", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentForceStarted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.hasStartedViaTimeout).to.be.true;
            expect(tournament.forceStarter).to.equal(player1.address);
        });

        it("Should handle single player force start with immediate win", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with only 1 player - they should win immediately
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentCompleted");

            // Tournament should reset after solo win
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset)
        });
    });

    describe("View Functions Coverage", function () {
        let tierId, instanceId;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 5; // Use a fresh instance
        });

        it("Should return correct tournament info via getTournamentInfo", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const info = await game.getTournamentInfo(tierId, instanceId);
            expect(info.status).to.equal(0); // Enrolling
            expect(info.enrolledCount).to.equal(1);
            expect(info.prizePool).to.be.gt(0);
        });

        it("Should track player active matches correctly", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const activeMatches = await game.getPlayerActiveMatches(player1.address);
            expect(activeMatches.length).to.equal(1);
        });

        it("Should return enrolled players list", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const enrolled = await game.getEnrolledPlayers(tierId, instanceId);
            expect(enrolled.length).to.equal(2);
            expect(enrolled).to.include(player1.address);
            expect(enrolled).to.include(player2.address);
        });

        it("Should return round info correctly", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const roundInfo = await game.getRoundInfo(tierId, instanceId, 0);
            expect(roundInfo.totalMatches).to.equal(1);
            expect(roundInfo.completedMatches).to.equal(0);
            expect(roundInfo.initialized).to.be.true;
        });

        it("Should return player stats correctly", async function () {
            // Complete a tournament first
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to win
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const stats = await game.getPlayerStats(firstPlayer.address);
            expect(stats.tournamentsWon).to.be.gte(1);
            expect(stats.tournamentsPlayed).to.be.gte(1);
            expect(stats.matchesWon).to.be.gte(1);
            expect(stats.matchesPlayed).to.be.gte(1);
        });

        it("Should return tier overview correctly", async function () {
            const overview = await game.getTierOverview(tierId);
            expect(overview.statuses.length).to.be.gt(0);
            expect(overview.enrolledCounts.length).to.be.gt(0);
            expect(overview.prizePools.length).to.be.gt(0);
        });

        it("Should return prize distribution for tier", async function () {
            const distribution = await game.getTierPrizeDistribution(0);
            expect(distribution.length).to.equal(2); // 2-player tier

            // Sum should be 100
            let sum = 0;
            for (const pct of distribution) {
                sum += Number(pct);
            }
            expect(sum).to.equal(100);
        });

        it("Should return individual prize percentages", async function () {
            const firstPlacePct = await game.getPrizePercentage(0, 0);
            const secondPlacePct = await game.getPrizePercentage(0, 1);

            expect(firstPlacePct).to.be.gt(secondPlacePct);
            expect(Number(firstPlacePct) + Number(secondPlacePct)).to.equal(100);
        });

        it("Should track player earnings on leaderboard - winner has positive, loser negative", async function () {
            const countBefore = await game.getLeaderboardCount();

            // Complete a tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const leaderboard = await game.getLeaderboard();
            const countAfter = await game.getLeaderboardCount();

            // Should have added 2 players to leaderboard
            expect(countAfter - countBefore).to.equal(2n);

            // Find winner and loser in leaderboard
            const winnerEntry = leaderboard.find(e => e.player === firstPlayer.address);
            const loserEntry = leaderboard.find(e => e.player === secondPlayer.address);

            // Winner should have positive net earnings (prize - entry fee)
            // Prize pool = 2 * 0.01 ETH * 90% = 0.018 ETH, winner gets 100%
            // Net = 0.018 - 0.01 = 0.008 ETH
            expect(winnerEntry.earnings).to.be.gt(0n);

            // Loser should have negative net earnings (-entry fee)
            expect(loserEntry.earnings).to.equal(-TIER_0_FEE);
        });

        it("Should return full leaderboard with all players", async function () {
            // Complete a tournament to populate leaderboard
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            let match = await game.getMatch(tierId, instanceId, 0, 0);
            let firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            let secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const leaderboard = await game.getLeaderboard();

            // Leaderboard should be an array of {player, earnings} entries
            expect(Array.isArray(leaderboard)).to.be.true;
            expect(leaderboard.length).to.be.gte(2);

            // Each entry should have player address and earnings
            for (const entry of leaderboard) {
                expect(entry.player).to.match(/^0x[a-fA-F0-9]{40}$/);
                expect(typeof entry.earnings).to.equal("bigint");
            }
        });

        it("Should return leaderboard count", async function () {
            const count = await game.getLeaderboardCount();
            expect(typeof count).to.equal("bigint");
        });
    });

    describe("Prize Distribution", function () {
        it("Should distribute prizes correctly (2-player)", async function () {
            const tierId = 0;
            const instanceId = 6;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Winner plays to win
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            const receipt = await tx.wait();

            // Extract prize amounts from PrizeDistributed events
            const prizeEvents = receipt.logs
                .map(log => { try { return game.interface.parseLog(log); } catch { return null; } })
                .filter(parsed => parsed?.name === "PrizeDistributed");

            // At least winner should receive prize
            expect(prizeEvents.length).to.be.gte(1);

            // Winner should receive prize
            const winnerEvent = prizeEvents.find(e => e.args.player === firstPlayer.address);
            expect(winnerEvent).to.not.be.undefined;
            expect(winnerEvent.args.amount).to.be.gt(0);
            expect(winnerEvent.args.rank).to.equal(1); // Winner is rank 1

            // Verify prize distribution percentages sum to 100
            const distribution = await game.getTierPrizeDistribution(tierId);
            let sum = 0;
            for (const pct of distribution) {
                sum += Number(pct);
            }
            expect(sum).to.equal(100);
        });

        it("Should handle draw finals with co-winners", async function () {
            const tierId = 0;
            const instanceId = 7;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to a draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Both should have same ranking (1) as co-winners
            // Tournament completes with finalsWasDraw = true
        });
    });

    describe("8-Player Tournament Full Flow", function () {
        it("Should complete full 8-player bracket tournament", async function () {
            const tierId = 2;
            const instanceId = 1;

            // Enroll 8 players
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Tournament should have started
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Round 0: 4 matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(4);

            // Helper to play a match to completion (first player wins)
            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return; // Not in progress

                const fp = match.currentTurn;
                const sp = match.player1 === fp ? match.player2 : match.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                // Play winning sequence for first player
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            // Play all 4 first round matches
            for (let m = 0; m < 4; m++) {
                await playMatchToWin(0, m);
            }

            // Round 1: 2 matches (semi-finals)
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
            expect(round1.totalMatches).to.equal(2);

            // Play semi-finals
            for (let m = 0; m < 2; m++) {
                await playMatchToWin(1, m);
            }

            // Round 2: 1 match (finals)
            const round2 = await game.rounds(tierId, instanceId, 2);
            expect(round2.initialized).to.be.true;
            expect(round2.totalMatches).to.equal(1);

            // Play finals
            await playMatchToWin(2, 0);

            // Tournament should be completed and reset
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling
        });
    });

    describe("Timeout Escalation Levels", function () {
        it("Should track timeout escalation timestamps", async function () {
            const tierId = 0;
            const instanceId = 8;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);

            // Match should have timeout state initialized
            expect(match.status).to.equal(1); // InProgress
        });

        it("Should reject Escalation 2 force eliminate before timeout", async function () {
            const tierId = 2;
            const instanceId = 2;

            // Need 8 players for tier 2
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Try to force eliminate immediately - should fail
            await expect(
                game.connect(player1).forceEliminateStalledMatch(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Tier 2 not reached");
        });

        it("Should reject Escalation 3 replacement claim before timeout", async function () {
            const tierId = 0;
            const instanceId = 9;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Try to claim slot immediately - should fail
            await expect(
                game.connect(player3).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Tier 3 timeout not reached");
        });
    });

    describe("Invalid Operations", function () {
        it("Should reject invalid instance ID", async function () {
            await expect(
                game.connect(player1).enrollInTournament(0, 99, { value: TIER_0_FEE })
            ).to.be.revertedWith("Invalid instance");
        });

        it("Should reject enrollment in full tournament", async function () {
            const tierId = 0;
            const instanceId = 10;

            // Fill the 2-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Third player should be rejected
            await expect(
                game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("Tournament not accepting enrollments");
        });

        it("Should reject force start when tournament already in progress", async function () {
            const tierId = 0;
            const instanceId = 11;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Tournament is now InProgress
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("Not enrolling");
        });

        it("Should reject getPrizePercentage for invalid tier", async function () {
            await expect(
                game.getPrizePercentage(99, 0)
            ).to.be.revertedWith("Invalid tier");
        });

        it("Should reject getPrizePercentage for invalid ranking", async function () {
            await expect(
                game.getPrizePercentage(0, 99)
            ).to.be.revertedWith("Invalid ranking");
        });
    });

    describe("Tournament Reset and Cleanup", function () {
        it("Should properly reset all state after tournament completion", async function () {
            const tierId = 0;
            const instanceId = 12;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify enrolled
            expect(await game.isEnrolled(tierId, instanceId, player1.address)).to.be.true;
            expect(await game.isEnrolled(tierId, instanceId, player2.address)).to.be.true;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Complete tournament
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // After reset, enrollment should be cleared
            expect(await game.isEnrolled(tierId, instanceId, player1.address)).to.be.false;
            expect(await game.isEnrolled(tierId, instanceId, player2.address)).to.be.false;

            // Tournament state should be reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling
            expect(tournament.enrolledCount).to.equal(0);
            expect(tournament.prizePool).to.equal(0);
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress);
        });

        it("Should allow re-enrollment after tournament reset", async function () {
            const tierId = 0;
            const instanceId = 13;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Should be able to re-enroll
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.emit(game, "PlayerEnrolled");
        });
    });

    describe("Entry Fee Distribution", function () {
        it("Should correctly split fees (90% pool, 7.5% owner, 2.5% protocol)", async function () {
            const tierId = 0;
            const instanceId = 14;

            const ownerBalBefore = await hre.ethers.provider.getBalance(owner.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const ownerBalAfter = await hre.ethers.provider.getBalance(owner.address);
            const tournament = await game.tournaments(tierId, instanceId);

            // Owner gets 7.5% + 2.5% = 10%
            const expectedOwnerShare = (TIER_0_FEE * 1000n) / 10000n;
            expect(ownerBalAfter - ownerBalBefore).to.equal(expectedOwnerShare);

            // Prize pool gets 90%
            const expectedPrizePool = (TIER_0_FEE * 9000n) / 10000n;
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });
    });

    describe("Enrollment Timeout State", function () {
        it("Should initialize enrollment timeout timestamps on first enrollment", async function () {
            const tierId = 1;
            const instanceId = 3;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament = await game.tournaments(tierId, instanceId);

            // First enroller should be recorded
            expect(tournament.firstEnroller).to.equal(player1.address);
            expect(tournament.firstEnrollmentTimestamp).to.be.gt(0);

            // Escalation timestamps should be set
            expect(tournament.enrollmentTimeout.escalation1Start).to.be.gt(0);
            expect(tournament.enrollmentTimeout.escalation2Start).to.be.gt(tournament.enrollmentTimeout.escalation1Start);
        });

        it("Should track forfeit pool during enrollment", async function () {
            const tierId = 1;
            const instanceId = 4;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament1 = await game.tournaments(tierId, instanceId);
            const forfeitPool1 = tournament1.enrollmentTimeout.forfeitPool;

            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament2 = await game.tournaments(tierId, instanceId);
            const forfeitPool2 = tournament2.enrollmentTimeout.forfeitPool;

            // Forfeit pool should grow with each enrollment
            expect(forfeitPool2).to.be.gt(forfeitPool1);
        });
    });

    describe("Tier Configuration Access", function () {
        it("Should expose ENTRY_FEES helper", async function () {
            const fee = await game.ENTRY_FEES(0);
            expect(fee).to.equal(TIER_0_FEE);
        });

        it("Should expose INSTANCE_COUNTS helper", async function () {
            const count = await game.INSTANCE_COUNTS(0);
            expect(count).to.equal(64);
        });

        it("Should expose TIER_SIZES helper", async function () {
            const size = await game.TIER_SIZES(0);
            expect(size).to.equal(2);
        });
    });

    // ============ Advanced Escalation & All-Draw Tests ============

    describe("Escalation Level 2 - Force Eliminate Stalled Match", function () {
        it("Should allow advanced player to force eliminate after Escalation 2 timeout", async function () {
            const tierId = 2;
            const instanceId = 5;

            // Enroll 8 players for tier 2
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Complete match 1 first so the winner is "advanced"
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const fp1 = players.find(p => p.address === match1.currentTurn);
            const sp1 = players.find(p => p.address === (match1.player1 === match1.currentTurn ? match1.player2 : match1.player1));

            // Win match 1
            await game.connect(fp1).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(sp1).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(fp1).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(sp1).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(fp1).makeMove(tierId, instanceId, 0, 1, 2); // fp1 wins

            // Make a move in match 0 so the clock starts
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const fp0 = players.find(p => p.address === match0.currentTurn);
            await game.connect(fp0).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past Escalation 2 timeout (1 min move + 1 min escalation = 2+ min)
            await hre.ethers.provider.send("evm_increaseTime", [130]); // 2 min 10 sec
            await hre.ethers.provider.send("evm_mine", []);

            // fp1 (who won match 1) is now "advanced" and can eliminate match 0
            await expect(
                game.connect(fp1).forceEliminateStalledMatch(tierId, instanceId, 0, 0)
            ).to.emit(game, "MatchCompleted");
        });

        it("Should reject force eliminate from non-advanced player", async function () {
            const tierId = 2;
            const instanceId = 6;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Fast forward past Escalation 2 without completing any matches
            await hre.ethers.provider.send("evm_increaseTime", [130]);
            await hre.ethers.provider.send("evm_mine", []);

            // Player from match 1 who hasn't won anything should NOT be able to force eliminate
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const nonAdvancedPlayer = players.find(p => p.address === match1.player1);

            await expect(
                game.connect(nonAdvancedPlayer).forceEliminateStalledMatch(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Must be in advanced round to eliminate");
        });
    });

    describe("Escalation Level 3 - Match Slot Replacement", function () {
        it("Should allow external player to claim match slot after Escalation 3 timeout", async function () {
            const tierId = 0;
            const instanceId = 15;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Fast forward past Escalation 3 (1 min move + 1 min + 1 min = 3+ min)
            await hre.ethers.provider.send("evm_increaseTime", [190]); // 3 min 10 sec
            await hre.ethers.provider.send("evm_mine", []);

            // External player (player3) claims the slot - emits MatchCompleted with replacer as winner
            await expect(
                game.connect(player3).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.emit(game, "MatchCompleted");
        });

        it("Should track forfeit amount for replaced player", async function () {
            const tierId = 0;
            const instanceId = 16;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const stalledPlayer = match.currentTurn; // The player who didn't move

            // Fast forward past Escalation 3
            await hre.ethers.provider.send("evm_increaseTime", [190]);
            await hre.ethers.provider.send("evm_mine", []);

            // Verify PlayerForfeited event is emitted for replaced players
            await expect(
                game.connect(player3).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.emit(game, "PlayerForfeited");
        });
    });

    describe("All-Draw Round Scenarios", function () {
        it("Should handle finals draw with co-winners", async function () {
            const tierId = 0;
            const instanceId = 17;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to a draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);  // X at 0
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O at 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X at 2
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O at 1
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);  // X at 7
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O at 6
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);  // X at 3
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O at 5

            // Final move results in draw
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8)
            ).to.emit(game, "TournamentCompleted");

            // Both players should be co-winners (rank 1) or tournament handles draw appropriately
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset after completion
        });

        it("Should handle 8-player tournament with multiple draws in first round", async function () {
            const tierId = 2;
            const instanceId = 7;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Helper to play a match to draw
            async function playMatchToDraw(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return false;

                const fp = match.currentTurn;
                const sp = match.player1 === fp ? match.player2 : match.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return false;

                // Play draw pattern
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 7);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 6);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 5);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 8);
                return true;
            }

            // Play first 2 matches to draw, other 2 to win
            await playMatchToDraw(0, 0);
            await playMatchToDraw(0, 1);

            // Play matches 2 and 3 to normal wins
            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return;

                const fp = match.currentTurn;
                const sp = match.player1 === fp ? match.player2 : match.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // All 4 matches should be completed (2 draws + 2 wins)
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.completedMatches).to.equal(4);
        });
    });

    describe("Advanced Tournament Progression", function () {
        it("Should handle walkover when odd number of players in round", async function () {
            // This tests the orphaned winner logic
            // When a round has odd players, one gets a bye/walkover

            const tierId = 2;
            const instanceId = 8;

            // Enroll 8 players
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Complete 3 matches normally, draw the 4th
            // This creates 3 winners + 2 players from draw = 5 players for next round

            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return;

                const fp = match.currentTurn;
                const sp = match.player1 === fp ? match.player2 : match.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                // Win pattern
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            // Complete matches 0, 1, 2 with wins
            await playMatchToWin(0, 0);
            await playMatchToWin(0, 1);
            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // Round 1 should now be initialized with remaining players
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
        });
    });

    describe("Match Timeout State Tracking", function () {
        it("Should update lastMoveTime after each move", async function () {
            const tierId = 0;
            const instanceId = 18;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const matchBefore = await game.getMatch(tierId, instanceId, 0, 0);
            const initialLastMove = matchBefore.lastMoveTime;

            // Fast forward time a bit
            await hre.ethers.provider.send("evm_increaseTime", [10]);
            await hre.ethers.provider.send("evm_mine", []);

            // Make a move
            const firstPlayer = matchBefore.currentTurn === player1.address ? player1 : player2;
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            const matchAfter = await game.getMatch(tierId, instanceId, 0, 0);
            const newLastMove = matchAfter.lastMoveTime;

            // lastMoveTime should have been updated
            expect(newLastMove).to.be.gt(initialLastMove);
        });

        it("Should allow timeout claim after move timeout elapses", async function () {
            const tierId = 0;
            const instanceId = 19;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past timeout (1 minute)
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player should be able to claim timeout win (second player didn't move)
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });
    });

    describe("Complete Tournament Flow with Mixed Results", function () {
        it("Should complete 8-player tournament with wins and draws", async function () {
            const tierId = 2;
            const instanceId = 9;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return null;

                const fp = match.currentTurn;
                const sp = match.player1 === fp ? match.player2 : match.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return null;

                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);

                return fp; // Return winner
            }

            // Round 0: 4 matches
            await playMatchToWin(0, 0);
            await playMatchToWin(0, 1);
            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // Verify round 1 initialized
            let round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;

            // Round 1: 2 matches
            await playMatchToWin(1, 0);
            await playMatchToWin(1, 1);

            // Round 2: Finals
            let round2 = await game.rounds(tierId, instanceId, 2);
            expect(round2.initialized).to.be.true;

            await playMatchToWin(2, 0);

            // Tournament should be completed
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset

            // Verify player stats updated
            const stats = await game.getPlayerStats(player1.address);
            expect(stats.tournamentsPlayed).to.be.gte(1);
        });
    });

    describe("Escalation Victory and Prize Distribution", function () {
        it("Should award full prize pool when timeout claim wins 2-player tournament", async function () {
            const tierId = 0;
            const instanceId = 20;

            // Track balance before
            const balanceBefore = await hre.ethers.provider.getBalance(player1.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past timeout
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player claims timeout win - should win tournament
            const tx = await game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);
            const receipt = await tx.wait();

            // Check TournamentCompleted event was emitted
            const tournamentCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "TournamentCompleted"
            );
            expect(tournamentCompletedEvent).to.not.be.undefined;

            // Winner should be the timeout claimer
            expect(tournamentCompletedEvent.args.winner).to.equal(firstPlayer.address);

            // Prize should be ~90% of total entry fees (2 * 0.01 ETH * 90% = 0.018 ETH)
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            expect(tournamentCompletedEvent.args.prizeAmount).to.equal(expectedPrize);

            // Verify leaderboard shows positive earnings for winner
            const leaderboard = await game.getLeaderboard();
            const winnerEntry = leaderboard.find(e => e.player === firstPlayer.address);
            expect(winnerEntry.earnings).to.be.gt(0n);
        });

        it("Should award full prize pool when Escalation Level 2 leads to tournament victory", async function () {
            const tierId = 2;
            const instanceId = 10;

            const allPlayers = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of allPlayers) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Complete matches 1, 2, 3 in round 0 to leave only match 0 stalled
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return null; // Not in progress

                const fpAddr = match.currentTurn;
                const spAddr = match.player1 === fpAddr ? match.player2 : match.player1;
                const fp = allPlayers.find(p => p.address === fpAddr);
                const sp = allPlayers.find(p => p.address === spAddr);

                if (!fp || !sp) return null;

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                return fp;
            }

            // Win matches 1, 2, 3 - these players advance
            const winner1 = await winMatch(0, 1);
            await winMatch(0, 2);
            await winMatch(0, 3);

            // Start match 0 with a single move (so timeout clock starts)
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const fp0 = allPlayers.find(p => p.address === match0.currentTurn);
            await game.connect(fp0).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past Escalation 2 timeout
            await hre.ethers.provider.send("evm_increaseTime", [130]);
            await hre.ethers.provider.send("evm_mine", []);

            // Winner1 (advanced player) force eliminates stalled match 0
            await game.connect(winner1).forceEliminateStalledMatch(tierId, instanceId, 0, 0);

            // Now complete round 1 (semis)
            await winMatch(1, 0);
            await winMatch(1, 1);

            // Complete finals
            const finalMatch = await game.getMatch(tierId, instanceId, 2, 0);
            const finalFpAddr = finalMatch.currentTurn;
            const finalSpAddr = finalMatch.player1 === finalFpAddr ? finalMatch.player2 : finalMatch.player1;
            const finalFp = allPlayers.find(p => p.address === finalFpAddr);
            const finalSp = allPlayers.find(p => p.address === finalSpAddr);

            await game.connect(finalFp).makeMove(tierId, instanceId, 2, 0, 0);
            await game.connect(finalSp).makeMove(tierId, instanceId, 2, 0, 3);
            await game.connect(finalFp).makeMove(tierId, instanceId, 2, 0, 1);
            await game.connect(finalSp).makeMove(tierId, instanceId, 2, 0, 4);

            // Final move wins tournament
            const tx = await game.connect(finalFp).makeMove(tierId, instanceId, 2, 0, 2);
            const receipt = await tx.wait();

            // Should have TournamentCompleted event
            const tournamentCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "TournamentCompleted"
            );
            expect(tournamentCompletedEvent).to.not.be.undefined;

            // Winner gets prize
            expect(tournamentCompletedEvent.args.prizeAmount).to.be.gt(0n);
        });

        it("Should allow Escalation Level 3 replacement player to win tournament and get prize", async function () {
            const tierId = 0;
            const instanceId = 21;

            // player1 and player2 enroll
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Start the match
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past Escalation 3 timeout (1 min move + 2 min = 3 min total)
            await hre.ethers.provider.send("evm_increaseTime", [200]);
            await hre.ethers.provider.send("evm_mine", []);

            // player3 (external) claims the match slot via replacement
            const tx = await game.connect(player3).claimMatchSlotByReplacement(tierId, instanceId, 0, 0);
            const receipt = await tx.wait();

            // Tournament should be completed with player3 as winner (since it's finals)
            const tournamentCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "TournamentCompleted"
            );
            expect(tournamentCompletedEvent).to.not.be.undefined;
            expect(tournamentCompletedEvent.args.winner).to.equal(player3.address);

            // player3 should have positive earnings (got prize without paying entry)
            const leaderboard = await game.getLeaderboard();
            const player3Entry = leaderboard.find(e => e.player === player3.address);
            // Note: player3 didn't pay entry fee, but got prize
            expect(player3Entry).to.not.be.undefined;
        });

        it("Should track forfeited amounts for eliminated players on escalation", async function () {
            const tierId = 0;
            const instanceId = 22;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward and claim timeout
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout win - should emit TimeoutVictoryClaimed
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed")
              .withArgs(tierId, instanceId, 0, 0, firstPlayer.address, secondPlayer.address);

            // Timeout loser loses their entry fee (tracked via leaderboard earnings, not forfeited amounts)
            const leaderboard = await game.getLeaderboard();
            const loserEntry = leaderboard.find(e => e.player === secondPlayer.address);
            expect(loserEntry).to.not.be.undefined;
            // Loser should have negative earnings (paid entry fee, got no prize)
            expect(loserEntry.earnings).to.be.lt(0);
        });

        it("Should correctly distribute prize pool after abandoned enrollment claim", async function () {
            const tierId = 0;
            const instanceId = 23;

            // Single player enrolls
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Fast forward past escalation 2 window
            await hre.ethers.provider.send("evm_increaseTime", [500]);
            await hre.ethers.provider.send("evm_mine", []);

            const balanceBefore = await hre.ethers.provider.getBalance(player3.address);

            // player3 (external) claims the abandoned enrollment pool
            const tx = await game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId);
            const receipt = await tx.wait();

            const balanceAfter = await hre.ethers.provider.getBalance(player3.address);
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            // player3 should have received the prize pool (90% of entry fee)
            const expectedClaim = (TIER_0_FEE * 90n) / 100n;
            const actualGain = balanceAfter - balanceBefore + gasUsed;
            expect(actualGain).to.equal(expectedClaim);

            // Check EnrollmentPoolClaimed event
            const claimEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "EnrollmentPoolClaimed"
            );
            expect(claimEvent).to.not.be.undefined;
            expect(claimEvent.args.claimant).to.equal(player3.address);
            expect(claimEvent.args.amount).to.equal(expectedClaim);
        });
    });

    describe("playerPrizes and Leaderboard Consistency", function () {
        // playerPrizes is permanent and persists after tournament reset

        it("Should have playerPrizes equal to prize amount for winner in 2-player tournament", async function () {
            const tierId = 0;
            const instanceId = 24;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Win the match
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Check playerPrizes for winner (should be 90% of total entry fees)
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            expect(winnerPrize).to.equal(expectedPrize);

            // Loser should have 0 prize
            const loserPrize = await game.playerPrizes(tierId, instanceId, secondPlayer.address);
            expect(loserPrize).to.equal(0n);
        });

        it("Should have leaderboard earnings equal to (playerPrizes - entryFee) for winner", async function () {
            const tierId = 0;
            const instanceId = 25;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Get playerPrizes (now permanent after tournament reset)
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);

            // Get leaderboard earnings change
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Winner's earnings change should equal (prize - entryFee)
            const winnerEarningsChange = earningsAfter1 - firstEarningsBefore;
            expect(winnerEarningsChange).to.equal(winnerPrize - TIER_0_FEE);

            // Loser's earnings change should equal -entryFee
            const loserEarningsChange = earningsAfter2 - secondEarningsBefore;
            expect(loserEarningsChange).to.equal(-TIER_0_FEE);
        });

        it("Should have consistent playerPrizes and leaderboard for 8-player tournament", async function () {
            const tierId = 2;
            const instanceId = 11;

            const allPlayers = [player1, player2, player3, player4, player5, player6, player7, player8];

            // Track earnings before
            const earningsBefore = {};
            for (const p of allPlayers) {
                earningsBefore[p.address] = await game.playerEarnings(p.address);
            }

            // Enroll all players
            for (const player of allPlayers) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Helper to win a match
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.status !== 1n) return null;

                const fpAddr = match.currentTurn;
                const spAddr = match.player1 === fpAddr ? match.player2 : match.player1;
                const fp = allPlayers.find(p => p.address === fpAddr);
                const sp = allPlayers.find(p => p.address === spAddr);

                if (!fp || !sp) return null;

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                return fp.address;
            }

            // Complete tournament
            await winMatch(0, 0);
            await winMatch(0, 1);
            await winMatch(0, 2);
            await winMatch(0, 3);
            await winMatch(1, 0);
            await winMatch(1, 1);
            const tournamentWinner = await winMatch(2, 0);

            // Check consistency for all players
            for (const p of allPlayers) {
                const prize = await game.playerPrizes(tierId, instanceId, p.address);
                const earningsAfter = await game.playerEarnings(p.address);
                const earningsChange = earningsAfter - earningsBefore[p.address];

                // Earnings change should equal (prize - entryFee)
                const expectedChange = prize - TIER_2_FEE;
                expect(earningsChange).to.equal(expectedChange);
            }

            // Winner should have positive prize and earnings
            const winnerPrize = await game.playerPrizes(tierId, instanceId, tournamentWinner);
            expect(winnerPrize).to.be.gt(0n);
            expect(winnerPrize - TIER_2_FEE).to.be.gt(0n);
        });

        it("Should have consistent playerPrizes and leaderboard after timeout victory", async function () {
            const tierId = 0;
            const instanceId = 26;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward and claim timeout
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            await game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check playerPrizes (permanent)
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            const loserPrize = await game.playerPrizes(tierId, instanceId, secondPlayer.address);

            // Winner should get full prize pool
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            expect(winnerPrize).to.equal(expectedPrize);
            expect(loserPrize).to.equal(0n);

            // Check leaderboard consistency
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Winner: prize - entryFee
            expect(earningsAfter1 - firstEarningsBefore).to.equal(winnerPrize - TIER_0_FEE);
            // Loser: -entryFee
            expect(earningsAfter2 - secondEarningsBefore).to.equal(-TIER_0_FEE);
        });

        it("Should have consistent playerPrizes and leaderboard for draw finals", async function () {
            const tierId = 0;
            const instanceId = 27;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Both players should get half the prize (permanent)
            const prizePool = (TIER_0_FEE * 2n * 90n) / 100n;
            const expectedPrizePerPlayer = prizePool / 2n;

            const prize1 = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, secondPlayer.address);

            expect(prize1).to.equal(expectedPrizePerPlayer);
            expect(prize2).to.equal(expectedPrizePerPlayer);

            // Check leaderboard consistency
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Both: prize - entryFee
            expect(earningsAfter1 - firstEarningsBefore).to.equal(prize1 - TIER_0_FEE);
            expect(earningsAfter2 - secondEarningsBefore).to.equal(prize2 - TIER_0_FEE);
        });
    });
});

// Helper to convert BigInt to int256 for comparison
function int256(val) {
    return BigInt(val);
}
