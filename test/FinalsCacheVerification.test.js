import hre from "hardhat";
import { expect } from "chai";

/**
 * Test: Verify finals are properly cached after clearing
 *
 * This test verifies that:
 * 1. Run #1 finals data (A vs B) is preserved after tournament completion
 * 2. First enrollment in Run #2 caches the old finals
 * 3. Old finals are cleared from live storage
 * 4. Cached finals can still be queried via getMatch()
 */
describe("Finals Cache Verification", function () {
    let game;
    let player1, player2, player3, player4;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [player1, player2, player3, player4] = await hre.ethers.getSigners();

        // Deploy modules
        const ETour_Core = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
        const moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        const GameCacheModule = await hre.ethers.getContractFactory("contracts/modules/GameCacheModule.sol:GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();
        await moduleGameCache.waitForDeployment();

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

    it("Should cache finals (A vs B) and retrieve from cache after clearing", async function () {
        console.log("\n=== FINALS CACHE VERIFICATION TEST ===\n");

        const tierId = 0;
        const instanceId = 0;

        // RUN #1: Complete a tournament with finals A vs B
        console.log("RUN #1: Creating and completing tournament...");

        await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
        await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

        const finalsMatch = await game.getMatch(tierId, instanceId, 0, 0);
        const playerA = finalsMatch.currentTurn === player1.address ? player1 : player2;
        const playerB = playerA === player1 ? player2 : player1;

        console.log(`Finals: ${playerA.address.slice(0, 10)} vs ${playerB.address.slice(0, 10)}`);

        // Complete finals
        await game.connect(playerA).makeMove(tierId, instanceId, 0, 0, 0);
        await game.connect(playerB).makeMove(tierId, instanceId, 0, 0, 3);
        await game.connect(playerA).makeMove(tierId, instanceId, 0, 0, 1);
        await game.connect(playerB).makeMove(tierId, instanceId, 0, 0, 4);
        await game.connect(playerA).makeMove(tierId, instanceId, 0, 0, 2);

        const finalsCompleted = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`✓ Finals completed: winner=${finalsCompleted.common.winner.slice(0, 10)}`);
        console.log(`✓ Status: ${finalsCompleted.common.status} (2=Completed)`);
        console.log(`✓ isCached: ${finalsCompleted.common.isCached}`);

        // Store original finals data for comparison
        const originalPlayer1 = finalsCompleted.common.player1;
        const originalPlayer2 = finalsCompleted.common.player2;
        const originalWinner = finalsCompleted.common.winner;
        const originalStatus = finalsCompleted.common.status;

        // Tournament should reset
        const tournament1 = await game.getTournamentInfo(tierId, instanceId);
        console.log(`✓ Tournament reset: status=${tournament1.status} (0=Enrolling)\n`);

        // WINDOW: Finals still visible in live storage
        console.log("WINDOW: Finals data before Run #2 enrollment:");
        const beforeEnrollment = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`  - player1: ${beforeEnrollment.common.player1.slice(0, 10)}`);
        console.log(`  - player2: ${beforeEnrollment.common.player2.slice(0, 10)}`);
        console.log(`  - winner: ${beforeEnrollment.common.winner.slice(0, 10)}`);
        console.log(`  - isCached: ${beforeEnrollment.common.isCached} (should be false - live storage)`);

        // RUN #2: First enrollment should cache then clear old finals
        console.log("\nRUN #2: First enrollment (should trigger cache + clear)...");
        await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
        console.log("✓ Player3 enrolled");

        // CRITICAL TEST: Can we still retrieve cached finals?
        console.log("\nQuerying old finals after clearing...");
        try {
            const cachedFinals = await game.getMatch(tierId, instanceId, 0, 0);

            console.log(`✓ CACHED FINALS RETRIEVED:`);
            console.log(`  - player1: ${cachedFinals.common.player1.slice(0, 10)} (expected: ${originalPlayer1.slice(0, 10)})`);
            console.log(`  - player2: ${cachedFinals.common.player2.slice(0, 10)} (expected: ${originalPlayer2.slice(0, 10)})`);
            console.log(`  - winner: ${cachedFinals.common.winner.slice(0, 10)} (expected: ${originalWinner.slice(0, 10)})`);
            console.log(`  - status: ${cachedFinals.common.status} (expected: ${originalStatus})`);
            console.log(`  - isCached: ${cachedFinals.common.isCached} (should be true)`);

            // Verify cached data matches original
            expect(cachedFinals.common.player1).to.equal(originalPlayer1, "Player1 should match");
            expect(cachedFinals.common.player2).to.equal(originalPlayer2, "Player2 should match");
            expect(cachedFinals.common.winner).to.equal(originalWinner, "Winner should match");
            expect(cachedFinals.common.status).to.equal(originalStatus, "Status should match");
            expect(cachedFinals.common.isCached).to.equal(true, "Should be marked as cached");

            console.log("\n✅ SUCCESS: Finals properly cached and retrievable!");

        } catch (e) {
            if (e.message.includes("MNF")) {
                console.log(`\n❌ CACHE FAILURE: Match not found!`);
                console.log(`   - Old finals were cleared but NOT cached`);
                console.log(`   - Historical data lost!`);
                expect.fail("Cache not working - finals data lost after clearing");
            } else {
                throw e;
            }
        }

        console.log("\n=== TEST COMPLETE ===\n");
    });
});
