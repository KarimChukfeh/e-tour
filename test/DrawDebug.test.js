import { expect } from "chai";
import hre from "hardhat";

describe("Draw Completion Debug", function () {
    let game, player1, player2, player3, player4, player5, player6, player7, player8;
    const TIER_2_FEE = hre.ethers.parseEther("0.004"); // 8-player tier
    const tierId = 2;
    const instanceId = 7; // Use same as original test

    beforeEach(async function () {
        [, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
    });

    it("Should debug completedMatches counter with draws", async function () {
        const players = [player1, player2, player3, player4, player5, player6, player7, player8];

        // Enroll all players
        for (const player of players) {
            await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
        }

        console.log("\n=== AFTER ENROLLMENT ===");
        let round0 = await game.rounds(tierId, instanceId, 0);
        console.log("Round 0 initialized:", round0.initialized);
        console.log("Round 0 totalMatches:", round0.totalMatches);
        console.log("Round 0 completedMatches:", round0.completedMatches);
        console.log("Round 0 drawCount:", round0.drawCount);

        // Helper to play a match to draw
        async function playMatchToDraw(matchNum) {
            console.log(`\n--- Playing Match ${matchNum} to DRAW ---`);

            const matchBefore = await game.getMatch(tierId, instanceId, 0, matchNum);
            console.log(`Match ${matchNum} common.status: ${matchBefore.common.status}`);
            console.log(`Match ${matchNum} common.player1: ${matchBefore.common.player1}`);
            console.log(`Match ${matchNum} common.player2: ${matchBefore.common.player2}`);
            console.log(`Match ${matchNum} common.isCached: ${matchBefore.common.isCached}`);

            if (matchBefore.common.status !== 1n) {
                console.log(`ERROR: Match ${matchNum} not InProgress, returning`);
                return false;
            }

            const fp = matchBefore.currentTurn;
            const sp = matchBefore.common.player1 === fp ? matchBefore.common.player2 : matchBefore.common.player1;

            const fpSigner = players.find(p => p.address === fp);
            const spSigner = players.find(p => p.address === sp);

            if (!fpSigner || !spSigner) {
                console.log(`ERROR: Could not find signers for match ${matchNum}`);
                return false;
            }

            console.log(`First player: ${fpSigner.address}`);
            console.log(`Second player: ${spSigner.address}`);

            // Draw pattern: fills board without winner
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 0);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 4);
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 2);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 1);
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 7);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 6);
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 3);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 5);
            const tx = await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 8);

            // Wait for transaction to be mined
            const receipt = await tx.wait();
            console.log(`Final move transaction mined in block ${receipt.blockNumber}`);

            const matchAfter = await game.getMatch(tierId, instanceId, 0, matchNum);
            console.log(`Match ${matchNum} status AFTER: ${matchAfter.common.status}`);
            console.log(`Match ${matchNum} isDraw: ${matchAfter.common.isDraw}`);

            const roundAfter = await game.rounds(tierId, instanceId, 0);
            console.log(`Round completedMatches after match ${matchNum}: ${roundAfter.completedMatches}`);
            console.log(`Round drawCount after match ${matchNum}: ${roundAfter.drawCount}`);

            return true;
        }

        // Helper to play a match to win
        async function playMatchToWin(matchNum) {
            console.log(`\n--- Playing Match ${matchNum} to WIN ---`);

            const matchBefore = await game.getMatch(tierId, instanceId, 0, matchNum);
            console.log(`Match ${matchNum} common.status BEFORE: ${matchBefore.common.status}`);

            if (matchBefore.common.status !== 1n) {
                console.log(`ERROR: Match ${matchNum} not InProgress, returning`);
                return false;
            }

            const fp = matchBefore.currentTurn;
            const sp = matchBefore.common.player1 === fp ? matchBefore.common.player2 : matchBefore.common.player1;

            const fpSigner = players.find(p => p.address === fp);
            const spSigner = players.find(p => p.address === sp);

            if (!fpSigner || !spSigner) {
                console.log(`ERROR: Could not find signers for match ${matchNum}`);
                return false;
            }

            console.log(`First player: ${fpSigner.address}`);
            console.log(`Second player: ${spSigner.address}`);

            // Win pattern: player 1 gets top row (0,1,2)
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 0);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 3);
            await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 1);
            await game.connect(spSigner).makeMove(tierId, instanceId, 0, matchNum, 4);
            const tx = await game.connect(fpSigner).makeMove(tierId, instanceId, 0, matchNum, 2);

            const receipt = await tx.wait();
            console.log(`Final move transaction mined in block ${receipt.blockNumber}`);

            const matchAfter = await game.getMatch(tierId, instanceId, 0, matchNum);
            console.log(`Match ${matchNum} common.status AFTER: ${matchAfter.common.status}`);
            console.log(`Match ${matchNum} common.winner: ${matchAfter.common.winner}`);

            const roundAfter = await game.rounds(tierId, instanceId, 0);
            console.log(`Round completedMatches after match ${matchNum}: ${roundAfter.completedMatches}`);
            console.log(`Round drawCount after match ${matchNum}: ${roundAfter.drawCount}`);

            return true;
        }

        // Play first 2 matches to draw
        await playMatchToDraw(0);
        await playMatchToDraw(1);

        // Play matches 2 and 3 to normal wins
        await playMatchToWin(2);
        await playMatchToWin(3);

        console.log("\n=== FINAL ROUND STATE ===");
        const finalRound = await game.rounds(tierId, instanceId, 0);
        console.log("Final completedMatches:", finalRound.completedMatches);
        console.log("Final drawCount:", finalRound.drawCount);
        console.log("Final totalMatches:", finalRound.totalMatches);
        console.log("Final allMatchesDrew:", finalRound.allMatchesDrew);

        // This should be 4
        expect(finalRound.completedMatches).to.equal(4);
    });
});
