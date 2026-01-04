import { expect } from "chai";
import hre from "hardhat";

describe("TicTacToe Timeout Debug", function () {
    let game, player1, player2;
    const tierId = 0;
    const instanceId = 15; // Unique
    const roundNumber = 0;
    const matchNumber = 0;
    const entryFee = hre.ethers.parseEther("0.001");

    beforeEach(async function () {
        [, player1, player2] = await hre.ethers.getSigners();
        
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
    });

    it("Debug: Should show match state immediately after enrollment", async function () {
        const enrollTime = await hre.ethers.provider.getBlock('latest');
        console.log("Before enrollment, block timestamp:", enrollTime.timestamp);

        await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
        await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

        const afterEnrollTime = await hre.ethers.provider.getBlock('latest');
        console.log("After enrollment, block timestamp:", afterEnrollTime.timestamp);

        const match = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
        console.log("Match lastMoveTimestamp:", match.lastMoveTimestamp.toString());
        console.log("Match player1TimeRemaining:", match.player1TimeRemaining.toString());
        console.log("Match player2TimeRemaining:", match.player2TimeRemaining.toString());
        console.log("Current turn:", match.currentTurn);

        const timeElapsed = BigInt(afterEnrollTime.timestamp) - match.lastMoveTimestamp;
        console.log("Time elapsed since match start:", timeElapsed.toString());

        // Try to claim timeout immediately (should fail)
        const claimer = match.currentTurn === player1.address ? player2 : player1;
        await expect(
            game.connect(claimer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
        ).to.be.revertedWith("Opponent has not run out of time");
    });
});
