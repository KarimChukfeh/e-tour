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

    // Deploy ETourLib_Core first (no dependencies)
    const ETourLib_Core = await hre.ethers.getContractFactory("ETourLib_Core");
    const coreLib = await ETourLib_Core.deploy();
    await coreLib.waitForDeployment();
    const coreLibAddress = await coreLib.getAddress();

    // Deploy ETourLib_Matches (depends on ETourLib_Core)
    const ETourLib_Matches = await hre.ethers.getContractFactory("ETourLib_Matches", {
      libraries: {
        ETourLib_Core: coreLibAddress,
      },
    });
    const matchesLib = await ETourLib_Matches.deploy();
    await matchesLib.waitForDeployment();

    // Deploy ETourLib_Prizes (only uses types from ETourLib_Core, no linking needed)
    const ETourLib_Prizes = await hre.ethers.getContractFactory("ETourLib_Prizes");
    const prizesLib = await ETourLib_Prizes.deploy();
    await prizesLib.waitForDeployment();

    // Deploy TicTacChain with all linked libraries
    const TicTacChain = await hre.ethers.getContractFactory("TicTacChain", {
      libraries: {
        ETourLib_Core: coreLibAddress,
        ETourLib_Matches: await matchesLib.getAddress(),
        ETourLib_Prizes: await prizesLib.getAddress(),
      },
    });
    ticTacChain = await TicTacChain.deploy();
    await ticTacChain.waitForDeployment();
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
      const [enrollingCount, activeCount] = await ticTacChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(1);
      expect(activeCount).to.equal(0);

      // Check isPlayerInTournament
      const [isEnrolling, isActive] = await ticTacChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(isEnrolling).to.be.true;
      expect(isActive).to.be.false;
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

      // Check player1: should be in active, not enrolling
      const [p1Enrolling, p1Active] = await ticTacChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.true;

      // Check player2: should be in active, not enrolling
      const [p2Enrolling, p2Active] = await ticTacChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.true;

      // Check via arrays
      const p1ActiveList = await ticTacChain.getPlayerActiveTournaments(player1.address);
      expect(p1ActiveList.length).to.equal(1);

      const p1EnrollingList = await ticTacChain.getPlayerEnrollingTournaments(player1.address);
      expect(p1EnrollingList.length).to.equal(0);
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
      let [p1Enrolling, p1Active] = await ticTacChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Active).to.be.true;

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
      [p1Enrolling, p1Active] = await ticTacChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await ticTacChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );

      expect(p1Active).to.be.false;
      expect(p2Active).to.be.false;
      expect(p1Enrolling).to.be.false;
      expect(p2Enrolling).to.be.false;
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
      const [p1Enrolling, p1Active] = await ticTacChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await ticTacChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );

      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.false;
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.false;

      // Check counts are zero
      const [p1EnrollCount, p1ActiveCount] = await ticTacChain.getPlayerActivityCounts(player1.address);
      const [p2EnrollCount, p2ActiveCount] = await ticTacChain.getPlayerActivityCounts(player2.address);

      expect(p1EnrollCount).to.equal(0);
      expect(p1ActiveCount).to.equal(0);
      expect(p2EnrollCount).to.equal(0);
      expect(p2ActiveCount).to.equal(0);
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

      const [enrollingCount, activeCount] = await ticTacChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(2);
      expect(activeCount).to.equal(0);
    });
  });
});
