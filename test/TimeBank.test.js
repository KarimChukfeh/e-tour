// test/TimeBank.test.js
// Comprehensive test suite for the Time Bank (Chess Clock) system

import { expect } from "chai";
import hre from "hardhat";

describe("Time Bank System (Chess Clock) Tests", function () {
    let game;
    let owner, player1, player2, player3, player4;

    const TIER_0_FEE = hre.ethers.parseEther("0.001"); // 2-player tier
    const TIER_1_FEE = hre.ethers.parseEther("0.002"); // 4-player tier

    // Time constants
    const TEN_SECONDS = 10;

    // Dynamic timeout values (read from tier config)
    let MATCH_TIME_PER_PLAYER;

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();

        // Read actual timeout config from tier 0
        const tierConfig = await game.tierConfigs(0);
        MATCH_TIME_PER_PLAYER = Number(tierConfig.timeouts.matchTimePerPlayer);
    });

    describe("Time Bank Initialization", function () {
        it("Should initialize both players with configured match time at match start", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll two players to start a match
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match data
            const match = await game.getMatch(tierId, instanceId, 0, 0);

            // Both players should have the configured match time
            expect(match.player1TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
            expect(match.player2TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);

            // lastMoveTimestamp should be set to current block timestamp
            expect(match.lastMoveTimestamp).to.be.gt(0);
        });
    });

    describe("Time Bank Mechanics", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;
        let firstPlayerAddr, secondPlayerAddr;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayerAddr = match.currentTurn;
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
            secondPlayerAddr = secondPlayer.address;
        });

        it("Should deduct time from player's bank after making a move", async function () {
            // Wait 10 seconds
            await hre.ethers.provider.send("evm_increaseTime", [TEN_SECONDS]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player makes a move (cell 0)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Check time bank
            const match = await game.getMatch(tierId, instanceId, 0, 0);

            // First player's time should be reduced by ~10 seconds
            const isFirstPlayerP1 = firstPlayerAddr === player1.address;
            const firstPlayerTime = isFirstPlayerP1 ? match.player1TimeRemaining : match.player2TimeRemaining;

            // Should have approximately (MATCH_TIME_PER_PLAYER - 10) seconds remaining
            // Allow 2 second tolerance for block timestamp variations
            expect(firstPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - TEN_SECONDS, 2);
        });

        it("Should allow multiple moves with cumulative time deduction", async function () {
            // First player moves (10 seconds pass)
            await hre.ethers.provider.send("evm_increaseTime", [TEN_SECONDS]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Second player moves (15 seconds pass)
            await hre.ethers.provider.send("evm_increaseTime", [15]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);

            // First player moves again (20 seconds pass)
            await hre.ethers.provider.send("evm_increaseTime", [20]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const isFirstPlayerP1 = firstPlayerAddr === player1.address;
            const firstPlayerTime = isFirstPlayerP1 ? match.player1TimeRemaining : match.player2TimeRemaining;
            const secondPlayerTime = isFirstPlayerP1 ? match.player2TimeRemaining : match.player1TimeRemaining;

            // First player used: 10 + 20 = 30 seconds
            expect(firstPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 30, 3);

            // Second player used: 15 seconds
            expect(secondPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 15, 2);
        });

        it("Should NOT allow opponent to claim timeout before time runs out", async function () {
            // Wait less than the configured timeout - still within limit
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER - 10]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player tries to claim timeout - should fail
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Opponent has not run out of time");
        });

        it("Should allow opponent to claim timeout after time runs out", async function () {
            // Wait 5 minutes and 1 second (301 seconds) - exceeds 5 minute limit
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player claims timeout - should succeed
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed")
              .withArgs(tierId, instanceId, 0, 0, secondPlayerAddr, firstPlayerAddr);

            // Verify match is completed with secondPlayer as winner
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.common.winner).to.equal(secondPlayerAddr);
            expect(match.common.status).to.equal(2); // MatchStatus.Completed
        });

        it("Should NOT allow player to claim timeout on their own turn", async function () {
            // Wait past timeout
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player (current turn) tries to claim timeout - should fail
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Cannot claim timeout on your own turn");
        });

        it("Should accurately track time after turn switches", async function () {
            // First player takes 30 seconds, makes move
            await hre.ethers.provider.send("evm_increaseTime", [30]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Second player takes 45 seconds, makes move
            await hre.ethers.provider.send("evm_increaseTime", [45]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const isFirstPlayerP1 = firstPlayerAddr === player1.address;
            const firstPlayerTime = isFirstPlayerP1 ? match.player1TimeRemaining : match.player2TimeRemaining;
            const secondPlayerTime = isFirstPlayerP1 ? match.player2TimeRemaining : match.player1TimeRemaining;

            // Verify time deductions
            expect(firstPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 30, 2);
            expect(secondPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 45, 2);
        });

        it("Should handle time bank reaching exactly zero", async function () {
            // Use up exactly 5 minutes
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER]);
            await hre.ethers.provider.send("evm_mine", []);

            // Opponent can now claim timeout
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });

        it("Should NOT allow timeout claim while opponent still has time", async function () {
            // First player makes a quick move (5 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [5]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Now it's second player's turn
            // Wait less than the configured timeout (still has time)
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER - 10]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player tries to claim timeout - should fail
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Opponent has not run out of time");
        });
    });

    describe("Time Bank Edge Cases", function () {
        it("Should handle rapid successive moves without time manipulation", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match1.currentTurn === player1.address ? player2 : player1;

            // Make moves rapidly (natural block time)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Both should still have most of their time (only a few seconds elapsed)
            const match2 = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match2.player1TimeRemaining).to.be.gt(MATCH_TIME_PER_PLAYER - 10); // Lost less than 10 seconds
            expect(match2.player2TimeRemaining).to.be.gt(MATCH_TIME_PER_PLAYER - 10);
        });

        it("Should correctly handle match completion before timeout", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play a game to completion (first player wins)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);  // X top-left
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3); // O middle-left
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);  // X top-center
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O center
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X top-right - WIN

            // Match should be completed
            const finalMatch = await game.getMatch(tierId, instanceId, 0, 0);
            expect(finalMatch.common.status).to.equal(2); // MatchStatus.Completed

            // Cannot claim timeout on completed match
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Match not active");
        });
    });

    describe("Tournament Integration with Time Banks", function () {
        it("Should handle 4-player tournament with time banks properly", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Check both semifinal matches have proper time banks
            const sf0 = await game.getMatch(tierId, instanceId, 0, 0);
            const sf1 = await game.getMatch(tierId, instanceId, 0, 1);

            expect(sf0.player1TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
            expect(sf0.player2TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
            expect(sf1.player1TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
            expect(sf1.player2TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
        });

        it("Should allow timeout claim in semifinal and winner advances to finals", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Get semifinal 0 players
            const sf0 = await game.getMatch(tierId, instanceId, 0, 0);
            const sf0FirstPlayer = sf0.currentTurn === player1.address ? player1 : player2;
            const sf0SecondPlayer = sf0.currentTurn === player1.address ? player2 : player1;

            // Wait for timeout in semifinal 0
            await hre.ethers.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout victory in semifinal 0
            await game.connect(sf0SecondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check that winner advanced to finals
            const finals = await game.getMatch(tierId, instanceId, 1, 0);
            expect(finals.common.player1).to.equal(sf0SecondPlayer.address);

            // Finals should have fresh time banks when both semifinals complete
            // Since only one semifinal is done, time banks will be 0 until match starts
            expect(finals.player1TimeRemaining).to.equal(0); // Not started yet
            expect(finals.player2TimeRemaining).to.equal(0); // Not started yet
        });
    });

    describe("Time Increment (Future Feature)", function () {
        it("Should have zero increment by default", async function () {
            // This test documents that increment is currently 0
            // When increment is added in the future, this test will need updating

            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            // Wait and make move
            await hre.ethers.provider.send("evm_increaseTime", [10]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            const match2 = await game.getMatch(tierId, instanceId, 0, 0);
            const timeAfterMove = isFirstPlayerP1 ? match2.player1TimeRemaining : match2.player2TimeRemaining;

            // Time should be reduced by 10 seconds with no increment added
            expect(timeAfterMove).to.be.closeTo(MATCH_TIME_PER_PLAYER - 10, 2);
        });
    });

});
