import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Enrollment Window Reset", function () {
    let game, player1, player2, player3;
    const TIER_0 = 0;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [, player1, player2, player3] = await hre.ethers.getSigners();

        // Deploy modules
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();

        const GameCacheModule = await hre.ethers.getContractFactory("GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress()
        );
        await game.waitForDeployment();
    });

    describe("Test 1: Successful Reset", function () {
        it("Should allow solo player to reset enrollment window after expiry", async function () {
            const instanceId = 0;

            // Enroll single player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Verify initially cannot reset (window not expired)
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.false;

            // Fast forward past escalation1Start (300 seconds) but before escalation2Start (420 seconds)
            await time.increase(301);

            // Verify can reset now
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.true;

            // Get tournament state before reset
            const tournamentBefore = await game.tournaments(TIER_0, instanceId);
            const oldEscalation1Start = tournamentBefore.enrollmentTimeout.escalation1Start;

            // Reset the window
            const tx = await game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId);

            // Verify event emitted
            await expect(tx).to.emit(game, "EnrollmentWindowReset");

            // Verify new escalation windows set
            const tournamentAfter = await game.tournaments(TIER_0, instanceId);
            expect(tournamentAfter.enrollmentTimeout.escalation1Start).to.be.greaterThan(oldEscalation1Start);

            // Verify forceStartTournament now fails (window not expired yet)
            await expect(
                game.connect(player1).forceStartTournament(TIER_0, instanceId)
            ).to.be.revertedWith("FS"); // Short error code for force start failure
        });
    });

    describe("Test 2: Reject if Tournament Not Enrolling", function () {
        it("Should reject reset if tournament not enrolling", async function () {
            const instanceId = 1;

            // Start and complete a tournament
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Tournament should have started (status = InProgress)
            const tournament = await game.tournaments(TIER_0, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Try to reset (should fail)
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.be.revertedWith("RW"); // Short error code for reset window failure
        });
    });

    describe("Test 3: Reject if Multiple Players Enrolled", function () {
        it("Should reject reset if multiple players enrolled", async function () {
            const instanceId = 2;

            // Enroll 2 players
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Tournament should have started
            const tournament = await game.tournaments(TIER_0, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Try to reset (should fail - tournament not enrolling anymore)
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.be.revertedWith("RW"); // Short error code for reset window failure
        });
    });

    describe("Test 4: Reject if Caller Not Enrolled", function () {
        it("Should reject reset if caller not enrolled", async function () {
            const instanceId = 3;

            // Enroll only player1
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward
            await time.increase(301);

            // player2 tries to reset (not enrolled)
            await expect(
                game.connect(player2).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.be.revertedWith("RW"); // Short error code for reset window failure
        });
    });

    describe("Test 5: Reject if Window Not Expired", function () {
        it("Should reject reset if enrollment window not expired", async function () {
            const instanceId = 4;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Try to reset immediately (should fail)
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.be.revertedWith("RW"); // Short error code for reset window failure
        });
    });

    describe("Test 6: Reset Still Works After Escalation Level 2", function () {
        it("Should allow reset even after escalation level 2 reached", async function () {
            const instanceId = 5;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward past escalation2Start (600 seconds + 1)
            // enrollmentWindow (300) + enrollmentLevel2Delay (300) = 600
            await time.increase(601);

            // Reset should still work (player can keep waiting for others to join)
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.emit(game, "EnrollmentWindowReset");

            // Verify new escalation windows set
            const tournament = await game.tournaments(TIER_0, instanceId);
            expect(tournament.enrollmentTimeout.escalation1Start).to.be.greaterThan(0);
        });
    });

    describe("Test 7: Second Player Can Enroll After Reset", function () {
        it("Should allow second player to enroll after reset", async function () {
            const instanceId = 6;

            // Enroll first player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward and reset
            await time.increase(301);
            await game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId);

            // Second player should be able to enroll
            await expect(
                game.connect(player2).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE })
            ).to.emit(game, "TournamentStarted");

            // Tournament should have started
            const tournament = await game.tournaments(TIER_0, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });
    });

    describe("Test 8: Multiple Resets Allowed", function () {
        it("Should allow player to reset multiple times", async function () {
            const instanceId = 7;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // First reset
            await time.increase(301);
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.emit(game, "EnrollmentWindowReset");

            // Second reset
            await time.increase(301);
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.emit(game, "EnrollmentWindowReset");

            // Third reset
            await time.increase(301);
            const tx = await game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId);
            await expect(tx).to.emit(game, "EnrollmentWindowReset");
        });
    });

    describe("Test 9: canResetEnrollmentWindow View Function Accuracy", function () {
        it("Should accurately report reset eligibility via view function", async function () {
            const instanceId = 8;

            // Before enrollment
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.false;

            // After enrollment but before expiry
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.false;

            // After escalation1 - should be true
            await time.increase(301);
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.true;

            // Even after escalation2 - should still be true
            await time.increase(60);
            expect(await game.connect(player1).canResetEnrollmentWindow.staticCall(TIER_0, instanceId)).to.be.true;
        });
    });

    describe("Test 10: Reset Preserves forfeitPool", function () {
        it("Should preserve forfeitPool amount after reset", async function () {
            const instanceId = 9;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Get initial forfeit pool
            const tournamentBefore = await game.tournaments(TIER_0, instanceId);
            const forfeitPoolBefore = tournamentBefore.enrollmentTimeout.forfeitPool;

            // Reset
            await time.increase(301);
            await game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId);

            // Verify forfeit pool unchanged
            const tournamentAfter = await game.tournaments(TIER_0, instanceId);
            expect(tournamentAfter.enrollmentTimeout.forfeitPool).to.equal(forfeitPoolBefore);
        });
    });

    describe("Test 11: Reset Event Contains Correct Data", function () {
        it("Should emit event with correct escalation timestamps", async function () {
            const instanceId = 10;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward and reset
            await time.increase(301);
            const tx = await game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId);

            // Get receipt and find event
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = game.interface.parseLog(log);
                    return parsed && parsed.name === "EnrollmentWindowReset";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;

            // Parse the event
            const parsed = game.interface.parseLog(event);
            expect(parsed.args.tierId).to.equal(TIER_0);
            expect(parsed.args.instanceId).to.equal(instanceId);
            expect(parsed.args.player).to.equal(player1.address);
            expect(parsed.args.newEscalation1Start).to.be.greaterThan(0);
            expect(parsed.args.newEscalation2Start).to.be.greaterThan(parsed.args.newEscalation1Start);
        });
    });

    describe("Test 12: Cannot Reset After Force Start", function () {
        it("Should not allow reset after force starting tournament", async function () {
            const instanceId = 11;

            // Enroll player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward and force start
            await time.increase(301);
            await game.connect(player1).forceStartTournament(TIER_0, instanceId);

            // Try to reset (should fail - tournament no longer enrolling, and enrolledCount is now 0 after walkover)
            // The error could be "Not enrolling" or "Must have exactly 1 player enrolled" depending on check order
            await expect(
                game.connect(player1).resetEnrollmentWindow(TIER_0, instanceId)
            ).to.be.reverted;
        });
    });
});
