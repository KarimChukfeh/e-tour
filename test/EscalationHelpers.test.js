import { expect } from "chai";
import hre from "hardhat";

describe("Escalation Helper Functions Tests", function() {
    let game;
    let players = [];
    let outsiders = [];

    const TIER_ID = 1; // 4-player tier
    const INSTANCE_ID = 0;
    const TIER_FEE = hre.ethers.parseEther("0.004");

    // Timeout values - will be read from contract
    let MATCH_TIME;
    let L2_DELAY;
    let L3_DELAY;

    // Helper to complete a match
    async function completeMatch(tierId, instanceId, roundNumber, matchNumber) {
        const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        let currentMatch = match;
        for (let i = 0; i < 7; i++) {
            await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, i % 2);
            currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            if (currentMatch.common.status === 2) break;
        }
    }

    // Helper to stall a match
    async function stallMatch(tierId, instanceId, roundNumber, matchNumber) {
        const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
    }

    beforeEach(async function() {
        const signers = await hre.ethers.getSigners();
        players = signers.slice(1, 5); // 4 players
        outsiders = signers.slice(5, 8); // 3 outsiders

        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy();
        await game.waitForDeployment();

        // Read actual timeout configuration from contract
        const tierConfig = await game.tierConfigs(TIER_ID);
        MATCH_TIME = Number(tierConfig.timeouts.matchTimePerPlayer);
        L2_DELAY = Number(tierConfig.timeouts.matchLevel2Delay);
        L3_DELAY = Number(tierConfig.timeouts.matchLevel3Delay);
    });

    describe("isMatchEscL1Available() - Opponent Timeout Claim", function() {

        it("Should return false for match that hasn't timed out", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Make one move to ensure match is properly initialized
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
            await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(TIER_ID, INSTANCE_ID, 0, 0, 0);

            // Check L1 availability immediately after move - should be false (no timeout yet)
            const l1Available = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l1Available).to.equal(false);
        });

        it("Should return true after player times out", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Make one move then wait for timeout
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait for timeout
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + 1]);
            await hre.network.provider.send("evm_mine");

            // Check L1 availability - should be true
            const l1Available = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l1Available).to.equal(true);
        });

        it("Should return false for completed match", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Complete the match
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Check L1 availability - should be false (match completed)
            const l1Available = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l1Available).to.equal(false);
        });
    });

    describe("isMatchEscL2Available() - Advanced Player Force Eliminate", function() {

        it("Should return false before timeout", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Check L2 availability - should be false
            const l2Available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l2Available).to.equal(false);
        });

        it("Should return false immediately after timeout (before L2 delay)", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait for timeout only (not L2 delay)
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + 1]);
            await hre.network.provider.send("evm_mine");

            // Check L2 availability - should be false (L2 delay not reached)
            const l2Available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l2Available).to.equal(false);
        });

        it("Should return true after L2 delay", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait for timeout + L2 delay
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Check L2 availability - should be true
            const l2Available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l2Available).to.equal(true);
        });

        it("Should remain true after L3 becomes active (L2 never expires)", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait way past L3 activation
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + 300]);
            await hre.network.provider.send("evm_mine");

            // Check L2 availability - should still be true
            const l2Available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l2Available).to.equal(true);
        });
    });

    describe("isMatchEscL3Available() - External Player Replacement", function() {

        it("Should return false before L3 delay", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait for timeout + L2 delay (but not L3 delay)
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Check L3 availability - should be false
            const l3Available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l3Available).to.equal(false);
        });

        it("Should return true after L3 delay", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Wait for timeout + L3 delay
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Check L3 availability - should be true
            const l3Available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(l3Available).to.equal(true);
        });
    });

    describe("isPlayerInAdvancedRound() - Check Player Status", function() {

        it("Should return false for players not enrolled", async function() {
            // Don't enroll anyone
            const isAdvanced = await game.isPlayerInAdvancedRound(outsiders[0].address, TIER_ID, INSTANCE_ID, 0);
            expect(isAdvanced).to.equal(false);
        });

        it("Should return false for players enrolled but not yet advanced", async function() {
            // Enroll players
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Check all enrolled players - none should be advanced yet
            for (const player of players) {
                const isAdvanced = await game.isPlayerInAdvancedRound(player.address, TIER_ID, INSTANCE_ID, 0);
                expect(isAdvanced).to.equal(false);
            }
        });

        it("Should return true for player who won a match", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Complete match 0
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const match0 = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const winner = match0.common.winner;
            const loser = match0.common.player1 === winner ? match0.common.player2 : match0.common.player1;

            // Winner should be advanced, loser should not
            const winnerIsAdvanced = await game.isPlayerInAdvancedRound(winner, TIER_ID, INSTANCE_ID, 0);
            const loserIsAdvanced = await game.isPlayerInAdvancedRound(loser, TIER_ID, INSTANCE_ID, 0);

            expect(winnerIsAdvanced).to.equal(true);
            expect(loserIsAdvanced).to.equal(false);
        });

        it("Should return false for outsider even if L3 is active", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match and wait for L3
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Outsider should NOT be advanced
            const isAdvanced = await game.isPlayerInAdvancedRound(outsiders[0].address, TIER_ID, INSTANCE_ID, 0);
            expect(isAdvanced).to.equal(false);
        });
    });

    describe("Misuse Prevention Tests", function() {

        it("Should prevent using helpers on non-existent matches", async function() {
            // Don't enroll anyone - no tournament

            // All helpers should return false for non-existent match
            const l1 = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);

            expect(l1).to.equal(false);
            expect(l2).to.equal(false);
            expect(l3).to.equal(false);
        });

        it("Should consistently return same result when called multiple times", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match and wait for L3
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Call helpers multiple times
            const l1_call1 = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l1_call2 = await game.isMatchEscL1Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l2_call1 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l2_call2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l3_call1 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
            const l3_call2 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);

            // Should be consistent
            expect(l1_call1).to.equal(l1_call2);
            expect(l2_call1).to.equal(l2_call2);
            expect(l3_call1).to.equal(l3_call2);
        });

        it("Should work correctly across multiple matches in same tournament", async function() {
            // Enroll and start tournament
            for (const player of players) {
                await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Stall match 0
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 0);

            // Complete match 1
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 1);

            // Wait for L2
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Match 0: Should show L2 available
            const match0L2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
            expect(match0L2).to.equal(true);

            // Match 1: Should show L2 NOT available (completed)
            const match1L2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 1);
            expect(match1L2).to.equal(false);
        });
    });
});
