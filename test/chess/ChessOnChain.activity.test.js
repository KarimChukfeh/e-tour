import { expect } from "chai";
import hre from "hardhat";

describe("ChessOnChain Player Activity Tracking", function () {
  let chessOnChain;
  let owner, player1, player2, player3, player4;

  const TIER_0 = 0; // 2-player tier
  const INSTANCE_0 = 0;
  const ENTRY_FEE_TIER_0 = hre.ethers.parseEther("0.01");

  beforeEach(async function () {
    [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

    const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
    chessOnChain = await ChessOnChain.deploy();
    await chessOnChain.waitForDeployment();
  });

  describe("Enrollment Tracking", function () {
    it("should add player to enrolling list on enrollment", async function () {
      // Player 1 enrolls
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check enrolling tournaments
      const enrolling = await chessOnChain.getPlayerEnrollingTournaments(player1.address);
      expect(enrolling.length).to.equal(1);
      expect(enrolling[0].tierId).to.equal(TIER_0);
      expect(enrolling[0].instanceId).to.equal(INSTANCE_0);

      // Check activity counts
      const [enrollingCount, activeCount] = await chessOnChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(1);
      expect(activeCount).to.equal(0);

      // Check isPlayerInTournament
      const [isEnrolling, isActive] = await chessOnChain.isPlayerInTournament(
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
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await chessOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Check player1: should be in active, not enrolling
      const [p1Enrolling, p1Active] = await chessOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.true;

      // Check player2: should be in active, not enrolling
      const [p2Enrolling, p2Active] = await chessOnChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.true;

      // Check via arrays
      const p1ActiveList = await chessOnChain.getPlayerActiveTournaments(player1.address);
      expect(p1ActiveList.length).to.equal(1);

      const p1EnrollingList = await chessOnChain.getPlayerEnrollingTournaments(player1.address);
      expect(p1EnrollingList.length).to.equal(0);
    });
  });

  describe("Match Completion and Cleanup", function () {
    it("should remove both players from active list on match completion", async function () {
      // Start tournament (2 players)
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await chessOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Verify both in active list
      let [p1Enrolling, p1Active] = await chessOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      expect(p1Active).to.be.true;

      // Get match info
      const matchData = await chessOnChain.getChessMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData[2]; // currentTurn is 3rd element in tuple
      const player = currentTurn === player1.address ? player1 : player2;
      const opponent = currentTurn === player1.address ? player2 : player1;

      // Player resigns (fastest way to end match)
      await chessOnChain.connect(player).resign(TIER_0, INSTANCE_0, 0, 0);

      // Check that both players are removed from active list (match completed)
      [p1Enrolling, p1Active] = await chessOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await chessOnChain.isPlayerInTournament(
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
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });
      await chessOnChain.connect(player2).enrollInTournament(TIER_0, INSTANCE_0, {
        value: ENTRY_FEE_TIER_0,
      });

      // Get current player and resign to complete
      const matchData = await chessOnChain.getChessMatch(TIER_0, INSTANCE_0, 0, 0);
      const currentTurn = matchData[2]; // currentTurn is 3rd element in tuple
      const player = currentTurn === player1.address ? player1 : player2;

      // Resign to complete match
      await chessOnChain.connect(player).resign(TIER_0, INSTANCE_0, 0, 0);

      // Verify all tracking cleared
      const [p1Enrolling, p1Active] = await chessOnChain.isPlayerInTournament(
        player1.address,
        TIER_0,
        INSTANCE_0
      );
      const [p2Enrolling, p2Active] = await chessOnChain.isPlayerInTournament(
        player2.address,
        TIER_0,
        INSTANCE_0
      );

      expect(p1Enrolling).to.be.false;
      expect(p1Active).to.be.false;
      expect(p2Enrolling).to.be.false;
      expect(p2Active).to.be.false;

      // Check counts are zero
      const [p1EnrollCount, p1ActiveCount] = await chessOnChain.getPlayerActivityCounts(player1.address);
      const [p2EnrollCount, p2ActiveCount] = await chessOnChain.getPlayerActivityCounts(player2.address);

      expect(p1EnrollCount).to.equal(0);
      expect(p1ActiveCount).to.equal(0);
      expect(p2EnrollCount).to.equal(0);
      expect(p2ActiveCount).to.equal(0);
    });
  });

  describe("View Functions", function () {
    it("should return empty arrays for new players", async function () {
      const enrolling = await chessOnChain.getPlayerEnrollingTournaments(player1.address);
      const active = await chessOnChain.getPlayerActiveTournaments(player1.address);

      expect(enrolling.length).to.equal(0);
      expect(active.length).to.equal(0);
    });

    it("should return correct counts", async function () {
      // Enroll player1 in two tournaments
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, 0, {
        value: ENTRY_FEE_TIER_0,
      });
      await chessOnChain.connect(player1).enrollInTournament(TIER_0, 1, {
        value: ENTRY_FEE_TIER_0,
      });

      const [enrollingCount, activeCount] = await chessOnChain.getPlayerActivityCounts(player1.address);
      expect(enrollingCount).to.equal(2);
      expect(activeCount).to.equal(0);
    });
  });
});
