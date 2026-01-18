// test/TimeBank.test.js
// Comprehensive test suite for the Time Bank (Chess Clock) system

import { expect } from "chai";
import hre from "hardhat";

describe("Time Bank System (Chess Clock) Tests", function () {
    let game;
    let owner, player1, player2, player3, player4;

    const TIER_0_FEE = hre.ethers.parseEther("0.0003"); // 2-player tier
    const TIER_1_FEE = hre.ethers.parseEther("0.0007"); // 4-player tier

    // Time constants
    const TEN_SECONDS = 10;

    // Dynamic timeout values (read from tier config)
    let TIER_0_MATCH_TIME;
    let TIER_1_MATCH_TIME;

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        // Deploy modules first
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();

        // Deploy TicTacChain with module addresses
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // Hardcoded timeout values matching TicTacChain.sol configuration
        // Tier 0 (2-player): 120s match time per player
        // Tier 1 (4-player): 120s match time per player
        TIER_0_MATCH_TIME = 120;
        TIER_1_MATCH_TIME = 120;
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
            expect(match.player1TimeRemaining).to.equal(TIER_0_MATCH_TIME);
            expect(match.player2TimeRemaining).to.equal(TIER_0_MATCH_TIME);

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

            // With Fischer increment: (TIER_0_MATCH_TIME - 10 elapsed + 15 increment) = TIER_0_MATCH_TIME + 5
            // Allow 2 second tolerance for block timestamp variations
            expect(firstPlayerTime).to.be.closeTo(TIER_0_MATCH_TIME + 5, 2);
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

            // First player: -10 elapsed +15 increment, then -20 elapsed +15 increment = TIER_0_MATCH_TIME
            expect(firstPlayerTime).to.be.closeTo(TIER_0_MATCH_TIME, 3);

            // Second player: -15 elapsed +15 increment = TIER_0_MATCH_TIME
            expect(secondPlayerTime).to.be.closeTo(TIER_0_MATCH_TIME, 2);
        });

        it("Should NOT allow opponent to claim timeout before time runs out", async function () {
            // Wait less than the configured timeout - still within limit
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME - 10]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player tries to claim timeout - should fail
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("TO"); // Short error code for timeout not reached
        });

        it("Should allow opponent to claim timeout after time runs out", async function () {
            // Wait past timeout limit
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Second player claims timeout - should succeed
            await game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Verify tournament completed and reset to Enrolling
            const [tournamentStatus] = await game.getTournamentInfo(tierId, instanceId);
            expect(tournamentStatus).to.equal(0); // Tournament completed and reset to Enrolling

            // Verify winner received prize
            const winnerPrize = await game.playerPrizes(tierId, instanceId, secondPlayerAddr);
            expect(winnerPrize).to.be.gt(0);
        });

        it("Should NOT allow player to claim timeout on their own turn", async function () {
            // Wait past timeout
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player (current turn) tries to claim timeout - should fail
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("OT"); // Short error code for own turn
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

            // Verify time with Fischer increment: first player -30 +15 = -15, second player -45 +15 = -30
            expect(firstPlayerTime).to.be.closeTo(TIER_0_MATCH_TIME - 15, 2);
            expect(secondPlayerTime).to.be.closeTo(TIER_0_MATCH_TIME - 30, 2);
        });

        it("Should handle time bank reaching exactly zero", async function () {
            // Use up exactly the match time
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME]);
            await hre.ethers.provider.send("evm_mine", []);

            // Opponent can now claim timeout
            await game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Verify tournament completed
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling after completion
        });

        it("Should NOT allow timeout claim while opponent still has time", async function () {
            // First player makes a quick move (5 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [5]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Now it's second player's turn
            // Wait less than the configured timeout (still has time)
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME - 10]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player tries to claim timeout - should fail
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("TO"); // Short error code for timeout not reached
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
            expect(match2.player1TimeRemaining).to.be.gt(TIER_0_MATCH_TIME - 10); // Lost less than 10 seconds
            expect(match2.player2TimeRemaining).to.be.gt(TIER_0_MATCH_TIME - 10);
        });

        it("Should correctly handle match completion before timeout", async function () {
            const tierId = 0;
            const instanceId = 50; // Use unique instance to avoid conflicts

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
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X top-right - WIN

            // Verify TournamentCompleted event contains winner data
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
            const parsedTournamentEvent = game.interface.parseLog(tournamentEvent);
            expect(parsedTournamentEvent.args.winner).to.equal(match.currentTurn);

            // Match should be completed (2-player tournament finals)
            // Finals cleared immediately - verify tournament completed via status
            const [tournamentStatus] = await game.getTournamentInfo(tierId, instanceId);
            expect(tournamentStatus).to.equal(0); // Tournament completed and reset to Enrolling

            // Cannot claim timeout on completed match (finals already cleared)
            await hre.ethers.provider.send("evm_increaseTime", [TIER_0_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("MA"); // Match not Active - finals cleared (status = 0)
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

            expect(sf0.player1TimeRemaining).to.equal(TIER_1_MATCH_TIME);
            expect(sf0.player2TimeRemaining).to.equal(TIER_1_MATCH_TIME);
            expect(sf1.player1TimeRemaining).to.equal(TIER_1_MATCH_TIME);
            expect(sf1.player2TimeRemaining).to.equal(TIER_1_MATCH_TIME);
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
            await hre.ethers.provider.send("evm_increaseTime", [TIER_1_MATCH_TIME + 1]);
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout victory in semifinal 0
            await game.connect(sf0SecondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check that winner advanced to finals
            const finals = await game.getMatch(tierId, instanceId, 1, 0);
            expect(finals.player1).to.equal(sf0SecondPlayer.address);

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

            // Time: -10 seconds elapsed + 15 seconds Fischer increment = +5 seconds net
            expect(timeAfterMove).to.be.closeTo(TIER_0_MATCH_TIME + 5, 2);
        });
    });

});
