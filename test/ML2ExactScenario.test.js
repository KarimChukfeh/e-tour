import { expect } from "chai";
import hre from "hardhat";

describe("ML2 Exact User Scenario", function() {
    let game;
    let playerA, playerB, playerC, playerD;

    const TIER_4 = 1; // 4-player tier
    const INSTANCE_ID = 0;
    const TIER_FEE = hre.ethers.parseEther("0.0007");
    const MATCH_TIME = 120;
    const L2_DELAY = 120;

    beforeEach(async function() {
        const signers = await hre.ethers.getSigners();
        playerA = signers[1];
        playerB = signers[2];
        playerC = signers[3];
        playerD = signers[4];

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

        const TicTacChain = await hre.ethers.getContractFactory("contracts/TicTacChain.sol:TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();
    });

    it("EXACT SCENARIO: A beats B, C vs D stalls, A triggers ML2 → should complete tournament", async function() {
        this.timeout(60000);

        console.log("\n=== EXACT USER SCENARIO TEST ===\n");

        // Step 1: Enroll A, B, C, D
        console.log("Step 1: Enrolling 4 players (A, B, C, D)...");
        await game.connect(playerA).enrollInTournament(TIER_4, INSTANCE_ID, { value: TIER_FEE });
        await game.connect(playerB).enrollInTournament(TIER_4, INSTANCE_ID, { value: TIER_FEE });
        await game.connect(playerC).enrollInTournament(TIER_4, INSTANCE_ID, { value: TIER_FEE });
        await game.connect(playerD).enrollInTournament(TIER_4, INSTANCE_ID, { value: TIER_FEE });

        const match0 = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        const match1 = await game.getMatch(TIER_4, INSTANCE_ID, 0, 1);

        console.log(`Match 0 (semi): ${match0.player1} vs ${match0.player2}`);
        console.log(`Match 1 (semi): ${match1.player1} vs ${match1.player2}`);
        console.log("✓ Tournament started");

        // Step 2: A vs B → A wins
        console.log("\nStep 2: Playing A vs B (A should win)...");
        let currentMatch = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);

        // Play 5 moves for A to win
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 0, 0);
        currentMatch = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 0, 3);
        currentMatch = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 0, 1);
        currentMatch = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 0, 4);
        currentMatch = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(currentMatch.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 0, 2);

        const match0After = await game.getMatch(TIER_4, INSTANCE_ID, 0, 0);
        const winnerAddress = match0After.winner;
        const winnerA = await hre.ethers.getSigner(winnerAddress);
        console.log(`Winner of match 0: ${winnerAddress}`);
        console.log(`✓ A won and advanced to finals`);

        // Verify A is in finals
        const finalsMatch = await game.getMatch(TIER_4, INSTANCE_ID, 1, 0);
        expect(finalsMatch.player1 === winnerAddress || finalsMatch.player2 === winnerAddress).to.be.true;
        console.log(`Finals: player1=${finalsMatch.player1}, player2=${finalsMatch.player2}`);

        // Step 3: C vs D stalls
        console.log("\nStep 3: C vs D stalling (one move then timeout)...");
        let currentMatch1 = await game.getMatch(TIER_4, INSTANCE_ID, 0, 1);
        await game.connect(await hre.ethers.getSigner(currentMatch1.currentTurn)).makeMove(TIER_4, INSTANCE_ID, 0, 1, 0);
        console.log("✓ One move made in C vs D, now waiting for stall...");

        // Wait for ML2 to become available
        await hre.network.provider.send("evm_increaseTime", [MATCH_TIME + L2_DELAY + 1]);
        await hre.network.provider.send("evm_mine");
        console.log("✓ Time advanced past ML2 threshold");

        // Step 4: Check state BEFORE ML2
        console.log("\nStep 4: State BEFORE ML2 trigger:");
        let tournamentBefore = await game.getTournamentInfo(TIER_4, INSTANCE_ID);
        console.log(`  Tournament status: ${tournamentBefore.status} (0=Enrolling, 1=InProgress, 2=Completed)`);
        console.log(`  Enrolled count: ${tournamentBefore.enrolledCount}`);
        console.log(`  Prize pool: ${hre.ethers.formatEther(tournamentBefore.prizePool)} ETH`);

        const enrolledBefore = await game.getPlayerEnrollingTournaments(winnerAddress);
        console.log(`  A enrolling tournaments: ${enrolledBefore.length}`);
        const activeBefore = await game.getPlayerActiveTournaments(winnerAddress);
        console.log(`  A active tournaments: ${activeBefore.length}`);

        expect(tournamentBefore.status).to.equal(1, "Tournament should be InProgress before ML2");

        // Check if A is recognized as advanced
        const isAdvanced = await game.isPlayerInAdvancedRound(TIER_4, INSTANCE_ID, 0, winnerAddress);
        console.log(`  Is A advanced? ${isAdvanced}`);
        expect(isAdvanced).to.be.true;

        // Step 5: A triggers ML2
        console.log("\nStep 5: A triggering ML2 on C vs D...");
        const aBalanceBefore = await hre.ethers.provider.getBalance(winnerA.address);

        const tx = await game.connect(winnerA).forceEliminateStalledMatch(TIER_4, INSTANCE_ID, 0, 1);
        const receipt = await tx.wait();
        console.log("✓ ML2 transaction successful");

        // Step 6: Check state AFTER ML2
        console.log("\nStep 6: State AFTER ML2 trigger:");
        let tournamentAfter = await game.getTournamentInfo(TIER_4, INSTANCE_ID);
        console.log(`  Tournament status: ${tournamentAfter.status} (0=Enrolling, 1=InProgress, 2=Completed)`);
        console.log(`  Enrolled count: ${tournamentAfter.enrolledCount}`);
        console.log(`  Prize pool: ${hre.ethers.formatEther(tournamentAfter.prizePool)} ETH`);
        console.log(`  Winner: ${tournamentAfter.winner}`);

        const enrolledAfter = await game.getPlayerEnrollingTournaments(winnerAddress);
        console.log(`  A enrolling tournaments: ${enrolledAfter.length}`);
        const activeAfter = await game.getPlayerActiveTournaments(winnerAddress);
        console.log(`  A active tournaments: ${activeAfter.length}`);

        // Check if C and D are still enrolled
        const cEnrolled = await game.getPlayerEnrollingTournaments(playerC.address);
        const dEnrolled = await game.getPlayerEnrollingTournaments(playerD.address);
        console.log(`  C enrolling tournaments: ${cEnrolled.length}`);
        console.log(`  D enrolling tournaments: ${dEnrolled.length}`);

        // Step 7: Verify tournament completed properly
        console.log("\nStep 7: Verifying tournament completion...");
        expect(tournamentAfter.status).to.equal(0, "❌ TOURNAMENT SHOULD BE ENROLLING (RESET)");
        expect(tournamentAfter.enrolledCount).to.equal(0, "❌ ENROLLED COUNT SHOULD BE 0");
        expect(tournamentAfter.prizePool).to.equal(0n, "❌ PRIZE POOL SHOULD BE 0");
        expect(tournamentAfter.winner).to.equal(hre.ethers.ZeroAddress, "❌ WINNER SHOULD BE CLEARED");

        // Verify A is removed from tracking
        expect(enrolledAfter.length).to.equal(0, "❌ A SHOULD NOT BE IN ENROLLING TOURNAMENTS");
        expect(activeAfter.length).to.equal(0, "❌ A SHOULD NOT BE IN ACTIVE TOURNAMENTS");

        // Verify C and D are removed from tracking
        expect(cEnrolled.length).to.equal(0, "❌ C SHOULD NOT BE IN ENROLLING TOURNAMENTS");
        expect(dEnrolled.length).to.equal(0, "❌ D SHOULD NOT BE IN ENROLLING TOURNAMENTS");

        console.log("✓ Tournament properly reset");

        // Step 8: Verify A received prize
        console.log("\nStep 8: Verifying prize distribution...");
        const aBalanceAfter = await hre.ethers.provider.getBalance(winnerA.address);
        const gasCost = receipt.gasUsed * receipt.gasPrice;
        const prizeReceived = aBalanceAfter - aBalanceBefore + gasCost;

        console.log(`  A's prize: ${hre.ethers.formatEther(prizeReceived)} ETH`);
        expect(prizeReceived).to.be.gt(0n, "❌ A SHOULD HAVE RECEIVED PRIZE");
        console.log("✓ Prize distributed to A");

        // Step 9: Verify TournamentCompleted event
        console.log("\nStep 9: Verifying TournamentCompleted event...");
        const events = await game.queryFilter(game.filters.TournamentCompleted(), receipt.blockNumber, receipt.blockNumber);
        expect(events.length).to.be.gt(0, "❌ TOURNAMENT COMPLETED EVENT SHOULD BE EMITTED");
        console.log(`✓ TournamentCompleted event emitted (${events.length} event(s))`);

        console.log("\n=== TEST COMPLETE ✅ ===\n");
    });
});
