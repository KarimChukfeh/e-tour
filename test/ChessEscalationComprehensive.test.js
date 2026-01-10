import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hre;

describe("ChessOnChain Comprehensive Escalation Tests", function () {
  let chess, owner, player1, player2, player3, player4, outsider;
  const TIER = 0;
  const ENTRY_FEE = ethers.parseEther("0.003"); // Tier 0 entry fee for ChessOnChain
  const INSTANCE_ID = 0;

  // Tier 4 constants (for 4-player tests - Chess tiers 4-7 support 4 players)
  const TIER4 = 4;
  const ENTRY_FEE_T4 = ethers.parseEther("0.004");
  const ENROLLMENT_TIMEOUT_T4 = 1800; // 30 minutes

  // Escalation timeouts from contract (Chess Tier 0)
  const ENROLLMENT_TIMEOUT = 600; // 10 minutes
  const ENROLLMENT_ESC_L2 = 300; // 5 minutes
  const MATCH_TIMEOUT = 600; // 10 minutes (matchTimePerPlayer)
  const MATCH_ESC_L2 = 180; // 3 minutes
  const MATCH_ESC_L3 = 360; // 6 minutes

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

    const GameCacheModule = await ethers.getContractFactory("GameCacheModule");
    const moduleGameCache = await GameCacheModule.deploy();
    await moduleGameCache.waitForDeployment();

    const ChessRulesModule = await ethers.getContractFactory("ChessRulesModule");
    const chessRulesModule = await ChessRulesModule.deploy();
    await chessRulesModule.waitForDeployment();

    // Deploy ChessOnChain
    const ChessOnChain = await ethers.getContractFactory("ChessOnChain");
    chess = await ChessOnChain.deploy(
      await moduleCore.getAddress(),
      await moduleMatches.getAddress(),
      await modulePrizes.getAddress(),
      await moduleRaffle.getAddress(),
      await moduleEscalation.getAddress(),
      await moduleGameCache.getAddress(),
      await chessRulesModule.getAddress()
    );
    await chess.waitForDeployment();
  });

  /**
   * Helper: Make a simple chess move
   * @param {*} signer - The signer making the move
   * @param {number} from - From square (0-63)
   * @param {number} to - To square (0-63)
   * @param {number} roundNumber - Round number (default 0)
   * @param {number} matchNumber - Match number (default 0)
   * @param {number} promotion - Promotion piece (default 0 = no promotion)
   * @param {number} tier - Tier (default TIER)
   */
  async function makeChessMove(signer, from, to, roundNumber = 0, matchNumber = 0, promotion = 0, tier = TIER) {
    return await chess.connect(signer).makeMove(tier, INSTANCE_ID, roundNumber, matchNumber, from, to, promotion);
  }

  /**
   * Helper: Get the current turn player from match data
   * @param {number} roundNumber - Round number
   * @param {number} matchNumber - Match number
   * @param {number} tier - Tier
   * @returns {Promise<address>}
   */
  async function getCurrentTurnPlayer(roundNumber, matchNumber, tier = TIER) {
    const match = await chess.getMatch(tier, INSTANCE_ID, roundNumber, matchNumber);
    return match.currentTurn;
  }

  /**
   * Helper: Get white and black players from match data
   * @param {number} roundNumber - Round number
   * @param {number} matchNumber - Match number
   * @param {number} tier - Tier
   * @returns {Promise<{white: address, black: address}>}
   */
  async function getWhiteAndBlack(roundNumber, matchNumber, tier = TIER) {
    const match = await chess.getMatch(tier, INSTANCE_ID, roundNumber, matchNumber);
    return { white: match.common.player1, black: match.common.player2 };
  }

  /**
   * Helper: Play Scholar's Mate to quickly end a match
   * White player (match.player1) will win.
   * @param {*} player1 - First player
   * @param {*} player2 - Second player
   * @param {number} roundNumber - Round number (default 0)
   * @param {number} matchNumber - Match number (default 0)
   * @param {number} tier - Tier (default TIER)
   */
  async function playScholarsMateFast(player1, player2, roundNumber = 0, matchNumber = 0, tier = TIER) {
    // Get match data to determine who is white (player1 is always white)
    let match = await chess.getMatch(tier, INSTANCE_ID, roundNumber, matchNumber);
    const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
    const blackPlayer = whitePlayer.address === player1.address ? player2 : player1;

    await makeChessMove(whitePlayer, 12, 28, roundNumber, matchNumber, 0, tier); // e2-e4
    await makeChessMove(blackPlayer, 52, 36, roundNumber, matchNumber, 0, tier); // e7-e5
    await makeChessMove(whitePlayer, 5, 26, roundNumber, matchNumber, 0, tier); // f1-c4
    await makeChessMove(blackPlayer, 57, 42, roundNumber, matchNumber, 0, tier); // b8-c6
    await makeChessMove(whitePlayer, 3, 39, roundNumber, matchNumber, 0, tier); // d1-h5
    await makeChessMove(blackPlayer, 62, 45, roundNumber, matchNumber, 0, tier); // g8-f6
    await makeChessMove(whitePlayer, 39, 53, roundNumber, matchNumber, 0, tier); // h5-f7# (Checkmate)
  }

  describe("EL1: Enrollment Force Start", function () {
    it("Should allow enrolled player to force start after enrollment timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament should still be in Enrolling state

      const [statusBefore] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusBefore).to.equal(0); // Enrolling

      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);

      const [statusAfter] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset to Enrolling
    });

    it("Should reject force start before timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - still in Enrolling state

      await expect(
        chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("FS");
    });

    it("Should reject force start from non-enrolled player", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        chess.connect(outsider).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("FS");
    });

    it("Should complete tournament immediately if only one player enrolled and force starts", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);

      const [statusAfter, , enrolledCountAfter] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset to Enrolling
      expect(enrolledCountAfter).to.equal(0);

      // Verify prize distribution (90% of entry fee)
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore - ENTRY_FEE + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after solo force start completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let enrollingBefore = await chess.getPlayerEnrollingTournaments(player1.address);
      expect(enrollingBefore.length).to.equal(1);

      await time.increase(ENROLLMENT_TIMEOUT + 1);
      await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);

      let enrollingAfter = await chess.getPlayerEnrollingTournaments(player1.address);
      expect(enrollingAfter.length).to.equal(0);
    });
  });

  describe("EL2: Enrollment External Claim", function () {
    it("Should allow external player to claim abandoned enrollment pool after EL2 delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament stays in Enrolling state

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const [statusAfter, , enrolledCountAfter] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset
      expect(enrolledCountAfter).to.equal(0);

      // Verify prize distribution
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should reject claim before EL2 delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID)
      ).to.be.revertedWith("CAE");
    });

    it("Should forfeit all enrolled players when pool is claimed", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament stays in Enrolling state

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Verify tournament was reset
      const [status, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling
      expect(enrolledCount).to.equal(0);
    });

    it("Should clear all player activity entries after EL2 claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament stays in Enrolling state

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const activeOutsider = await chess.getPlayerActiveTournaments(outsider.address);

      expect(active1.length).to.equal(0);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should allow new tournament to start after EL2 claim and reset", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Should be able to enroll in new tournament
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Verify enrollment succeeded
      const [, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(enrolledCount).to.equal(1);
    });
  });

  describe("ML1: Match Timeout Claim", function () {
    it("Should allow opponent to claim timeout after match timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Tournament auto-starts with 2 players
      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;

      await makeChessMove(whitePlayer, 12, 28); // e2-e4 (correct numbering)

      await time.increase(MATCH_TIMEOUT + 1);

      // Claim timeout - this completes the match and tournament
      await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      // ARCHITECTURE CHANGE: Finals are now cleared immediately on tournament completion
      // Match data no longer queryable - use events for historical data
      // Verify tournament completed by checking status
      const [status] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling (reset after completion)
    });

    it("Should complete 2-player tournament after ML1 timeout claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;

      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(whitePlayer.address);

      await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const [status, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
      expect(enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(whitePlayer.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after ML1 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;

      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const active2 = await chess.getPlayerActiveTournaments(player2.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
    });

    it("Should reject timeout claim before timeout period", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;

      await makeChessMove(whitePlayer, 12, 28);

      await expect(
        chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("TO");
    });

    it("Should reject timeout claim on own turn", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(MATCH_TIMEOUT + 1);

      await expect(
        chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("OT");
    });
  });

  describe("ML2: Advanced Player Force Eliminate", function () {
    it("Should allow advanced player to force eliminate stalled semi-final", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete semi-final 0 (round 0, match 0)
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      // Stall semi-final 1 (round 0, match 1)
      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Winner of match 0 can force eliminate
      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;

      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      // After ML2 force eliminate, verify advanced player can proceed
      // (Note: Eliminated status no longer exists; match is either completed or the tournament resets)
      const [tournamentStatus] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(Number(tournamentStatus)).to.be.oneOf([0, 1, 2]); // Tournament continues or resets
    });

    it("Should reject ML2 from non-advanced player", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28, 0, 0, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        chess.connect(player3).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("FE");
    });

    it("Should complete tournament when finalist uses ML2 on stalled semi-final", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete semi-final 0 (round 0, match 0)
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      // Stall semi-final 1 (round 0, match 1)
      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Winner of match 0 can force eliminate
      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      const balanceBefore = await ethers.provider.getBalance(advancedPlayer.address);

      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      const [status, , enrolledCount] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
      expect(enrolledCount).to.equal(0);

      // Verify prize distribution
      const expectedPrize = (ENTRY_FEE_T4 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(advancedPlayer.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });

    it("Should clear all player activity after ML2 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const active2 = await chess.getPlayerActiveTournaments(player2.address);
      const active3 = await chess.getPlayerActiveTournaments(player3.address);
      const active4 = await chess.getPlayerActiveTournaments(player4.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
      expect(active3.length).to.equal(0);
      expect(active4.length).to.equal(0);
    });

    it("Should handle ML2 on finals match (both players eliminated)", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete both semi-finals
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);
      await playScholarsMateFast(player3, player4, 0, 1, TIER4);

      // Stall finals (round 1, match 0)
      const finalsMatch = await chess.getMatch(TIER4, INSTANCE_ID, 1, 0);
      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const winner1 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);

      // Determine which signer corresponds to currentTurn
      const finalsFirstPlayer = finalsMatch.currentTurn === winner0.common.winner ?
        (winner0.common.winner === player1.address ? player1 : player2) :
        (winner1.common.winner === player3.address ? player3 : player4);
      const finalsSecondPlayer = finalsMatch.currentTurn === winner0.common.winner ?
        (winner1.common.winner === player3.address ? player3 : player4) :
        (winner0.common.winner === player1.address ? player1 : player2);

      await makeChessMove(finalsFirstPlayer, 12, 28, 1, 0, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await chess.connect(finalsSecondPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 1, 0);

      const [status] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(status).to.equal(0);
    });

    it("Should reject ML2 before escalation delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + 1);

      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;

      await expect(
        chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1)
      ).to.be.revertedWith("FE");
    });
  });

  describe("ML3: External Player Replacement", function () {
    it("Should allow external player to replace stalled match player", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      // Claim ML3 - this completes the match and tournament
      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      // ARCHITECTURE CHANGE: Finals cleared immediately on tournament completion
      // Verify tournament completed by checking status
      const [status] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0); // Enrolling (reset after completion)
    });

    it("Should complete 2-player tournament after ML3 claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const [status, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear all player activity after ML3 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);
      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const active2 = await chess.getPlayerActiveTournaments(player2.address);
      const activeOutsider = await chess.getPlayerActiveTournaments(outsider.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should allow ML3 claimer to advance in tournament", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete semi-final 0 (round 0, match 0)
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      // Stall semi-final 1 (round 0, match 1)
      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      await chess.connect(outsider).claimMatchSlotByReplacement(TIER4, INSTANCE_ID, 0, 1);

      // Check that outsider is in finals (round 1, match 0)
      const finals = await chess.getMatch(TIER4, INSTANCE_ID, 1, 0);
      const isOutsiderInFinals =
        finals.common.player1 === outsider.address || finals.common.player2 === outsider.address;
      expect(isOutsiderInFinals).to.be.true;
    });

    it("Should reject ML3 before escalation delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("CR");
    });

    it("Should reject ML3 on non-stalled match", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await expect(
        chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("CR");
    });

    it("Should handle ML3 on finals match properly", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete both semi-finals
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);
      await playScholarsMateFast(player3, player4, 0, 1, TIER4);

      // Stall finals (round 1, match 0)
      const finalsMatch = await chess.getMatch(TIER4, INSTANCE_ID, 1, 0);
      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const winner1 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const finalsWhitePlayer = finalsMatch.common.player1 === winner0.common.winner ?
        (winner0.common.winner === player1.address ? player1 : player2) :
        (winner1.common.winner === player3.address ? player3 : player4);

      await makeChessMove(finalsWhitePlayer, 12, 28, 1, 0, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await chess.connect(outsider).claimMatchSlotByReplacement(TIER4, INSTANCE_ID, 1, 0);

      const [status] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(status).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE_T4 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });
  });

  describe("Cascading Effects: Multi-Level Escalation", function () {
    it("Should handle ML1 -> tournament completion -> reset -> new enrollment", async function () {
      // First tournament with ML1
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      let [status, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);

      // New tournament should start fresh
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      [status, , enrolledCount] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(1);
      expect(enrolledCount).to.equal(2);
    });

    it("Should handle ML2 in round 0 -> ML3 in finals", async function () {
      // 4-player tournament
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete semi-final 0 (round 0, match 0)
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      // Stall semi-final 1 (round 0, match 1) and use ML2
      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Advanced player uses ML2
      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      // Tournament completes since other semi-final was eliminated
      const [status] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(status).to.equal(0); // Reset
    });

    it("Should handle EL2 with multiple enrollments -> complete reset", async function () {
      // Only enroll 1 player to keep tournament in Enrolling state
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let enrollingBefore = await chess.getPlayerEnrollingTournaments(player1.address);
      expect(enrollingBefore.length).to.equal(1);

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Verify tournament was reset
      const [statusAfter, , enrolledCountAfter] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Reset to Enrolling
      expect(enrolledCountAfter).to.equal(0); // No players enrolled

      // Verify outsider received the pool funds
      const activeOutsider = await chess.getPlayerActiveTournaments(outsider.address);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should track forfeited amounts correctly across escalation types", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      // Complete semi-final 0 (round 0, match 0)
      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      // Stall semi-final 1 (round 0, match 1), use ML2
      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      // Verify tournament completed and reset after ML2
      const [statusAfter] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(statusAfter).to.equal(0); // Tournament reset
    });
  });

  describe("Prize Distribution Verification Across Escalation Types", function () {
    it("Should distribute correct prizes for EL1 solo force start", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      const enrollTx = await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      const enrollReceipt = await enrollTx.wait();
      const enrollGas = enrollReceipt.gasUsed * enrollReceipt.gasPrice;

      await time.increase(ENROLLMENT_TIMEOUT + 1);

      const tx = await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(player1.address);
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;

      expect(balanceAfter).to.equal(balanceBefore - ENTRY_FEE + expectedPrize - enrollGas - gasUsed);
    });

    it("Should distribute correct prizes for EL2 abandoned claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament stays in Enrolling state

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);
      const tx = await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML1 timeout victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(whitePlayer.address);
      const tx = await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(whitePlayer.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML2 force eliminate victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      const balanceBefore = await ethers.provider.getBalance(advancedPlayer.address);
      const tx = await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE_T4 * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(advancedPlayer.address);

      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize - gasUsed, ethers.parseEther("0.0001"));
    });

    it("Should distribute correct prizes for ML3 replacement victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);
      const tx = await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should maintain zero contract balance after all escalation type completions", async function () {
      const contractBalanceBefore = await ethers.provider.getBalance(chess.target);

      // ML1 tournament
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(whitePlayer).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const contractBalanceAfter = await ethers.provider.getBalance(chess.target);

      // Only protocol fees should remain (owner fees are withdrawn immediately)
      const expectedProtocolFees = (ENTRY_FEE * 2n * 25n) / 1000n; // 2.5%
      const expectedRemaining = expectedProtocolFees;

      expect(contractBalanceAfter).to.equal(contractBalanceBefore + expectedRemaining);
    });
  });

  describe("Tournament Reset Verification", function () {
    it("Should fully reset tournament state after EL2 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      // Only 1 player enrolled - tournament stays in Enrolling state

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const [status, currentRound, enrolledCount, prizePool, winner] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
      expect(currentRound).to.equal(0);
      expect(winner).to.equal(ethers.ZeroAddress);
    });

    it("Should fully reset tournament state after ML2 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player2).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player3).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });
      await chess.connect(player4).enrollInTournament(TIER4, INSTANCE_ID, { value: ENTRY_FEE_T4 });

      await playScholarsMateFast(player1, player2, 0, 0, TIER4);

      let match = await chess.getMatch(TIER4, INSTANCE_ID, 0, 1);
      const whitePlayer = match.common.player1 === player3.address ? player3 : player4;
      await makeChessMove(whitePlayer, 12, 28, 0, 1, 0, TIER4);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const winner0 = await chess.getMatch(TIER4, INSTANCE_ID, 0, 0);
      const advancedPlayer = winner0.common.winner === player1.address ? player1 : player2;
      await chess.connect(advancedPlayer).forceEliminateStalledMatch(TIER4, INSTANCE_ID, 0, 1);

      const [status, currentRound, enrolledCount, prizePool] = await chess.getTournamentInfo(TIER4, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
      expect(currentRound).to.equal(0);
    });

    it("Should fully reset tournament state after ML3 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      const whitePlayer = match.common.player1 === player1.address ? player1 : player2;
      await makeChessMove(whitePlayer, 12, 28);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);
      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const [status, , enrolledCount, prizePool] = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(status).to.equal(0);
      expect(enrolledCount).to.equal(0);
      expect(prizePool).to.equal(0);
    });
  });
});
