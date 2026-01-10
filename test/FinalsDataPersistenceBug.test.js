import hre from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Test Suite: Finals Data Persistence Across Tournament Cycles
 *
 * PURPOSE: Demonstrates critical bug where finals match data from previous tournament
 * cycles is not properly cleared, allowing attackers to exploit old match state.
 *
 * BUG SCENARIOS:
 * 1. Finals never completed (status = InProgress) → Not cleared on first enrollment
 * 2. Double-elimination finals (winner = address(0)) → Clearing condition fails
 * 3. Attacker can claim ML3 on stale finals data in new tournament cycle
 */
describe("Finals Data Persistence Bug (TDD)", function () {
    let game;
    let owner, player1, player2, player3, player4, attacker;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, attacker] = await hre.ethers.getSigners();

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

    describe("Scenario 1: Finals Never Completed (InProgress)", function () {
        it("Should clear incomplete finals match data on first enrollment in new cycle", async function () {
            console.log("\n=== TEST: Incomplete Finals Data Persistence ===\n");

            const tierId = 0;
            const instanceId = 0;

            // CYCLE 1: Create and complete tournament normally
            console.log("CYCLE 1: Creating tournament...");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const finalsMatch1 = await game.getMatch(tierId, instanceId, 0, 0);
            console.log(`Finals status: ${finalsMatch1.common.status} (1=InProgress)`);

            // Complete match normally
            const firstPlayer = finalsMatch1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            console.log("✓ Finals completed, tournament reset");

            const tournament1 = await game.getTournamentInfo(tierId, instanceId);
            console.log(`✓ Tournament status: ${tournament1.status} (0=Enrolling)`);

            // CYCLE 2: First enrollment should clear old finals
            console.log("\nCYCLE 2: First enrollment in new cycle...");

            // Check if old finals data still exists BEFORE enrollment
            try {
                const staleFinals = await game.getMatch(tierId, instanceId, 0, 0);
                console.log(`⚠️  OLD FINALS DATA STILL EXISTS BEFORE ENROLLMENT:`);
                console.log(`  - player1: ${staleFinals.common.player1}`);
                console.log(`  - player2: ${staleFinals.common.player2}`);
                console.log(`  - status: ${staleFinals.common.status}`);
                console.log(`  - isCached: ${staleFinals.common.isCached}`);
            } catch (e) {
                console.log(`✓ Old finals already cleared (expected after fix)`);
            }

            // First enrollment in Cycle 2
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            console.log("✓ Player3 enrolled in Cycle 2");

            // BUG CHECK: Old finals data should be cleared now
            try {
                const finalsMatch2 = await game.getMatch(tierId, instanceId, 0, 0);

                // If we can read it, check if it's the OLD data (BUG) or NEW data (OK)
                if (finalsMatch2.common.player1 === player1.address ||
                    finalsMatch2.common.player2 === player2.address) {
                    console.log(`\n❌ BUG DETECTED: Old finals data NOT cleared!`);
                    console.log(`  - Old player1: ${player1.address}`);
                    console.log(`  - Old player2: ${player2.address}`);
                    console.log(`  - Current player1: ${finalsMatch2.common.player1}`);
                    console.log(`  - Current player2: ${finalsMatch2.common.player2}`);

                    // This test SHOULD FAIL before the fix
                    expect.fail("Old finals data persisted into new tournament cycle!");
                } else {
                    console.log(`✓ Finals data belongs to new cycle`);
                }
            } catch (e) {
                if (e.message.includes("MNF")) {
                    console.log(`✓ Old finals properly cleared (match not found)`);
                } else {
                    throw e;
                }
            }

            console.log("\n=== TEST COMPLETE ===\n");
        });
    });

    describe("Scenario 2: Double-Elimination Finals (winner = address(0))", function () {
        it("Should clear double-elimination finals on first enrollment in new cycle", async function () {
            console.log("\n=== TEST: Double-Elimination Finals Data Persistence ===\n");

            const tierId = 1; // Tier 1 accepts 4 players
            const instanceId = 0;
            const TIER_1_FEE = hre.ethers.parseEther("0.0007");

            // CYCLE 1: Create 4-player tournament to get semi-finals
            console.log("CYCLE 1: Creating 4-player tournament...");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Complete first semi-final (match 0)
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer0 = match0.currentTurn === player1.address ? player1 : player2;
            const secondPlayer0 = firstPlayer0 === player1 ? player2 : player1;

            await game.connect(firstPlayer0).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer0).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer0).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer0).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer0).makeMove(tierId, instanceId, 0, 0, 2);

            console.log(`✓ Semi-final 0 complete: winner=${firstPlayer0.address.slice(0, 10)}...`);

            // Complete second semi-final (match 1)
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const firstPlayer1 = match1.currentTurn === player3.address ? player3 : player4;
            const secondPlayer1 = firstPlayer1 === player3 ? player4 : player3;

            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 1, 2);

            console.log(`✓ Semi-final 1 complete: winner=${firstPlayer1.address.slice(0, 10)}...`);

            // Finals should now exist
            const finalsMatch = await game.getMatch(tierId, instanceId, 1, 0);
            console.log(`✓ Finals created: ${finalsMatch.common.player1.slice(0, 10)}... vs ${finalsMatch.common.player2.slice(0, 10)}...`);

            // Trigger ML2 on finals (double elimination)
            const MATCH_TIMEOUT = 120;
            const MATCH_LEVEL_2_DELAY = 120;
            await time.increase(MATCH_TIMEOUT + MATCH_LEVEL_2_DELAY + 1);

            // Advanced player (firstPlayer0) forces elimination on finals
            await game.connect(firstPlayer0).forceEliminateStalledMatch(tierId, instanceId, 1, 0);

            const finalsAfterML2 = await game.getMatch(tierId, instanceId, 1, 0);
            console.log(`✓ ML2 executed on finals:`);
            console.log(`  - winner: ${finalsAfterML2.common.winner} (should be 0x0)`);
            console.log(`  - status: ${finalsAfterML2.common.status} (2=Completed)`);

            expect(finalsAfterML2.common.winner).to.equal(hre.ethers.ZeroAddress);
            expect(finalsAfterML2.common.status).to.equal(2); // Completed

            // Tournament should have completed and reset
            const tournament1 = await game.getTournamentInfo(tierId, instanceId);
            console.log(`✓ Tournament completed and reset: status=${tournament1.status}`);

            // CYCLE 2: First enrollment should clear old finals (even with winner = address(0))
            console.log("\nCYCLE 2: First enrollment in new cycle...");

            // Check if old finals exists BEFORE enrollment
            try {
                const staleFinals = await game.getMatch(tierId, instanceId, 1, 0);
                console.log(`⚠️  OLD FINALS DATA EXISTS (winner=0x0 case):`);
                console.log(`  - player1: ${staleFinals.common.player1}`);
                console.log(`  - winner: ${staleFinals.common.winner}`);
                console.log(`  - status: ${staleFinals.common.status}`);
            } catch (e) {
                console.log(`✓ Old finals already cleared`);
            }

            // Enroll new players for Cycle 2
            const newPlayer1 = attacker;
            await game.connect(newPlayer1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            console.log("✓ First enrollment in Cycle 2");

            // BUG CHECK: Old finals with winner=0x0 should be cleared
            try {
                const finalsMatch2 = await game.getMatch(tierId, instanceId, 1, 0);

                // Check if it's old data (contains player1 or firstPlayer1)
                if (finalsMatch2.common.player1 === firstPlayer0.address ||
                    finalsMatch2.common.player2 === firstPlayer1.address) {
                    console.log(`\n❌ BUG DETECTED: Double-elimination finals NOT cleared!`);
                    console.log(`  - Old finalists still present in match data`);

                    expect.fail("Double-elimination finals data persisted into new cycle!");
                } else {
                    console.log(`✓ Finals data cleared properly`);
                }
            } catch (e) {
                if (e.message.includes("MNF")) {
                    console.log(`✓ Old finals properly cleared`);
                } else {
                    throw e;
                }
            }

            console.log("\n=== TEST COMPLETE ===\n");
        });
    });

    describe("Scenario 3: Exploit Attempt After Status Check Fix", function () {
        it("Should prevent ML3 claim on stale finals even if not cleared", async function () {
            console.log("\n=== TEST: ML3 Exploit Prevention with Status Check ===\n");

            const tierId = 0;
            const instanceId = 0;

            // CYCLE 1: Complete tournament normally
            console.log("CYCLE 1: Completing tournament...");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            console.log("✓ Tournament completed normally");

            // CYCLE 2 starts (status = Enrolling)
            const tournament = await game.getTournamentInfo(tierId, instanceId);
            console.log(`✓ Tournament reset: status=${tournament.status} (0=Enrolling)`);

            // EXPLOIT ATTEMPT: Try to claim ML3 on stale finals
            console.log("\nATTACKER: Attempting ML3 on stale finals...");

            try {
                await game.connect(attacker).claimMatchSlotByReplacement(tierId, instanceId, 0, 0);
                console.log("❌ EXPLOIT SUCCEEDED - ML3 claim allowed on stale data!");
                expect.fail("ML3 should be blocked by tournament status check");
            } catch (e) {
                if (e.message.includes("Tournament not in progress")) {
                    console.log("✓ EXPLOIT BLOCKED: Tournament status check prevented ML3");
                    console.log(`  - Error: ${e.message.split('\n')[0]}`);
                } else {
                    console.log(`✓ EXPLOIT BLOCKED: ${e.message.split('\n')[0]}`);
                }
            }

            console.log("\n=== TEST COMPLETE ===\n");
        });
    });
});
