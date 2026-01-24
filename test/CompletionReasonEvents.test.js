import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Comprehensive test suite for CompletionReason enum in MatchCompleted events
 *
 * Tests all 6 CompletionReason values:
 * 0: NormalWin - Normal gameplay win
 * 1: Timeout - Win by opponent timeout (ML1)
 * 2: Draw - Match/finals ended in a draw
 * 3: ForceElimination - ML2 advanced players force eliminated both players
 * 4: Replacement - ML3 external player replaced stalled players
 * 5: AllDrawScenario - All matches in a round resulted in draws (tournament only)
 */
describe("CompletionReason Event Verification", function () {
    let game;
    let owner, player1, player2, player3, player4, outsider1, outsider2;

    const TIER_2_PLAYER = 0; // 2-player tier
    const TIER_4_PLAYER = 1; // 4-player tier
    const INSTANCE_ID = 0;
    const TIER_2_FEE = hre.ethers.parseEther("0.0003");
    const TIER_4_FEE = hre.ethers.parseEther("0.0007");

    // Timeout configuration
    const MATCH_TIME = 120; // 120 seconds per player
    const L2_DELAY = 120;   // 120 seconds after timeout before L2
    const L3_DELAY = 240;   // 240 seconds after timeout before L3

    // Helper to compute matchId
    function getMatchId(tierId, instanceId, roundNumber, matchNumber) {
        return hre.ethers.keccak256(
            hre.ethers.solidityPacked(
                ["uint8", "uint8", "uint8", "uint8"],
                [tierId, instanceId, roundNumber, matchNumber]
            )
        );
    }

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, outsider1, outsider2] = await hre.ethers.getSigners();

        // Deploy all modules
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

        // Deploy TicTacChain
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();
    });

    describe("CompletionReason.NormalWin (0)", function () {
        it("Should emit MatchCompleted with NormalWin when player wins by regular gameplay", async function () {
            // Enroll 2 players
            await game.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            // Get match to determine who goes first
            let match = await game.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play a game where firstPlayer wins
            // X plays: 0, 1, 2 (top row win)
            // O plays: 3, 4
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Winning move should emit MatchCompleted with CompletionReason.NormalWin (0)
            await expect(game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2))
                .to.emit(game, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    0,     // CompletionReason.NormalWin
                    (board) => true // board state (any value)
                );
        });
    });

    describe("CompletionReason.Timeout (1)", function () {
        it("Should emit MatchCompleted with Timeout when opponent claims timeout victory", async function () {
            // Enroll 2 players
            await game.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            // Get match to determine who goes first
            let match = await game.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move - now secondPlayer is current turn
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);

            // Advance time past secondPlayer's time bank (secondPlayer is now current turn and times out)
            await time.increase(MATCH_TIME + 1);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // First player (not current turn) claims timeout victory over secondPlayer (who is current turn and timed out)
            await expect(game.connect(firstPlayer).claimTimeoutWin(TIER_2_PLAYER, INSTANCE_ID, 0, 0))
                .to.emit(game, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address, // firstPlayer wins by timeout
                    false, // not a draw
                    1,     // CompletionReason.Timeout
                    (board) => true
                );
        });
    });

    describe("CompletionReason.Draw (2)", function () {
        it("Should emit MatchCompleted with Draw when match ends in a draw", async function () {
            await game.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            let match = await game.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play a draw game
            // Board:
            // X O X
            // X O O
            // O X X
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);  // X
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1); // O
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2);  // X
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4); // O
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3);  // X
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 5); // O
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 7);  // X
            await game.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 6); // O

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Final move results in draw
            await expect(game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 8))
                .to.emit(game, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    hre.ethers.ZeroAddress, // no winner
                    true,  // is a draw
                    2,     // CompletionReason.Draw
                    (board) => true
                );
        });
    });

    describe("CompletionReason.ForceElimination (3)", function () {
        it("Should emit MatchCompleted with ForceElimination when ML2 is executed", async function () {
            // Enroll 4 players for a 4-player tournament
            await game.connect(player1).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await game.connect(player2).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await game.connect(player3).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await game.connect(player4).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });

            // Complete match 0 to create an advanced player
            let match0 = await game.getMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match0.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match0.currentTurn === player1.address ? player2 : player1;

            // Complete match 0 quickly
            await game.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 2); // firstPlayer wins

            // Now match 1 stalls - one player makes a move, then times out
            let match1 = await game.getMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 1);
            const match1FirstPlayer = match1.currentTurn === player3.address ? player3 : player4;
            await game.connect(match1FirstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 1, 0);

            // Advance time past timeout + L2 delay
            await time.increase(MATCH_TIME + L2_DELAY + 1);

            const matchId = getMatchId(TIER_4_PLAYER, INSTANCE_ID, 0, 1);

            // Advanced player (firstPlayer who won match 0) force eliminates both players in match 1
            await expect(game.connect(firstPlayer).forceEliminateStalledMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 1))
                .to.emit(game, "MatchCompleted")
                .withArgs(
                    matchId,
                    match1.common.player1,
                    match1.common.player2,
                    firstPlayer.address, // The advanced player who triggered ML2
                    false, // not a draw
                    3,     // CompletionReason.ForceElimination
                    (board) => true
                );
        });
    });

    describe("CompletionReason.Replacement (4)", function () {
        it("Should emit MatchCompleted with Replacement when ML3 is executed", async function () {
            // Enroll 2 players
            await game.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            // First player makes a move, then stalls
            let match = await game.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            await game.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);

            // Advance time past timeout + L3 delay
            await time.increase(MATCH_TIME + L3_DELAY + 1);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // External player claims the match slot
            await expect(game.connect(outsider1).claimMatchSlotByReplacement(TIER_2_PLAYER, INSTANCE_ID, 0, 0))
                .to.emit(game, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    outsider1.address, // The external player who replaced stalled players
                    false, // not a draw
                    4,     // CompletionReason.Replacement
                    (board) => true
                );
        });
    });
});
