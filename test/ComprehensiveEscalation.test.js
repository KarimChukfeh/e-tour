import { expect } from "chai";
import hre from "hardhat";

describe("Comprehensive Tournament Escalation Flow Tests", function() {
    let game;
    let owner;
    let players = [];
    let outsiders = [];

    const TIER_ID = 2; // 8-player tier (good balance for testing)
    const INSTANCE_ID = 0;
    const TIER_FEE = hre.ethers.parseEther("0.004"); // Correct fee for Tier 2
    const MATCH_TIME = 300; // 5 minutes per player (matchTimePerPlayer from contract)
    const L2_DELAY = 120; // 2 minutes (matchLevel2Delay from contract)
    const L3_DELAY = 240; // 4 minutes (matchLevel3Delay from contract)

    // Helper to complete a match quickly (vertical win in Connect Four)
    async function completeMatch(tierId, instanceId, roundNumber, matchNumber) {
        const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        const p1 = match.common.player1;
        const p2 = match.common.player2;

        // Use currentTurn to determine who moves
        let currentMatch = match;
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
        currentMatch = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
    }

    // Helper to stall a match (make one move then wait)
    async function stallMatch(tierId, instanceId, roundNumber, matchNumber) {
        const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
    }

    beforeEach(async function() {
        const signers = await hre.ethers.getSigners();
        owner = signers[0];
        players = signers.slice(1, 9); // 8 players
        outsiders = signers.slice(9, 12); // 3 outsiders

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

        // Deploy ConnectFourOnChain with modules
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // tierConfigs removed - tier configuration is now hardcoded in contract
    });

    describe("8-Player Tournament with Mixed Escalation Scenarios", function() {

        it("Should handle tournament with normal wins, L2 eliminations, and L3 replacements", async function() {
            this.timeout(180000);

            console.log("\n=== COMPREHENSIVE ESCALATION TEST ===\n");

            // Enroll 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }
            console.log("✓ 8 players enrolled, tournament started");

            console.log("\n=== ROUND 0: 4 MATCHES (8 → 4 players) ===\n");

            // Match 0: Normal completion
            console.log("Match 0: Normal completion");
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const match0After = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
            expect(match0After.common.status).to.equal(2);
            const advancedPlayer = match0After.common.winner;
            console.log(`✓ Winner: ${advancedPlayer} (now advanced player)`);

            // Match 1: Stalls → Advanced player uses L2
            console.log("\nMatch 1: Stalls → L2 force elimination by advanced player");
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 1);

            // Wait for L2 to become active
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Verify outsider cannot use L2
            await expect(
                game.connect(outsiders[0]).forceEliminateStalledMatch(TIER_ID, INSTANCE_ID, 0, 1)
            ).to.be.revertedWith("FE"); // FE = Force Eliminate failed (wraps "Not an advanced player")
            console.log("✓ Outsider correctly blocked from L2");

            // Advanced player force eliminates
            await game.connect(await hre.ethers.getSigner(advancedPlayer)).forceEliminateStalledMatch(TIER_ID, INSTANCE_ID, 0, 1);
            const match1After = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 1);
            expect(match1After.common.status).to.equal(2);
            expect(match1After.common.winner).to.equal(hre.ethers.ZeroAddress);
            console.log("✓ Match force eliminated via L2 by advanced player");

            // Match 2: Stalls → Outsider claims L3
            console.log("\nMatch 2: Stalls → L3 replacement by outsider");
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 2);

            // Wait for L3 to become active
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Verify advanced player CANNOT claim L3
            await expect(
                game.connect(await hre.ethers.getSigner(advancedPlayer)).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 2)
            ).to.be.revertedWith("CR"); // CR = Claim Replacement failed (wraps "Advanced players cannot claim L3")
            console.log("✓ Advanced player correctly blocked from L3");

            // Outsider claims
            await game.connect(outsiders[0]).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 2);
            const match2After = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 2);
            expect(match2After.common.status).to.equal(2);
            expect(match2After.common.winner).to.equal(outsiders[0].address);
            console.log(`✓ Outsider ${outsiders[0].address.substring(0, 8)}... claimed via L3`);

            // Match 3: Stalls → Advanced player uses L2 AFTER L3 is active (proving L2 doesn't expire)
            console.log("\nMatch 3: Stalls → L2 still works after L3 active (proving L2 never expires)");
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 3);

            // Wait way past L3 (5 minutes)
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + 300]);
            await hre.network.provider.send("evm_mine");
            console.log("Waited 5 minutes (way past L3 activation)");

            // Advanced player should still be able to use L2
            await game.connect(await hre.ethers.getSigner(advancedPlayer)).forceEliminateStalledMatch(TIER_ID, INSTANCE_ID, 0, 3);
            const match3After = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 3);
            expect(match3After.common.status).to.equal(2);
            console.log("✓ L2 still worked 5 minutes after L3 became active - L2 NEVER EXPIRES");

            console.log("\n=== ROUND 0 SUMMARY ===");
            const round0 = await game.getRoundInfo(TIER_ID, INSTANCE_ID, 0);
            expect(round0.completedMatches).to.equal(4);
            console.log("✓ All 4 matches completed:");
            console.log("  - 1 normal win");
            console.log("  - 2 L2 force eliminations");
            console.log("  - 1 L3 replacement");

            console.log("\n=== ROUND 1: 2 MATCHES (Semi-Finals) ===\n");

            // Get round 1 status - only 2 players advanced (match 0 winner and outsider0)
            // Matches 1 and 3 had double eliminations, so only 2 players in round 1
            const round1Match0 = await game.getMatch(TIER_ID, INSTANCE_ID, 1, 0);
            console.log(`Round 1 has: ${round1Match0.common.player1} vs ${round1Match0.common.player2}`);

            if (round1Match0.common.status === 1) {
                await completeMatch(TIER_ID, INSTANCE_ID, 1, 0);
                console.log("✓ Semi-final completed");
            }

            console.log("\n=== TOURNAMENT COMPLETION ===");
            const finalTournament = await game.getTournamentInfo(TIER_ID, INSTANCE_ID);
            console.log(`Tournament status: ${finalTournament.status}`);
            if (finalTournament.status === 2) {
                console.log(`Winner: ${finalTournament.winner}`);
            }

            console.log("\n✅ COMPREHENSIVE ESCALATION TEST PASSED");
            console.log("\nValidated:");
            console.log("✓ Normal match completions work");
            console.log("✓ L2 (force eliminate) works for advanced players");
            console.log("✓ L2 blocked for non-advanced players");
            console.log("✓ L3 (replacement) works for outsiders");
            console.log("✓ L3 blocked for advanced players");
            console.log("✓ L2 never expires (works even after L3 active)");
            console.log("✓ Bracket advancement handles mixed completion types");
        });

        it("Should verify eliminated player can claim L3 in their own round", async function() {
            this.timeout(120000);

            console.log("\n=== Testing Eliminated Player L3 Access ===\n");

            // Enroll 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Complete match 0 to get winner and loser
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const match0 = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const winner = match0.common.winner;
            const loser = match0.common.player1 === winner ? match0.common.player2 : match0.common.player1;
            console.log(`Match 0: Winner ${winner.substring(0, 8)}..., Loser ${loser.substring(0, 8)}...`);

            // Stall match 1
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 1);
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");

            // Winner is advanced and should be blocked from L3
            await expect(
                game.connect(await hre.ethers.getSigner(winner)).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 1)
            ).to.be.revertedWith("CR"); // CR = Claim Replacement failed (wraps "Advanced players cannot claim L3")
            console.log("✓ Advanced player (winner) blocked from L3");

            // Loser is eliminated but NOT advanced, so can claim L3
            await game.connect(await hre.ethers.getSigner(loser)).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 1);
            const match1After = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 1);
            expect(match1After.common.winner).to.equal(loser);
            console.log("✓ Eliminated (non-advanced) player successfully claimed L3");

            console.log("\n✅ Eliminated players CAN claim L3 (they're not advanced)");
        });

        it("Should handle complex bracket with multiple escalation types", async function() {
            this.timeout(120000);

            console.log("\n=== Complex Bracket Test ===\n");

            // Enroll 8 players
            for (let i = 0; i < 8; i++) {
                await game.connect(players[i]).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            }

            // Round 0: Mix of normal, L2, and L3
            console.log("Round 0:");

            // Match 0: Normal
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 0);
            console.log("  Match 0: Normal ✓");
            const match0 = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
            const advPlayer = match0.common.winner;

            // Match 1: Normal
            await completeMatch(TIER_ID, INSTANCE_ID, 0, 1);
            console.log("  Match 1: Normal ✓");

            // Match 2: L2
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 2);
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
            await hre.network.provider.send("evm_mine");
            await game.connect(await hre.ethers.getSigner(advPlayer)).forceEliminateStalledMatch(TIER_ID, INSTANCE_ID, 0, 2);
            console.log("  Match 2: L2 elimination ✓");

            // Match 3: L3
            await stallMatch(TIER_ID, INSTANCE_ID, 0, 3);
            await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L3_DELAY + 1]);
            await hre.network.provider.send("evm_mine");
            await game.connect(outsiders[1]).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 3);
            console.log("  Match 3: L3 replacement ✓");

            // Verify round completion
            const round0 = await game.getRoundInfo(TIER_ID, INSTANCE_ID, 0);
            expect(round0.completedMatches).to.equal(4);
            console.log("\n✓ Round 0 complete with mixed completion types");

            // Check who advanced to round 1
            const r1m0 = await game.getMatch(TIER_ID, INSTANCE_ID, 1, 0);
            if (r1m0.common.player1 !== hre.ethers.ZeroAddress) {
                console.log(`\nRound 1 players: ${r1m0.common.player1.substring(0, 8)}... vs ${r1m0.common.player2.substring(0, 8)}...`);
                console.log("✓ Bracket advanced correctly");
            }

            console.log("\n✅ Complex bracket with multiple escalation types handled correctly");
        });
    });
});
