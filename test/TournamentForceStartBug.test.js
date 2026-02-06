import hre from "hardhat";
import { expect } from "chai";

describe("BUG: Force Start Tournament with Insufficient Players", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;
    const TIER_0_FEE = hre.ethers.parseEther("0.001"); // 2-player tier
    const TIER_1_FEE = hre.ethers.parseEther("0.002"); // 4-player tier
    const TIER_2_FEE = hre.ethers.parseEther("0.004"); // 8-player tier

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        // Deploy all ETour modules
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

        // Deploy ConnectFourOnChain with module addresses
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();
    });

    describe("Critical Bug: 8-player tournament force started with 2 players never completes", function () {
        it("Should complete and reset tournament after single match in force-started 2-player 8-player-tier tournament", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 0;

            console.log("\n=== BUG REPRODUCTION: 8-player tier force started with 2 players ===");

            // Enroll only 2 players in an 8-player tier
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Verify enrollment
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling
            expect(tournament.enrolledCount).to.equal(2);
            console.log("✓ 2 players enrolled in 8-player tier");

            // Fast forward past enrollment window for tier 2 (900 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [901]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with EL1
            await game.connect(player1).forceStartTournament(tierId, instanceId);
            console.log("✓ Tournament force-started (EL1)");

            // Verify tournament started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(2);

            // Check round 0 - should have 1 match
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(1); // Only 1 match needed for 2 players
            console.log(`✓ Round 0 initialized with ${round0.totalMatches} match(es)`);

            // Get the match details
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            console.log(`Match 0-0: ${match.common.player1.slice(0, 6)} vs ${match.common.player2.slice(0, 6)}`);
            console.log(`Match status: ${match.common.status} (0=Active, 1=Pending, 2=Completed)`);
            expect(match.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.player2).to.not.equal(hre.ethers.ZeroAddress);

            // Determine who goes first
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Play the match to completion - quick win pattern
            console.log("\n=== Playing the single match ===");
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            console.log(`${firstPlayer.address.slice(0, 6)} plays column 0`);

            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            console.log(`${secondPlayer.address.slice(0, 6)} plays column 1`);

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            console.log(`${firstPlayer.address.slice(0, 6)} plays column 0`);

            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            console.log(`${secondPlayer.address.slice(0, 6)} plays column 1`);

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            console.log(`${firstPlayer.address.slice(0, 6)} plays column 0`);

            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            console.log(`${secondPlayer.address.slice(0, 6)} plays column 1`);

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            console.log(`${firstPlayer.address.slice(0, 6)} plays column 0 - WINS!`);

            // Verify match is completed
            const completedMatch = await game.getMatch(tierId, instanceId, 0, 0);
            expect(completedMatch.common.status).to.equal(2); // Completed
            expect(completedMatch.common.winner).to.equal(firstPlayer.address);
            console.log(`✓ Match completed, winner: ${firstPlayer.address.slice(0, 6)}`);

            // *** THIS IS THE BUG ***
            // Tournament should now be completed and reset, but it stays InProgress
            tournament = await game.tournaments(tierId, instanceId);

            console.log("\n=== CHECKING FOR BUG ===");
            console.log(`Tournament status: ${tournament.status} (0=Enrolling, 1=InProgress, 2=Completed)`);
            console.log(`Enrolled count: ${tournament.enrolledCount}`);
            console.log(`Prize pool: ${hre.ethers.formatEther(tournament.prizePool)} ETH`);
            console.log(`Winner: ${tournament.winner}`);

            // Check round status
            const round0Status = await game.rounds(tierId, instanceId, 0);
            console.log(`\nRound 0: initialized=${round0Status.initialized}, totalMatches=${round0Status.totalMatches}, completedMatches=${round0Status.completedMatches}`);

            // Check if there's a round 1
            const round1Status = await game.rounds(tierId, instanceId, 1);
            console.log(`Round 1: initialized=${round1Status.initialized}, totalMatches=${round1Status.totalMatches}, completedMatches=${round1Status.completedMatches}`);

            // EXPECTED BEHAVIOR: Tournament should auto-reset after completion
            expect(tournament.status).to.equal(0);
                // "BUG: Tournament status should be 0 (Enrolling) after match completion, but it's still InProgress!"
            expect(tournament.enrolledCount).to.equal(0);
                // "BUG: Enrolled count should be 0 after reset!"
            expect(tournament.prizePool).to.equal(0);
                // "BUG: Prize pool should be 0 after distribution and reset!"
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress);
                // "BUG: Winner should be cleared on reset!"

            // Verify round data cleared
            const round0After = await game.rounds(tierId, instanceId, 0);
            expect(round0After.initialized).to.be.false;
                // "BUG: Round 0 should be cleared after tournament reset!"
            expect(round0After.totalMatches).to.equal(0);
            expect(round0After.completedMatches).to.equal(0);

            // Verify enrollment status cleared for players
            const player1Enrolled = await game.isEnrolled(tierId, instanceId, player1.address);
            const player2Enrolled = await game.isEnrolled(tierId, instanceId, player2.address);
            expect(player1Enrolled).to.be.false;
                // "BUG: Player 1 enrollment should be cleared!"
            expect(player2Enrolled).to.be.false;
                // "BUG: Player 2 enrollment should be cleared!"

            console.log("\n✓ Tournament properly completed and reset!");
            console.log("✓ All state cleared - ready for new tournament");

            // Verify we can enroll new players
            await expect(
                game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE })
            ).to.not.be.reverted;

            await expect(
                game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE })
            ).to.not.be.reverted;

            const newTournament = await game.tournaments(tierId, instanceId);
            expect(newTournament.status).to.equal(1); // InProgress (auto-start with 2 players)
            expect(newTournament.enrolledCount).to.equal(2);
            console.log("✓ New tournament started successfully with new players");
        });

        it("Should handle 4-player tier force started with 2 players (sanity check)", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            console.log("\n=== SANITY CHECK: 4-player tier force started with 2 players ===");

            // Enroll 2 players in a 4-player tier
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past enrollment window for tier 1 (600 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start
            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Play the single match
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Quick win pattern for TicTacToe
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Check if this has the same bug
            const tournament = await game.tournaments(tierId, instanceId);
            console.log(`4-player tier status: ${tournament.status}`);
            console.log(`4-player tier enrolled count: ${tournament.enrolledCount}`);

            // This MIGHT work if the bug is specific to 8-player tier
            expect(tournament.status).to.equal(0);
                // "4-player tier should complete and reset"
            expect(tournament.enrolledCount).to.equal(0);

            console.log("✓ 4-player tier works correctly");
        });
    });
});
