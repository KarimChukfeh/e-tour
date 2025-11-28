// test/ETourIntegration.test.js
// Comprehensive test suite for ETour protocol integration with TicTacBlock

import { expect } from "chai";
import hre from "hardhat";

describe("ETour Protocol Integration Tests", function () {
    let etour, game;
    let owner, player1, player2, player3, player4;

    beforeEach(async function () {
        // Get signers
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        // Deploy ETour protocol
        const ETour = await hre.ethers.getContractFactory("ETour");
        etour = await ETour.deploy();
        await etour.waitForDeployment();

        // Deploy TicTacBlock with ETour integration
        const TicTacBlock = await hre.ethers.getContractFactory("TicTacBlock");
        game = await TicTacBlock.deploy(await etour.getAddress());
        await game.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should deploy with correct ETour address", async function () {
            expect(await game.etour()).to.equal(await etour.getAddress());
        });

        it("Should have correct owner", async function () {
            expect(await game.owner()).to.equal(owner.address);
        });
    });

    describe("ETour Protocol Functions", function () {
        it("Should calculate total rounds correctly", async function () {
            expect(await etour.calculateTotalRounds(2)).to.equal(1);
            expect(await etour.calculateTotalRounds(4)).to.equal(2);
            expect(await etour.calculateTotalRounds(8)).to.equal(3);
            expect(await etour.calculateTotalRounds(16)).to.equal(4);
            expect(await etour.calculateTotalRounds(64)).to.equal(6);
            expect(await etour.calculateTotalRounds(128)).to.equal(7);
        });

        it("Should calculate three-way split correctly", async function () {
            const amount = hre.ethers.parseEther("1.0");
            const [participants, ownerShare, protocol] = await etour.calculateThreeWaySplit(amount);

            expect(participants).to.equal(hre.ethers.parseEther("0.9"));
            expect(ownerShare).to.equal(hre.ethers.parseEther("0.075"));
            expect(protocol).to.equal(hre.ethers.parseEther("0.025"));

            // Verify no dust is lost
            const total = participants + ownerShare + protocol;
            expect(total).to.equal(amount);
        });

        it("Should validate power of two correctly", async function () {
            expect(await etour.isPowerOfTwo(1)).to.be.true;
            expect(await etour.isPowerOfTwo(2)).to.be.true;
            expect(await etour.isPowerOfTwo(4)).to.be.true;
            expect(await etour.isPowerOfTwo(8)).to.be.true;
            expect(await etour.isPowerOfTwo(16)).to.be.true;
            expect(await etour.isPowerOfTwo(32)).to.be.true;
            expect(await etour.isPowerOfTwo(64)).to.be.true;
            expect(await etour.isPowerOfTwo(128)).to.be.true;

            expect(await etour.isPowerOfTwo(3)).to.be.false;
            expect(await etour.isPowerOfTwo(5)).to.be.false;
            expect(await etour.isPowerOfTwo(6)).to.be.false;
            expect(await etour.isPowerOfTwo(7)).to.be.false;
            expect(await etour.isPowerOfTwo(9)).to.be.false;
        });

        it("Should check round completion correctly", async function () {
            expect(await etour.isRoundComplete(0, 4)).to.be.false;
            expect(await etour.isRoundComplete(2, 4)).to.be.false;
            expect(await etour.isRoundComplete(4, 4)).to.be.true;
            expect(await etour.isRoundComplete(5, 4)).to.be.true;
        });
    });

    describe("Tournament Enrollment", function () {
        it("Should enroll players and auto-start when full", async function () {
            const tierId = 0; // 2-player tier
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.001");

            // Enroll first player
            await expect(game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: entryFee
            })).to.emit(game, "PlayerEnrolled");

            // Check tournament is still enrolling
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Enroll second player - should auto-start
            await expect(game.connect(player2).enrollInTournament(tierId, instanceId, {
                value: entryFee
            })).to.emit(game, "TournamentStarted");

            // Check tournament has started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });

        it("Should split entry fees correctly using ETour", async function () {
            const tierId = 0;
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.001");

            const ownerBalanceBefore = await hre.ethers.provider.getBalance(owner.address);

            // Enroll player
            await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: entryFee
            });

            const ownerBalanceAfter = await hre.ethers.provider.getBalance(owner.address);

            // Owner should receive 7.5% + 2.5% = 10% of entry fee
            const expectedOwnerIncrease = (entryFee * 1000n) / 10000n; // 10%
            expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(expectedOwnerIncrease);

            // Tournament should have 90% in prize pool
            const tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = (entryFee * 9000n) / 10000n; // 90%
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });
    });

    describe("Tournament Logic", function () {
        it("Should use ETour for match count calculation", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.002");

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Tournament should have started
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round 0 was initialized with correct match count
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(2); // 4 players = 2 matches in first round
        });

        it("Should handle odd player count with walkover", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.002");

            // Enroll only 3 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Force start after timeout
            await hre.ethers.provider.send("evm_increaseTime", [120]); // 2 minutes
            await hre.ethers.provider.send("evm_mine", []);

            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Check tournament started
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round has 1 match (3 players = 1 match + 1 walkover)
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(1);
        });
    });

    describe("Game Play Integration", function () {
        beforeEach(async function () {
            // Start a 2-player tournament
            const tierId = 0;
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.001");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
        });

        it("Should allow players to make moves", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Player 1 makes first move
            await expect(game.connect(player1).makeMove(tierId, instanceId, 0, 0, 4))
                .to.emit(game, "MoveMade");

            // Player 2 makes second move
            await expect(game.connect(player2).makeMove(tierId, instanceId, 0, 0, 0))
                .to.emit(game, "MoveMade");
        });

        it("Should handle blocking mechanic in Pro mode", async function () {
            const tierId = 6; // 2-player Pro mode
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.0015");

            // Enroll in Pro tier
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Player 1 moves to cell 4 and blocks cell 0
            await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 4, 0);

            // Player 2 cannot move to blocked cell 0
            await expect(game.connect(player2).makeMove(tierId, instanceId, 0, 0, 0))
                .to.be.revertedWith("Cell is blocked");

            // Player 2 can move to a different cell
            await expect(game.connect(player2).makeMove(tierId, instanceId, 0, 0, 1))
                .to.emit(game, "MoveMade");
        });
    });

    describe("ABI Compatibility", function () {
        it("Should maintain all essential functions", async function () {
            // Check that key functions exist
            expect(game.enrollInTournament).to.exist;
            expect(game.forceStartTournament).to.exist;
            expect(game.makeMove).to.exist;
            expect(game.claimMatchByTimeout).to.exist;
            expect(game.claimStuckTournament).to.exist;
            expect(game.manuallyAdvanceWinnersFromAllDrawRound).to.exist;

            // Check view functions
            expect(game.tournaments).to.exist;
            expect(game.rounds).to.exist;
            expect(game.matches).to.exist;
            expect(game.getBoard).to.exist;
            expect(game.getCachedTournamentState).to.exist;
        });
    });

    describe("Gas Optimization", function () {
        it("Should have reasonable gas costs for enrollment", async function () {
            const tierId = 0;
            const instanceId = 1; // Use different instance
            const entryFee = hre.ethers.parseEther("0.001");

            const tx = await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: entryFee
            });
            const receipt = await tx.wait();

            console.log("      Gas used for enrollment:", receipt.gasUsed.toString());
            expect(receipt.gasUsed).to.be.lt(500000); // Should be under 500k gas
        });
    });
});
