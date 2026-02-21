import hre from "hardhat";
import { expect } from "chai";

/**
 * Test Suite: Move History Pollution Across Tournament Cycles
 *
 * PURPOSE: Demonstrates critical bug where move history from previous tournament
 * matches persists into subsequent tournament matches.
 *
 * BUG SCENARIO:
 * - 4-player tournament (TicTacToe), Round 0: A vs B, C vs D. A and D advance.
 * - Round 1 (finals): A vs D complete their match
 * - Tournament resets, new 4-player tournament starts
 * - Round 1 (finals) in the NEW tournament shows moves from the PREVIOUS finals
 * - This persists in the player's recent match instance record
 */
describe("Move History Pollution Bug (TDD)", function () {
    let game;
    let owner, playerA, playerB, playerC, playerD, playerE, playerF, playerG, playerH;
    const TIER_1_FEE = hre.ethers.parseEther("0.0007"); // Tier 1 accepts 4 players

    beforeEach(async function () {
        [owner, playerA, playerB, playerC, playerD, playerE, playerF, playerG, playerH] = await hre.ethers.getSigners();

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

    it("Should NOT have move history pollution in finals match across tournament cycles", async function () {
        console.log("\n=== TEST: Move History Pollution in Finals ===\n");

        const tierId = 1; // Tier 1 accepts 4 players
        const instanceId = 0;

        // ========== CYCLE 1: First 4-player tournament ==========
        console.log("CYCLE 1: Creating first 4-player tournament...");

        await game.connect(playerA).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerB).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerC).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerD).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

        console.log("✓ 4 players enrolled (A, B, C, D)");

        // Round 0: Two semi-finals
        // Match 0: Player A vs Player B (or B vs A, depending on random assignment)
        // Match 1: Player C vs Player D (or D vs C)

        // Complete Round 0, Match 0 (semi-final)
        const round0Match0 = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`\nRound 0, Match 0: ${round0Match0.common.player1.slice(0, 10)}... vs ${round0Match0.common.player2.slice(0, 10)}...`);

        const match0Player1 = round0Match0.currentTurn === playerA.address ? playerA :
                              round0Match0.currentTurn === playerB.address ? playerB :
                              round0Match0.common.player1 === playerA.address ? playerA : playerB;
        const match0Player2 = match0Player1 === playerA ? playerB : playerA;

        // Play match 0 to completion (player1 wins)
        await game.connect(match0Player1).makeMove(tierId, instanceId, 0, 0, 0); // Top-left
        await game.connect(match0Player2).makeMove(tierId, instanceId, 0, 0, 3); // Middle-left
        await game.connect(match0Player1).makeMove(tierId, instanceId, 0, 0, 1); // Top-center
        await game.connect(match0Player2).makeMove(tierId, instanceId, 0, 0, 4); // Middle-center
        await game.connect(match0Player1).makeMove(tierId, instanceId, 0, 0, 2); // Top-right (wins)

        const round0Match0Final = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`✓ Match 0 complete: Winner = ${round0Match0Final.common.winner.slice(0, 10)}...`);
        const semifinal1Winner = round0Match0Final.common.winner;

        // Complete Round 0, Match 1 (semi-final)
        const round0Match1 = await game.getMatch(tierId, instanceId, 0, 1);
        console.log(`\nRound 0, Match 1: ${round0Match1.common.player1.slice(0, 10)}... vs ${round0Match1.common.player2.slice(0, 10)}...`);

        const match1Player1 = round0Match1.currentTurn === playerC.address ? playerC :
                              round0Match1.currentTurn === playerD.address ? playerD :
                              round0Match1.common.player1 === playerC.address ? playerC : playerD;
        const match1Player2 = match1Player1 === playerC ? playerD : playerC;

        // Play match 1 to completion (player1 wins)
        await game.connect(match1Player1).makeMove(tierId, instanceId, 0, 1, 0); // Top-left
        await game.connect(match1Player2).makeMove(tierId, instanceId, 0, 1, 3); // Middle-left
        await game.connect(match1Player1).makeMove(tierId, instanceId, 0, 1, 1); // Top-center
        await game.connect(match1Player2).makeMove(tierId, instanceId, 0, 1, 4); // Middle-center
        await game.connect(match1Player1).makeMove(tierId, instanceId, 0, 1, 2); // Top-right (wins)

        const round0Match1Final = await game.getMatch(tierId, instanceId, 0, 1);
        console.log(`✓ Match 1 complete: Winner = ${round0Match1Final.common.winner.slice(0, 10)}...`);
        const semifinal2Winner = round0Match1Final.common.winner;

        // Round 1: Finals
        console.log("\n--- Round 1: Finals ---");
        const cycle1Finals = await game.getMatch(tierId, instanceId, 1, 0);
        console.log(`Finals: ${cycle1Finals.common.player1.slice(0, 10)}... vs ${cycle1Finals.common.player2.slice(0, 10)}...`);
        console.log(`Move history BEFORE any moves: "${cycle1Finals.moves}"`);

        // This should be empty initially
        expect(cycle1Finals.moves).to.equal("", "Finals should start with empty move history");

        // Determine who plays first in finals
        const finalsPlayer1Signer = cycle1Finals.currentTurn === semifinal1Winner ?
            (semifinal1Winner === playerA.address ? playerA : playerB) :
            (semifinal2Winner === playerC.address ? playerC : playerD);
        const finalsPlayer2Signer = finalsPlayer1Signer.address === semifinal1Winner ?
            (semifinal2Winner === playerC.address ? playerC : playerD) :
            (semifinal1Winner === playerA.address ? playerA : playerB);

        // Play finals to completion
        await game.connect(finalsPlayer1Signer).makeMove(tierId, instanceId, 1, 0, 6); // Bottom-left
        await game.connect(finalsPlayer2Signer).makeMove(tierId, instanceId, 1, 0, 0); // Top-left
        await game.connect(finalsPlayer1Signer).makeMove(tierId, instanceId, 1, 0, 7); // Bottom-center
        await game.connect(finalsPlayer2Signer).makeMove(tierId, instanceId, 1, 0, 1); // Top-center
        await game.connect(finalsPlayer1Signer).makeMove(tierId, instanceId, 1, 0, 8); // Bottom-right (wins)

        const cycle1FinalsComplete = await game.getMatch(tierId, instanceId, 1, 0);
        console.log(`✓ Finals complete: Winner = ${cycle1FinalsComplete.common.winner.slice(0, 10)}...`);
        console.log(`Move history after completion: "${cycle1FinalsComplete.moves}"`);

        // Store the move history from cycle 1 finals for comparison
        const cycle1FinalsMoves = cycle1FinalsComplete.moves;
        console.log(`Cycle 1 finals moves: ${cycle1FinalsMoves}`);

        // Tournament should reset
        const tournament1 = await game.getTournamentInfo(tierId, instanceId);
        console.log(`\n✓ Tournament completed: status = ${tournament1.status} (0=Enrolling)`);

        // ========== CYCLE 2: Second 4-player tournament (same instance) ==========
        console.log("\n\nCYCLE 2: Creating second 4-player tournament (same instance)...");

        await game.connect(playerE).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerF).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerG).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
        await game.connect(playerH).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

        console.log("✓ 4 NEW players enrolled (E, F, G, H)");

        // Complete Round 0 matches in cycle 2
        const cycle2Round0Match0 = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`\nCycle 2 - Round 0, Match 0: ${cycle2Round0Match0.common.player1.slice(0, 10)}... vs ${cycle2Round0Match0.common.player2.slice(0, 10)}...`);
        console.log(`Move history BEFORE any moves: "${cycle2Round0Match0.moves}"`);

        const cycle2Match0Player1 = cycle2Round0Match0.currentTurn === playerE.address ? playerE :
                                    cycle2Round0Match0.currentTurn === playerF.address ? playerF :
                                    cycle2Round0Match0.common.player1 === playerE.address ? playerE : playerF;
        const cycle2Match0Player2 = cycle2Match0Player1 === playerE ? playerF : playerE;

        await game.connect(cycle2Match0Player1).makeMove(tierId, instanceId, 0, 0, 0);
        await game.connect(cycle2Match0Player2).makeMove(tierId, instanceId, 0, 0, 3);
        await game.connect(cycle2Match0Player1).makeMove(tierId, instanceId, 0, 0, 1);
        await game.connect(cycle2Match0Player2).makeMove(tierId, instanceId, 0, 0, 4);
        await game.connect(cycle2Match0Player1).makeMove(tierId, instanceId, 0, 0, 2);

        const cycle2Round0Match0Final = await game.getMatch(tierId, instanceId, 0, 0);
        console.log(`✓ Match 0 complete: Winner = ${cycle2Round0Match0Final.common.winner.slice(0, 10)}...`);
        const cycle2Semifinal1Winner = cycle2Round0Match0Final.common.winner;

        const cycle2Round0Match1 = await game.getMatch(tierId, instanceId, 0, 1);
        console.log(`\nCycle 2 - Round 0, Match 1: ${cycle2Round0Match1.common.player1.slice(0, 10)}... vs ${cycle2Round0Match1.common.player2.slice(0, 10)}...`);

        const cycle2Match1Player1 = cycle2Round0Match1.currentTurn === playerG.address ? playerG :
                                    cycle2Round0Match1.currentTurn === playerH.address ? playerH :
                                    cycle2Round0Match1.common.player1 === playerG.address ? playerG : playerH;
        const cycle2Match1Player2 = cycle2Match1Player1 === playerG ? playerH : playerG;

        await game.connect(cycle2Match1Player1).makeMove(tierId, instanceId, 0, 1, 0);
        await game.connect(cycle2Match1Player2).makeMove(tierId, instanceId, 0, 1, 3);
        await game.connect(cycle2Match1Player1).makeMove(tierId, instanceId, 0, 1, 1);
        await game.connect(cycle2Match1Player2).makeMove(tierId, instanceId, 0, 1, 4);
        await game.connect(cycle2Match1Player1).makeMove(tierId, instanceId, 0, 1, 2);

        const cycle2Round0Match1Final = await game.getMatch(tierId, instanceId, 0, 1);
        console.log(`✓ Match 1 complete: Winner = ${cycle2Round0Match1Final.common.winner.slice(0, 10)}...`);

        // ========== THE BUG: Finals in cycle 2 should have EMPTY move history ==========
        console.log("\n--- Cycle 2 - Round 1: Finals (BUG CHECK) ---");
        const cycle2FinalsBeforeMoves = await game.getMatch(tierId, instanceId, 1, 0);
        console.log(`Finals: ${cycle2FinalsBeforeMoves.common.player1.slice(0, 10)}... vs ${cycle2FinalsBeforeMoves.common.player2.slice(0, 10)}...`);
        console.log(`Move history BEFORE any moves: "${cycle2FinalsBeforeMoves.moves}"`);

        if (cycle2FinalsBeforeMoves.moves.length > 0) {
            console.log(`❌ BUG DETECTED: Move history is polluted with ${cycle2FinalsBeforeMoves.moves.length} characters from previous tournament!`);
            console.log(`Polluted moves: ${cycle2FinalsBeforeMoves.moves}`);
            console.log(`Expected: "" (clean slate)`);
            console.log(`Actual: "${cycle2FinalsBeforeMoves.moves}"`);
        } else {
            console.log(`✓ Move history is clean (empty string)`);
        }

        // THIS IS THE ASSERTION THAT SHOULD FAIL IF BUG EXISTS
        expect(cycle2FinalsBeforeMoves.moves).to.equal(
            "",
            "Finals in new tournament cycle should start with empty move history, not polluted with previous tournament moves"
        );

        console.log("\n=== TEST COMPLETE ===\n");
    });
});
