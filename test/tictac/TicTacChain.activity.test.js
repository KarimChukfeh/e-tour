import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain Player Activity Tracking", function () {
  let ticTacChain;
  let owner, player1, player2, player3, player4;

  const TIER_0 = 0; // 2-player tier
  const INSTANCE_0 = 0;
  const ENTRY_FEE_TIER_0 = hre.ethers.parseEther("0.001");

  beforeEach(async function () {
    [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

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

    // Deploy TicTacChain (player tracking and game logic are now built-in)
    const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
    ticTacChain = await TicTacChain.deploy(
      await moduleCore.getAddress(),
      await moduleMatches.getAddress(),
      await modulePrizes.getAddress(),
      await moduleRaffle.getAddress(),
      await moduleEscalation.getAddress(),
      await moduleGameCache.getAddress()
    );
    await ticTacChain.waitForDeployment();

    // Initialize
    const initTx = await ticTacChain.initializeAllInstances();
    await initTx.wait();
  });

  describe("Enrollment Tracking", function () {
    it("should add player to enrolling list on enrollment", async function () {
      // Player 1 enrolls
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check enrolling tournaments
      const enrolling = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      expect(enrolling.length).to.equal(1);
      expect(enrolling[0].tierId).to.equal(TIER_0);
      expect(enrolling[0].instanceId).to.equal(INSTANCE_0);

      // Check activity counts
      const enrollingTournaments = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      const activeTournaments = await ticTacChain.getPlayerActiveTournaments(player1.address);
      expect(enrollingTournaments.length).to.equal(1);
      expect(activeTournaments.length).to.equal(0);

      // Check enrollment status
      const isEnrolled = await ticTacChain.isEnrolled(TIER_0, INSTANCE_0, player1.address);
      expect(isEnrolled).to.be.true;
    });

    it("should track multiple enrollments in different tournaments", async function () {
      // Player 1 enrolls in two different instances
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, 0, {
        value: ENTRY_FEE_TIER_0,
      });
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, 1, {
        value: ENTRY_FEE_TIER_0,
      });

      const enrolling = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      expect(enrolling.length).to.equal(2);
      expect(enrolling[0].instanceId).to.equal(0);
      expect(enrolling[1].instanceId).to.equal(1);
    });
  });

  describe("Tournament Start Transition", function () {
    it("should move all players from enrolling to active on tournament start", async function () {
      // Both players enroll (triggers auto-start)
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await ticTacChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check player1: should be in active list (moved from enrolling)
      // Note: isEnrolled mapping stays true during tournament (cleared on tournament reset)
      const p1IsEnrolled = await ticTacChain.isEnrolled(TIER_0, INSTANCE_0, player1.address);
      const p1ActiveList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      const p1EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      expect(p1IsEnrolled).to.be.true; // Player is still enrolled in tournament
      expect(p1ActiveList.length).to.be.greaterThan(0);
      expect(p1EnrollingList.length).to.equal(0);

      // Check player2: should be in active list (moved from enrolling)
      const p2IsEnrolled = await ticTacChain.isEnrolled(TIER_0, INSTANCE_0, player2.address);
      const p2ActiveList = await ticTacChain.getPlayerActiveTournaments(player2.address);
      const p2EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player2.address);
      expect(p2IsEnrolled).to.be.true; // Player is still enrolled in tournament
      expect(p2ActiveList.length).to.be.greaterThan(0);
      expect(p2EnrollingList.length).to.equal(0);
    });
  });

  describe("Elimination Tracking", function () {
    it("should remove eliminated player from active list", async function () {
      // Start tournament (2 players)
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await ticTacChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Verify both in active list
      let p1ActiveList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      expect(p1ActiveList.length).to.be.greaterThan(0);

      // Get match info
      const matchData = await ticTacChain.getMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData.currentTurn;
      const player = currentTurn === player1.address ? player1 : player2;
      const opponent = currentTurn === player1.address ? player2 : player1;

      // Play game until someone wins (player makes winning move)
      // This is tier 0 (2-player), round 0, match 0
      // Simple winning pattern: X wins with top row (cells 0, 1, 2)

      // Assume player is X (first player), play to win
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 0); // X at 0
      await ticTacChain.connect(opponent).makeMove(TIER_0, INSTANCE_0, 0, 0, 3); // O at 3
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 1); // X at 1
      await ticTacChain.connect(opponent).makeMove(TIER_0, INSTANCE_0, 0, 0, 4); // O at 4
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 2); // X at 2 - WINS!

      // Check that both players are removed from active list (match completed)
      p1ActiveList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      const p1EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      const p2ActiveList = await ticTacChain.getPlayerActiveTournaments(player2.address);
      const p2EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player2.address);

      expect(p1ActiveList.length).to.equal(0);
      expect(p2ActiveList.length).to.equal(0);
      expect(p1EnrollingList.length).to.equal(0);
      expect(p2EnrollingList.length).to.equal(0);
    });
  });

  describe("Tournament Completion Cleanup", function () {
    it("should clear all player tracking on tournament completion", async function () {
      // Complete a 2-player tournament
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await ticTacChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Get current player and play to completion
      const matchData = await ticTacChain.getMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData.currentTurn;
      const player = currentTurn === player1.address ? player1 : player2;
      const opponent = currentTurn === player1.address ? player2 : player1;

      // Play winning game
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);
      await ticTacChain.connect(opponent).makeMove(TIER_0, INSTANCE_0, 0, 0, 3);
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);
      await ticTacChain.connect(opponent).makeMove(TIER_0, INSTANCE_0, 0, 0, 4);
      await ticTacChain.connect(player).makeMove(TIER_0, INSTANCE_0, 0, 0, 2); // Win

      // Verify all tracking cleared
      const p1EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      const p1ActiveList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      const p2EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player2.address);
      const p2ActiveList = await ticTacChain.getPlayerActiveTournaments(player2.address);

      expect(p1EnrollingList.length).to.equal(0);
      expect(p1ActiveList.length).to.equal(0);
      expect(p2EnrollingList.length).to.equal(0);
      expect(p2ActiveList.length).to.equal(0);
    });
  });

  describe("View Functions", function () {
    it("should return empty arrays for new players", async function () {
      const enrolling = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      const active = await ticTacChain.getPlayerActiveTournaments(player1.address);

      expect(enrolling.length).to.equal(0);
      expect(active.length).to.equal(0);
    });

    it("should return correct counts", async function () {
      // Enroll player1 in two tournaments
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, 0, {
        value: ENTRY_FEE_TIER_0,
      });
      await ticTacChain.connect(player1).enrollInTournament(TIER_0, 1, {
        value: ENTRY_FEE_TIER_0,
      });

      const enrollingList = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      const activeList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      expect(enrollingList.length).to.equal(2);
      expect(activeList.length).to.equal(0);
    });
  });
});
