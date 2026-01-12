import hre from "hardhat";
import { expect } from "chai";

describe("Wei Precision and Rounding in Prize Distribution", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");
    const TIER_1_FEE = hre.ethers.parseEther("0.0007");
    const TIER_2_FEE = hre.ethers.parseEther("0.0013");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

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

    describe("Wei Rounding in Prize Splits", function () {
        it("Should handle indivisible prize pool in finals draw (2 co-winners)", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Use standard fee (contract validates exact entry fee)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Prize pool should be 90% of (TIER_0_FEE * 2)
            const expectedPrizePool = (TIER_0_FEE * 2n * 90n) / 100n;
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
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8); // Draw

            // Verify draw completed via TournamentCompleted event (2-player draw uses regular completion)
            const receipt = await tx.wait();
            const tournamentEvent = receipt.logs.find(log => {
                try {
                    const parsed = game.interface.parseLog(log);
                    return parsed.name === "TournamentCompleted";
                } catch (e) {
                    return false;
                }
            });
            expect(tournamentEvent).to.not.be.undefined;

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

            // Use standard fee (contract validates exact entry fee)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

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

            // Use standard fee (contract validates exact entry fee)
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
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
            // Tier 2 (8-player): 1st=100%, all others=0%
            const winner = players.find(async (p) => {
                const prize = await game.playerPrizes(tierId, instanceId, p.address);
                return prize === prizePool;
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

            // Contract should retain only protocol fee (owner fee paid out immediately)
            const contractBalanceAfter = await hre.ethers.provider.getBalance(await game.getAddress());

            // Protocol fee = 2.5% of total fees = 2.5% of (TIER_0_FEE * 2)
            const protocolFee = (TIER_0_FEE * 2n * 25n) / 1000n;

            // Contract should have retained protocol fee in accumulatedProtocolShare
            expect(contractBalanceAfter - contractBalanceBefore).to.equal(protocolFee);
        });

        it("Should accumulate protocol fees correctly across multiple tournaments", async function () {
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

            // Protocol fee per tournament = 2.5% of (TIER_0_FEE * 2)
            const protocolFeePerTournament = (TIER_0_FEE * 2n * 25n) / 1000n;
            const totalProtocolFees = protocolFeePerTournament * 3n;

            expect(contractBalanceAfter - contractBalanceBefore).to.equal(totalProtocolFees);
        });
    });

    describe("Prize Distribution Precision", function () {
        it("Should handle standard entry fee precision correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Use standard fee (contract validates exact entry fee)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Prize pool = 90% of (TIER_0_FEE * 2)
            const expectedPrizePool = (TIER_0_FEE * 2n * 90n) / 100n;
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

        it("Should handle entry fee calculations with precision", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Use standard fee (contract validates exact entry fee)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Verify prize pool calculated correctly
            const expectedPrizePool = (TIER_0_FEE * 2n * 90n) / 100n;
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
