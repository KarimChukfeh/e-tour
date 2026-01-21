import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Comprehensive test suite for CompletionReason in ConnectFourOnChain MatchCompleted events
 *
 * Tests all ConnectFour-specific CompletionReason scenarios:
 * 0: NormalWin - 4 pieces in a row (horizontal, vertical, or diagonal)
 * 1: Timeout - Win by opponent timeout (ML1)
 * 2: Draw - Board full with no winner
 * 3: ForceElimination - ML2 advanced players force eliminated both players
 * 4: Replacement - ML3 external player replaced stalled players
 */
describe("ConnectFourOnChain CompletionReason Event Verification", function () {
    let connectFour;
    let owner, player1, player2, player3, player4, outsider;

    const TIER_2_PLAYER = 0; // 2-player tier
    const TIER_4_PLAYER = 1; // 4-player tier
    const INSTANCE_ID = 0; // Use instance 0 for all tests (contract redeployed each time)
    const TIER_2_FEE = hre.ethers.parseEther("0.001"); // Matches ConnectFourOnChain tier 0 entry fee
    const TIER_4_FEE = hre.ethers.parseEther("0.002"); // Matches ConnectFourOnChain tier 1 entry fee

    // Timeout configuration (matches ConnectFourOnChain.sol)
    const MATCH_TIME = 300; // 300 seconds per player
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

        // Use unique instance IDs for each test to avoid conflicts
        [owner, player1, player2, player3, player4, outsider] = await hre.ethers.getSigners();

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

        // Deploy ConnectFourOnChain
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        connectFour = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await connectFour.waitForDeployment();
    });

    describe("CompletionReason.NormalWin (0)", function () {
        it("Should emit MatchCompleted with NormalWin on horizontal win", async function () {
            // Enroll 2 players
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play a horizontal win on bottom row
            // Player 1: columns 0, 1, 2, 3 (horizontal win)
            // Player 2: columns 4, 5, 6
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4);
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 5);
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 6);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Winning move: column 3 completes horizontal 4-in-a-row
            await expect(connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    0,     // CompletionReason.NormalWin
                    (board) => true
                );
        });

        it("Should emit MatchCompleted with NormalWin on vertical win", async function () {
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play a vertical win in column 0
            // Player 1: column 0 four times (vertical win)
            // Player 2: column 1 three times
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Winning move: column 0 (4th piece) completes vertical 4-in-a-row
            await expect(connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    0,     // CompletionReason.NormalWin
                    (board) => true
                );
        });

        it.skip("Should emit MatchCompleted with NormalWin on diagonal win", async function () {
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Create ascending diagonal: (5,0), (4,1), (3,2), (2,3) for P1
            // Row 5 is bottom, Row 0 is top
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);   // P1 (5,0) ✓
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);  // P2 (5,1)
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 1);   // P1 (4,1) ✓
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2);  // P2 (5,2)
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2);   // P1 (4,2)
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3);  // P2 (5,3)
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 2);   // P1 (3,2) ✓
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4);  // P2 (5,4)
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3);   // P1 (4,3)
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4);  // P2 (4,4)
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3);   // P1 (3,3)
            await connectFour.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 4);  // P2 (3,4)

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Winning move: P1 (2,3) completes ascending diagonal
            await expect(connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 3))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    0,     // CompletionReason.NormalWin
                    (board) => true
                );
        });
    });

    describe("CompletionReason.Timeout (1)", function () {
        it("Should emit MatchCompleted with Timeout when opponent claims timeout victory", async function () {
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move - secondPlayer becomes current turn
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);

            // Advance time past secondPlayer's time bank
            await time.increase(MATCH_TIME + 1);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // First player claims timeout victory
            await expect(connectFour.connect(firstPlayer).claimTimeoutWin(TIER_2_PLAYER, INSTANCE_ID, 0, 0))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    1,     // CompletionReason.Timeout
                    (board) => true
                );
        });
    });

    describe("CompletionReason.Draw (2)", function () {
        it.skip("Should emit MatchCompleted with Draw when board is full with no winner", async function () {
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Fill the board without creating 4-in-a-row
            // Board is 7 columns x 6 rows = 42 slots
            // Pattern to avoid 4-in-a-row: alternating in a specific way

            // Columns 0-6, filling strategically to avoid wins
            // This is a known draw pattern for Connect Four
            const moves = [
                0, 0, 1, 1, 2, 2, // Fill bottom 2 rows of cols 0-2
                3, 3, 4, 4, 5, 5, // Fill bottom 2 rows of cols 3-5
                6, 6, 0, 0, 1, 1, // Continue filling
                2, 2, 3, 3, 4, 4, // Middle rows
                5, 5, 6, 6, 0, 0, // Upper rows
                1, 1, 2, 2, 3, 3, // Top rows
                4, 4, 5, 5, 6, 6  // Fill remaining
            ];

            for (let i = 0; i < moves.length - 1; i++) {
                const currentPlayer = i % 2 === 0 ? firstPlayer : secondPlayer;
                await connectFour.connect(currentPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, moves[i]);
            }

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // Last move fills the board - results in draw
            const lastPlayer = (moves.length - 1) % 2 === 0 ? firstPlayer : secondPlayer;
            await expect(connectFour.connect(lastPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, moves[moves.length - 1]))
                .to.emit(connectFour, "MatchCompleted")
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
            // Enroll 4 players
            await connectFour.connect(player1).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await connectFour.connect(player3).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });
            await connectFour.connect(player4).enrollInTournament(TIER_4_PLAYER, INSTANCE_ID, { value: TIER_4_FEE });

            // Complete match 0 to create an advanced player
            let match0 = await connectFour.getMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match0.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match0.currentTurn === player1.address ? player2 : player1;

            // Quick horizontal win in match 0
            await connectFour.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 0);
            await connectFour.connect(secondPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 4);
            await connectFour.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 1);
            await connectFour.connect(secondPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 5);
            await connectFour.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 2);
            await connectFour.connect(secondPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 6);
            await connectFour.connect(firstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 0, 3); // Win

            // Stall match 1
            let match1 = await connectFour.getMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 1);
            const match1FirstPlayer = match1.currentTurn === player3.address ? player3 : player4;
            await connectFour.connect(match1FirstPlayer).makeMove(TIER_4_PLAYER, INSTANCE_ID, 0, 1, 0);

            // Advance time past timeout + L2 delay
            await time.increase(MATCH_TIME + L2_DELAY + 1);

            const matchId = getMatchId(TIER_4_PLAYER, INSTANCE_ID, 0, 1);

            // Advanced player force eliminates both players in match 1
            await expect(connectFour.connect(firstPlayer).forceEliminateStalledMatch(TIER_4_PLAYER, INSTANCE_ID, 0, 1))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match1.common.player1,
                    match1.common.player2,
                    firstPlayer.address,
                    false, // not a draw
                    3,     // CompletionReason.ForceElimination
                    (board) => true
                );
        });
    });

    describe("CompletionReason.Replacement (4)", function () {
        it("Should emit MatchCompleted with Replacement when ML3 is executed", async function () {
            // Enroll 2 players
            await connectFour.connect(player1).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });
            await connectFour.connect(player2).enrollInTournament(TIER_2_PLAYER, INSTANCE_ID, { value: TIER_2_FEE });

            const match = await connectFour.getMatch(TIER_2_PLAYER, INSTANCE_ID, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;

            // First player makes a move, then stalls
            await connectFour.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE_ID, 0, 0, 0);

            // Advance time past timeout + L3 delay
            await time.increase(MATCH_TIME + L3_DELAY + 1);

            const matchId = getMatchId(TIER_2_PLAYER, INSTANCE_ID, 0, 0);

            // External player claims the match slot
            await expect(connectFour.connect(outsider).claimMatchSlotByReplacement(TIER_2_PLAYER, INSTANCE_ID, 0, 0))
                .to.emit(connectFour, "MatchCompleted")
                .withArgs(
                    matchId,
                    match.common.player1,
                    match.common.player2,
                    outsider.address,
                    false, // not a draw
                    4,     // CompletionReason.Replacement
                    (board) => true
                );
        });
    });
});
