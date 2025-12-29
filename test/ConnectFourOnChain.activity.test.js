import { expect } from "chai";
import hre from "hardhat";

describe("ConnectFourOnChain Player Activity Tracking", function () {
  let connectFourOnChain;
  let owner, player1, player2, player3, player4;

  const TIER_0 = 0; // 2-player tier
  const INSTANCE_0 = 0;
  const ENTRY_FEE_TIER_0 = hre.ethers.parseEther("0.002");

  beforeEach(async function () {
    [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

    const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
    connectFourOnChain = await ConnectFourOnChain.deploy();
    await connectFourOnChain.waitForDeployment();
  });

  describe("Enrollment Tracking", function () {
    it("should add player to enrolling list on enrollment", async function () {
      // Player 1 enrolls
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check enrolling tournaments
      const enrolling = await connectFourOnChain.getPlayerEnrollingTournaments(player1.address);
      expect(enrolling.length).to.equal(1);
      expect(enrolling[0].tierId).to.equal(TIER_0);
      expect(enrolling[0].instanceId).to.equal(INSTANCE_0);

      // Check activity counts
      const [enrollingCount, activeCount] = await connectFourOnChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(1);
      expect(activeCount).to.equal(0);

      // Check isPlayerInTournament
      const [isEnrolling, isActive] = await connectFourOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(isEnrolling).to.be.true;
      expect(isActive).to.be.false;
    });
  });

  describe("Tournament Start Transition", function () {
    it("should move all players from enrolling to active on tournament start", async function () {
      // Both players enroll (triggers auto-start)
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await connectFourOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check player1: should be in active, not enrolling
      const [p1Enrolling, p1Active] = await connectFourOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.true;

      // Check player2: should be in active, not enrolling
      const [p2Enrolling, p2Active] = await connectFourOnChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.true;

      // Check via arrays
      const p1ActiveList = await connectFourOnChain.getPlayerActiveTournaments(player1.address);
      expect(p1ActiveList.length).to.equal(1);

      const p1EnrollingList = await connectFourOnChain.getPlayerEnrollingTournaments(player1.address);
      expect(p1EnrollingList.length).to.equal(0);
    });
  });

  describe("Match Completion and Cleanup", function () {
    it("should remove both players from active list on match completion", async function () {
      // Start tournament (2 players)
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await connectFourOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Verify both in active list
      let [p1Enrolling, p1Active] = await connectFourOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Active).to.be.true;

      // Get match info
      const matchData = await connectFourOnChain.getMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData.currentTurn;
      const firstPlayer = currentTurn === player1.address ? player1 : player2;
      const secondPlayer = currentTurn === player1.address ? player2 : player1;

      // Play winning game (first player gets leftmost column)
      // Connect Four: columns 0-6, need 4 in a row vertically
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);   // First player column 0
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);  // Second player column 1
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);   // First player column 0
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);  // Second player column 1
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);   // First player column 0
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);  // Second player column 1
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);   // First player column 0 - WINS!

      // Check that both players are removed from active list (match completed)
      [p1Enrolling, p1Active] = await connectFourOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await connectFourOnChain.isPlayerInTournament(
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
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await connectFourOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Get current player and play to completion
      const matchData = await connectFourOnChain.getMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData.currentTurn;
      const firstPlayer = currentTurn === player1.address ? player1 : player2;
      const secondPlayer = currentTurn === player1.address ? player2 : player1;

      // Play winning game
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0);
      await connectFourOnChain.connect(secondPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 1);
      await connectFourOnChain.connect(firstPlayer).makeMove(TIER_0, INSTANCE_0, 0, 0, 0); // Win

      // Verify all tracking cleared
      const [p1Enrolling, p1Active] = await connectFourOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await connectFourOnChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );

      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.false;
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.false;

      // Check counts are zero
      const [p1EnrollCount, p1ActiveCount] = await connectFourOnChain.getPlayerActivityCounts(player1.address);
      const [p2EnrollCount, p2ActiveCount] = await connectFourOnChain.getPlayerActivityCounts(player2.address);

      expect(p1EnrollCount).to.equal(0);
      expect(p1ActiveCount).to.equal(0);
      expect(p2EnrollCount).to.equal(0);
      expect(p2ActiveCount).to.equal(0);
    });
  });

  describe("View Functions", function () {
    it("should return empty arrays for new players", async function () {
      const enrolling = await connectFourOnChain.getPlayerEnrollingTournaments(player1.address);
      const active = await connectFourOnChain.getPlayerActiveTournaments(player1.address);

      expect(enrolling.length).to.equal(0);
      expect(active.length).to.equal(0);
    });

    it("should return correct counts", async function () {
      // Enroll player1 in two tournaments
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, 0, {
        value: ENTRY_FEE_TIER_0,
      });
      await connectFourOnChain.connect(player1).enrollInTournament(TIER_0, 1, {
        value: ENTRY_FEE_TIER_0,
      });

      const [enrollingCount, activeCount] = await connectFourOnChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(2);
      expect(activeCount).to.equal(0);
    });
  });
});
