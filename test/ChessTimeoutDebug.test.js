import { expect } from "chai";
import hre from "hardhat";

describe("Chess Timeout Debug", function () {
    let chess, player1, player2;
    const tierId = 0;
    const instanceId = 5; // Unique
    const roundNumber = 0;
    const matchNumber = 0;
    const entryFee = hre.ethers.parseEther("0.01");

    beforeEach(async function () {
        [, player1, player2] = await hre.ethers.getSigners();
        
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy();
        await chess.waitForDeployment();
    });

    it("Debug: Should show match state immediately after enrollment", async function () {
        const enrollTime = await hre.ethers.provider.getBlock('latest');
        console.log("Before enrollment, block timestamp:", enrollTime.timestamp);

        // Check tier config before enrollment
        const tierConfig = await chess.tierConfigs(tierId);
        console.log("Tier config matchTimePerPlayer:", tierConfig.timeouts.matchTimePerPlayer.toString());

        await chess.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
        await chess.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

        const afterEnrollTime = await hre.ethers.provider.getBlock('latest');
        console.log("After enrollment, block timestamp:", afterEnrollTime.timestamp);

        const match = await chess.getMatch(tierId, instanceId, roundNumber, matchNumber);
        console.log("Match isCached:", match.common.isCached);
        console.log("Match status:", match.common.status);
        console.log("Match player1:", match.common.player1);
        console.log("Match player2:", match.common.player2);
        console.log("Match lastMoveTimestamp:", match.lastMoveTimestamp.toString());
        console.log("Match player1TimeRemaining:", match.player1TimeRemaining.toString());
        console.log("Match player2TimeRemaining:", match.player2TimeRemaining.toString());
        console.log("Current turn:", match.currentTurn);

        const timeElapsed = BigInt(afterEnrollTime.timestamp) - match.lastMoveTimestamp;
        console.log("Time elapsed since match start:", timeElapsed.toString());

        // Try to claim timeout immediately (should fail)
        const claimer = match.currentTurn === player1.address ? player2 : player1;
        await expect(
            chess.connect(claimer).claimTimeoutWin(tierId, instanceId, roundNumber, matchNumber)
        ).to.be.revertedWith("Opponent has not run out of time");
    });
});
