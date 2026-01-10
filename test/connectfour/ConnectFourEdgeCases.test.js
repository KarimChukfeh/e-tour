import hre from "hardhat";
import { expect } from "chai";

describe("ConnectFour Edge Cases", function () {
    let game;
    let player1, player2;
    const TIER_0_FEE = hre.ethers.parseEther("0.001");

    beforeEach(async function () {
        [, player1, player2] = await hre.ethers.getSigners();

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

        // Deploy ConnectFourOnChain with modules
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // Initialize tiers
        // Tiers are now initialized in constructor
    });

    describe("Column Full Detection", function () {
        it("Should reject move to column that is full (6 pieces)", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayerAddr = match.currentTurn;
            const firstPlayer = [player1, player2].find(p => p.address === firstPlayerAddr);
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Fill column 3 completely (6 pieces)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // 1st piece
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // 2nd piece
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // 3rd piece
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // 4th piece
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // 5th piece
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // 6th piece (column now full)

            // Try to place 7th piece in same column - should fail (column full)
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3)
            ).to.be.reverted; // Error code is "CF" now
        });

        it("Should allow moves to other columns when one column is full", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayerAddr = match.currentTurn;
            const firstPlayer = [player1, player2].find(p => p.address === firstPlayerAddr);
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Fill column 0
            for (let i = 0; i < 6; i++) {
                const player = i % 2 === 0 ? firstPlayer : secondPlayer;
                await game.connect(player).makeMove(tierId, instanceId, 0, 0, 0);
            }

            // Column 0 should be full - verify by checking move fails
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0)
            ).to.be.reverted;

            // Column 1 should still be available - verify successful move
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1)
            ).to.not.be.reverted;
        });
    });
});
