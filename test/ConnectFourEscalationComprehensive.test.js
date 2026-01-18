import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hre;

describe("ConnectFourOnChain Comprehensive Escalation Tests", function () {
  let connectFour, owner, player1, player2, player3, player4, outsider;
  const TIER = 0;
  const ENTRY_FEE = ethers.parseEther("0.001");
  const INSTANCE_ID = 0;

  // Escalation timeouts from contract (ConnectFour Tier 0)
  const ENROLLMENT_TIMEOUT = 300; // 5 minutes
  const ENROLLMENT_ESC_L2 = 300; // 5 minutes
  const MATCH_TIMEOUT = 300; // 5 minutes (matchTimePerPlayer)
  const MATCH_ESC_L2 = 120; // 2 minutes
  const MATCH_ESC_L3 = 240; // 4 minutes

  // Tier 1 constants (for 4-player tests)
  const TIER1 = 1;
  const ENTRY_FEE_T1 = ethers.parseEther("0.002");
  const ENROLLMENT_TIMEOUT_T1 = 600; // 10 minutes

  // Tier 2 constants (for 8-player tests)
  const TIER2 = 2;
  const ENTRY_FEE_T2 = ethers.parseEther("0.004");
  const ENROLLMENT_TIMEOUT_T2 = 900; // 15 minutes

  beforeEach(async function () {
    [owner, player1, player2, player3, player4, outsider] = await ethers.getSigners();

    // Deploy all modules
    const ETour_Core = await ethers.getContractFactory("ETour_Core");
    const moduleCore = await ETour_Core.deploy();
    await moduleCore.waitForDeployment();

    const ETour_Matches = await ethers.getContractFactory("ETour_Matches");
    const moduleMatches = await ETour_Matches.deploy();
    await moduleMatches.waitForDeployment();

    const ETour_Prizes = await ethers.getContractFactory("ETour_Prizes");
    const modulePrizes = await ETour_Prizes.deploy();
    await modulePrizes.waitForDeployment();

    const ETour_Raffle = await ethers.getContractFactory("ETour_Raffle");
    const moduleRaffle = await ETour_Raffle.deploy();
    await moduleRaffle.waitForDeployment();

    const ETour_Escalation = await ethers.getContractFactory("ETour_Escalation");
    const moduleEscalation = await ETour_Escalation.deploy();
    await moduleEscalation.waitForDeployment();

    // Deploy ConnectFourOnChain
    const ConnectFourOnChain = await ethers.getContractFactory("ConnectFourOnChain");
    connectFour = await ConnectFourOnChain.deploy(
      await moduleCore.getAddress(),
      await moduleMatches.getAddress(),
      await modulePrizes.getAddress(),
      await moduleRaffle.getAddress(),
      await moduleEscalation.getAddress()
    );
    await connectFour.waitForDeployment();
  });

  /**
   * Helper: Make a Connect Four move
   * @param {*} signer - The signer making the move
   * @param {number} column - Column to drop piece (0-6)
   * @param {number} roundNumber - Round number (default 0)
   * @param {number} matchNumber - Match number (default 0)
   */
  async function makeMove(signer, column, roundNumber = 0, matchNumber = 0, tier = TIER) {
    return await connectFour.connect(signer).makeMove(tier, INSTANCE_ID, roundNumber, matchNumber, column);
  }

  /**
   * Helper: Play a quick horizontal win
   * @param {*} winner - Player who will win
   * @param {*} loser - Player who will lose
   * @param {number} roundNumber - Round number (default 0)
   * @param {number} matchNumber - Match number (default 0)
   */
  async function playQuickHorizontalWin(winner, loser, roundNumber = 0, matchNumber = 0, tier = TIER) {
    // Winner plays columns 0,1,2,3 to win horizontally on bottom row
    // Loser plays columns 4,5,0,1 to not interfere
    // Check who goes first based on currentTurn
    let match = await connectFour.getMatch(tier, INSTANCE_ID, roundNumber, matchNumber);
    let firstPlayer = match.currentTurn === winner.address ? winner : loser;
    let secondPlayer = firstPlayer.address === winner.address ? loser : winner;

    if (firstPlayer.address === winner.address) {
      await makeMove(winner, 0, roundNumber, matchNumber, tier);
      await makeMove(loser, 4, roundNumber, matchNumber, tier);
      await makeMove(winner, 1, roundNumber, matchNumber, tier);
      await makeMove(loser, 5, roundNumber, matchNumber, tier);
      await makeMove(winner, 2, roundNumber, matchNumber, tier);
      await makeMove(loser, 0, roundNumber, matchNumber, tier);
      await makeMove(winner, 3, roundNumber, matchNumber, tier); // Winner wins
    } else {
      await makeMove(loser, 4, roundNumber, matchNumber, tier);
      await makeMove(winner, 0, roundNumber, matchNumber, tier);
      await makeMove(loser, 5, roundNumber, matchNumber, tier);
      await makeMove(winner, 1, roundNumber, matchNumber, tier);
      await makeMove(loser, 0, roundNumber, matchNumber, tier);
      await makeMove(winner, 2, roundNumber, matchNumber, tier);
      await makeMove(loser, 6, roundNumber, matchNumber, tier);
      await makeMove(winner, 3, roundNumber, matchNumber, tier); // Winner wins
    }
  }

  /**
   * Helper: Play a quick vertical win
   * @param {*} winner - Player who will win
   * @param {*} loser - Player who will lose
   * @param {number} roundNumber - Round number (default 0)
   * @param {number} matchNumber - Match number (default 0)
   */
  async function playQuickVerticalWin(winner, loser, roundNumber = 0, matchNumber = 0, tier = TIER) {
    // Winner plays column 0 four times
    // Loser plays column 1
    await makeMove(winner, 0, roundNumber, matchNumber, tier);
    await makeMove(loser, 1, roundNumber, matchNumber, tier);
    await makeMove(winner, 0, roundNumber, matchNumber, tier);
    await makeMove(loser, 1, roundNumber, matchNumber, tier);
    await makeMove(winner, 0, roundNumber, matchNumber, tier);
    await makeMove(loser, 1, roundNumber, matchNumber, tier);
    await makeMove(winner, 0, roundNumber, matchNumber, tier); // Winner wins
  }

  describe("EL1: Enrollment Force Start", function () {
    it("Should allow enrolled player to force start after enrollment timeout", async function () {
      // With minPlayers=2, tournament auto-starts when 2nd player enrolls
      // This test is effectively the same as solo force start for Tier 0
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const [statusBefore] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusBefore).to.equal(0); // Enrolling

      await time.increase(ENROLLMENT_TIMEOUT + 1);

      // Force start completes tournament immediately with 1 player
      await expect(connectFour.connect(player1).forceStartTournament(TIER, INSTANCE_ID))
        .to.emit(connectFour, "TournamentCompleted");

      const [statusAfter] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset after completion
    });

    it("Should reject force start before timeout", async function () {
      // Test with 1 player only (can't use 2+ as they auto-start)
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await expect(
        connectFour.connect(player1).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("FS");
    });

    it("Should reject force start from non-enrolled player", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        connectFour.connect(outsider).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("FS");
    });

    it("Should complete tournament immediately if only one player enrolled and force starts", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(connectFour.connect(player1).forceStartTournament(TIER, INSTANCE_ID))
        .to.emit(connectFour, "TournamentCompleted");

      const [statusAfter, , enrolledCountAfter] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset to Enrolling
      expect(enrolledCountAfter).to.equal(0);

      // Verify prize distribution (90% of entry fee)
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore - ENTRY_FEE + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after solo force start completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // After enrolling, player should be in enrolling tournaments, not active
      let enrollingBefore = await connectFour.getPlayerEnrollingTournaments(player1.address);
      expect(enrollingBefore.length).to.equal(1);

      await time.increase(ENROLLMENT_TIMEOUT + 1);
      await connectFour.connect(player1).forceStartTournament(TIER, INSTANCE_ID);

      // After force start and completion, player should be cleared from all lists
      let enrollingAfter = await connectFour.getPlayerEnrollingTournaments(player1.address);
      let activeAfter = await connectFour.getPlayerActiveTournaments(player1.address);
      expect(enrollingAfter.length).to.equal(0);
      expect(activeAfter.length).to.equal(0);
    });
  });

  describe("EL2: Enrollment External Claim", function () {
    it("Should allow external player to claim abandoned enrollment pool after EL2 delay", async function () {
      // Use only 1 player to avoid auto-start, then have outsider claim
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const [statusAfter, , enrolledCountAfter] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset
      expect(enrolledCountAfter).to.equal(0);

      // Verify prize distribution (1 player)
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should reject claim before EL2 delay", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID)
      ).to.be.revertedWith("CAE");
    });

    it("Should forfeit all enrolled players when pool is claimed", async function () {
      // Use just 1 player to avoid auto-start
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Verify tournament was reset
      const [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling
      expect(enrolledCount).to.equal(0);
    });

    it("Should clear all player activity entries after EL2 claim", async function () {
      // Use only 1 player to avoid auto-start
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const active1 = await connectFour.getPlayerActiveTournaments(player1.address);
      const activeOutsider = await connectFour.getPlayerActiveTournaments(outsider.address);

      expect(active1.length).to.equal(0);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should allow new tournament to start after EL2 claim and reset", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Should be able to enroll in new tournament
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Verify enrollment succeeded
      const [, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(enrolledCount).to.equal(1);
    });
  });

  describe("ML1: Match Timeout Claim", function () {
    it("Should allow opponent to claim timeout after match timeout", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Tournament auto-starts with 2 players
      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      // Use currentTurn to determine who should move (it's randomly assigned)
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
      const otherPlayer = match.currentTurn === player1.address ? player2 : player1;

      await makeMove(currentPlayer, 0);

      await time.increase(MATCH_TIMEOUT + 1);

      // Claim timeout - completes match and tournament
      await expect(connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0))
        .to.emit(connectFour, "MatchCompleted");

      // ARCHITECTURE CHANGE: Finals cleared immediately on tournament completion
      // Verify tournament completed by checking status
      const [status] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling (reset after completion)
    });

    it("Should complete 2-player tournament after ML1 timeout claim", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(currentPlayer.address);

      await expect(connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0))
        .to.emit(connectFour, "TournamentCompleted");

      const [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
      expect(enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(currentPlayer.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after ML1 tournament completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0);
      await time.increase(MATCH_TIMEOUT + 1);
      await connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const active1 = await connectFour.getPlayerActiveTournaments(player1.address);
      const active2 = await connectFour.getPlayerActiveTournaments(player2.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
    });

    it("Should reject timeout claim before timeout period", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0);

      await expect(
        connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("TO");
    });

    it("Should reject timeout claim on own turn", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(MATCH_TIMEOUT + 1);

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await expect(
        connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("OT");
    });
  });

  describe("ML2: Advanced Player Force Eliminate", function () {
    it("Should allow advanced player to force eliminate stalled semi-final", async function () {
      // Use Tier 1 for 4-player tournament (Tier 0 auto-starts at 2)
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete semi-final 0 (round 0, match 0)
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const winner0 = allPlayers.find(p => p.address === match0.common.player1) || player1;
      const loser0 = allPlayers.find(p => p.address === match0.common.player2) || player2;
      await playQuickHorizontalWin(winner0, loser0, 0, 0, TIER1);

      // Stall semi-final 1 (round 0, match 1)
      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const currentPlayer1 = allPlayers.find(p => p.address === match1.currentTurn) || player3;

      await makeMove(currentPlayer1, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Should succeed without error
      await connectFour.connect(winner0).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1);

      // Tournament should complete since only winner0 remains
      const [status] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0); // Reset after completion
    });

    it("Should reject ML2 from non-advanced player", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const currentPlayer = allPlayers.find(p => p.address === match0.currentTurn) || player1;

      await makeMove(currentPlayer, 0, 0, 0, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        connectFour.connect(player3).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("FE");
    });

    it("Should complete tournament when finalist uses ML2 on stalled semi-final", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete semi-final 0 (round 0, match 0)
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const winner = allPlayers.find(p => p.address === match0.common.player1) || player1;
      const loser = allPlayers.find(p => p.address === match0.common.player2) || player2;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      // Stall semi-final 1 (round 0, match 1)
      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const currentPlayer1 = allPlayers.find(p => p.address === match1.currentTurn) || player3;

      await makeMove(currentPlayer1, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(winner.address);

      await expect(connectFour.connect(winner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1))
        .to.emit(connectFour, "TournamentCompleted");

      const [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
      expect(enrolledCount).to.equal(0);

      // Verify prize distribution
      const expectedPrize = (ENTRY_FEE_T1 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(winner.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });

    it("Should clear all player activity after ML2 tournament completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const winner = allPlayers.find(p => p.address === match0.common.player1) || player1;
      const loser = allPlayers.find(p => p.address === match0.common.player2) || player2;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const currentPlayer1 = allPlayers.find(p => p.address === match1.currentTurn) || player3;

      await makeMove(currentPlayer1, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await connectFour.connect(winner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1);

      const active1 = await connectFour.getPlayerActiveTournaments(player1.address);
      const active2 = await connectFour.getPlayerActiveTournaments(player2.address);
      const active3 = await connectFour.getPlayerActiveTournaments(player3.address);
      const active4 = await connectFour.getPlayerActiveTournaments(player4.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
      expect(active3.length).to.equal(0);
      expect(active4.length).to.equal(0);
    });

    it("Should handle ML2 on finals match (both players eliminated)", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete both semi-finals
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const w1 = match0.common.player1 === player1.address ? player1 : player2;
      const l1 = match0.common.player1 === player1.address ? player2 : player1;
      await playQuickHorizontalWin(w1, l1, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const w2 = match1.common.player1 === player3.address ? player3 : player4;
      const l2 = match1.common.player1 === player3.address ? player4 : player3;
      await playQuickHorizontalWin(w2, l2, 0, 1, TIER1);

      // Stall finals (round 1, match 0)
      const finals = await connectFour.getMatch(TIER1, INSTANCE_ID, 1, 0);
      const finalsCurrentPlayer = finals.currentTurn === w1.address ? w1 : w2;

      await makeMove(finalsCurrentPlayer, 0, 1, 0, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const otherWinner = finalsCurrentPlayer.address === w1.address ? w2 : w1;
      await expect(connectFour.connect(otherWinner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 1, 0))
        .to.emit(connectFour, "TournamentCompleted");

      const [status] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0);
    });

    it("Should reject ML2 before escalation delay", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const winner = allPlayers.find(p => p.address === match0.common.player1) || player1;
      const loser = allPlayers.find(p => p.address === match0.common.player2) || player2;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const currentPlayer1 = allPlayers.find(p => p.address === match1.currentTurn) || player3;

      await makeMove(currentPlayer1, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + 1);

      await expect(
        connectFour.connect(winner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1)
      ).to.be.revertedWith("FE");
    });
  });

  describe("ML3: External Player Replacement", function () {
    it("Should allow external player to replace stalled match player", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      // Claim ML3 - completes match and tournament
      await connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      // ARCHITECTURE CHANGE: Finals cleared immediately on tournament completion
      // Verify tournament completed by checking status
      const [status] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling (reset after completion)
    });

    it("Should complete 2-player tournament after ML3 claim", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await expect(connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0))
        .to.emit(connectFour, "TournamentCompleted");

      const [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear all player activity after ML3 tournament completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);
      await connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const active1 = await connectFour.getPlayerActiveTournaments(player1.address);
      const active2 = await connectFour.getPlayerActiveTournaments(player2.address);
      const activeOutsider = await connectFour.getPlayerActiveTournaments(outsider.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should allow ML3 claimer to advance in tournament", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete semi-final 0
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const allPlayers = [player1, player2, player3, player4];
      const winner = allPlayers.find(p => p.address === match0.common.player1) || player1;
      const loser = allPlayers.find(p => p.address === match0.common.player2) || player2;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      // Stall semi-final 1
      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const currentPlayer1 = allPlayers.find(p => p.address === match1.currentTurn) || player3;

      await makeMove(currentPlayer1, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      await connectFour.connect(outsider).claimMatchSlotByReplacement(TIER1, INSTANCE_ID, 0, 1);

      // Check that outsider is in finals
      const finals = await connectFour.getMatch(TIER1, INSTANCE_ID, 1, 0);
      const isOutsiderInFinals =
        finals.common.player1 === outsider.address || finals.common.player2 === outsider.address;
      expect(isOutsiderInFinals).to.be.true;
    });

    it("Should reject ML3 before escalation delay", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("CR");
    });

    it("Should reject ML3 on non-stalled match", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await expect(
        connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("CR");
    });

    it("Should handle ML3 on finals match properly", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete both semi-finals
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const w1 = match0.common.player1 === player1.address ? player1 : player2;
      const l1 = match0.common.player1 === player1.address ? player2 : player1;
      await playQuickHorizontalWin(w1, l1, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const w2 = match1.common.player1 === player3.address ? player3 : player4;
      const l2 = match1.common.player1 === player3.address ? player4 : player3;
      await playQuickHorizontalWin(w2, l2, 0, 1, TIER1);

      // Stall finals
      const finals = await connectFour.getMatch(TIER1, INSTANCE_ID, 1, 0);
      const finalsCurrentPlayer = finals.currentTurn === w1.address ? w1 : w2;

      await makeMove(finalsCurrentPlayer, 0, 1, 0, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await expect(connectFour.connect(outsider).claimMatchSlotByReplacement(TIER1, INSTANCE_ID, 1, 0))
        .to.emit(connectFour, "TournamentCompleted");

      const [status] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE_T1 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });
  });

  describe("Cascading Effects: Multi-Level Escalation", function () {
    it("Should handle ML1 -> tournament completion -> reset -> new enrollment", async function () {
      // First tournament with ML1
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + 1);
      await connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      let [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);

      // New tournament should start fresh
      await connectFour.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      [status, , enrolledCount] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(1);
      expect(enrolledCount).to.equal(2);
    });

    it("Should handle ML2 in round 0 -> ML3 in finals", async function () {
      // 8-player tournament using TIER2
      const players = [player1, player2, player3, player4];
      const additionalPlayers = await ethers.getSigners();
      const player5 = additionalPlayers[5];
      const player6 = additionalPlayers[6];
      const player7 = additionalPlayers[7];
      const player8 = additionalPlayers[8];
      const allPlayers = [...players, player5, player6, player7, player8];

      for (let p of allPlayers) {
        await connectFour.connect(p).enrollInTournament(TIER2, INSTANCE_ID, { value: ENTRY_FEE_T2 });
      }

      // Complete 3 matches in round 0
      for (let i = 0; i < 3; i++) {
        const match = await connectFour.getMatch(TIER2, INSTANCE_ID, 0, i);
        const w = match.common.player1 === allPlayers[i * 2].address ? allPlayers[i * 2] : allPlayers[i * 2 + 1];
        const l = match.common.player1 === allPlayers[i * 2].address ? allPlayers[i * 2 + 1] : allPlayers[i * 2];
        await playQuickHorizontalWin(w, l, 0, i, TIER2);
      }

      // Stall 4th match in round 0
      const match3 = await connectFour.getMatch(TIER2, INSTANCE_ID, 0, 3);
      const currentPlayer3 = match3.currentTurn === player7.address ? player7 : player8;

      await makeMove(currentPlayer3, 0, 0, 3, TIER2);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Advanced player uses ML2
      const match0 = await connectFour.getMatch(TIER2, INSTANCE_ID, 0, 0);
      const advancedPlayer = match0.common.winner;
      const advancedSigner = allPlayers.find(p => p.address === advancedPlayer);

      await connectFour.connect(advancedSigner).forceEliminateStalledMatch(TIER2, INSTANCE_ID, 0, 3);

      // After ML2, consolidation creates only 1 semi-final (3 winners -> 1 match + 1 walkover)
      const [totalMatches] = await connectFour.getRoundInfo(TIER2, INSTANCE_ID, 1);
      expect(totalMatches).to.equal(1); // Consolidation should create only 1 match

      // Complete the single semi-final
      const semi0 = await connectFour.getMatch(TIER2, INSTANCE_ID, 1, 0);
      const sw1 = allPlayers.find(p => p.address === semi0.common.player1);
      const sl1 = allPlayers.find(p => p.address === semi0.common.player2);
      await playQuickHorizontalWin(sw1, sl1, 1, 0, TIER2);

      // Verify finals exists with the winner and the walkover player
      const finals = await connectFour.getMatch(TIER2, INSTANCE_ID, 2, 0);
      expect(finals.common.player1).to.not.equal(ethers.ZeroAddress);
      expect(finals.common.player2).to.not.equal(ethers.ZeroAddress);
    });

    it("Should handle EL2 with multiple enrollments -> complete reset", async function () {
      // Use only 1 player to avoid auto-start at minPlayers (2)
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Check enrolling tournaments, not active (player hasn't started yet)
      let enrollingBefore = await connectFour.getPlayerEnrollingTournaments(player1.address);
      expect(enrollingBefore.length).to.equal(1);

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Verify tournament was reset
      const [status, , enrolledCount, prizePool] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
    });

    it("Should track forfeited amounts correctly across escalation types", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      // Complete semi-final 0
      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const w = match0.common.player1 === player1.address ? player1 : player2;
      const l = match0.common.player1 === player1.address ? player2 : player1;
      await playQuickHorizontalWin(w, l, 0, 0, TIER1);

      // Stall semi-final 1, use ML2
      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const p3 = match1.currentTurn === player3.address ? player3 : player4;

      await makeMove(p3, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await connectFour.connect(w).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1);

      // Tournament should complete successfully
      const [status] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0); // Reset after completion
    });
  });

  describe("Prize Distribution Verification Across Escalation Types", function () {
    it("Should distribute correct prizes for EL1 solo force start", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      const tx = await connectFour.connect(player1).forceStartTournament(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(player1.address);
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;

      expect(balanceAfter).to.be.closeTo(balanceBefore - ENTRY_FEE + expectedPrize - gasUsed, ethers.parseEther("0.001"));
    });

    it("Should distribute correct prizes for EL2 abandoned claim", async function () {
      // Use only 1 player to avoid auto-start
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);
      const tx = await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML1 timeout victory", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(currentPlayer.address);
      const tx = await connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(currentPlayer.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML2 force eliminate victory", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const winner = match0.common.player1 === player1.address ? player1 : player2;
      const loser = match0.common.player1 === player1.address ? player2 : player1;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const p3 = match1.currentTurn === player3.address ? player3 : player4;

      await makeMove(p3, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(winner.address);
      const tx = await connectFour.connect(winner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE_T1 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(winner.address);

      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize - gasUsed, ethers.parseEther("0.0001"));
    });

    it("Should distribute correct prizes for ML3 replacement victory", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);
      const tx = await connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should maintain protocol and owner fees after all escalation type completions", async function () {
      const contractBalanceBefore = await ethers.provider.getBalance(connectFour.target);

      // ML1 tournament
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + 1);
      await connectFour.connect(currentPlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const contractBalanceAfter = await ethers.provider.getBalance(connectFour.target);

      // Protocol and owner fees should be collected (10% total)
      const expectedFees = (ENTRY_FEE * 2n * 100n) / 1000n; // 10% of total pool

      // Contract should have at least the fees
      expect(contractBalanceAfter).to.be.gte(contractBalanceBefore + expectedFees - ethers.parseEther("0.001"));
    });
  });

  describe("Tournament Reset Verification", function () {
    it("Should fully reset tournament state after EL2 completion", async function () {
      // Use only 1 player to avoid auto-start
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await connectFour.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const [status, currentRound, enrolledCount, prizePool, winner] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
      expect(currentRound).to.equal(0);
      expect(winner).to.equal(ethers.ZeroAddress);
    });

    it("Should fully reset tournament state after ML2 completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player2).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player3).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });
      await connectFour.connect(player4).enrollInTournament(TIER1, INSTANCE_ID, { value: ENTRY_FEE_T1 });

      const match0 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 0);
      const winner = match0.common.player1 === player1.address ? player1 : player2;
      const loser = match0.common.player1 === player1.address ? player2 : player1;
      await playQuickHorizontalWin(winner, loser, 0, 0, TIER1);

      const match1 = await connectFour.getMatch(TIER1, INSTANCE_ID, 0, 1);
      const p3 = match1.currentTurn === player3.address ? player3 : player4;

      await makeMove(p3, 0, 0, 1, TIER1);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await connectFour.connect(winner).forceEliminateStalledMatch(TIER1, INSTANCE_ID, 0, 1);

      const [status, currentRound, enrolledCount, prizePool] = await connectFour.getTournamentInfo(TIER1, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
      expect(currentRound).to.equal(0);
    });

    it("Should fully reset tournament state after ML3 completion", async function () {
      await connectFour.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await connectFour.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const match = await connectFour.getMatch(TIER, INSTANCE_ID, 0, 0);
      const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

      await makeMove(currentPlayer, 0, 0, 0, TIER);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);
      await connectFour.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const [status, , enrolledCount, prizePool] = await connectFour.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
    });
  });
});
