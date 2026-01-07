import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hre;

describe("ChessOnChain Comprehensive Escalation Tests", function () {
  let chess, owner, player1, player2, player3, player4, outsider;
  const TIER = 0;
  const ENTRY_FEE = ethers.parseEther("0.003"); // Tier 0 entry fee for ChessOnChain
  const INSTANCE_ID = 0;

  // Escalation timeouts from contract
  const ENROLLMENT_TIMEOUT = 300; // 5 minutes
  const ENROLLMENT_ESC_L2 = 600; // 10 minutes
  const MATCH_TIMEOUT = 600; // 10 minutes
  const MATCH_ESC_L2 = 600; // 10 minutes
  const MATCH_ESC_L3 = 600; // 10 minutes

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
   */
  async function makeChessMove(signer, from, to) {
    return await chess.connect(signer).makeMove(TIER, INSTANCE_ID, from, to);
  }

  /**
   * Helper: Play Scholar's Mate to quickly end a match
   */
  async function playScholarsMateFast(whitePlayer, blackPlayer) {
    await makeChessMove(whitePlayer, 52, 36); // e2-e4
    await makeChessMove(blackPlayer, 11, 27); // e7-e5
    await makeChessMove(whitePlayer, 61, 34); // f1-c4
    await makeChessMove(blackPlayer, 3, 39); // b8-c6
    await makeChessMove(whitePlayer, 59, 45); // d1-h5
    await makeChessMove(blackPlayer, 6, 21); // g8-f6
    await makeChessMove(whitePlayer, 45, 13); // h5-f7# (Checkmate)
  }

  describe("EL1: Enrollment Force Start", function () {
    it("Should allow enrolled player to force start after enrollment timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      const tournamentBefore = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournamentBefore.status).to.equal(0); // Enrolling

      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID))
        .to.emit(chess, "TournamentStarted");

      const tournamentAfter = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournamentAfter.status).to.equal(1); // InProgress
    });

    it("Should reject force start before timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await expect(
        chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("enrollment window not expired");
    });

    it("Should reject force start from non-enrolled player", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        chess.connect(outsider).forceStartTournament(TIER, INSTANCE_ID)
      ).to.be.revertedWith("not enrolled");
    });

    it("Should complete tournament immediately if only one player enrolled and force starts", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID))
        .to.emit(chess, "TournamentCompleted");

      const tournamentAfter = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournamentAfter.status).to.equal(0); // Reset to Enrolling
      expect(tournamentAfter.enrolledCount).to.equal(0);

      // Verify prize distribution (90% of entry fee)
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore - ENTRY_FEE + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after solo force start completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      let activeBefore = await chess.getPlayerActiveTournaments(player1.address);
      expect(activeBefore.length).to.equal(1);

      await time.increase(ENROLLMENT_TIMEOUT + 1);
      await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);

      let activeAfter = await chess.getPlayerActiveTournaments(player1.address);
      expect(activeAfter.length).to.equal(0);
    });
  });

  describe("EL2: Enrollment External Claim", function () {
    it("Should allow external player to claim abandoned enrollment pool after EL2 delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await expect(chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID))
        .to.emit(chess, "TournamentCompleted");

      const tournamentAfter = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournamentAfter.status).to.equal(0); // Reset
      expect(tournamentAfter.enrolledCount).to.equal(0);

      // Verify prize distribution
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should reject claim before EL2 delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      await expect(
        chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID)
      ).to.be.revertedWith("escalation level 2 not available yet");
    });

    it("Should emit PlayerForfeited events for all enrolled players", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const tx = await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);
      const receipt = await tx.wait();

      const forfeitEvents = receipt.logs
        .filter(log => log.fragment && log.fragment.name === "PlayerForfeited");

      expect(forfeitEvents.length).to.equal(3);
    });

    it("Should clear all player activity entries after EL2 claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const active2 = await chess.getPlayerActiveTournaments(player2.address);
      const activeOutsider = await chess.getPlayerActiveTournaments(outsider.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should allow new tournament to start after EL2 claim and reset", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Should be able to enroll in new tournament
      await expect(chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE }))
        .to.emit(chess, "PlayerEnrolled");
    });
  });

  describe("ML1: Match Timeout Claim", function () {
    it("Should allow opponent to claim timeout after match timeout", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Tournament auto-starts with 2 players
      await makeChessMove(player1, 52, 36); // e2-e4

      await time.increase(MATCH_TIMEOUT + 1);

      await expect(chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0))
        .to.emit(chess, "MatchCompleted");

      const match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      expect(match.status).to.equal(2); // Completed
      expect(match.winner).to.equal(player1.address);
    });

    it("Should complete 2-player tournament after ML1 timeout claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await expect(chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0))
        .to.emit(chess, "TournamentCompleted");

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0); // Reset
      expect(tournament.enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear player activity after ML1 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const active1 = await chess.getPlayerActiveTournaments(player1.address);
      const active2 = await chess.getPlayerActiveTournaments(player2.address);

      expect(active1.length).to.equal(0);
      expect(active2.length).to.equal(0);
    });

    it("Should reject timeout claim before timeout period", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);

      await expect(
        chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("match has not timed out yet");
    });

    it("Should reject timeout claim on own turn", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(MATCH_TIMEOUT + 1);

      await expect(
        chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("cannot claim timeout on your own turn");
    });
  });

  describe("ML2: Advanced Player Force Eliminate", function () {
    it("Should allow advanced player to force eliminate stalled semi-final", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete semi-final 0
      await playScholarsMateFast(player1, player2);

      // Stall semi-final 1
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1))
        .to.emit(chess, "MatchEliminated");

      const match = await chess.getMatch(TIER, INSTANCE_ID, 0, 1);
      expect(match.status).to.equal(3); // Eliminated
    });

    it("Should reject ML2 from non-advanced player", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        chess.connect(player3).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("not advanced player");
    });

    it("Should complete tournament when finalist uses ML2 on stalled semi-final", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete semi-final 0 - player1 advances
      await playScholarsMateFast(player1, player2);

      // Stall semi-final 1
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await expect(chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1))
        .to.emit(chess, "TournamentCompleted");

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0); // Reset
      expect(tournament.enrolledCount).to.equal(0);

      // Verify prize distribution
      const expectedPrize = (ENTRY_FEE * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });

    it("Should clear all player activity after ML2 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await playScholarsMateFast(player1, player2);
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1);

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
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete both semi-finals
      await playScholarsMateFast(player1, player2);
      await playScholarsMateFast(player3, player4);

      // Stall finals
      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(chess.connect(player3).forceEliminateStalledMatch(TIER, INSTANCE_ID, 1, 0))
        .to.emit(chess, "TournamentCompleted");

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);
    });

    it("Should reject ML2 before escalation delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await playScholarsMateFast(player1, player2);
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);

      await expect(
        chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1)
      ).to.be.revertedWith("escalation level 2 not available yet");
    });
  });

  describe("ML3: External Player Replacement", function () {
    it("Should allow external player to replace stalled match player", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      await expect(chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0))
        .to.emit(chess, "PlayerReplaced");

      const match = await chess.getMatch(TIER, INSTANCE_ID, 0, 0);
      expect(match.status).to.equal(2); // Completed
      expect(match.winner).to.equal(outsider.address);
    });

    it("Should complete 2-player tournament after ML3 claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await expect(chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0))
        .to.emit(chess, "TournamentCompleted");

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);
      expect(tournament.enrolledCount).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.001"));
    });

    it("Should clear all player activity after ML3 tournament completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
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
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete semi-final 0
      await playScholarsMateFast(player1, player2);

      // Stall semi-final 1
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 1);

      // Check that outsider is in finals
      const finals = await chess.getMatch(TIER, INSTANCE_ID, 1, 0);
      const isOutsiderInFinals =
        finals.player1 === outsider.address || finals.player2 === outsider.address;
      expect(isOutsiderInFinals).to.be.true;
    });

    it("Should reject ML3 before escalation delay", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      await expect(
        chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("escalation level 3 not available yet");
    });

    it("Should reject ML3 on non-stalled match", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await expect(
        chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0)
      ).to.be.revertedWith("match not stalled");
    });

    it("Should handle ML3 on finals match properly", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete both semi-finals
      await playScholarsMateFast(player1, player2);
      await playScholarsMateFast(player3, player4);

      // Stall finals
      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);

      await expect(chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 1, 0))
        .to.emit(chess, "TournamentCompleted");

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);

      // Verify prize
      const expectedPrize = (ENTRY_FEE * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);
      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize, ethers.parseEther("0.002"));
    });
  });

  describe("Cascading Effects: Multi-Level Escalation", function () {
    it("Should handle ML1 -> tournament completion -> reset -> new enrollment", async function () {
      // First tournament with ML1
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      let tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);

      // New tournament should start fresh
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(1);
      expect(tournament.enrolledCount).to.equal(2);
    });

    it("Should handle ML2 in round 0 -> ML3 in finals", async function () {
      // 8-player tournament
      const players = [player1, player2, player3, player4];
      const additionalPlayers = await ethers.getSigners();
      const player5 = additionalPlayers[5];
      const player6 = additionalPlayers[6];
      const player7 = additionalPlayers[7];
      const player8 = additionalPlayers[8];
      const allPlayers = [...players, player5, player6, player7, player8];

      for (let p of allPlayers) {
        await chess.connect(p).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      }

      // Complete 3 matches in round 0
      await playScholarsMateFast(player1, player2);
      await playScholarsMateFast(player3, player4);
      await playScholarsMateFast(player5, player6);

      // Stall 4th match in round 0
      await makeChessMove(player7, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      // Advanced player uses ML2
      await chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 3);

      // Complete one semi-final
      await playScholarsMateFast(player1, player3);

      // Stall other semi-final - use ML3
      await makeChessMove(player5, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);

      const outsider2 = additionalPlayers[9];
      await chess.connect(outsider2).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 1, 1);

      // Verify outsider2 is in finals
      const finals = await chess.getMatch(TIER, INSTANCE_ID, 2, 0);
      expect([finals.player1, finals.player2]).to.include(outsider2.address);
    });

    it("Should handle EL2 with multiple enrollments -> complete reset", async function () {
      const additionalPlayers = await ethers.getSigners();
      const enrolledPlayers = [player1, player2, player3, player4,
                               additionalPlayers[5], additionalPlayers[6]];

      for (let p of enrolledPlayers) {
        await chess.connect(p).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      }

      let activeCountsBefore = [];
      for (let p of enrolledPlayers) {
        const active = await chess.getPlayerActiveTournaments(p.address);
        activeCountsBefore.push(active.length);
      }

      expect(activeCountsBefore.every(count => count === 1)).to.be.true;

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      // Verify all players cleared
      for (let p of enrolledPlayers) {
        const active = await chess.getPlayerActiveTournaments(p.address);
        expect(active.length).to.equal(0);
      }

      // Verify outsider also cleared
      const activeOutsider = await chess.getPlayerActiveTournaments(outsider.address);
      expect(activeOutsider.length).to.equal(0);
    });

    it("Should track forfeited amounts correctly across escalation types", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      // Complete semi-final 0
      await playScholarsMateFast(player1, player2);

      // Stall semi-final 1, use ML2
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1);

      // Check player stats for forfeited players
      const stats3 = await chess.getPlayerStats(player3.address);
      const stats4 = await chess.getPlayerStats(player4.address);

      expect(stats3.amountForfeited).to.be.gt(0);
      expect(stats4.amountForfeited).to.be.gt(0);
    });
  });

  describe("Prize Distribution Verification Across Escalation Types", function () {
    it("Should distribute correct prizes for EL1 solo force start", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);

      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await time.increase(ENROLLMENT_TIMEOUT + 1);

      const tx = await chess.connect(player1).forceStartTournament(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(player1.address);
      const expectedPrize = (ENTRY_FEE * 90n) / 100n;

      expect(balanceAfter).to.equal(balanceBefore - ENTRY_FEE + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for EL2 abandoned claim", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(outsider.address);
      const tx = await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 3n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(outsider.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML1 timeout victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);

      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const tx = await chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 2n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedPrize - gasUsed);
    });

    it("Should distribute correct prizes for ML2 force eliminate victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await playScholarsMateFast(player1, player2);
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);

      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const tx = await chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const expectedPrize = (ENTRY_FEE * 4n * 90n) / 100n;
      const balanceAfter = await ethers.provider.getBalance(player1.address);

      expect(balanceAfter).to.be.closeTo(balanceBefore + expectedPrize - gasUsed, ethers.parseEther("0.0001"));
    });

    it("Should distribute correct prizes for ML3 replacement victory", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
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
      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + 1);
      await chess.connect(player1).claimTimeoutWin(TIER, INSTANCE_ID, 0, 0);

      const contractBalanceAfter = await ethers.provider.getBalance(chess.target);

      // Only protocol fees should remain
      const expectedProtocolFees = (ENTRY_FEE * 2n * 25n) / 1000n; // 2.5%
      const ownerFees = (ENTRY_FEE * 2n * 75n) / 1000n; // 7.5%
      const expectedRemaining = expectedProtocolFees + ownerFees;

      expect(contractBalanceAfter).to.equal(contractBalanceBefore + expectedRemaining);
    });
  });

  describe("Tournament Reset Verification", function () {
    it("Should fully reset tournament state after EL2 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await time.increase(ENROLLMENT_TIMEOUT + ENROLLMENT_ESC_L2 + 1);
      await chess.connect(outsider).claimAbandonedEnrollmentPool(TIER, INSTANCE_ID);

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);
      expect(tournament.enrolledCount).to.equal(0);
      expect(tournament.prizePool).to.equal(0);
      expect(tournament.currentRound).to.equal(0);
      expect(tournament.winner).to.equal(ethers.ZeroAddress);
    });

    it("Should fully reset tournament state after ML2 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player3).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player4).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await playScholarsMateFast(player1, player2);
      await makeChessMove(player3, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + 1);
      await chess.connect(player1).forceEliminateStalledMatch(TIER, INSTANCE_ID, 0, 1);

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);
      expect(tournament.enrolledCount).to.equal(0);
      expect(tournament.prizePool).to.equal(0);
      expect(tournament.currentRound).to.equal(0);
    });

    it("Should fully reset tournament state after ML3 completion", async function () {
      await chess.connect(player1).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });
      await chess.connect(player2).enrollInTournament(TIER, INSTANCE_ID, { value: ENTRY_FEE });

      await makeChessMove(player1, 52, 36);
      await time.increase(MATCH_TIMEOUT + MATCH_ESC_L2 + MATCH_ESC_L3 + 1);
      await chess.connect(outsider).claimMatchSlotByReplacement(TIER, INSTANCE_ID, 0, 0);

      const tournament = await chess.getTournamentInfo(TIER, INSTANCE_ID);
      expect(tournament.status).to.equal(0);
      expect(tournament.enrolledCount).to.equal(0);
      expect(tournament.prizePool).to.equal(0);
    });
  });
});
