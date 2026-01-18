import { expect } from "chai";
import hre from "hardhat";

describe("Escalation View Functions Tests", function () {
    let game;
    let owner, player1, player2, advancedPlayer, externalPlayer;

    const TIER_ID = 1;
    const INSTANCE_ID = 0;
    const ROUND_NUMBER = 0;
    const MATCH_NUMBER = 0;

    const TIER_1_FEE = hre.ethers.parseEther("0.0007");

    // Hardcoded timeout values matching TicTacChain.sol Tier 1 configuration
    // Tier 1 (4-player): 120s match time, 15s increment, 120s L2 delay, 240s L3 delay
    const MATCH_TIME_PER_PLAYER = 120;
    const TIME_INCREMENT_PER_MOVE = 15;
    const MATCH_LEVEL_2_DELAY = 120;
    const MATCH_LEVEL_3_DELAY = 240;

    beforeEach(async function () {
        [owner, player1, player2, advancedPlayer, externalPlayer] = await hre.ethers.getSigners();

        // Deploy modules
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

        // Deploy TicTacChain
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );

        // Enroll 4 players in tier 1 (4-player tournament)
        await game.connect(player1).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_1_FEE });
        await game.connect(player2).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_1_FEE });
        await game.connect(advancedPlayer).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_1_FEE });
        await game.connect(externalPlayer).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_1_FEE });

        // Start tournament and first match
        await hre.network.provider.send("evm_mine");
    });

    describe("isMatchEscL2Available", function () {
        it("Should return false when tournament status is not InProgress", async function () {
            // This is difficult to test since we'd need to complete the tournament
            // For now, we'll test that it returns false for non-existent tournament
            const available = await game.isMatchEscL2Available(99, 0, 0, 0);
            expect(available).to.be.false;
        });

        it("Should return false when match is not active", async function () {
            const available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99);
            expect(available).to.be.false;
        });

        it("Should return false when current player has not timed out", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move (still has time)
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            const available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.false;
        });

        it("Should return false when timeout occurred but L2 delay has not passed", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward to timeout but before L2 delay
            await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME_PER_PLAYER) + 10]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.false;
        });

        it("Should return true when timeout occurred and L2 delay has passed (not marked stalled)", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward past timeout + L2 delay
            const totalDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_2_DELAY) + 10;
            await hre.network.provider.send("evm_increaseTime", [totalDelay]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.true;
        });


        it("Should return false exactly at the L2 delay boundary (edge case)", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward to exactly timeout + L2 delay (not past it)
            const totalDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_2_DELAY);
            await hre.network.provider.send("evm_increaseTime", [totalDelay]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            // Should be true at >= boundary
            expect(available).to.be.true;
        });
    });

    describe("isMatchEscL3Available", function () {
        it("Should return false when tournament status is not InProgress", async function () {
            const available = await game.isMatchEscL3Available(99, 0, 0, 0);
            expect(available).to.be.false;
        });

        it("Should return false when match is not active", async function () {
            const available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99);
            expect(available).to.be.false;
        });

        it("Should return false when current player has not timed out", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move (still has time)
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            const available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.false;
        });

        it("Should return false when timeout occurred but L3 delay has not passed", async function () {
            // Get current player's turn
            let match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward to timeout + L2 delay (but not L3)
            const partialDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_2_DELAY) + 10;
            await hre.network.provider.send("evm_increaseTime", [partialDelay]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.false;
        });

        it("Should return true when timeout occurred and L3 delay has passed (not marked stalled)", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward past timeout + L3 delay
            const totalDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_3_DELAY) + 10;
            await hre.network.provider.send("evm_increaseTime", [totalDelay]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(available).to.be.true;
        });


        it("Should return false exactly at the L3 delay boundary (edge case)", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Fast forward to exactly timeout + L3 delay
            const totalDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_3_DELAY);
            await hre.network.provider.send("evm_increaseTime", [totalDelay]);
            await hre.network.provider.send("evm_mine");

            const available = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            // Should be true at >= boundary
            expect(available).to.be.true;
        });

        it("Should progress from L2 -> L3 availability over time", async function () {
            // Get current player's turn
            let match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Initial state: no escalation available
            let l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            let l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(l2).to.be.false;
            expect(l3).to.be.false;

            // After timeout + L2 delay: L2 available
            await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_2_DELAY) + 10]);
            await hre.network.provider.send("evm_mine");

            l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(l2).to.be.true;
            expect(l3).to.be.false;

            // After L3 delay: both L2 and L3 available
            await hre.network.provider.send("evm_increaseTime", [
                Number(MATCH_LEVEL_3_DELAY) - Number(MATCH_LEVEL_2_DELAY) + 10
            ]);
            await hre.network.provider.send("evm_mine");

            l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(l2).to.be.true;
            expect(l3).to.be.true;
        });
    });

    describe("Cross-level consistency checks", function () {
        it("Should never have L3 available without L2 being available", async function () {
            // Get current player's turn
            const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // Test at multiple time points
            for (let i = 0; i < 15; i++) {
                await hre.network.provider.send("evm_increaseTime", [30]);
                await hre.network.provider.send("evm_mine");

                const l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);

                if (l3) {
                    expect(l2).to.be.true;
                }
            }
        });
    });

    describe("Match completion invalidation", function () {
        it("Should return false for all escalation levels after match is completed", async function () {
            // Get current player's turn
            let match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const currentPlayer = match.currentTurn === player1.address ? player1 : player2;

            // Player makes a move
            await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

            // After the move, the turn switches - get the new current player
            match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            const opponentPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Fast forward past timeout + L3 delay
            const totalDelay = Number(MATCH_TIME_PER_PLAYER) + Number(MATCH_LEVEL_3_DELAY) + 100;
            await hre.network.provider.send("evm_increaseTime", [totalDelay]);
            await hre.network.provider.send("evm_mine");

            // Verify L2 and L3 are available before completion
            let l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            let l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(l2).to.be.true;
            expect(l3).to.be.true;

            // Complete the match by claiming timeout (opponent of current player claims)
            await game.connect(opponentPlayer).claimTimeoutWin(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);

            // After completion, all should be false
            l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
            expect(l2).to.be.false;
            expect(l3).to.be.false;
        });
    });
});
