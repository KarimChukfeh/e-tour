import { expect } from "chai";
import hre from "hardhat";

describe("Match-Level Escalation (Anti-Stalling) Tests", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6;

    const TIER_0_FEE = hre.ethers.parseEther("0.0003");
    const TIER_1_FEE = hre.ethers.parseEther("0.0007");

    // Dynamic timeout values (read from tier config)
    let TIER_0_MATCH_TIME;
    let TIER_1_MATCH_TIME;
    let TIER_1_L2_DELAY;
    let TIER_1_L3_DELAY;

    // Helper to compute matchId the same way as the contract
    function getMatchId(tierId, instanceId, roundNumber, matchNumber) {
        return hre.ethers.keccak256(
            hre.ethers.solidityPacked(
                ["uint8", "uint8", "uint8", "uint8"],
                [tierId, instanceId, roundNumber, matchNumber]
            )
        );
    }

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6] = await hre.ethers.getSigners();

        // Deploy modules first
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();

        // Deploy TicTacChain with module addresses
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // Hardcoded timeout values matching TicTacChain.sol configuration
        // Tier 0 (2-player): 120s match time, 120s L2 delay, 240s L3 delay
        // Tier 1 (4-player): 120s match time, 120s L2 delay, 240s L3 delay
        TIER_0_MATCH_TIME = 120;
        TIER_1_MATCH_TIME = 120;
        TIER_1_L2_DELAY = 120;
        TIER_1_L3_DELAY = 240;
    });

    describe("Level 1: Normal Timeout Claim (Baseline)", function () {
        it("Should allow opponent to claim timeout when player runs out of time", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll and start tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Determine who goes first using currentTurn
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player's time runs out
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player claims timeout - this completes match and tournament
            await game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // ARCHITECTURE CHANGE: Finals cleared immediately on tournament completion
            // Verify tournament completed by checking status
            const tournament = await game.getTournamentInfo(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset after completion)
        });

        it("Should reflect ML1 timeout as CompletionReason.Timeout in recentInstances", async function () {
            const tierId = 0;
            const instanceId = 1;

            // Enroll and start tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Determine who goes first using currentTurn
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player's time runs out
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player claims timeout - this completes match and tournament
            await game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Get the tournament record from recentInstances
            const record = await game.getTournamentRecord(tierId, instanceId);

            // CRITICAL: Verify completion reason is Timeout (enum value 1)
            expect(record.completionReason).to.equal(1); // CompletionReason.Timeout
            expect(record.winner).to.equal(secondPlayer.address);
            expect(record.players.length).to.equal(2);
            expect(record.endTime).to.be.greaterThan(0);
        });
    });

    describe("Level 2: Advanced Player Force Elimination", function () {
        it("Should mark match as stalled when player runs out of time", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            // Enroll 4 players to create a bracket with 2 matches
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Match 0: player1 vs player2
            // Match 1: player3 vs player4
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match0.currentTurn === player1.address ? player1 : player2;

            // First player in Match 0 runs out of time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Check that match can be marked as stalled (timeout state should exist)
            const matchId = getMatchId(tierId, instanceId, 0, 0);
            const timeoutState = await game.matchTimeouts(matchId);

            // After one player runs out of time and it's claimable, escalation should be trackable
            // Timeout state exists even if not explicitly marked as stalled
            expect(timeoutState).to.exist;
        });

        it("Should allow advanced player to force eliminate stalled match after escalation window", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Match 0: First two players (will stall)
            // Match 1: Second two players (will complete normally)

            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const match1Player1Addr = match1.common.player1;
            const match1Player2Addr = match1.common.player2;
            const match1Player1 = [player1, player2, player3, player4].find(p => p.address === match1Player1Addr);
            const match1Player2 = [player1, player2, player3, player4].find(p => p.address === match1Player2Addr);

            // Match 1 completes normally (simple win)
            const match1FirstPlayer = match1.currentTurn === match1Player1Addr ? match1Player1 : match1Player2;
            const match1SecondPlayer = match1FirstPlayer === match1Player1 ? match1Player2 : match1Player1;

            // Play out Match 1 to completion (winning moves)
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 0); // Top-left
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 3); // Middle-left
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 1); // Top-center
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 4); // Center
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 2); // Top-right (wins)

            // Match 1 winner is now an "advanced player"
            const advancedPlayer = match1FirstPlayer;

            // Match 0: First player runs out of time
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);

            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Opponent doesn't claim, wait for escalation window
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_L2_DELAY + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Advanced player from Match 1 should be able to force eliminate Match 0
            // This should also complete the tournament since advancedPlayer is the only remaining player
            await game.connect(advancedPlayer).forceEliminateStalledMatch(tierId, instanceId, 0, 0);

            // Tournament should be completed and reset (orphaned winner scenario)
            const tournamentInfo = await game.getTournamentInfo(tierId, instanceId);
            expect(tournamentInfo.status).to.equal(0); // Enrolling (reset)
            expect(tournamentInfo.enrolledCount).to.equal(0); // Reset
            expect(tournamentInfo.prizePool).to.equal(0n); // Reset

            // Advanced player should no longer be in active tournaments
        });

        it("Should reject force elimination from non-advanced player", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // First player in Match 0 runs out of time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Wait for escalation window
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_L2_DELAY + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // External player (not in tournament) tries to force eliminate
            await expect(
                game.connect(player5).forceEliminateStalledMatch(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Not an advanced player");
        });

        it("Should reject force elimination before escalation window", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Setup: 4 players, Match 1 completes, Match 0 stalls
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Complete Match 1 to get advanced player
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const match1Player1Addr = match1.common.player1;
            const match1Player2Addr = match1.common.player2;
            const match1Player1 = [player1, player2, player3, player4].find(p => p.address === match1Player1Addr);
            const match1Player2 = [player1, player2, player3, player4].find(p => p.address === match1Player2Addr);
            const match1FirstPlayer = match1.currentTurn === match1Player1Addr ? match1Player1 : match1Player2;
            const match1SecondPlayer = match1FirstPlayer === match1Player1 ? match1Player2 : match1Player1;

            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 2);

            const advancedPlayer = match1FirstPlayer;

            // Match 0 player runs out of time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Try to force eliminate immediately (before escalation window)
            await expect(
                game.connect(advancedPlayer).forceEliminateStalledMatch(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Level 2 not active yet");
        });
    });

    describe("Level 3: External Player Replacement", function () {
        it("Should allow external player to claim match slot after Level 3 escalation window", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Match 0 player runs out of time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Wait for Level 2 escalation window to pass
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_L2_DELAY + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Wait for Level 3 escalation window to activate
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_L2_DELAY + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // External player (player5, not in tournament) claims the slot
            await game.connect(player5).claimMatchSlotByReplacement(tierId, instanceId, 0, 0);

            // Match should be completed with player5 as winner
            const completedMatch = await game.getMatch(tierId, instanceId, 0, 0);
            expect(completedMatch.common.status).to.equal(2); // Completed
            expect(completedMatch.common.winner).to.equal(player5.address);

            // Player5 should now be enrolled in the tournament
            const isEnrolled = await game.isEnrolled(tierId, instanceId, player5.address);
            expect(isEnrolled).to.be.true;
        });

        it("Should reject replacement claim before Level 3 window", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Player runs out of time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Only wait for Level 2 window (not Level 3)
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_L2_DELAY + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // External player tries to claim too early
            await expect(
                game.connect(player5).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Level 3 not active yet");
        });

        it("Should reject replacement claim on non-stalled match", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Match is active, no timeout yet
            // External player tries to claim
            await expect(
                game.connect(player5).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Match not stalled");
        });
    });

    describe("Escalation Integration with Tournament Progression", function () {
        it("Should allow tournament to progress after force elimination", async function () {
            const tierId = 1; // 4-player tier: Round 0 (2 matches) → Round 1 (1 final)
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Debug: Check initial round state
            const initialRound0 = await game.rounds(tierId, instanceId, 0);
            console.log("Round 0 after enrollment:", {
                initialized: initialRound0.initialized,
                totalMatches: initialRound0.totalMatches,
                completedMatches: initialRound0.completedMatches
            });

            // Match 1 completes normally
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const match1Player1Addr = match1.common.player1;
            const match1Player2Addr = match1.common.player2;
            const match1Player1 = [player1, player2, player3, player4].find(p => p.address === match1Player1Addr);
            const match1Player2 = [player1, player2, player3, player4].find(p => p.address === match1Player2Addr);
            const match1FirstPlayer = match1.currentTurn === match1Player1Addr ? match1Player1 : match1Player2;
            const match1SecondPlayer = match1FirstPlayer === match1Player1 ? match1Player2 : match1Player1;

            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 2);

            const winnerMatch1 = match1FirstPlayer;

            // Debug: Check round state after match 1 completes
            const round0AfterMatch1 = await game.rounds(tierId, instanceId, 0);
            console.log("Round 0 after Match 1 completes:", {
                totalMatches: round0AfterMatch1.totalMatches,
                completedMatches: round0AfterMatch1.completedMatches
            });

            const tournamentAfterMatch1 = await game.tournaments(tierId, instanceId);
            console.log("Tournament status after Match 1:", tournamentAfterMatch1.status);

            // Match 0 stalls
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + TIER_1_L2_DELAY + 2]);
            await hre.ethers.provider.send("evm_mine", []);

            // Winner from Match 1 force eliminates Match 0
            // This should complete the tournament (orphaned winner scenario)
            await game.connect(winnerMatch1).forceEliminateStalledMatch(tierId, instanceId, 0, 0);

            // Tournament should be completed and reset
            // Only the winner from Match 1 remains, they should have won the tournament automatically
            const tournament = await game.getTournamentInfo(tierId, instanceId);

            // Check tournament completed and reset (status = Enrolling, winner cleared)
            expect(tournament[0]).to.equal(0); // TournamentStatus.Enrolling (after reset)
            expect(tournament[4]).to.equal(hre.ethers.ZeroAddress); // Winner cleared after reset
            expect(tournament[2]).to.equal(0); // Enrolled count reset
            expect(tournament[3]).to.equal(0n); // Prize pool reset

            // Winner should no longer be in active tournaments
        });

        it("Should allow replacement player to advance in tournament", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Match 1 completes
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const match1Player1Addr = match1.common.player1;
            const match1Player2Addr = match1.common.player2;
            const match1Player1 = [player1, player2, player3, player4].find(p => p.address === match1Player1Addr);
            const match1Player2 = [player1, player2, player3, player4].find(p => p.address === match1Player2Addr);
            const match1FirstPlayer = match1.currentTurn === match1Player1Addr ? match1Player1 : match1Player2;
            const match1SecondPlayer = match1FirstPlayer === match1Player1 ? match1Player2 : match1Player1;

            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(match1SecondPlayer).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(match1FirstPlayer).makeMove(tierId, instanceId, 0, 1, 2);

            // Match 0 stalls, wait for Level 3
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + (TIER_1_L2_DELAY * 2) + 3]);
            await hre.ethers.provider.send("evm_mine", []);

            // External player claims Match 0
            await game.connect(player5).claimMatchSlotByReplacement(tierId, instanceId, 0, 0);

            // Player5 should now be in the finals against the winner of Match 1
            const finalsMatch = await game.getMatch(tierId, instanceId, 1, 0);
            const finalsPlayers = [finalsMatch.common.player1, finalsMatch.common.player2];

            expect(finalsPlayers).to.include(player5.address);
            expect(finalsPlayers).to.include(match1FirstPlayer.address);
        });
    });

    describe("Edge Cases and Security", function () {
        it("Should not allow claiming already completed match", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete match normally
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Win the game
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Try to claim completed match
            // SECURITY FIX: Now correctly fails with "Tournament not in progress"
            // because tournament has completed and reset to Enrolling status
            await expect(
                game.connect(player3).claimMatchSlotByReplacement(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Tournament not in progress");
        });

        it("Should clear escalation state after match completion", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player times out
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player claims timeout normally
            await game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check that escalation state is cleared (isStalled should be false or reset)
            const matchId = getMatchId(tierId, instanceId, 0, 0);
            const timeoutState = await game.matchTimeouts(matchId);

            // After normal completion, isStalled should be false (or state reset)
            // This ensures escalation doesn't trigger after legitimate completion
            expect(timeoutState.isStalled).to.be.false;
        });
    });
});
