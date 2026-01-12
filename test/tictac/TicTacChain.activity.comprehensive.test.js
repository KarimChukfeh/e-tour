import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TicTacChain Player Activity Tracking - Comprehensive 8-Player Tournament", function () {
  let ticTacChain;
  let owner, p1, p2, p3, p4, p5, p6, p7, p8, external1, external2;

  const TIER_2 = 2; // 8-player tier
  const INSTANCE_0 = 0;
  const ENTRY_FEE_TIER_2 = hre.ethers.parseEther("0.0013");

  // Storage snapshots at each step
  const storageSnapshots = [];

  async function captureStorageSnapshot(label, players) {
    const snapshot = {
      label,
      timestamp: Date.now(),
      players: {},
    };

    for (const player of players) {
      const enrolling = await ticTacChain.getPlayerEnrollingTournaments(player.address);
      const active = await ticTacChain.getPlayerActiveTournaments(player.address);

      snapshot.players[player.address] = {
        name: player === p1 ? "P1" : player === p2 ? "P2" : player === p3 ? "P3" :
               player === p4 ? "P4" : player === p5 ? "P5" : player === p6 ? "P6" :
               player === p7 ? "P7" : player === p8 ? "P8" : player === external1 ? "EXT1" : "EXT2",
        enrolling: enrolling.map(t => ({ tierId: t.tierId, instanceId: t.instanceId })),
        active: active.map(t => ({ tierId: t.tierId, instanceId: t.instanceId })),
        enrollingCount: enrolling.length,
        activeCount: active.length,
      };
    }

    storageSnapshots.push(snapshot);
    return snapshot;
  }

  function printSnapshot(snapshot) {
    console.log(`\n=== ${snapshot.label} ===`);
    for (const [addr, data] of Object.entries(snapshot.players)) {
      console.log(`${data.name}: enrolling=${data.enrollingCount}, active=${data.activeCount}`);
    }
  }

  async function playMatch(tierId, instanceId, roundNum, matchNum, winner) {
    const matchData = await ticTacChain.getMatch(tierId, instanceId, roundNum, matchNum);
    const player1Addr = matchData.common.player1;
    const player2Addr = matchData.common.player2;

    // Determine who's who
    const player1 = [p1, p2, p3, p4, p5, p6, p7, p8, external1, external2].find(p => p.address === player1Addr);
    const player2 = [p1, p2, p3, p4, p5, p6, p7, p8, external1, external2].find(p => p.address === player2Addr);

    // Determine winner and play to completion
    const winnerPlayer = winner === 1 ? player1 : player2;
    const loserPlayer = winner === 1 ? player2 : player1;

    // Get current turn
    let currentPlayer = matchData.currentTurn === player1.address ? player1 : player2;

    // Play winning game - winner gets top row (0, 1, 2)
    const moves = [
      { player: winnerPlayer, cell: 0 },
      { player: loserPlayer, cell: 3 },
      { player: winnerPlayer, cell: 1 },
      { player: loserPlayer, cell: 4 },
      { player: winnerPlayer, cell: 2 }, // WIN!
    ];

    let lastTx;
    for (const move of moves) {
      const currentMatchData = await ticTacChain.getMatch(tierId, instanceId, roundNum, matchNum);
      if (currentMatchData.common.status === 2) break; // Already completed

      currentPlayer = currentMatchData.currentTurn === player1.address ? player1 : player2;

      // Skip if not current player's turn
      if (currentPlayer.address !== move.player.address) {
        // Adjust moves on the fly
        lastTx = await ticTacChain.connect(currentPlayer).makeMove(tierId, instanceId, roundNum, matchNum, move.cell);
      } else {
        lastTx = await ticTacChain.connect(move.player).makeMove(tierId, instanceId, roundNum, matchNum, move.cell);
      }
    }
    return lastTx;
  }

  beforeEach(async function () {
    [owner, p1, p2, p3, p4, p5, p6, p7, p8, external1, external2] = await hre.ethers.getSigners();

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

    // Deploy TicTacChain (game logic is built-in, no separate game module)
    const TicTacChain = await hre.ethers.getContractFactory("contracts/TicTacChain.sol:TicTacChain");
    ticTacChain = await TicTacChain.deploy(
      await moduleCore.getAddress(),
      await moduleMatches.getAddress(),
      await modulePrizes.getAddress(),
      await moduleRaffle.getAddress(),
      await moduleEscalation.getAddress()
    );
    await ticTacChain.waitForDeployment();

    // Initialize
    // Tiers are now initialized in constructor

    storageSnapshots.length = 0;
  });

  it("should track complete 8-player tournament with escalations", async function () {
    // SKIPPED: This comprehensive stress test uses extreme time advancements (301+ seconds cumulative)
    // that exceed player time banks with Fischer increment. Core activity tracking is tested in other tests.
    const allPlayers = [p1, p2, p3, p4, p5, p6, p7, p8];
    const allPlayersWithExternal = [...allPlayers, external1, external2];

    // STEP 1: Initial state (all empty)
    await captureStorageSnapshot("Step 1: Initial State (before enrollment)", allPlayers);

    // STEP 2: All 8 players enroll
    console.log("\n🎯 ENROLLING 8 PLAYERS...");
    for (let i = 0; i < allPlayers.length; i++) {
      await ticTacChain.connect(allPlayers[i]).enrollInTournament(TIER_2, INSTANCE_0, {
        value: ENTRY_FEE_TIER_2,
      });
    }
    await captureStorageSnapshot("Step 2: All 8 Players Enrolled (in enrolling list)", allPlayers);

    // STEP 3: Tournament auto-starts (enrolling → active)
    await captureStorageSnapshot("Step 3: Tournament Started (all moved to active list)", allPlayers);

    // STEP 4: Round 0 - Quarter Finals (4 matches)
    console.log("\n🏆 ROUND 0: QUARTER FINALS");

    // Match 0: P1 vs P2 - P1 wins normally
    await playMatch(TIER_2, INSTANCE_0, 0, 0, 1);
    await captureStorageSnapshot("Step 4.1: Match 0 Complete - P1 wins, P2 eliminated", allPlayers);

    // Match 1: P3 vs P4 - P4 wins normally
    await playMatch(TIER_2, INSTANCE_0, 0, 1, 2);
    await captureStorageSnapshot("Step 4.2: Match 1 Complete - P4 wins, P3 eliminated", allPlayers);

    // Match 2: P5 vs P6 - One player moves, then the other times out
    console.log("\n⏰ TIMEOUT SCENARIO: P5 vs P6");
    const match2Data = await ticTacChain.getMatch(TIER_2, INSTANCE_0, 0, 2);
    const currentTurn = match2Data.currentTurn;
    const firstMover = currentTurn === p5.address ? p5 : p6;
    const secondPlayer = currentTurn === p5.address ? p6 : p5;

    // First player makes a move (turn switches to secondPlayer)
    await ticTacChain.connect(firstMover).makeMove(TIER_2, INSTANCE_0, 0, 2, 0);

    // Now secondPlayer times out (it's their turn, they don't move)
    await time.increase(120); // 2 minutes (timeout is 1 minute per player)

    // First player (who already moved) claims timeout win on secondPlayer
    await ticTacChain.connect(firstMover).claimTimeoutWin(TIER_2, INSTANCE_0, 0, 2);
    await captureStorageSnapshot("Step 4.3: Match 2 Timeout - Timeout win claimed, player eliminated", allPlayers);

    // Match 3: P7 vs P8 - DOUBLE ELIMINATION via L2 escalation
    console.log("\n💥 ESCALATION SCENARIO: P7 vs P8 - Both timeout, L2 eliminates both");
    const match3Data = await ticTacChain.getMatch(TIER_2, INSTANCE_0, 0, 3);
    const match3FirstPlayer = match3Data.currentTurn === p7.address ? p7 : p8;

    // First player makes one move to start the match
    await ticTacChain.connect(match3FirstPlayer).makeMove(TIER_2, INSTANCE_0, 0, 3, 0);

    // Now both players let it timeout and stall
    await time.increase(241); // 4 minutes + 1 second - enough for L2 escalation (matchTimePerPlayer 2min + matchLevel2Delay 2min)

    // Advanced player (winner of Match 2) triggers double elimination (L2)
    await ticTacChain.connect(firstMover).forceEliminateStalledMatch(TIER_2, INSTANCE_0, 0, 3);
    await captureStorageSnapshot("Step 4.4: Match 3 L2 Escalation - Both P7 & P8 eliminated by advanced player", allPlayers);

    // STEP 5: Round 1 - Semi Finals (2 matches expected, but only 1 due to consolidation)
    console.log("\n🏆 ROUND 1: SEMI FINALS (with consolidation)");

    // Now we have: P1, P4, P6 remaining (3 players)
    // System will consolidate P1 vs P4, P6 gets walkover to finals

    // Check if round initialized
    const [totalMatches, completedMatches, initialized] = await ticTacChain.getRoundInfo(TIER_2, INSTANCE_0, 1);
    console.log(`Round 1: ${totalMatches} matches, ${completedMatches} completed, initialized=${initialized}`);

    if (totalMatches > 0) {
      // Match 0: P1 vs P4 - one move made, then both timeout, external player replaces (L3)
      console.log("\n🔄 REPLACEMENT SCENARIO: Match stalls, External2 replaces");

      // Get match data and make one move
      const semifinalMatch = await ticTacChain.getMatch(TIER_2, INSTANCE_0, 1, 0);
      const semifinalPlayer = semifinalMatch.currentTurn === semifinalMatch.common.player1 ?
        allPlayersWithExternal.find(p => p.address === semifinalMatch.common.player1) :
        allPlayersWithExternal.find(p => p.address === semifinalMatch.common.player2);

      await ticTacChain.connect(semifinalPlayer).makeMove(TIER_2, INSTANCE_0, 1, 0, 0);

      // Wait for L3 escalation window
      await time.increase(481); 

      // External2 replaces both stalled players
      await ticTacChain.connect(external2).claimMatchSlotByReplacement(TIER_2, INSTANCE_0, 1, 0);
      await captureStorageSnapshot("Step 5.1: Match 0 L3 Replacement - External2 replaces stalled players", allPlayersWithExternal);

      // If there's a second semi-final match, check if it has valid players
      if (totalMatches > 1) {
        try {
          const match1Data = await ticTacChain.getMatch(TIER_2, INSTANCE_0, 1, 1);
          if (match1Data.common.player1 !== hre.ethers.ZeroAddress && match1Data.common.player2 !== hre.ethers.ZeroAddress) {
            await playMatch(TIER_2, INSTANCE_0, 1, 1, 1);
            await captureStorageSnapshot("Step 5.2: Match 1 Complete", allPlayersWithExternal);
          }
        } catch (e) {
          console.log("Match 1 not playable (consolidation handled it)");
        }
      }
    }

    // STEP 6: Round 2 - Finals
    console.log("\n🏆 ROUND 2: FINALS");
    const [finalMatches] = await ticTacChain.getRoundInfo(TIER_2, INSTANCE_0, 2);

    if (finalMatches > 0) {
      // Play finals normally
      const finalMatchData = await ticTacChain.getMatch(TIER_2, INSTANCE_0, 2, 0);
      const finalist1 = finalMatchData.common.player1;
      const finalist2 = finalMatchData.common.player2;

      console.log(`Finals: ${finalist1} vs ${finalist2}`);

      // First finalist wins
      await playMatch(TIER_2, INSTANCE_0, 2, 0, 1);
      await captureStorageSnapshot("Step 6: Finals Complete - Champion crowned!", allPlayersWithExternal);
    }

    // STEP 7: Tournament completes and resets
    // Storage should be cleaned up automatically
    await captureStorageSnapshot("Step 7: Tournament Complete - All storage cleaned up", allPlayersWithExternal);

    // Print all snapshots for visibility
    console.log("\n\n📊 ===== COMPLETE STORAGE TRACE =====");
    for (const snapshot of storageSnapshots) {
      printSnapshot(snapshot);
    }

    // Verify final state - all players should have empty tracking
    for (const player of allPlayersWithExternal) {
      const enrolling = await ticTacChain.getPlayerEnrollingTournaments(player.address);
      const active = await ticTacChain.getPlayerActiveTournaments(player.address);
      expect(enrolling.length).to.equal(0, `${player.address} should have 0 enrolling tournaments`);
      expect(active.length).to.equal(0, `${player.address} should have 0 active tournaments`);
    }

    // Export snapshots for HTML visualization (convert BigInts to strings)
    console.log("\n\n📦 Storage Snapshots for Visualization:");
    const jsonSafe = JSON.stringify(storageSnapshots, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    , 2);
    console.log(jsonSafe);

    // Assertions to verify tracking worked correctly
    expect(storageSnapshots.length).to.be.greaterThan(7);

    // Step 2: All 8 players should be in active (tournament auto-starts on 8th enrollment)
    const step2 = storageSnapshots.find(s => s.label.includes("Step 2"));
    let activeSum = Object.values(step2.players).reduce((sum, p) => sum + p.activeCount, 0);
    expect(activeSum).to.equal(8);

    // Step 3: All 8 players should still be in active
    const step3 = storageSnapshots.find(s => s.label.includes("Step 3"));
    activeSum = Object.values(step3.players).reduce((sum, p) => sum + p.activeCount, 0);
    expect(activeSum).to.equal(8);

    // Final: All should be clean
    const final = storageSnapshots[storageSnapshots.length - 1];
    const enrollingSum = Object.values(final.players).reduce((sum, p) => sum + p.enrollingCount, 0);
    activeSum = Object.values(final.players).reduce((sum, p) => sum + p.activeCount, 0);
    expect(enrollingSum).to.equal(0);
    expect(activeSum).to.equal(0);
  });

  it("should keep players in active tournaments after winning semifinal while waiting for other semifinal", async function () {
    // This test verifies the fix for the bug where players were incorrectly removed from
    // the active tournaments list after winning their semifinal, before the finals started

    // 4-player tournament (2 semifinals + 1 final)
    const TIER_1 = 1;
    const INSTANCE_0 = 0;
    const ENTRY_FEE_TIER_1 = hre.ethers.parseEther("0.0007");

    // Enroll 4 players
    await ticTacChain.connect(p1).enrollInTournament(TIER_1, INSTANCE_0, { value: ENTRY_FEE_TIER_1 });
    await ticTacChain.connect(p2).enrollInTournament(TIER_1, INSTANCE_0, { value: ENTRY_FEE_TIER_1 });
    await ticTacChain.connect(p3).enrollInTournament(TIER_1, INSTANCE_0, { value: ENTRY_FEE_TIER_1 });
    await ticTacChain.connect(p4).enrollInTournament(TIER_1, INSTANCE_0, { value: ENTRY_FEE_TIER_1 });

    // Check tournament status
    const tournament = await ticTacChain.tournaments(TIER_1, INSTANCE_0);
    console.log("\nTournament status:", tournament.status);
    console.log("Enrolled count:", tournament.enrolledCount);
    console.log("Current round:", tournament.currentRound);

    // Check round info
    const [totalMatches, completedMatches, initialized] = await ticTacChain.getRoundInfo(TIER_1, INSTANCE_0, 0);
    console.log("\nRound 0 info:");
    console.log("  Total matches:", totalMatches);
    console.log("  Completed:", completedMatches);
    console.log("  Initialized:", initialized);

    // Verify all 4 players are in active tournaments
    let p1Active = await ticTacChain.getPlayerActiveTournaments(p1.address);
    let p2Active = await ticTacChain.getPlayerActiveTournaments(p2.address);
    let p3Active = await ticTacChain.getPlayerActiveTournaments(p3.address);
    let p4Active = await ticTacChain.getPlayerActiveTournaments(p4.address);

    expect(p1Active.length).to.equal(1);
    expect(p2Active.length).to.equal(1);
    expect(p3Active.length).to.equal(1);
    expect(p4Active.length).to.equal(1);

    // Try to check match ID
    console.log("\nAttempting to get match 0,0...");
    try {
      const match = await ticTacChain.getMatch(TIER_1, INSTANCE_0, 0, 0);
      console.log("Match retrieved successfully!");
      console.log("Player 1:", match.common.player1);
      console.log("Player 2:", match.common.player2);
      console.log("Status:", match.common.status);
    } catch (err) {
      console.log("Error getting match:", err.message);

      // Try getting matchId
      const matchId = await ticTacChain._getMatchId(TIER_1, INSTANCE_0, 0, 0);
      console.log("Match ID:", matchId);

      // Try _isMatchActive
      const isActive = await ticTacChain._isMatchActive(matchId);
      console.log("Is match active?", isActive);
    }

    // Complete FIRST semifinal (Round 0, Match 0)
    await playMatch(TIER_1, INSTANCE_0, 0, 0, 1); // Player 1 wins

    const match0Data = await ticTacChain.getMatch(TIER_1, INSTANCE_0, 0, 0);
    const sf0Winner = match0Data.common.winner;
    const sf0Loser = match0Data.common.player1 === sf0Winner ? match0Data.common.player2 : match0Data.common.player1;

    console.log(`\nSemifinal 0 Complete:`);
    console.log(`  Winner: ${sf0Winner}`);
    console.log(`  Loser: ${sf0Loser}`);

    // CRITICAL TEST: Winner should STILL be in active tournaments
    // (waiting for other semifinal to complete before finals starts)
    const winnerActiveList = await ticTacChain.getPlayerActiveTournaments(sf0Winner);
    console.log(`  Winner's active tournaments: ${winnerActiveList.length}`);

    expect(winnerActiveList.length).to.equal(1,
      "Winner should remain in active tournaments list while waiting for finals");
    expect(winnerActiveList[0].tierId).to.equal(TIER_1);
    expect(winnerActiveList[0].instanceId).to.equal(INSTANCE_0);

    // Loser should be removed (they're eliminated)
    const loserActiveList = await ticTacChain.getPlayerActiveTournaments(sf0Loser);
    expect(loserActiveList.length).to.equal(0, "Loser should be removed from active tournaments");

    // Other semifinal players should still be active
    const match1Data = await ticTacChain.getMatch(TIER_1, INSTANCE_0, 0, 1);
    const sf1Player1 = match1Data.common.player1;
    const sf1Player2 = match1Data.common.player2;

    const sf1P1Active = await ticTacChain.getPlayerActiveTournaments(sf1Player1);
    const sf1P2Active = await ticTacChain.getPlayerActiveTournaments(sf1Player2);

    expect(sf1P1Active.length).to.equal(1, "SF1 Player 1 should still be active");
    expect(sf1P2Active.length).to.equal(1, "SF1 Player 2 should still be active");

    // Complete SECOND semifinal
    await playMatch(TIER_1, INSTANCE_0, 0, 1, 1); // First player wins

    const match1CompleteData = await ticTacChain.getMatch(TIER_1, INSTANCE_0, 0, 1);
    const sf1Winner = match1CompleteData.common.winner;
    const sf1Loser = match1CompleteData.common.player1 === sf1Winner ?
      match1CompleteData.common.player2 : match1CompleteData.common.player1;

    console.log(`\nSemifinal 1 Complete:`);
    console.log(`  Winner: ${sf1Winner}`);
    console.log(`  Loser: ${sf1Loser}`);

    // Now both finalists should be in active tournaments (finals has started)
    const sf0WinnerActive = await ticTacChain.getPlayerActiveTournaments(sf0Winner);
    const sf1WinnerActive = await ticTacChain.getPlayerActiveTournaments(sf1Winner);

    expect(sf0WinnerActive.length).to.equal(1, "SF0 winner should be in finals");
    expect(sf1WinnerActive.length).to.equal(1, "SF1 winner should be in finals");

    // SF1 loser should be removed
    const sf1LoserActive = await ticTacChain.getPlayerActiveTournaments(sf1Loser);
    expect(sf1LoserActive.length).to.equal(0, "SF1 loser should be eliminated");

    // Complete finals
    await playMatch(TIER_1, INSTANCE_0, 1, 0, 1);

    // After tournament completes, all players should be removed
    const finalSf0WinnerActive = await ticTacChain.getPlayerActiveTournaments(sf0Winner);
    const finalSf1WinnerActive = await ticTacChain.getPlayerActiveTournaments(sf1Winner);

    expect(finalSf0WinnerActive.length).to.equal(0, "Champion should be removed after tournament");
    expect(finalSf1WinnerActive.length).to.equal(0, "Finalist should be removed after tournament");
  });
});
