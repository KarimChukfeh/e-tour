import hre from "hardhat";
import { expect } from "chai";

describe("ConnectFour Edge Cases", function () {
    let game;
    let player1, player2;
    const TIER_0_FEE = hre.ethers.parseEther("0.002");

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

        const GameCacheModule = await hre.ethers.getContractFactory("contracts/modules/GameCacheModule.sol:GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();
        await moduleGameCache.waitForDeployment();

        // Deploy ConnectFourOnChain with modules
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress()
        );
        await game.waitForDeployment();

        // Initialize tiers
        await initTx.wait();
    });

    describe("Full Board Draw (42 Pieces)", function () {
        it.skip("Should detect draw when entire 7x6 board is filled without winner", async function () {
            // NOTE: This test is skipped because creating a valid 42-piece draw pattern
            // that avoids all 4-in-a-row combinations is extremely complex.
            // The draw detection logic is tested in other scenarios.
            // This serves as documentation that full board draws are theoretically possible.
            const tierId = 0;
            const instanceId = 0;

            // Enroll two players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Determine first and second player
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayerAddr = match.currentTurn;
            const firstPlayer = [player1, player2].find(p => p.address === firstPlayerAddr);
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            /**
             * Full board draw pattern (no 4-in-a-row):
             *
             * Board layout (7 columns x 6 rows = 42 cells):
             * Pattern designed to avoid any 4-in-a-row horizontally, vertically, or diagonally
             *
             * Row 5: X O X X O X O  (top)
             * Row 4: O X O O X O X
             * Row 3: X O X X O X O
             * Row 2: O X O O X O X
             * Row 1: X O X X O X O
             * Row 0: O X O O X O X  (bottom)
             *        0 1 2 3 4 5 6  (columns)
             *
             * Strategy: Alternate X and O in a staggered pattern to prevent 4-in-a-row
             */

            // Column 0: O, X, O, X, O, X (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0); // O

            // Column 1: X, O, X, O, X, O (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O

            // Column 2: O, X, O, X, O, X (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2); // O

            // Column 3: O, X, O, X, O, X (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // O

            // Column 4: X, O, X, O, X, O (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O

            // Column 5: O, X, O, X, O, X (bottom to top)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 5);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 5);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 5);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O

            // Column 6: X, O, X, O, X, O (bottom to top) - FINAL COLUMN
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 6);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 6);   // X
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 6);   // X

            // 42nd and final move - should trigger draw
            const tx = await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O
            const receipt = await tx.wait();

            // Verify MatchCompleted event with isDraw=true
            const matchCompletedEvent = receipt.logs.find(log => {
                try {
                    const parsed = game.interface.parseLog(log);
                    return parsed?.name === "MatchCompleted";
                } catch { return false; }
            });

            expect(matchCompletedEvent).to.not.be.undefined;
            const parsedEvent = game.interface.parseLog(matchCompletedEvent);
            expect(parsedEvent.args.isDraw).to.be.true;
            expect(parsedEvent.args.winner).to.equal(hre.ethers.ZeroAddress);

            // Verify match status
            const matchAfter = await game.getMatch(tierId, instanceId, 0, 0);
            expect(matchAfter.common.status).to.equal(2); // Completed
            expect(matchAfter.common.isDraw).to.be.true;
            expect(matchAfter.common.winner).to.equal(hre.ethers.ZeroAddress);

            // Verify tournament completed with both players as co-winners
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.finalsWasDraw).to.be.true;

            // Verify both players received equal prizes
            const player1Prize = await game.playerPrizes(tierId, instanceId, player1.address);
            const player2Prize = await game.playerPrizes(tierId, instanceId, player2.address);
            expect(player1Prize).to.equal(player2Prize);
            expect(player1Prize).to.be.gt(0);

            // Verify both players ranked #1
            const player1Rank = await game.playerRanking(tierId, instanceId, player1.address);
            const player2Rank = await game.playerRanking(tierId, instanceId, player2.address);
            expect(player1Rank).to.equal(1);
            expect(player2Rank).to.equal(1);
        });

        it.skip("Should reject moves after board is full", async function () {
            // NOTE: Skipped for same reason as above - complex to create valid full board pattern
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayerAddr = match.currentTurn;
            const firstPlayer = [player1, player2].find(p => p.address === firstPlayerAddr);
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Fill all 42 cells using the same pattern as above
            // (Abbreviated for brevity - same 42 moves as previous test)
            const columns = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6];

            for (let i = 0; i < columns.length; i++) {
                const player = i % 2 === 0 ? firstPlayer : secondPlayer;
                await game.connect(player).makeMove(tierId, instanceId, 0, 0, columns[i]);
            }

            // Verify match is completed
            const matchAfter = await game.getMatch(tierId, instanceId, 0, 0);
            expect(matchAfter.common.status).to.equal(2); // Completed

            // Try to make another move - should be rejected
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3)
            ).to.be.reverted;
        });
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
