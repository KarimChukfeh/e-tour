import hre from "hardhat";
import { expect } from "chai";

describe("Tournament Reset and Enrollment Edge Cases", function () {
    let game;
    let owner, player1, player2, player3, player4, player5;
    const TIER_0_FEE = hre.ethers.parseEther("0.001");
    const TIER_1_FEE = hre.ethers.parseEther("0.002");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.initializeAllInstances();
    });

    describe("Tournament Reset State Management", function () {
        it("Should allow enrollment after tournament completes and resets", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete first tournament
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Quick win pattern
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2); // Wins

            // Verify tournament completed and reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (auto-reset)
            expect(tournament.enrolledCount).to.equal(0);
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress); // Winner cleared on reset

            // Second tournament - should work immediately
            await expect(
                game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            await expect(
                game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            // Verify second tournament started
            const tournament2 = await game.tournaments(tierId, instanceId);
            expect(tournament2.status).to.equal(1); // InProgress
            expect(tournament2.enrolledCount).to.equal(2);
        });

        it("Should clear all round data on tournament reset", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            // Complete a 4-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Verify round 0 initialized
            let round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(2); // 4 players = 2 semi-final matches

            // Complete tournament (abbreviated - just forfeit both matches)
            await hre.ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout on match 0
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const nonCurrentPlayer0 = match0.currentTurn === player1.address ? player2 : player1;
            await game.connect(nonCurrentPlayer0).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Claim timeout on match 1
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const nonCurrentPlayer1 = match1.currentTurn === player3.address ? player4 : player3;
            await game.connect(nonCurrentPlayer1).claimTimeoutWin(tierId, instanceId, 0, 1);

            // Complete finals
            const finalsMatch = await game.getMatch(tierId, instanceId, 1, 0);
            const finalsP1 = [player1, player2, player3, player4].find(p => p.address === finalsMatch.common.player1);
            const finalsP2 = [player1, player2, player3, player4].find(p => p.address === finalsMatch.common.player2);
            const finalsFirst = finalsMatch.currentTurn === finalsP1.address ? finalsP1 : finalsP2;
            const finalsSecond = finalsFirst === finalsP1 ? finalsP2 : finalsP1;

            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 0);
            await game.connect(finalsSecond).makeMove(tierId, instanceId, 1, 0, 3);
            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 1);
            await game.connect(finalsSecond).makeMove(tierId, instanceId, 1, 0, 4);
            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 2); // Wins

            // Verify tournament completed and reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Verify round 0 cleared
            round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.false;
            expect(round0.totalMatches).to.equal(0);
            expect(round0.completedMatches).to.equal(0);

            // Verify round 1 cleared
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.false;
            expect(round1.totalMatches).to.equal(0);
        });

        it("Should clear player enrollment status on reset", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify players enrolled
            const isEnrolled1 = await game.isEnrolled(tierId, instanceId, player1.address);
            const isEnrolled2 = await game.isEnrolled(tierId, instanceId, player2.address);
            expect(isEnrolled1).to.be.true;
            expect(isEnrolled2).to.be.true;

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Verify enrollment cleared
            const isEnrolled1After = await game.isEnrolled(tierId, instanceId, player1.address);
            const isEnrolled2After = await game.isEnrolled(tierId, instanceId, player2.address);
            expect(isEnrolled1After).to.be.false;
            expect(isEnrolled2After).to.be.false;

            // Same players should be able to enroll again
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            await expect(
                game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;
        });
    });

    describe("Enrollment State Protection", function () {
        it("Should reject enrollment during active tournament", async function () {
            const tierId = 1; // 4-player
            const instanceId = 0;

            // Fill tournament to capacity
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Tournament should be InProgress
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // New player tries to enroll - should fail
            await expect(
                game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE })
            ).to.be.revertedWith("Tournament not accepting enrollments");
        });

        it("Should reject duplicate enrollment in same tournament", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Try to enroll same player again
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("Already enrolled");
        });

        it("Should allow same player in different instances", async function () {
            const tierId = 0;
            const instanceId1 = 0;
            const instanceId2 = 1;

            // Enroll in instance 0
            await game.connect(player1).enrollInTournament(tierId, instanceId1, { value: TIER_0_FEE });

            // Should be able to enroll in instance 1
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId2, { value: TIER_0_FEE })
            ).to.not.be.reverted;
        });

        it("Should allow same player in different tiers", async function () {
            const tier0 = 0;
            const tier1 = 1;
            const instanceId = 0;

            // Enroll in tier 0
            await game.connect(player1).enrollInTournament(tier0, instanceId, { value: TIER_0_FEE });

            // Should be able to enroll in tier 1
            await expect(
                game.connect(player1).enrollInTournament(tier1, instanceId, { value: TIER_1_FEE })
            ).to.not.be.reverted;
        });
    });

    describe("Prize Pool Reset", function () {
        it("Should reset prize pool to zero after distribution", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify prize pool accumulated
            let tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = TIER_0_FEE * 2n * 90n / 100n; // 90% of fees
            expect(tournament.prizePool).to.equal(expectedPrizePool);

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Verify prize pool reset to zero
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.prizePool).to.equal(0);
        });

        it("Should accumulate new prize pool for second tournament", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete first tournament
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer1 = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer1 = firstPlayer1 === player1 ? player2 : player1;

            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 2);

            // Second tournament
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify new prize pool
            const tournament2 = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = TIER_0_FEE * 2n * 90n / 100n;
            expect(tournament2.prizePool).to.equal(expectedPrizePool);
        });
    });

    describe("Match Cache Cleanup", function () {
        it("Should clear match data from cache on reset", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify match exists
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match1.common.status).to.equal(1); // Active

            // Complete tournament
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // After reset, finals match is preserved in live storage (still retrievable for history)
            const match1Cached = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match1Cached.common.isCached).to.be.false; // Finals preserved, not cached
            expect(match1Cached.common.status).to.equal(2); // Completed

            // Second tournament should create new match
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match2 = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match2.common.isCached).to.be.false; // New match, not cached
            expect(match2.common.status).to.equal(1); // Active
            expect(match2.common.player1).to.not.equal(match1.common.player1); // Different players
        });
    });
});
