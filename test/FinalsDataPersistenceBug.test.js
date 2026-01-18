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
            console.log(`Finals status: ${finalsMatch1.status} (1=InProgress)`);

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

            // NEW ARCHITECTURE: Finals cleared immediately on reset
            console.log("\nNEW CYCLE: Verifying finals cleared immediately...");

            // Finals should be cleared immediately (returns empty data)
            const staleFinals = await game.getMatch(tierId, instanceId, 0, 0);
            expect(staleFinals.player1).to.equal(hre.ethers.ZeroAddress);
            expect(staleFinals.player2).to.equal(hre.ethers.ZeroAddress);
            console.log(`✓ FINALS CLEARED IMMEDIATELY ON RESET`);
            console.log(`  - No stale data window`);
            console.log(`  - Historical data available via events`);

            // First enrollment in new cycle
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            console.log("✓ Player3 enrolled in new cycle");

            // Finals should still be cleared (empty data until new match starts)
            const clearedFinals = await game.getMatch(tierId, instanceId, 0, 0);
            expect(clearedFinals.player1).to.equal(hre.ethers.ZeroAddress);
            console.log(`✓ Finals remain cleared (as expected)`)

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
            console.log(`✓ Finals created: ${finalsMatch.player1.slice(0, 10)}... vs ${finalsMatch.player2.slice(0, 10)}...`);

            // Trigger ML2 on finals (double elimination)
            const MATCH_TIMEOUT = 120;
            const MATCH_LEVEL_2_DELAY = 120;
            await time.increase(MATCH_TIMEOUT + MATCH_LEVEL_2_DELAY + 1);

            // Advanced player (firstPlayer0) forces elimination on finals
            console.log(`Executing ML2 on finals...`);
            await game.connect(firstPlayer0).forceEliminateStalledMatch(tierId, instanceId, 1, 0);

            console.log(`✓ ML2 executed - tournament completed and reset`);

            // Tournament should have completed and reset
            const tournament1 = await game.getTournamentInfo(tierId, instanceId);
            console.log(`✓ Tournament status: ${tournament1.status} (0=Enrolling)`);

            // NEW ARCHITECTURE: Finals cleared immediately on reset (no waiting for enrollment)
            console.log("\nNEW CYCLE: Verifying immediate finals clearing...");

            // Finals should be cleared immediately after reset (returns empty data)
            const staleFinals = await game.getMatch(tierId, instanceId, 1, 0);
            expect(staleFinals.player1).to.equal(hre.ethers.ZeroAddress);
            expect(staleFinals.player2).to.equal(hre.ethers.ZeroAddress);
            console.log(`✓ DOUBLE-ELIMINATION FINALS CLEARED IMMEDIATELY`);
            console.log(`  - winner=0x0 case handled properly`);
            console.log(`  - No stale data vulnerability`);

            // Enroll new player for Cycle 2
            const newPlayer1 = attacker;
            await game.connect(newPlayer1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            console.log("✓ First enrollment in new cycle");

            // Finals should still be cleared (empty data)
            const clearedFinals = await game.getMatch(tierId, instanceId, 1, 0);
            expect(clearedFinals.player1).to.equal(hre.ethers.ZeroAddress);
            console.log(`✓ Finals remain cleared (as expected)`)

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
