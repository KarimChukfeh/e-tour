// test/TimeRemainingQuery.test.js
// Test that demonstrates the need for real-time time remaining calculation

import { expect } from "chai";
import hre from "hardhat";

describe("Real-Time Time Remaining Query Tests", function () {
    let game;
    let owner, player1, player2;

    const TIER_0_FEE = hre.ethers.parseEther("0.001");

    // Dynamic timeout values (read from tier config)
    let MATCH_TIME_PER_PLAYER;

    beforeEach(async function () {
        [owner, player1, player2] = await hre.ethers.getSigners();

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
        await game.initializeAllInstances();

        // Hardcoded timeout values (tierConfigs removed)
        // Tier 0 (2-player): 60s match time per player
        MATCH_TIME_PER_PLAYER = 60;
    });

    describe("Time Remaining Queries", function () {
        it("Should show correct time remaining for current player after time passes", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Start match
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match1.currentTurn === player1.address ? player2 : player1;
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            // Initial state: both players have 5 minutes
            expect(match1.player1TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);
            expect(match1.player2TimeRemaining).to.equal(MATCH_TIME_PER_PLAYER);

            // Wait 30 seconds WITHOUT making a move
            await hre.ethers.provider.send("evm_increaseTime", [30]);
            await hre.ethers.provider.send("evm_mine", []);

            // Query using getCurrentTimeRemaining - this should show real-time values
            const timeRemaining = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);

            const currentPlayerTime = isFirstPlayerP1 ? timeRemaining[0] : timeRemaining[1];
            const waitingPlayerTime = isFirstPlayerP1 ? timeRemaining[1] : timeRemaining[0];

            console.log("After 30 seconds without move:");
            console.log("  Current player real-time:", currentPlayerTime.toString());
            console.log(`  Expected: ~${MATCH_TIME_PER_PLAYER - 30} seconds (${MATCH_TIME_PER_PLAYER} - 30)`);

            // Current player should have ~270 seconds (300 - 30)
            expect(currentPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 30, 2);

            // Waiting player should still have 300
            expect(waitingPlayerTime).to.equal(MATCH_TIME_PER_PLAYER);
        });

        it("Should show real-time countdown for current player's turn", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match1.currentTurn === player1.address ? player2 : player1;
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            // First player makes a move (takes 10 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [10]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Check immediately after move - first player: -10 elapsed + 15 Fischer increment = +5 seconds net
            const match2 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayerTimeAfterMove = isFirstPlayerP1 ? match2.player1TimeRemaining : match2.player2TimeRemaining;
            expect(firstPlayerTimeAfterMove).to.be.closeTo(MATCH_TIME_PER_PLAYER + 5, 2);

            // Now it's second player's turn. Wait 20 seconds
            await hre.ethers.provider.send("evm_increaseTime", [20]);
            await hre.ethers.provider.send("evm_mine", []);

            // Query using getCurrentTimeRemaining
            const timeRemaining2 = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);
            const secondPlayerTimeDuringTurn = isFirstPlayerP1 ? timeRemaining2[1] : timeRemaining2[0];

            // Second player should show ~280 seconds (300 - 20)
            console.log("\nSecond player's turn after 20 seconds:");
            console.log("  Second player real-time:", secondPlayerTimeDuringTurn.toString());
            console.log(`  Expected: ~${MATCH_TIME_PER_PLAYER - 20} seconds (${MATCH_TIME_PER_PLAYER} - 20)`);

            expect(secondPlayerTimeDuringTurn).to.be.closeTo(MATCH_TIME_PER_PLAYER - 20, 2);
        });

        it("Should allow multiple clients to query accurate time remaining simultaneously", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            // First player's turn - wait 45 seconds
            await hre.ethers.provider.send("evm_increaseTime", [45]);
            await hre.ethers.provider.send("evm_mine", []);

            // Multiple clients query at the same time using getCurrentTimeRemaining
            const timeRemainingClient1 = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);
            const timeRemainingClient2 = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);
            const timeRemainingClient3 = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);

            const client1Time = isFirstPlayerP1 ? timeRemainingClient1[0] : timeRemainingClient1[1];
            const client2Time = isFirstPlayerP1 ? timeRemainingClient2[0] : timeRemainingClient2[1];
            const client3Time = isFirstPlayerP1 ? timeRemainingClient3[0] : timeRemainingClient3[1];

            // All clients should see the same time
            expect(client1Time).to.equal(client2Time);
            expect(client2Time).to.equal(client3Time);

            // And it should reflect the elapsed time (~255 seconds = 300 - 45)
            console.log("\nMultiple client queries after 45 seconds:");
            console.log("  All clients see:", client1Time.toString(), "seconds");
            console.log(`  Expected: ~${MATCH_TIME_PER_PLAYER - 45} seconds (${MATCH_TIME_PER_PLAYER} - 45)`);

            expect(client1Time).to.be.closeTo(MATCH_TIME_PER_PLAYER - 45, 2);
        });

        it("Should accurately calculate time remaining for both players in an ongoing match", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match1.currentTurn === player1.address ? player2 : player1;
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            // Player 1 takes 25 seconds, makes move
            await hre.ethers.provider.send("evm_increaseTime", [25]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Player 2 takes 35 seconds, makes move
            await hre.ethers.provider.send("evm_increaseTime", [35]);
            await hre.ethers.provider.send("evm_mine", []);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);

            // Player 1 is thinking for 15 seconds (no move yet)
            await hre.ethers.provider.send("evm_increaseTime", [15]);
            await hre.ethers.provider.send("evm_mine", []);

            // Query current state using getCurrentTimeRemaining
            const timeRemaining = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);
            const player1Time = isFirstPlayerP1 ? timeRemaining[0] : timeRemaining[1];
            const player2Time = isFirstPlayerP1 ? timeRemaining[1] : timeRemaining[0];

            console.log("\nAfter sequence of moves:");
            console.log("  Player 1 used 25s + thinking 15s = 40s total");
            console.log("  Player 1 real-time:", player1Time.toString());
            console.log(`  Expected: ~${MATCH_TIME_PER_PLAYER - 40} seconds (${MATCH_TIME_PER_PLAYER} - 40)`);

            console.log("\n  Player 2 used 35s");
            console.log("  Player 2 real-time:", player2Time.toString());
            console.log(`  Expected: ~${MATCH_TIME_PER_PLAYER - 35} seconds (${MATCH_TIME_PER_PLAYER} - 35)`);

            // Player 1: -25 elapsed + 15 increment (move 1), then -15 thinking = -25 total
            // Player 2: -35 elapsed + 15 increment (move 1) = -20 total
            // getCurrentTimeRemaining calculates real-time by deducting current elapsed time from stored value
            expect(player1Time).to.be.closeTo(MATCH_TIME_PER_PLAYER - 25, 2); // -25 + 15 - 15
            expect(player2Time).to.be.closeTo(MATCH_TIME_PER_PLAYER - 20, 2); // -35 + 15
        });
    });

    describe("Proposed Solution: getCurrentTimeRemaining()", function () {
        it("Should have a view function that calculates real-time remaining", async function () {
            // This test documents what we NEED to implement:
            // A view function that:
            // 1. Checks who's turn it is
            // 2. Calculates elapsed time since lastMoveTimestamp
            // 3. Returns stored time - elapsed time for current player
            // 4. Returns stored time as-is for waiting player

            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Wait 40 seconds
            await hre.ethers.provider.send("evm_increaseTime", [40]);
            await hre.ethers.provider.send("evm_mine", []);

            // Use the new getCurrentTimeRemaining() function
            const timeRemaining = await game.getCurrentTimeRemaining(tierId, instanceId, 0, 0);

            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const isFirstPlayerP1 = match1.currentTurn === player1.address;

            const currentPlayerTime = isFirstPlayerP1 ? timeRemaining[0] : timeRemaining[1];
            const waitingPlayerTime = isFirstPlayerP1 ? timeRemaining[1] : timeRemaining[0];

            console.log("\nReal-time query solution:");
            console.log("  getCurrentTimeRemaining() returns:");
            console.log("  - Current player time:", currentPlayerTime.toString(), "seconds");
            console.log(`  - Expected: ~${MATCH_TIME_PER_PLAYER - 40} seconds (${MATCH_TIME_PER_PLAYER} - 40)`);
            console.log("  - Waiting player time:", waitingPlayerTime.toString(), "seconds");
            console.log(`  - Expected: ${MATCH_TIME_PER_PLAYER} seconds`);

            // Current player should have ~260 seconds (300 - 40)
            expect(currentPlayerTime).to.be.closeTo(MATCH_TIME_PER_PLAYER - 40, 2);
            // Waiting player should still have full time
            expect(waitingPlayerTime).to.equal(MATCH_TIME_PER_PLAYER);
        });
    });
});
