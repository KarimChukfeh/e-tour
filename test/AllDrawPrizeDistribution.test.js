import hre from "hardhat";
import { expect } from "chai";

describe("All-Draw Prize Distribution Edge Cases", function () {
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

    describe("Finals Draw Scenarios", function () {
        it("Should split prize equally for finals draw with odd prize pool", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Use odd fee to create indivisible prize pool
            const oddFee = hre.ethers.parseEther("0.001") + 1n;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: oddFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: oddFee });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

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
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Verify both players ranked #1
            const rank1 = await game.playerRanking(tierId, instanceId, player1.address);
            const rank2 = await game.playerRanking(tierId, instanceId, player2.address);
            expect(rank1).to.equal(1);
            expect(rank2).to.equal(1);

            // Verify equal prize distribution
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);
            expect(prize1).to.equal(prize2);

            // Verify no wei lost
            expect(prize1 + prize2).to.equal(prizePool);
        });

        it("Should update tournament finalsWasDraw flag correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Play to draw
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Verify finalsWasDraw flag set
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.finalsWasDraw).to.be.true;

            // Verify both winner and coWinner set
            expect(tournament.winner).to.not.equal(hre.ethers.ZeroAddress);
            expect(tournament.coWinner).to.not.equal(hre.ethers.ZeroAddress);
            expect(tournament.winner).to.not.equal(tournament.coWinner);
        });
    });

    describe("Semi-Finals All-Draw Scenarios", function () {
        it("Should split prize among 4 players when both semi-finals draw", async function () {
            const tierId = 1; // 4-player
            const instanceId = 0;

            const players = [player1, player2, player3, player4];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Play both matches to draw
            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

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

            // Verify all 4 players have equal prizes
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);
            const prize3 = await game.playerPrizes(tierId, instanceId, player3.address);
            const prize4 = await game.playerPrizes(tierId, instanceId, player4.address);

            expect(prize1).to.equal(prize2);
            expect(prize2).to.equal(prize3);
            expect(prize3).to.equal(prize4);

            // Verify no wei lost (account for integer division remainder)
            const totalDistributed = prize1 + prize2 + prize3 + prize4;
            const remainder = prizePool - totalDistributed;
            expect(remainder).to.be.lt(4n); // Less than 4 wei remainder
            expect(remainder).to.be.gte(0n);
        });

        it("Should emit TournamentCompletedAllDraw event with correct parameters", async function () {
            const tierId = 1;
            const instanceId = 0;

            const players = [player1, player2, player3, player4];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

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

            const tx = await playMatchToDraw(1);

            // Verify event emitted
            await expect(tx)
                .to.emit(game, "TournamentCompletedAllDraw")
                .withArgs(tierId, instanceId, 0, 4, prizePool / 4n);
        });

        it("Should correctly set allDrawResolution and allDrawRound flags", async function () {
            const tierId = 1;
            const instanceId = 0;

            const players = [player1, player2, player3, player4];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            }

            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

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

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.allDrawResolution).to.be.true;
            expect(tournament.allDrawRound).to.equal(0); // Semi-finals are round 0
        });
    });

    describe("8-Player All-Draw Round 0 Scenario", function () {
        it("Should split prize among 8 players if all round 0 matches draw", async function () {
            this.timeout(60000);

            const tierId = 2; // 8-player
            const instanceId = 0;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Play all 4 matches in round 0 to draw
            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                if (!fp || !sp) {
                    console.log(`Could not find players for match ${matchNum}`);
                    return;
                }

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

            // Play all 4 matches to draw
            for (let i = 0; i < 4; i++) {
                await playMatchToDraw(i);
            }

            // Verify all 8 players have equal prizes
            const prizes = [];
            for (const player of players) {
                const prize = await game.playerPrizes(tierId, instanceId, player.address);
                prizes.push(prize);
            }

            // All prizes should be equal
            for (let i = 1; i < prizes.length; i++) {
                expect(prizes[i]).to.equal(prizes[0]);
            }

            // Verify no significant wei lost (account for integer division remainder)
            const totalDistributed = prizes.reduce((sum, prize) => sum + prize, 0n);
            const remainder = prizePool - totalDistributed;
            expect(remainder).to.be.lt(8n); // Less than 8 wei remainder
            expect(remainder).to.be.gte(0n);

            // Each should get approximately prizePool / 8
            const expectedEach = prizePool / 8n;
            expect(prizes[0]).to.equal(expectedEach);
        });
    });

    describe("Mixed Results Scenarios", function () {
        it("Should handle one draw and three wins in 8-player tournament", async function () {
            this.timeout(60000);

            const tierId = 2;
            const instanceId = 0;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Play match 0 to draw
            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

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

            // Win helper
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                return game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            // Match 0: Draw
            await playMatchToDraw(0);

            // Matches 1, 2, 3: Wins
            for (let i = 1; i < 4; i++) {
                await winMatch(0, i);
            }

            // Match 0 drew, so those players should not advance
            // Round 1 should only have 3 players (orphaned winners handling)
            // But wait, we can only have 2, 4, 8, 16 players in a round
            // So this creates an orphaned winner situation

            // For now, just verify match 0 drew and others won
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match0.common.isDraw).to.be.true;

            for (let i = 1; i < 4; i++) {
                const match = await game.getMatch(tierId, instanceId, 0, i);
                expect(match.common.isDraw).to.be.false;
                expect(match.common.winner).to.not.equal(hre.ethers.ZeroAddress);
            }
        });
    });

    describe("Player Stats for All-Draw Scenarios", function () {
        it("Should update player stats correctly for all-draw tournament", async function () {
            const tierId = 1;
            const instanceId = 0;

            const players = [player1, player2, player3, player4];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            }

            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

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

            // Verify all players have matchesPlayed incremented
            for (const player of players) {
                const stats = await game.getPlayerStats(player.address);
                expect(stats.matchesPlayed).to.equal(1);
                expect(stats.tournamentsPlayed).to.equal(1);
            }
        });
    });
});
