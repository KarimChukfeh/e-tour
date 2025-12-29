import hre from "hardhat";
import { expect } from "chai";

describe("Wei Precision and Rounding in Prize Distribution", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;
    const TIER_0_FEE = hre.ethers.parseEther("0.001");
    const TIER_1_FEE = hre.ethers.parseEther("0.002");
    const TIER_2_FEE = hre.ethers.parseEther("0.004");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
    });

    describe("Wei Rounding in Prize Splits", function () {
        it("Should handle indivisible prize pool in finals draw (2 co-winners)", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Use odd wei amount to force rounding
            const oddFee = hre.ethers.parseEther("0.001") + 1n; // 0.001 ETH + 1 wei

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: oddFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: oddFee });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Prize pool should be 90% of (oddFee * 2)
            const expectedPrizePool = (oddFee * 2n * 90n) / 100n;
            expect(prizePool).to.equal(expectedPrizePool);

            // Play to draw
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Draw pattern
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8); // Draw

            // Verify draw completed
            const matchAfter = await game.getMatch(tierId, instanceId, 0, 0);
            expect(matchAfter.common.isDraw).to.be.true;

            // Check prize distribution
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);

            // Both should get equal amounts
            expect(prize1).to.equal(prize2);

            // Total distributed should equal prize pool (no wei lost)
            expect(prize1 + prize2).to.equal(prizePool);

            // Each should get exactly half (with integer division)
            const expectedEach = prizePool / 2n;
            expect(prize1).to.equal(expectedEach);
        });

        it("Should handle wei remainder in 4-way all-draw split", async function () {
            const tierId = 1; // 4-player
            const instanceId = 0;

            // Use amount that doesn't divide evenly by 4
            const oddFee = hre.ethers.parseEther("0.001") + 3n; // +3 wei to make indivisible by 4

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: oddFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: oddFee });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: oddFee });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: oddFee });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Play both matches to draw
            const allPlayers = [player1, player2, player3, player4];

            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = allPlayers.find(p => p.address === match.currentTurn);
                const sp = allPlayers.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 2);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 1);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 7);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 6);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 3);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 5);
                return game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 8);
            }

            await playMatchToDraw(0);
            await playMatchToDraw(1);

            // Get prizes for all 4 players
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);
            const prize3 = await game.playerPrizes(tierId, instanceId, player3.address);
            const prize4 = await game.playerPrizes(tierId, instanceId, player4.address);

            // All should be equal (integer division)
            expect(prize1).to.equal(prize2);
            expect(prize2).to.equal(prize3);
            expect(prize3).to.equal(prize4);

            // Each should get floor(prizePool / 4)
            const expectedEach = prizePool / 4n;
            expect(prize1).to.equal(expectedEach);

            // Calculate total distributed
            const totalDistributed = prize1 + prize2 + prize3 + prize4;

            // Due to integer division, there may be remainder wei (0-3 wei)
            const remainder = prizePool - totalDistributed;

            // Remainder should be less than 4 wei
            expect(remainder).to.be.lt(4);
            expect(remainder).to.be.gte(0);

            // Verify remainder is the expected modulo
            expect(remainder).to.equal(prizePool % 4n);
        });

        it("Should not lose wei in 8-player tournament prize distribution", async function () {
            this.timeout(60000);

            const tierId = 2; // 8-player
            const instanceId = 0;

            // Use odd amount
            const oddFee = hre.ethers.parseEther("0.001") + 7n;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: oddFee });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Helper to win matches quickly
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null;

                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);

                return fp.address;
            }

            // Round 0: 4 matches
            for (let i = 0; i < 4; i++) {
                await winMatch(0, i);
            }

            // Round 1: 2 matches (semi-finals)
            for (let i = 0; i < 2; i++) {
                await winMatch(1, i);
            }

            // Round 2: 1 match (finals)
            await winMatch(2, 0);

            // Calculate total distributed
            let totalDistributed = 0n;
            for (const player of players) {
                const prize = await game.playerPrizes(tierId, instanceId, player.address);
                totalDistributed += prize;
            }

            // Total distributed should equal prize pool exactly (no wei lost)
            expect(totalDistributed).to.equal(prizePool);

            // Verify prize distribution percentages
            // Tier 2 (8-player): 1st=50%, 2nd=25%, 3rd/4th=10% each, 5th-8th=0%
            const winner = players.find(async (p) => {
                const prize = await game.playerPrizes(tierId, instanceId, p.address);
                return prize === prizePool * 50n / 100n;
            });

            expect(winner).to.not.be.undefined;
        });
    });

    describe("Contract Balance Verification", function () {
        it("Should maintain zero contract balance after prize distribution", async function () {
            const tierId = 0;
            const instanceId = 0;

            const contractBalanceBefore = await hre.ethers.provider.getBalance(await game.getAddress());

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Contract should have same balance (only 10% owner fee retained)
            const contractBalanceAfter = await hre.ethers.provider.getBalance(await game.getAddress());

            // Owner fee = 10% of total fees = 10% of (TIER_0_FEE * 2)
            const ownerFee = (TIER_0_FEE * 2n * 10n) / 100n;

            // Contract should have retained owner fee
            expect(contractBalanceAfter - contractBalanceBefore).to.equal(ownerFee);
        });

        it("Should accumulate owner fees correctly across multiple tournaments", async function () {
            const tierId = 0;

            const contractBalanceBefore = await hre.ethers.provider.getBalance(await game.getAddress());

            // Run 3 tournaments
            for (let instanceId = 0; instanceId < 3; instanceId++) {
                await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
                await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

                const match = await game.getMatch(tierId, instanceId, 0, 0);
                const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
                const secondPlayer = firstPlayer === player1 ? player2 : player1;

                await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
                await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
                await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
                await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
                await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            }

            const contractBalanceAfter = await hre.ethers.provider.getBalance(await game.getAddress());

            // Owner fee per tournament = 10% of (TIER_0_FEE * 2)
            const ownerFeePerTournament = (TIER_0_FEE * 2n * 10n) / 100n;
            const totalOwnerFees = ownerFeePerTournament * 3n;

            expect(contractBalanceAfter - contractBalanceBefore).to.equal(totalOwnerFees);
        });
    });

    describe("Prize Distribution Precision", function () {
        it("Should handle 1 wei entry fee correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Minimum possible fee: 1 wei
            const minFee = 1n;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: minFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: minFee });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Prize pool = 90% of 2 wei = 1.8 wei -> rounds to 1 wei
            const expectedPrizePool = (minFee * 2n * 90n) / 100n;
            expect(prizePool).to.equal(expectedPrizePool);

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Winner should get full prize pool
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            expect(winnerPrize).to.equal(prizePool);
        });

        it("Should handle maximum precision entry fee (many decimal places)", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Fee with many decimal places: 0.123456789123456789 ETH
            const precisionFee = hre.ethers.parseEther("0.123456789123456789");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: precisionFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: precisionFee });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Verify prize pool calculated correctly
            const expectedPrizePool = (precisionFee * 2n * 90n) / 100n;
            expect(prizePool).to.equal(expectedPrizePool);

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Verify prize distribution
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            expect(winnerPrize).to.equal(prizePool);

            // No wei should be lost
            const loserPrize = await game.playerPrizes(tierId, instanceId, secondPlayer.address);
            expect(winnerPrize + loserPrize).to.equal(prizePool);
        });
    });
});
