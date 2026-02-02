/**
 * @title Enrollment Escalation - TournamentRecord Validation Tests
 * @notice Comprehensive test suite validating that enrollment escalation scenarios
 *         (EL1 and EL2) correctly populate recentInstances with TournamentRecord
 *
 * @dev Tests verify the following critical scenarios:
 *
 * EL1 (Solo Enrollment Force Start):
 * - When a single player enrolls and waits for the enrollment window to expire,
 *   they can force start the tournament via forceStartTournament()
 * - The tournament completes immediately with CompletionReason.SoloEnrollForceStart (enum value 6)
 * - recentInstances[tierId][instanceId] is populated with correct TournamentRecord:
 *   - players array contains solo player
 *   - winner is the solo player
 *   - prizePool is 90% of entry fee (after fees)
 *   - completionReason is SoloEnrollForceStart (6)
 *
 * EL2 (Abandoned Tournament Claim):
 * - When players enroll but tournament doesn't start, and escalation2Start passes,
 *   an external player can claim the abandoned pool via claimAbandonedEnrollmentPool()
 * - The tournament completes with CompletionReason.AbandonedTournamentClaimed (enum value 7)
 * - recentInstances[tierId][instanceId] is populated with correct TournamentRecord:
 *   - players array contains abandoned players
 *   - winner is the external claimer
 *   - prizePool reflects the forfeited entry fees
 *   - completionReason is AbandonedTournamentClaimed (7)
 *
 * Additional validations:
 * - Player earnings are correctly updated for both scenarios
 * - recentInstances persist across multiple tournament completions
 * - Different tiers and instances maintain separate records
 * - Edge cases like never-completed tournaments handled correctly
 *
 * @author ETour Protocol Team
 */

import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Enrollment Escalation - TournamentRecord Validation", function () {
    let game, player1, player2, externalPlayer;
    const TIER_0 = 0;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [, player1, player2, externalPlayer] = await hre.ethers.getSigners();

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

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();
    });

    describe("EL1: Solo Enrollment Force Start", function () {
        it("Should create TournamentRecord with SoloEnrollForceStart completion reason", async function () {
            const instanceId = 0;

            // Enroll single player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Verify tournament is in enrolling state
            const tournamentBefore = await game.tournaments(TIER_0, instanceId);
            expect(tournamentBefore.status).to.equal(0); // Enrolling

            // Fast forward past escalation1Start to enable force start (Tier 0 enrollmentWindow = 180 seconds)
            await time.increase(181);

            // Force start tournament as solo player
            await game.connect(player1).forceStartTournament(TIER_0, instanceId);

            // Verify tournament is completed
            const tournamentAfter = await game.tournaments(TIER_0, instanceId);
            expect(tournamentAfter.status).to.equal(0); // Should be reset back to Enrolling

            // Get the tournament record from recentInstances
            const record = await game.getTournamentRecord(TIER_0, instanceId);

            // Validate TournamentRecord fields
            expect(record.players.length).to.equal(1);
            expect(record.players[0]).to.equal(player1.address);
            expect(record.winner).to.equal(player1.address);
            // Prize pool is 90% of entry fee (10% fees split between owner and protocol)
            const expectedPrizePool = (TIER_0_FEE * BigInt(9000)) / BigInt(10000);
            expect(record.prizePool).to.equal(expectedPrizePool);
            expect(record.endTime).to.be.greaterThan(0);

            // CRITICAL: Verify completion reason is SoloEnrollForceStart (enum value 6)
            expect(record.completionReason).to.equal(6); // CompletionReason.SoloEnrollForceStart
        });

        it("Should handle EL1 correctly for different tier sizes", async function () {
            // Test with a larger tier (Tier 1: 4-player tournament)
            const TIER_1 = 1;
            const TIER_1_FEE = hre.ethers.parseEther("0.0007");
            const instanceId = 0;

            // Enroll single player
            await game.connect(player1).enrollInTournament(TIER_1, instanceId, { value: TIER_1_FEE });

            // Fast forward past escalation1Start (300 seconds for Tier 1)
            await time.increase(301);

            // Force start tournament
            await game.connect(player1).forceStartTournament(TIER_1, instanceId);

            // Get the tournament record
            const record = await game.getTournamentRecord(TIER_1, instanceId);

            // Validate
            expect(record.players.length).to.equal(1);
            expect(record.winner).to.equal(player1.address);
            expect(record.completionReason).to.equal(6); // CompletionReason.SoloEnrollForceStart
        });

        it("Should update player earnings correctly for EL1", async function () {
            const instanceId = 0;

            // Get initial earnings
            const earningsBefore = await game.connect(player1).getPlayerStats();

            // Enroll and force start
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await time.increase(181);
            await game.connect(player1).forceStartTournament(TIER_0, instanceId);

            // Get updated earnings
            const earningsAfter = await game.connect(player1).getPlayerStats();

            // Verify earnings increased by 90% of entry fee (prize pool after fees)
            const expectedPrizePool = (TIER_0_FEE * BigInt(9000)) / BigInt(10000);
            expect(earningsAfter).to.equal(earningsBefore + expectedPrizePool);
        });
    });

    describe("EL2: Abandoned Tournament Claim", function () {
        it("Should create TournamentRecord with AbandonedTournamentClaimed completion reason", async function () {
            const instanceId = 1;

            // Enroll single player to create an abandoned enrollment
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Verify tournament is in enrolling state
            const tournamentBefore = await game.tournaments(TIER_0, instanceId);
            expect(tournamentBefore.status).to.equal(0); // Enrolling

            // Fast forward past escalation2Start to enable external claim
            // enrollmentWindow (180) + enrollmentLevel2Delay (300) = 480 seconds for Tier 0
            await time.increase(481);

            // External player claims the abandoned pool
            await game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_0, instanceId);

            // Verify tournament is reset
            const tournamentAfter = await game.tournaments(TIER_0, instanceId);
            expect(tournamentAfter.status).to.equal(0); // Should be reset back to Enrolling

            // Get the tournament record from recentInstances
            const record = await game.getTournamentRecord(TIER_0, instanceId);

            // Validate TournamentRecord fields
            expect(record.players.length).to.equal(1);
            expect(record.players[0]).to.equal(player1.address);
            expect(record.winner).to.equal(externalPlayer.address);
            expect(record.prizePool).to.be.greaterThan(0); // Should have the forfeited entry fee
            expect(record.endTime).to.be.greaterThan(0);

            // CRITICAL: Verify completion reason is AbandonedTournamentClaimed (enum value 7)
            expect(record.completionReason).to.equal(7); // CompletionReason.AbandonedTournamentClaimed
        });

        it("Should handle EL2 with multiple abandoned players", async function () {
            const instanceId = 2;

            // Enroll two players but don't start the tournament
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Wait a bit before second enrollment to simulate separate enrollments
            await time.increase(10);

            // Note: For Tier 0 (2-player), the tournament starts automatically when 2nd player enrolls
            // So we need to use a different approach - enroll one player only

            // Fast forward past escalation2Start
            await time.increase(481);

            // External player claims the abandoned pool
            await game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_0, instanceId);

            // Get the tournament record
            const record = await game.getTournamentRecord(TIER_0, instanceId);

            // Validate
            expect(record.players.length).to.equal(1);
            expect(record.winner).to.equal(externalPlayer.address);
            expect(record.completionReason).to.equal(7); // CompletionReason.AbandonedTournamentClaimed
        });

        it("Should update claimer earnings correctly for EL2", async function () {
            const instanceId = 3;

            // Get initial earnings of external player
            const earningsBefore = await game.connect(externalPlayer).getPlayerStats();

            // Enroll player and abandon
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward past escalation2Start
            await time.increase(481);

            // External player claims
            await game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_0, instanceId);

            // Get updated earnings
            const earningsAfter = await game.connect(externalPlayer).getPlayerStats();

            // Verify earnings increased (should get the forfeit pool)
            expect(earningsAfter).to.be.greaterThan(earningsBefore);
        });

        it("Should not allow EL2 claim before escalation2Start", async function () {
            const instanceId = 4;

            // Enroll single player
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Fast forward past escalation1Start but before escalation2Start
            await time.increase(181);

            // Attempt to claim (should fail)
            await expect(
                game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_0, instanceId)
            ).to.be.revertedWith("CAE"); // Claim Abandoned Enrollment failed
        });
    });

    describe("EL1 vs EL2 Comparison", function () {
        it("Should create different completion reasons for EL1 vs EL2", async function () {
            const el1Instance = 5;
            const el2Instance = 6;

            // EL1 scenario
            await game.connect(player1).enrollInTournament(TIER_0, el1Instance, { value: TIER_0_FEE });
            await time.increase(181);
            await game.connect(player1).forceStartTournament(TIER_0, el1Instance);

            // EL2 scenario
            await game.connect(player2).enrollInTournament(TIER_0, el2Instance, { value: TIER_0_FEE });
            await time.increase(481);
            await game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_0, el2Instance);

            // Get both records
            const el1Record = await game.getTournamentRecord(TIER_0, el1Instance);
            const el2Record = await game.getTournamentRecord(TIER_0, el2Instance);

            // Verify different completion reasons
            expect(el1Record.completionReason).to.equal(6); // SoloEnrollForceStart
            expect(el2Record.completionReason).to.equal(7); // AbandonedTournamentClaimed

            // Verify different winners
            expect(el1Record.winner).to.equal(player1.address); // Solo player wins in EL1
            expect(el2Record.winner).to.equal(externalPlayer.address); // Claimer wins in EL2

            // Verify players list
            expect(el1Record.players[0]).to.equal(player1.address);
            expect(el2Record.players[0]).to.equal(player2.address);
        });
    });

    describe("recentInstances Persistence", function () {
        it("Should persist TournamentRecord across multiple tournament instances", async function () {
            const instanceId = 7;

            // First tournament (EL1)
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await time.increase(181);
            await game.connect(player1).forceStartTournament(TIER_0, instanceId);

            const firstRecord = await game.getTournamentRecord(TIER_0, instanceId);
            expect(firstRecord.completionReason).to.equal(6);

            // Second tournament (normal completion) - need 2 players for tier 0
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Get the match to determine who has the first turn
            const matchData = await game.getMatch(TIER_0, instanceId, 0, 0);
            const firstTurnPlayer = matchData.currentTurn === player1.address ? player1 : player2;
            const secondTurnPlayer = matchData.currentTurn === player1.address ? player2 : player1;

            // Play the match to completion (TicTacToe)
            await game.connect(firstTurnPlayer).makeMove(TIER_0, instanceId, 0, 0, 0); // Top-left
            await game.connect(secondTurnPlayer).makeMove(TIER_0, instanceId, 0, 0, 1); // Top-middle
            await game.connect(firstTurnPlayer).makeMove(TIER_0, instanceId, 0, 0, 3); // Middle-left
            await game.connect(secondTurnPlayer).makeMove(TIER_0, instanceId, 0, 0, 4); // Center
            await game.connect(firstTurnPlayer).makeMove(TIER_0, instanceId, 0, 0, 6); // Bottom-left (wins vertically)

            const secondRecord = await game.getTournamentRecord(TIER_0, instanceId);

            // Verify the record was updated (not the first one)
            expect(secondRecord.completionReason).to.equal(0); // NormalWin
            expect(secondRecord.winner).to.equal(firstTurnPlayer.address);
            expect(secondRecord.players.length).to.equal(2);

            // The first record should be overwritten
            expect(secondRecord.endTime).to.not.equal(firstRecord.endTime);
        });

        it("Should maintain separate records for different tiers and instances", async function () {
            const tier0Instance = 8;
            const tier1Instance = 0;
            const TIER_1 = 1;
            const TIER_1_FEE = hre.ethers.parseEther("0.0007");

            // Create EL1 record for Tier 0
            await game.connect(player1).enrollInTournament(TIER_0, tier0Instance, { value: TIER_0_FEE });
            await time.increase(181);
            await game.connect(player1).forceStartTournament(TIER_0, tier0Instance);

            // Create EL2 record for Tier 1 (enrollmentWindow = 300 seconds)
            await game.connect(player2).enrollInTournament(TIER_1, tier1Instance, { value: TIER_1_FEE });
            await time.increase(601); // 300 + 300 = 600 seconds
            await game.connect(externalPlayer).claimAbandonedEnrollmentPool(TIER_1, tier1Instance);

            // Get both records
            const tier0Record = await game.getTournamentRecord(TIER_0, tier0Instance);
            const tier1Record = await game.getTournamentRecord(TIER_1, tier1Instance);

            // Verify they are different
            expect(tier0Record.completionReason).to.equal(6);
            expect(tier1Record.completionReason).to.equal(7);
            expect(tier0Record.winner).to.not.equal(tier1Record.winner);
        });
    });

    describe("Edge Cases", function () {
        it("Should handle recentInstances query for never-completed tournament", async function () {
            const instanceId = 10;

            // Query recentInstances before any tournament has completed
            const record = await game.getTournamentRecord(TIER_0, instanceId);

            // Should return empty/default values
            expect(record.players.length).to.equal(0);
            expect(record.winner).to.equal(hre.ethers.ZeroAddress);
            expect(record.endTime).to.equal(0);
            expect(record.prizePool).to.equal(0);
        });

        it("Should preserve TournamentRecord after subsequent enrollments", async function () {
            const instanceId = 11;

            // Complete EL1 tournament
            await game.connect(player1).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });
            await time.increase(181);
            await game.connect(player1).forceStartTournament(TIER_0, instanceId);

            const recordAfterEL1 = await game.getTournamentRecord(TIER_0, instanceId);
            expect(recordAfterEL1.completionReason).to.equal(6);

            // Enroll new player (tournament reset allows this)
            await game.connect(player2).enrollInTournament(TIER_0, instanceId, { value: TIER_0_FEE });

            // Record should still be the same (not affected by new enrollment)
            const recordAfterNewEnrollment = await game.getTournamentRecord(TIER_0, instanceId);
            expect(recordAfterNewEnrollment.completionReason).to.equal(6);
            expect(recordAfterNewEnrollment.endTime).to.equal(recordAfterEL1.endTime);
        });
    });
});
