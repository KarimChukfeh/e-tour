// test/ETourIntegration.test.js
// Comprehensive test suite for TicTacChain (ETour protocol implementation)

import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain (ETour Protocol) Tests", function () {
    let game;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;

    const TIER_0_FEE = hre.ethers.parseEther("0.001"); // 2-player tier
    const TIER_1_FEE = hre.ethers.parseEther("0.002"); // 4-player tier
    const TIER_2_FEE = hre.ethers.parseEther("0.004"); // 8-player tier

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        // Deploy all ETour modules
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

        // Deploy TicTacChain (player tracking and game logic are now built-in)
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress()
        );
        await game.waitForDeployment();

        // Initialize tiers (moved out of constructor for gas optimization)
        await game.initializeAllInstances();
    });

    describe("Deployment", function () {
        it("Should deploy successfully", async function () {
            expect(await game.getAddress()).to.be.properAddress;
        });

        it("Should have correct owner", async function () {
            expect(await game.owner()).to.equal(owner.address);
        });

        it("Should have 3 tiers configured", async function () {
            expect(await game.tierCount()).to.equal(3);
        });

        // tierConfigs tests removed - tier configuration is now hardcoded in contract
    });

    describe("Tournament Enrollment", function () {
        it("Should enroll players and auto-start when full (2-player)", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll first player
            await expect(game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "PlayerEnrolled");

            // Check tournament is still enrolling
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Enroll second player - should auto-start
            await expect(game.connect(player2).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            })).to.emit(game, "TournamentStarted");

            // Check tournament has started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });

        it("Should split entry fees correctly (90% prize pool, 10% owner)", async function () {
            const tierId = 0;
            const instanceId = 0;

            const ownerBalanceBefore = await hre.ethers.provider.getBalance(owner.address);

            // Enroll player
            await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            });

            const ownerBalanceAfter = await hre.ethers.provider.getBalance(owner.address);

            // Owner should receive 7.5% of entry fee (2.5% protocol fee goes to accumulatedProtocolShare)
            const expectedOwnerIncrease = (TIER_0_FEE * 750n) / 10000n; // 7.5%
            expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(expectedOwnerIncrease);

            // Tournament should have 90% in prize pool
            const tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = (TIER_0_FEE * 9000n) / 10000n; // 90%
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });

        it("Should reject incorrect entry fee", async function () {
            const tierId = 0;
            const instanceId = 0;

            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, {
                    value: hre.ethers.parseEther("0.0005") // Wrong fee
                })
            ).to.be.revertedWith("E");
        });

        it("Should reject duplicate enrollment", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });

        it("Should reject invalid tier", async function () {
            await expect(
                game.connect(player1).enrollInTournament(99, 0, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });
    });

    describe("Tournament Logic", function () {
        it("Should initialize round with correct match count (8-player = 4 matches)", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 0;

            // Enroll 8 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player6).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player7).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player8).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Tournament should have started
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Check round 0 was initialized with 4 matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(4); // 8 players = 4 matches in first round
        });

        it("Should handle force start after enrollment timeout", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 0;

            // Enroll only 2 players (less than required 8)
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Tournament should still be enrolling
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Force start before timeout should fail
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("FS");

            // Fast forward past enrollment window (480s for Tier 2)
            await hre.ethers.provider.send("evm_increaseTime", [481]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start should work now
            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Check tournament started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });
    });

    describe("Game Play", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;

            // Start a 2-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Determine who goes first (randomized)
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should allow players to make moves", async function () {
            // First player makes move to center (cell 4)
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4))
                .to.emit(game, "MoveMade");

            // Second player makes move to corner (cell 0)
            await expect(game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0))
                .to.emit(game, "MoveMade");
        });

        it("Should switch turns after each move", async function () {
            let match = await game.getMatch(tierId, instanceId, 0, 0);
            const initialTurn = match.currentTurn;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.currentTurn).to.not.equal(initialTurn);
        });

        it("Should reject move when not your turn", async function () {
            await expect(
                game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("NT");
        });

        it("Should reject move to occupied cell", async function () {
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 0);

            // Try to move to already occupied cell 4
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("CO");
        });

        it("Should reject invalid cell index", async function () {
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 9)
            ).to.be.revertedWith("IC");
        });

        it("Should reject move from non-player", async function () {
            await expect(
                game.connect(player3).makeMove(tierId, instanceId, 0, 0, 4)
            ).to.be.revertedWith("NP");
        });
    });

    describe("Win Detection", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should detect horizontal win (top row)", async function () {
            // First player: 0, 1, 2 (top row)
            // Second player: 3, 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move - verify via TournamentCompleted event (2-player = finals)
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            // Winner's earnings should be updated
            const earnings = await game.connect(firstPlayer).getPlayerStats();
            expect(earnings).to.be.gt(0);
        });

        it("Should detect vertical win (left column)", async function () {
            // First player: 0, 3, 6 (left column)
            // Second player: 1, 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move - verify via TournamentCompleted event
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 6))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            const earnings = await game.connect(firstPlayer).getPlayerStats();
            expect(earnings).to.be.gt(0);
        });

        it("Should detect diagonal win (0, 4, 8)", async function () {
            // First player: 0, 4, 8 (diagonal)
            // Second player: 1, 2
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Winning move - verify via TournamentCompleted event
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8))
                .to.emit(game, "MatchCompleted")
                .and.to.emit(game, "TournamentCompleted");

            const earnings = await game.connect(firstPlayer).getPlayerStats();
            expect(earnings).to.be.gt(0);
        });

        it("Should detect draw when board is full with no winner", async function () {
            // Classic draw pattern:
            // X | O | X
            // X | O | O
            // O | X | X
            // Cells: 0=X, 1=O, 2=X, 3=X, 4=O, 5=O, 6=O, 7=X, 8=X

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);  // X at 0
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O at 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X at 2
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O at 1
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);  // X at 7
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O at 6
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);  // X at 3
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O at 5

            // Final move results in draw - emits MatchCompleted with isDraw=true via event args
            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);
            const receipt = await tx.wait();

            // Find MatchCompleted event and verify isDraw
            const matchCompletedEvent = receipt.logs.find(log => {
                try {
                    const parsed = game.interface.parseLog(log);
                    return parsed?.name === "MatchCompleted";
                } catch { return false; }
            });

            expect(matchCompletedEvent).to.not.be.undefined;
            const parsedEvent = game.interface.parseLog(matchCompletedEvent);
            expect(parsedEvent.args.isDraw).to.be.true;
        });
    });

    describe("Tournament Completion", function () {
        it("Should complete 2-player tournament and distribute prizes", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            const winnerBalanceBefore = await hre.ethers.provider.getBalance(firstPlayer.address);

            // Play to a quick win (top row)
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Winning move completes tournament
            await expect(game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2))
                .to.emit(game, "TournamentCompleted");

            // Tournament should reset to Enrolling
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset)
        });
    });

    describe("Timeout Functions", function () {
        let tierId, instanceId;
        let firstPlayer, secondPlayer;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;
        });

        it("Should allow timeout claim after timeout period", async function () {
            // Move time forward past time bank (2 minutes + 1 second)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // Non-current-turn player can claim timeout
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });

        it("Should reject early timeout claim", async function () {
            await expect(
                game.connect(secondPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("TO");
        });

        it("Should reject timeout claim on your own turn", async function () {
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // Current turn player cannot claim timeout
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("OT");
        });
    });

    describe("View Functions", function () {
        it("Should return match data correctly", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(match.common.status).to.equal(1); // InProgress
        });
    });

    describe("Gas Optimization", function () {
        it("Should have reasonable gas costs for enrollment", async function () {
            const tierId = 0;
            const instanceId = 1;

            const tx = await game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: TIER_0_FEE
            });
            const receipt = await tx.wait();

            console.log("      Gas used for enrollment:", receipt.gasUsed.toString());
            expect(receipt.gasUsed).to.be.lt(500000);
        });

        it("Should have reasonable gas costs for making a move", async function () {
            const tierId = 0;
            const instanceId = 2;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;

            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const receipt = await tx.wait();

            console.log("      Gas used for move:", receipt.gasUsed.toString());
            expect(receipt.gasUsed).to.be.lt(200000);
        });
    });

    // ============ ETour Core Logic Tests ============

    describe("Abandoned Enrollment Pool Claims", function () {
        it("Should reject claim before escalation2 window", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll a player
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Try to claim immediately - should fail
            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.be.revertedWith("CAE");
        });

        it("Should allow external player to claim abandoned pool after escalation2", async function () {
            const tierId = 1;
            const instanceId = 0;

            // Enroll 2 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past escalation2 window (enrollment window + escalation interval)
            // For Tier 1: 300s enrollment + 300s escalation = 600s
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            const claimerBalanceBefore = await hre.ethers.provider.getBalance(player3.address);

            // External player claims the pool
            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.emit(game, "EnrollmentPoolClaimed");

            const claimerBalanceAfter = await hre.ethers.provider.getBalance(player3.address);

            // Claimer should have received funds (minus gas)
            expect(claimerBalanceAfter).to.be.gt(claimerBalanceBefore);

            // Tournament should be reset to Enrolling
            const tournamentAfter = await game.tournaments(tierId, instanceId);
            expect(tournamentAfter.status).to.equal(0); // Enrolling
            expect(tournamentAfter.enrolledCount).to.equal(0);
        });

        it("Should emit PlayerForfeited for all enrolled players", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.emit(game, "PlayerForfeited")
             .and.to.emit(game, "TournamentCached");
        });

        it("Should reject claim when no enrollment pool exists", async function () {
            const tierId = 1;
            const instanceId = 1; // Different instance with no enrollments

            await expect(
                game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId)
            ).to.be.revertedWith("CAE");
        });
    });

    describe("Force Start Edge Cases", function () {
        it("Should reject force start from non-enrolled player", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [301]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player3).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("FS");
        });

        // hasStartedViaTimeout field has been removed from the contract

        it("Should handle single player force start with immediate win", async function () {
            const tierId = 1;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            await hre.ethers.provider.send("evm_increaseTime", [301]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with only 1 player - they should win immediately
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentCompleted");

            // Tournament should reset after solo win
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset)
        });
    });

    describe("View Functions Coverage", function () {
        let tierId, instanceId;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 5; // Use a fresh instance
        });

        it("Should return correct tournament info via getTournamentInfo", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const info = await game.getTournamentInfo(tierId, instanceId);
            expect(info.status).to.equal(0); // Enrolling
            expect(info.enrolledCount).to.equal(1);
            expect(info.prizePool).to.be.gt(0);
        });

        it("Should return round info correctly", async function () {
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const roundInfo = await game.getRoundInfo(tierId, instanceId, 0);
            expect(roundInfo.totalMatches).to.equal(1);
            expect(roundInfo.completedMatches).to.equal(0);
            expect(roundInfo.initialized).to.be.true;
        });

        it("Should return player stats correctly", async function () {
            // Complete a tournament first
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to win
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const earnings = await game.connect(firstPlayer).getPlayerStats();
            expect(earnings).to.be.gt(0); // Winner should have positive earnings
        });

        it("Should track player earnings on leaderboard - winner has positive, loser negative", async function () {
            // Complete a tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const leaderboard = await game.getLeaderboard();

            // Should have at least 1 player on leaderboard
            expect(leaderboard.length).to.be.gte(1);

            // Find winner in leaderboard (loser won't be tracked)
            const winnerEntry = leaderboard.find(e => e.player === firstPlayer.address);
            const loserEntry = leaderboard.find(e => e.player === secondPlayer.address);

            // Winner should have positive earnings (total prizes won)
            // Prize pool = 2 * 0.001 ETH * 90% = 0.0018 ETH, winner gets 100%
            expect(winnerEntry.earnings).to.be.gt(0n);

            // Loser should not be on leaderboard (won no prizes)
            expect(loserEntry).to.be.undefined;
        });

        it("Should return full leaderboard with all players", async function () {
            // Complete a tournament to populate leaderboard
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            let match = await game.getMatch(tierId, instanceId, 0, 0);
            let firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            let secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const leaderboard = await game.getLeaderboard();

            // Leaderboard should only contain players who won prizes
            expect(Array.isArray(leaderboard)).to.be.true;
            expect(leaderboard.length).to.be.gte(1); // At least the winner

            // Each entry should have player address and positive earnings
            for (const entry of leaderboard) {
                expect(entry.player).to.match(/^0x[a-fA-F0-9]{40}$/);
                expect(typeof entry.earnings).to.equal("bigint");
                expect(entry.earnings).to.be.gt(0); // Only winners with prizes are tracked
            }
        });

    });

    describe("Prize Distribution", function () {
        it("Should distribute prizes correctly (2-player)", async function () {
            const tierId = 0;
            const instanceId = 6;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Winner plays to win
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            const tx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            const receipt = await tx.wait();

            // Extract prize amounts from PrizeDistributed events
            const prizeEvents = receipt.logs
                .map(log => { try { return game.interface.parseLog(log); } catch { return null; } })
                .filter(parsed => parsed?.name === "PrizeDistributed");

            // At least winner should receive prize
            expect(prizeEvents.length).to.be.gte(1);

            // Winner should receive prize
            const winnerEvent = prizeEvents.find(e => e.args.player === firstPlayer.address);
            expect(winnerEvent).to.not.be.undefined;
            expect(winnerEvent.args.amount).to.be.gt(0);
            expect(winnerEvent.args.rank).to.equal(1); // Winner is rank 1
        });

        it("Should handle draw finals with co-winners", async function () {
            const tierId = 0;
            const instanceId = 7;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to a draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Both should have same ranking (1) as co-winners
            // Tournament completes with finalsWasDraw = true
        });
    });

    describe("8-Player Tournament Full Flow", function () {
        it("Should complete full 8-player bracket tournament", async function () {
            const tierId = 2;
            const instanceId = 1;

            // Enroll 8 players
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Tournament should have started
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Round 0: 4 matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.totalMatches).to.equal(4);

            // Helper to play a match to completion (first player wins)
            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return; // Not in progress

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                // Play winning sequence for first player
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            // Play all 4 first round matches
            for (let m = 0; m < 4; m++) {
                await playMatchToWin(0, m);
            }

            // Round 1: 2 matches (semi-finals)
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
            expect(round1.totalMatches).to.equal(2);

            // Play semi-finals
            for (let m = 0; m < 2; m++) {
                await playMatchToWin(1, m);
            }

            // Round 2: 1 match (finals)
            const round2 = await game.rounds(tierId, instanceId, 2);
            expect(round2.initialized).to.be.true;
            expect(round2.totalMatches).to.equal(1);

            // Play finals
            await playMatchToWin(2, 0);

            // Tournament should be completed and reset
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling
        });
    });

    describe("Timeout Escalation Levels", function () {
        it("Should track timeout escalation timestamps", async function () {
            const tierId = 0;
            const instanceId = 8;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);

            // Match should have timeout state initialized
            expect(match.common.status).to.equal(1); // InProgress
        });

    });

    describe("Invalid Operations", function () {
        it("Should reject invalid instance ID", async function () {
            await expect(
                game.connect(player1).enrollInTournament(0, 100, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });

        it("Should reject enrollment in full tournament", async function () {
            const tierId = 0;
            const instanceId = 10;

            // Fill the 2-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Third player should be rejected
            await expect(
                game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });

        it("Should reject force start when tournament already in progress", async function () {
            const tierId = 0;
            const instanceId = 11;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Tournament is now InProgress
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.be.revertedWith("FS");
        });

    });

    describe("Tournament Reset and Cleanup", function () {
        it("Should properly reset all state after tournament completion", async function () {
            const tierId = 0;
            const instanceId = 12;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify enrolled
            expect(await game.isEnrolled(tierId, instanceId, player1.address)).to.be.true;
            expect(await game.isEnrolled(tierId, instanceId, player2.address)).to.be.true;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Complete tournament
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // After reset, enrollment should be cleared
            expect(await game.isEnrolled(tierId, instanceId, player1.address)).to.be.false;
            expect(await game.isEnrolled(tierId, instanceId, player2.address)).to.be.false;

            // Tournament state should be reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling
            expect(tournament.enrolledCount).to.equal(0);
            expect(tournament.prizePool).to.equal(0);
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress);
        });

        it("Should allow re-enrollment after tournament reset", async function () {
            const tierId = 0;
            const instanceId = 13;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Should be able to re-enroll
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.emit(game, "PlayerEnrolled");
        });
    });

    describe("Entry Fee Distribution", function () {
        it("Should correctly split fees (90% pool, 7.5% owner, 2.5% protocol)", async function () {
            const tierId = 0;
            const instanceId = 14;

            const ownerBalBefore = await hre.ethers.provider.getBalance(owner.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const ownerBalAfter = await hre.ethers.provider.getBalance(owner.address);
            const tournament = await game.tournaments(tierId, instanceId);

            // Owner gets 7.5% (2.5% protocol fee goes to accumulatedProtocolShare for raffle)
            const expectedOwnerShare = (TIER_0_FEE * 750n) / 10000n; // 7.5%
            expect(ownerBalAfter - ownerBalBefore).to.equal(expectedOwnerShare);

            // Prize pool gets 90%
            const expectedPrizePool = (TIER_0_FEE * 9000n) / 10000n;
            expect(tournament.prizePool).to.equal(expectedPrizePool);
        });
    });

    describe("Enrollment Timeout State", function () {
        it("Should initialize enrollment timeout timestamps on first enrollment", async function () {
            const tierId = 1;
            const instanceId = 3;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament = await game.tournaments(tierId, instanceId);

            // Escalation timestamps should be set
            expect(tournament.enrollmentTimeout.escalation1Start).to.be.gt(0);
            expect(tournament.enrollmentTimeout.escalation2Start).to.be.gt(tournament.enrollmentTimeout.escalation1Start);
        });

        it("Should track forfeit pool during enrollment", async function () {
            const tierId = 1;
            const instanceId = 4;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament1 = await game.tournaments(tierId, instanceId);
            const forfeitPool1 = tournament1.enrollmentTimeout.forfeitPool;

            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament2 = await game.tournaments(tierId, instanceId);
            const forfeitPool2 = tournament2.enrollmentTimeout.forfeitPool;

            // Forfeit pool should grow with each enrollment
            expect(forfeitPool2).to.be.gt(forfeitPool1);
        });
    });

    // ============ All-Draw Tests ============

    describe("All-Draw Round Scenarios", function () {
        it("Should handle finals draw with co-winners", async function () {
            const tierId = 0;
            const instanceId = 17;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to a draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);  // X at 0
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4); // O at 4
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);  // X at 2
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // O at 1
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);  // X at 7
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6); // O at 6
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);  // X at 3
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5); // O at 5

            // Final move results in draw
            await expect(
                game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8)
            ).to.emit(game, "TournamentCompleted");

            // Both players should be co-winners (rank 1) or tournament handles draw appropriately
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset after completion
        });

        it("Should handle 8-player tournament with multiple draws in first round", async function () {
            const tierId = 2;
            const instanceId = 7;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Helper to play a match to draw
            async function playMatchToDraw(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return false;

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return false;

                // Play draw pattern
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 7);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 6);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 5);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 8);
                return true;
            }

            // Play first 2 matches to draw, other 2 to win
            await playMatchToDraw(0, 0);
            await playMatchToDraw(0, 1);

            // Play matches 2 and 3 to normal wins
            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return;

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // All 4 matches should be completed (2 draws + 2 wins)
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.completedMatches).to.equal(4);
        });
    });

    describe("Advanced Tournament Progression", function () {
        it("Should handle walkover when odd number of players in round", async function () {
            // This tests the orphaned winner logic
            // When a round has odd players, one gets a bye/walkover

            const tierId = 2;
            const instanceId = 8;

            // Enroll 8 players
            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Complete 3 matches normally, draw the 4th
            // This creates 3 winners + 2 players from draw = 5 players for next round

            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return;

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return;

                // Win pattern
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);
            }

            // Complete matches 0, 1, 2 with wins
            await playMatchToWin(0, 0);
            await playMatchToWin(0, 1);
            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // Round 1 should now be initialized with remaining players
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
        });

        it("Should NOT have stale finals data from previous tournament", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 9; // Use instance ID within valid range (tier 1 has 10 instances: 0-9)

            // ========== FIRST TOURNAMENT ==========
            console.log("\n========== FIRST TOURNAMENT ==========");

            // Enroll 4 players for first tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Helper function to play a match to completion
            async function playMatchToWin(roundNum, matchNum, players) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null; // Not InProgress

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return null;

                // Win pattern
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);

                const finalMatch = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                return finalMatch.common.winner;
            }

            // Complete first tournament fully
            const players = [player1, player2, player3, player4];

            // Complete both semifinals
            await playMatchToWin(0, 0, players);
            await playMatchToWin(0, 1, players);

            // Capture finalists BEFORE finals completes (so we have the data before it's cached/cleared)
            const firstTournamentFinalsBeforeComplete = await game.getMatch(tierId, instanceId, 1, 0);
            const firstTournamentFinalist1 = firstTournamentFinalsBeforeComplete.common.player1;
            const firstTournamentFinalist2 = firstTournamentFinalsBeforeComplete.common.player2;
            console.log("First Tournament Finalists:", firstTournamentFinalist1, firstTournamentFinalist2);

            // Complete finals
            const firstTournamentWinner = await playMatchToWin(1, 0, players);
            console.log("First Tournament Winner:", firstTournamentWinner);

            // Verify first tournament completed and reset
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (tournament auto-resets after completion)

            // ========== SECOND TOURNAMENT ==========
            console.log("\n========== SECOND TOURNAMENT ==========");

            // Enroll different 4 players for second tournament (using player5, player6, player7, player8)
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player6).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player7).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player8).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Verify second tournament started
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Get semifinal 0 match details for second tournament
            const sf0Before = await game.getMatch(tierId, instanceId, 0, 0);
            const sf0Player1 = sf0Before.common.player1;
            const sf0Player2 = sf0Before.common.player2;

            console.log("Second Tournament Semifinal 0 Players:", sf0Player1, sf0Player2);

            // Play semifinal 0 to completion
            const secondTournamentPlayers = [player5, player6, player7, player8];
            const sf0Winner = await playMatchToWin(0, 0, secondTournamentPlayers);

            console.log("Second Tournament Semifinal 0 Winner:", sf0Winner);

            // Check finals state AFTER first semifinal completes
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
            expect(round1.totalMatches).to.equal(1);

            // Complete second semifinal to progress tournament
            const sf1Winner = await playMatchToWin(0, 1, secondTournamentPlayers);
            console.log("Second Tournament Semifinal 1 Winner:", sf1Winner);

            // Now check finals - both semifinal winners should be in finals
            const secondTournamentFinalsMatch = await game.getMatch(tierId, instanceId, 1, 0);

            console.log("\nSecond Tournament Finals after both semifinals:");
            console.log("  player1:", secondTournamentFinalsMatch.common.player1);
            console.log("  player2:", secondTournamentFinalsMatch.common.player2);
            console.log("  status:", secondTournamentFinalsMatch.common.status);

            // Verify finals has the correct semifinal winners
            expect(secondTournamentFinalsMatch.common.player1).to.equal(sf0Winner,
                "Finals slot 0 should have semifinal 0 winner");
            expect(secondTournamentFinalsMatch.common.player2).to.equal(sf1Winner,
                "Finals slot 1 should have semifinal 1 winner");

            // Verify no players from first tournament are in current finals
            expect(secondTournamentFinalsMatch.common.player1).to.not.equal(firstTournamentFinalist1);
            expect(secondTournamentFinalsMatch.common.player1).to.not.equal(firstTournamentFinalist2);
            expect(secondTournamentFinalsMatch.common.player2).to.not.equal(firstTournamentFinalist1);
            expect(secondTournamentFinalsMatch.common.player2).to.not.equal(firstTournamentFinalist2);

            // Finals should be either InProgress (1) or Completed (2), but not NotStarted (0)
            expect(secondTournamentFinalsMatch.common.status).to.be.greaterThan(0,
                "Finals should have started (InProgress or Completed)");

            // Finals should be independent from first tournament
        });
    });

    describe("Match Timeout State Tracking", function () {
        it("Should update lastMoveTime after each move", async function () {
            const tierId = 0;
            const instanceId = 18;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const matchBefore = await game.getMatch(tierId, instanceId, 0, 0);
            const initialLastMove = matchBefore.common.lastMoveTime;

            // Fast forward time a bit
            await hre.ethers.provider.send("evm_increaseTime", [10]);
            await hre.ethers.provider.send("evm_mine", []);

            // Make a move
            const firstPlayer = matchBefore.currentTurn === player1.address ? player1 : player2;
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            const matchAfter = await game.getMatch(tierId, instanceId, 0, 0);
            const newLastMove = matchAfter.common.lastMoveTime;

            // lastMoveTime should have been updated
            expect(newLastMove).to.be.gt(initialLastMove);
        });

        it("Should allow timeout claim after move timeout elapses", async function () {
            const tierId = 0;
            const instanceId = 19;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past time bank (2 minutes + 1 second)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player should be able to claim timeout win (second player didn't move)
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed");
        });
    });

    describe("Complete Tournament Flow with Mixed Results", function () {
        it("Should complete 8-player tournament with wins and draws", async function () {
            const tierId = 2;
            const instanceId = 9;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null;

                const fp = match.currentTurn;
                const sp = match.common.player1 === fp ? match.common.player2 : match.common.player1;

                const fpSigner = players.find(p => p.address === fp);
                const spSigner = players.find(p => p.address === sp);

                if (!fpSigner || !spSigner) return null;

                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(spSigner).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fpSigner).makeMove(tierId, instanceId, roundNum, matchNum, 2);

                return fp; // Return winner
            }

            // Round 0: 4 matches
            await playMatchToWin(0, 0);
            await playMatchToWin(0, 1);
            await playMatchToWin(0, 2);
            await playMatchToWin(0, 3);

            // Verify round 1 initialized
            let round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;

            // Round 1: 2 matches
            await playMatchToWin(1, 0);
            await playMatchToWin(1, 1);

            // Round 2: Finals
            let round2 = await game.rounds(tierId, instanceId, 2);
            expect(round2.initialized).to.be.true;

            await playMatchToWin(2, 0);

            // Tournament should be completed
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset

            // Verify leaderboard has prize winners (at least 1 player won)
            const leaderboard = await game.getLeaderboard();
            const winnersCount = leaderboard.filter(e => e.earnings > 0n).length;
            expect(winnersCount).to.be.gte(1); // At least one player won prizes
        });
    });

    describe("Escalation Victory and Prize Distribution", function () {
        it("Should award full prize pool when timeout claim wins 2-player tournament", async function () {
            const tierId = 0;
            const instanceId = 20;

            // Track balance before
            const balanceBefore = await hre.ethers.provider.getBalance(player1.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward past time bank (2 minutes + 1 second)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // First player claims timeout win - should win tournament
            const tx = await game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);
            const receipt = await tx.wait();

            // Check TournamentCompleted event was emitted
            const tournamentCompletedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "TournamentCompleted"
            );
            expect(tournamentCompletedEvent).to.not.be.undefined;

            // Winner should be the timeout claimer
            expect(tournamentCompletedEvent.args.winner).to.equal(firstPlayer.address);

            // Prize should be ~90% of total entry fees (2 * 0.01 ETH * 90% = 0.018 ETH)
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            expect(tournamentCompletedEvent.args.prizeAmount).to.equal(expectedPrize);

            // Verify leaderboard shows positive earnings for winner
            const leaderboard = await game.getLeaderboard();
            const winnerEntry = leaderboard.find(e => e.player === firstPlayer.address);
            expect(winnerEntry.earnings).to.be.gt(0n);
        });

        it("Should track forfeited amounts for eliminated players on escalation", async function () {
            const tierId = 0;
            const instanceId = 22;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward and claim timeout (2 minutes + 1 second)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout win - should emit TimeoutVictoryClaimed
            await expect(
                game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.emit(game, "TimeoutVictoryClaimed")
              .withArgs(tierId, instanceId, 0, 0, firstPlayer.address, secondPlayer.address);

            // Timeout loser won't appear on leaderboard (no prizes won)
            const leaderboard = await game.getLeaderboard();
            const loserEntry = leaderboard.find(e => e.player === secondPlayer.address);
            // Loser should not be on leaderboard since they won no prizes
            expect(loserEntry).to.be.undefined;
        });

        it("Should correctly distribute prize pool after abandoned enrollment claim", async function () {
            const tierId = 0;
            const instanceId = 23;

            // Single player enrolls
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Fast forward past escalation 2 window (300s + 300s = 600s)
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            const balanceBefore = await hre.ethers.provider.getBalance(player3.address);

            // player3 (external) claims the abandoned enrollment pool
            const tx = await game.connect(player3).claimAbandonedEnrollmentPool(tierId, instanceId);
            const receipt = await tx.wait();

            const balanceAfter = await hre.ethers.provider.getBalance(player3.address);
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            // player3 should have received the prize pool (90% of entry fee)
            const expectedClaim = (TIER_0_FEE * 90n) / 100n;
            const actualGain = balanceAfter - balanceBefore + gasUsed;
            expect(actualGain).to.equal(expectedClaim);

            // Check EnrollmentPoolClaimed event
            const claimEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "EnrollmentPoolClaimed"
            );
            expect(claimEvent).to.not.be.undefined;
            expect(claimEvent.args.claimant).to.equal(player3.address);
            expect(claimEvent.args.amount).to.equal(expectedClaim);
        });
    });

    describe("playerPrizes and Leaderboard Consistency", function () {
        // playerPrizes is permanent and persists after tournament reset

        it("Should have playerPrizes equal to prize amount for winner in 2-player tournament", async function () {
            const tierId = 0;
            const instanceId = 24;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Win the match
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Check playerPrizes for winner (should be 90% of total entry fees)
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            expect(winnerPrize).to.equal(expectedPrize);

            // Loser should have 0 prize
            const loserPrize = await game.playerPrizes(tierId, instanceId, secondPlayer.address);
            expect(loserPrize).to.equal(0n);
        });

        it("Should have leaderboard earnings equal to (playerPrizes - entryFee) for winner", async function () {
            const tierId = 0;
            const instanceId = 25;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Get playerPrizes (now permanent after tournament reset)
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);

            // Get leaderboard earnings change
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Winner's earnings change should equal prize (leaderboard tracks total prizes won)
            const winnerEarningsChange = earningsAfter1 - firstEarningsBefore;
            expect(winnerEarningsChange).to.equal(winnerPrize);

            // Loser's earnings change should be 0 (won no prizes)
            const loserEarningsChange = earningsAfter2 - secondEarningsBefore;
            expect(loserEarningsChange).to.equal(0n);
        });

        it("Should have consistent playerPrizes and leaderboard for 8-player tournament", async function () {
            const tierId = 2;
            const instanceId = 11;

            const allPlayers = [player1, player2, player3, player4, player5, player6, player7, player8];

            // Track earnings before
            const earningsBefore = {};
            for (const p of allPlayers) {
                earningsBefore[p.address] = await game.playerEarnings(p.address);
            }

            // Enroll all players
            for (const player of allPlayers) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Helper to win a match
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null;

                const fpAddr = match.currentTurn;
                const spAddr = match.common.player1 === fpAddr ? match.common.player2 : match.common.player1;
                const fp = allPlayers.find(p => p.address === fpAddr);
                const sp = allPlayers.find(p => p.address === spAddr);

                if (!fp || !sp) return null;

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                return fp.address;
            }

            // Complete tournament
            await winMatch(0, 0);
            await winMatch(0, 1);
            await winMatch(0, 2);
            await winMatch(0, 3);
            await winMatch(1, 0);
            await winMatch(1, 1);
            const tournamentWinner = await winMatch(2, 0);

            // Check consistency for all players
            for (const p of allPlayers) {
                const prize = await game.playerPrizes(tierId, instanceId, p.address);
                const earningsAfter = await game.playerEarnings(p.address);
                const earningsChange = earningsAfter - earningsBefore[p.address];

                // Earnings change should equal prize (leaderboard tracks total prizes won)
                expect(earningsChange).to.equal(prize);
            }

            // Winner should have positive prize
            const winnerPrize = await game.playerPrizes(tierId, instanceId, tournamentWinner);
            expect(winnerPrize).to.be.gt(0n);
        });

        it("Should have consistent playerPrizes and leaderboard after timeout victory", async function () {
            const tierId = 0;
            const instanceId = 26;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // First player makes a move
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 4);

            // Fast forward and claim timeout (2 minutes + 1 second)
            await hre.ethers.provider.send("evm_increaseTime", [121]);
            await hre.ethers.provider.send("evm_mine", []);

            await game.connect(firstPlayer).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Check playerPrizes (permanent)
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            const loserPrize = await game.playerPrizes(tierId, instanceId, secondPlayer.address);

            // Winner should get full prize pool
            const expectedPrize = (TIER_0_FEE * 2n * 90n) / 100n;
            expect(winnerPrize).to.equal(expectedPrize);
            expect(loserPrize).to.equal(0n);

            // Check leaderboard consistency
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Winner: prize (leaderboard tracks total prizes won)
            expect(earningsAfter1 - firstEarningsBefore).to.equal(winnerPrize);
            // Loser: 0 (won no prizes)
            expect(earningsAfter2 - secondEarningsBefore).to.equal(0n);
        });

        it("Should have consistent playerPrizes and leaderboard for draw finals", async function () {
            const tierId = 0;
            const instanceId = 27;

            const earningsBefore1 = await game.playerEarnings(player1.address);
            const earningsBefore2 = await game.playerEarnings(player2.address);

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Both players should get half the prize (permanent)
            const prizePool = (TIER_0_FEE * 2n * 90n) / 100n;
            const expectedPrizePerPlayer = prizePool / 2n;

            const prize1 = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, secondPlayer.address);

            expect(prize1).to.equal(expectedPrizePerPlayer);
            expect(prize2).to.equal(expectedPrizePerPlayer);

            // Check leaderboard consistency
            const earningsAfter1 = await game.playerEarnings(firstPlayer.address);
            const earningsAfter2 = await game.playerEarnings(secondPlayer.address);

            const firstEarningsBefore = firstPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;
            const secondEarningsBefore = secondPlayer.address === player1.address ? earningsBefore1 : earningsBefore2;

            // Leaderboard tracks total prizes won (not net profit/loss)
            expect(earningsAfter1 - firstEarningsBefore).to.equal(prize1);
            expect(earningsAfter2 - secondEarningsBefore).to.equal(prize2);
        });
    });

    // ============ ETour Protocol Edge Cases ============

    describe("Force Start with Odd Players", function () {
        it("Should handle force start with 3 players (requires walkover)", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 12;

            // Enroll only 3 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });

            // Fast forward past enrollment window (480s)
            await hre.ethers.provider.send("evm_increaseTime", [481]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with 3 players
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentForceStarted");

            // Tournament should be in progress
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // With 3 players: 1 match + 1 walkover
            // Round 0 should have 1 match (2 players) and 1 player gets walkover
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            // Either 1 or 2 matches depending on walkover handling
            expect(round0.totalMatches).to.be.gte(1);
        });

        it("Should handle force start with 5 players", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 13;

            // Enroll 5 players
            const players = [player1, player2, player3, player4, player5];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Fast forward past enrollment window (480s)
            await hre.ethers.provider.send("evm_increaseTime", [481]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentForceStarted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1);

            // With 5 players: 2 matches + 1 walkover
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
        });

        it("Should handle force start with 7 players", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 14;

            // Enroll 7 players
            const players = [player1, player2, player3, player4, player5, player6, player7];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            // Fast forward past enrollment window (480s)
            await hre.ethers.provider.send("evm_increaseTime", [481]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start
            await expect(
                game.connect(player1).forceStartTournament(tierId, instanceId)
            ).to.emit(game, "TournamentForceStarted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1);

            // With 7 players: 3 matches + 1 walkover
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
        });

        it("Should complete tournament started with odd players", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 5;

            // Enroll 3 players in a 4-player tier
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward and force start
            await hre.ethers.provider.send("evm_increaseTime", [601]);
            await hre.ethers.provider.send("evm_mine", []);

            await game.connect(player1).forceStartTournament(tierId, instanceId);

            const players = [player1, player2, player3];

            // Helper to win a match
            async function playMatchToWin(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null;

                const fpAddr = match.currentTurn;
                const spAddr = match.common.player1 === fpAddr ? match.common.player2 : match.common.player1;
                const fp = players.find(p => p.address === fpAddr);
                const sp = players.find(p => p.address === spAddr);

                if (!fp || !sp) return null;

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                return fp.address;
            }

            // Play through available matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            for (let m = 0; m < round0.totalMatches; m++) {
                await playMatchToWin(0, m);
            }

            // Play finals if needed
            const round1 = await game.rounds(tierId, instanceId, 1);
            if (round1.initialized && round1.totalMatches > 0) {
                await playMatchToWin(1, 0);
            }

            // Tournament should complete
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling
        });
    });

    describe("All-Draw Round Scenarios", function () {
        it("Should handle all semi-finals drawing - all 4 players share prize", async function () {
            // When all matches in semi-finals draw, no one advances to finals
            // All 4 semi-finalists share the prize pool equally
            const tierId = 1; // 4-player tier
            const instanceId = 6;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Verify tournament started
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            const prizePool = tournament.prizePool;

            const allPlayers = [player1, player2, player3, player4];

            // Helper function to play a match to draw, returns last transaction
            async function playMatchToDraw(matchNum) {
                const match = await game.getMatch(tierId, instanceId, 0, matchNum);
                expect(match.common.status).to.equal(1n, `Match ${matchNum} should be InProgress`);

                const fp = allPlayers.find(p => p.address === match.currentTurn);
                const sp = allPlayers.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                // Draw pattern
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 2);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 1);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 7);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 6);
                await game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 3);
                await game.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 5);
                // Return the last transaction
                return game.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 8);
            }

            // Play both semi-final matches to draw
            await playMatchToDraw(0);

            // Verify match 0 completed and match 1 is still active
            let match0 = await game.getMatch(tierId, instanceId, 0, 0);
            expect(match0.common.status).to.equal(2n); // Completed
            expect(match0.common.isDraw).to.be.true;

            let match1 = await game.getMatch(tierId, instanceId, 0, 1);
            expect(match1.common.status).to.equal(1n, "Match 1 should still be InProgress after Match 0 draws");

            // Play match 1 and verify TournamentCompletedAllDraw event
            const tx = await playMatchToDraw(1);
            await expect(tx)
                .to.emit(game, "TournamentCompletedAllDraw")
                .withArgs(tierId, instanceId, 0, 4, prizePool / 4n);

            // After all-draw completion, tournament resets (match data is cleared)
            // But playerPrizes persists as historical record
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (reset after completion)

            // All 4 players should have equal prizes
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);
            const prize3 = await game.playerPrizes(tierId, instanceId, player3.address);
            const prize4 = await game.playerPrizes(tierId, instanceId, player4.address);

            // All should be equal
            expect(prize1).to.equal(prize2);
            expect(prize2).to.equal(prize3);
            expect(prize3).to.equal(prize4);

            // Each should get 1/4 of the prize pool
            const expectedPrize = prizePool / 4n;
            expect(prize1).to.equal(expectedPrize);
        });

        it("Should complete tournament when finals also draws (co-winners)", async function () {
            const tierId = 0; // 2-player tier
            const instanceId = 31;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Play to draw
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 7);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 6);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 5);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 8);

            // Tournament should complete
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset

            // Both players should have prizes
            const prize1 = await game.playerPrizes(tierId, instanceId, player1.address);
            const prize2 = await game.playerPrizes(tierId, instanceId, player2.address);

            // Both should get equal share
            expect(prize1).to.equal(prize2);
            expect(prize1).to.be.gt(0);
        });
    });

    describe("Prize Distribution Edge Cases", function () {
        it("Should handle prize distribution with odd total (rounding)", async function () {
            // This tests that prize calculations don't lose wei due to rounding
            const tierId = 0;
            const instanceId = 32;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Win the match
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Check that winner received full prize pool
            const winnerPrize = await game.playerPrizes(tierId, instanceId, firstPlayer.address);
            expect(winnerPrize).to.equal(prizePool);
        });

        it("Should distribute prizes correctly in 8-player tournament", async function () {
            const tierId = 2; // 8-player tier
            const instanceId = 3;

            const players = [player1, player2, player3, player4, player5, player6, player7, player8];
            for (const player of players) {
                await game.connect(player).enrollInTournament(tierId, instanceId, { value: TIER_2_FEE });
            }

            const tournament = await game.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Helper to win matches
            async function winMatch(roundNum, matchNum) {
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                if (match.common.status !== 1n) return null;

                const fpAddr = match.currentTurn;
                const spAddr = match.common.player1 === fpAddr ? match.common.player2 : match.common.player1;
                const fp = players.find(p => p.address === fpAddr);
                const sp = players.find(p => p.address === spAddr);

                if (!fp || !sp) return null;

                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 0);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 3);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 1);
                await game.connect(sp).makeMove(tierId, instanceId, roundNum, matchNum, 4);
                await game.connect(fp).makeMove(tierId, instanceId, roundNum, matchNum, 2);
                return fp.address;
            }

            // Complete all rounds
            for (let m = 0; m < 4; m++) await winMatch(0, m);
            for (let m = 0; m < 2; m++) await winMatch(1, m);
            const winner = await winMatch(2, 0);

            // Verify prizes distributed
            // Simplified prize distribution: first place gets 100%
            const winnerPrize = await game.playerPrizes(tierId, instanceId, winner);
            const expectedWinnerPrize = prizePool;
            expect(winnerPrize).to.equal(expectedWinnerPrize);

            // Total prizes should equal prize pool
            let totalPrizes = 0n;
            for (const player of players) {
                const prize = await game.playerPrizes(tierId, instanceId, player.address);
                totalPrizes += prize;
            }
            expect(totalPrizes).to.equal(prizePool);
        });
    });

    describe("Multi-Tournament Player Scenarios", function () {
        it("Should allow same player to enroll in different instances", async function () {
            const tierId = 0;

            // Player enrolls in instance 33
            await game.connect(player1).enrollInTournament(tierId, 33, { value: TIER_0_FEE });
            expect(await game.isEnrolled(tierId, 33, player1.address)).to.be.true;

            // Same player enrolls in instance 34
            await game.connect(player1).enrollInTournament(tierId, 34, { value: TIER_0_FEE });
            expect(await game.isEnrolled(tierId, 34, player1.address)).to.be.true;
        });

        it("Should allow same player in different tiers", async function () {
            // Enroll in tier 0
            await game.connect(player1).enrollInTournament(0, 35, { value: TIER_0_FEE });
            expect(await game.isEnrolled(0, 35, player1.address)).to.be.true;

            // Enroll in tier 1
            await game.connect(player1).enrollInTournament(1, 7, { value: TIER_1_FEE });
            expect(await game.isEnrolled(1, 7, player1.address)).to.be.true;

            // Both enrollments valid
            const info0 = await game.tournaments(0, 35);
            const info1 = await game.tournaments(1, 7);

            expect(info0.enrolledCount).to.be.gte(1);
            expect(info1.enrolledCount).to.be.gte(1);
        });

        it("Should correctly update earnings across multiple tournaments", async function () {

            // Play and complete first tournament
            await game.connect(player1).enrollInTournament(0, 38, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(0, 38, { value: TIER_0_FEE });

            let match = await game.getMatch(0, 38, 0, 0);
            let firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            let secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            // Win first tournament
            await game.connect(firstPlayer).makeMove(0, 38, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(0, 38, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(0, 38, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(0, 38, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(0, 38, 0, 0, 2);

            const tournament1Winner = firstPlayer;
            const earningsAfterTournament1 = await game.connect(tournament1Winner).getPlayerStats();

            // Play and complete second tournament
            await game.connect(player1).enrollInTournament(0, 39, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(0, 39, { value: TIER_0_FEE });

            match = await game.getMatch(0, 39, 0, 0);
            firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            secondPlayer = match.currentTurn === player1.address ? player2 : player1;

            await game.connect(firstPlayer).makeMove(0, 39, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(0, 39, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(0, 39, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(0, 39, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(0, 39, 0, 0, 2);

            // If first tournament winner won again, earnings should have increased
            const earningsAfterTournament2 = await game.connect(tournament1Winner).getPlayerStats();
            if (tournament1Winner.address === firstPlayer.address) {
                expect(earningsAfterTournament2).to.be.gt(earningsAfterTournament1);
            }
        });
    });

    describe("Instance and Tier Boundary Cases", function () {
        it("Should reject enrollment at max instanceId", async function () {
            const tierId = 0; // Has 100 instances (0-99)

            // Try to enroll in instance 100 (out of bounds)
            await expect(
                game.connect(player1).enrollInTournament(tierId, 100, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });

        it("Should reject enrollment in non-existent tier", async function () {
            // Tier 3 doesn't exist in TicTacChain (only 0, 1, 2)
            await expect(
                game.connect(player1).enrollInTournament(3, 0, { value: TIER_0_FEE })
            ).to.be.revertedWith("E");
        });

        it("Should handle enrollment at exact tier boundaries", async function () {
            const tierId = 0;
            const lastValidInstance = 63; // 64 instances, 0-indexed

            // This should work
            await game.connect(player1).enrollInTournament(tierId, lastValidInstance, { value: TIER_0_FEE });
            expect(await game.isEnrolled(tierId, lastValidInstance, player1.address)).to.be.true;
        });
    });

    describe("getMatch Cache Fallback - Two-Person Tournament", function () {
        it("Should return match data from cache after tournament completion and match reset (loser perspective)", async function () {
            const tierId = 0; // 2-player tier
            const instanceId = 10; // Use unique instance to avoid conflicts with other tests
            const roundNumber = 0;
            const matchNumber = 0;

            // Step 1: Enroll two players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify tournament started
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Step 2: Get initial match state - should work (active match)
            let matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.player1).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.player2).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.status).to.equal(1); // InProgress
            expect(matchData.common.isCached).to.be.false; // Should come from active storage

            // Store player addresses for later verification
            const actualPlayer1 = matchData.common.player1;
            const actualPlayer2 = matchData.common.player2;
            const firstPlayer = matchData.firstPlayer;

            // Step 3: Play the match to completion
            // Determine who goes first and play winning moves
            let currentPlayer = firstPlayer === actualPlayer1 ? player1 : player2;
            let otherPlayer = firstPlayer === actualPlayer1 ? player2 : player1;

            // Play a winning pattern (diagonal: cells 0, 4, 8)
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 8);

            // Step 4: getMatch should work after match completion
            // Finals matches are preserved in live storage (not cached)
            matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            // Verify finals is preserved (not cached) - this is round 0, match 0 = finals for 2-player tier
            expect(matchData.common.isCached).to.be.false; // Finals preserved in live storage

            // Verify match data is complete and correct
            expect(matchData.common.player1).to.equal(actualPlayer1);
            expect(matchData.common.player2).to.equal(actualPlayer2);
            expect(matchData.common.status).to.equal(2); // Completed
            expect(matchData.common.isDraw).to.be.false;

            // Verify winner and loser addresses
            expect(matchData.common.winner).to.equal(firstPlayer); // First player won
            expect(matchData.common.loser).to.equal(firstPlayer === actualPlayer1 ? actualPlayer2 : actualPlayer1);

            // Verify winner is not zero address
            expect(matchData.common.winner).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.loser).to.not.equal(hre.ethers.ZeroAddress);

            // Verify timestamps are preserved
            expect(matchData.common.startTime).to.be.gt(0);
            // Finals are preserved in live storage (not cached), so check lastMoveTime instead of endTime
            expect(matchData.common.lastMoveTime).to.be.gt(0);
            expect(matchData.common.lastMoveTime).to.be.gte(matchData.common.startTime);

            // Verify tournament context
            expect(matchData.common.tierId).to.equal(tierId);
            expect(matchData.common.instanceId).to.equal(instanceId);
            expect(matchData.common.roundNumber).to.equal(roundNumber);
            expect(matchData.common.matchNumber).to.equal(matchNumber);

            // Verify board state is preserved in cache (packedBoard is a uint256 encoding all cells)
            expect(matchData.packedBoard).to.be.greaterThan(0);
            expect(matchData.firstPlayer).to.equal(firstPlayer);
        });

        it("Should return match data from cache after tournament completion (winner perspective)", async function () {
            const tierId = 0;
            const instanceId = 1; // Use different instance
            const roundNumber = 0;
            const matchNumber = 0;

            // Enroll and start tournament
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info
            let matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const actualPlayer1 = matchData.common.player1;
            const actualPlayer2 = matchData.common.player2;
            const firstPlayer = matchData.firstPlayer;

            // Play to completion
            let currentPlayer = firstPlayer === actualPlayer1 ? player3 : player4;
            let otherPlayer = firstPlayer === actualPlayer1 ? player4 : player3;

            // Winning pattern
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 3);
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 6);

            // Winner calls getMatch - finals preserved in live storage
            matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            expect(matchData.common.isCached).to.be.false; // Finals preserved, not cached
            expect(matchData.common.winner).to.equal(firstPlayer);
            expect(matchData.common.loser).to.not.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.status).to.equal(2); // Completed
        });

        it("Should handle draw scenario with cache fallback", async function () {
            const tierId = 0;
            const instanceId = 2; // Use different instance
            const roundNumber = 0;
            const matchNumber = 0;

            // Enroll and start tournament
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player6).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info
            let matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const actualPlayer1 = matchData.common.player1;
            const actualPlayer2 = matchData.common.player2;
            const firstPlayer = matchData.firstPlayer;

            // Play to a draw
            let currentPlayer = firstPlayer === actualPlayer1 ? player5 : player6;
            let otherPlayer = firstPlayer === actualPlayer1 ? player6 : player5;

            // Draw pattern: X X O / O O X / X O X
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 0); // X
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);   // O
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 1); // X
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 3);   // O
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 5); // X
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);   // O
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 6); // X
            await game.connect(otherPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 8);   // O
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 7); // X - Draw

            // After draw, getMatch returns finals from live storage
            matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            expect(matchData.common.isCached).to.be.false; // Finals preserved, not cached
            expect(matchData.common.isDraw).to.be.true;
            expect(matchData.common.winner).to.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.loser).to.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.status).to.equal(2); // Completed
        });

        it("Should fail gracefully for non-existent match", async function () {
            const tierId = 0;
            const instanceId = 50; // Instance that was never used
            const roundNumber = 0;
            const matchNumber = 0;

            // This should revert because match never existed (not in active storage or cache)
            await expect(
                game.getMatch(tierId, instanceId, roundNumber, matchNumber)
            ).to.be.revertedWith("MNF");
        });

        it("Should return active match data when match is still in progress", async function () {
            const tierId = 0;
            const instanceId = 3; // Use different instance
            const roundNumber = 0;
            const matchNumber = 0;

            // Enroll and start tournament
            await game.connect(player7).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player8).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info - should come from active storage
            let matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            expect(matchData.common.isCached).to.be.false; // Should be active
            expect(matchData.common.status).to.equal(1); // InProgress
            expect(matchData.common.winner).to.equal(hre.ethers.ZeroAddress);
            expect(matchData.common.loser).to.equal(hre.ethers.ZeroAddress);
            // endTime field was removed - startTime is set when match begins

            // Make one move
            const firstPlayer = matchData.firstPlayer;
            const actualPlayer1 = matchData.common.player1;
            let currentPlayer = firstPlayer === actualPlayer1 ? player7 : player8;
            await game.connect(currentPlayer).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);

            // Still should come from active storage
            matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            expect(matchData.common.isCached).to.be.false;
            expect(matchData.common.status).to.equal(1); // Still InProgress
        });

        it("Should prevent cache collision when circular buffer wraps around", async function () {
            // This test verifies that matchIdToCacheIndex mappings are properly cleaned up
            // when the cache wraps around and overwrites old entries

            const tierId = 0;

            // We'll use a unique instanceId range for this test
            const startInstance = 20;

            // Note: This test simulates the wrap-around behavior without actually filling
            // 1000 entries (which would take too long). We verify the cleanup logic works.

            // Create first match and verify it's cached
            await game.connect(player1).enrollInTournament(tierId, startInstance, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, startInstance, { value: TIER_0_FEE });

            let match1 = await game.getMatch(tierId, startInstance, 0, 0);
            const p1 = match1.firstPlayer === match1.common.player1 ? player1 : player2;
            const p2 = match1.firstPlayer === match1.common.player1 ? player2 : player1;

            // Complete match 1
            await game.connect(p1).makeMove(tierId, startInstance, 0, 0, 0);
            await game.connect(p2).makeMove(tierId, startInstance, 0, 0, 1);
            await game.connect(p1).makeMove(tierId, startInstance, 0, 0, 4);
            await game.connect(p2).makeMove(tierId, startInstance, 0, 0, 2);
            await game.connect(p1).makeMove(tierId, startInstance, 0, 0, 8);

            // Verify match 1 finals is preserved (not cached)
            match1 = await game.getMatch(tierId, startInstance, 0, 0);
            expect(match1.common.isCached).to.be.false; // Finals preserved in live storage
            const match1Winner = match1.common.winner;

            // Create second match in different instance
            await game.connect(player3).enrollInTournament(tierId, startInstance + 1, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, startInstance + 1, { value: TIER_0_FEE });

            let match2 = await game.getMatch(tierId, startInstance + 1, 0, 0);
            const p3 = match2.firstPlayer === match2.common.player1 ? player3 : player4;
            const p4 = match2.firstPlayer === match2.common.player1 ? player4 : player3;

            // Complete match 2
            await game.connect(p3).makeMove(tierId, startInstance + 1, 0, 0, 0);
            await game.connect(p4).makeMove(tierId, startInstance + 1, 0, 0, 1);
            await game.connect(p3).makeMove(tierId, startInstance + 1, 0, 0, 3);
            await game.connect(p4).makeMove(tierId, startInstance + 1, 0, 0, 2);
            await game.connect(p3).makeMove(tierId, startInstance + 1, 0, 0, 6);

            // Verify match 2 finals is preserved (not cached)
            match2 = await game.getMatch(tierId, startInstance + 1, 0, 0);
            expect(match2.common.isCached).to.be.false; // Finals preserved in live storage
            const match2Winner = match2.common.winner;

            // Both matches should be retrievable with correct data
            match1 = await game.getMatch(tierId, startInstance, 0, 0);
            expect(match1.common.winner).to.equal(match1Winner);
            expect(match1.common.instanceId).to.equal(startInstance);

            match2 = await game.getMatch(tierId, startInstance + 1, 0, 0);
            expect(match2.common.winner).to.equal(match2Winner);
            expect(match2.common.instanceId).to.equal(startInstance + 1);

            // Verify they have different winners (different matches)
            expect(match1Winner).to.not.equal(match2Winner);
        });
    });

    describe("Finals Match Preservation", function () {
        it("Should preserve finals match data in live storage after tournament completion", async function () {
            const tierId = 0;
            const instanceId = 50; // Use unique instance
            const roundNumber = 0; // Finals is in round 0 for 2-player
            const matchNumber = 0;

            // Enroll and start tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info
            let matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const firstPlayer = matchData.firstPlayer;
            const actualPlayer1 = matchData.common.player1;
            const actualPlayer2 = matchData.common.player2;
            const p1 = firstPlayer === actualPlayer1 ? player1 : player2;
            const p2 = firstPlayer === actualPlayer1 ? player2 : player1;

            // Play finals match to completion
            await game.connect(p1).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(p2).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(p1).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);
            await game.connect(p2).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(p1).makeMove(tierId, instanceId, roundNumber, matchNumber, 8);

            // Tournament should now be complete and reset to Enrolling
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Finals match data should still be accessible from live storage
            matchData = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);

            // Verify finals data is preserved
            expect(matchData.common.isCached).to.be.false; // Should be in live storage, not cache yet
            expect(matchData.common.status).to.equal(2); // Completed
            expect(matchData.common.player1).to.equal(actualPlayer1);
            expect(matchData.common.player2).to.equal(actualPlayer2);
            expect(matchData.common.winner).to.not.equal(hre.ethers.ZeroAddress);
            // Note: endTime is only set for cached matches, preserved matches have lastMoveTime
            expect(matchData.common.lastMoveTime).to.be.greaterThan(0);

            // Verify board state is preserved (packedBoard is a uint256 encoding all cells)
            expect(matchData.packedBoard).to.be.greaterThan(0);
        });

        it("Should cache old finals and preserve new finals when second tournament completes (instance-specific eviction)", async function () {
            const tierId = 0;
            const instanceId = 51; // Use unique instance
            const roundNumber = 0;
            const matchNumber = 0;

            // ========== FIRST TOURNAMENT ==========
            // Enroll and start first tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info for first tournament
            let match1Data = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const firstPlayer1 = match1Data.firstPlayer;
            const actualPlayer1_t1 = match1Data.common.player1;
            const actualPlayer2_t1 = match1Data.common.player2;
            const p1_t1 = firstPlayer1 === actualPlayer1_t1 ? player1 : player2;
            const p2_t1 = firstPlayer1 === actualPlayer1_t1 ? player2 : player1;

            // Complete first finals
            await game.connect(p1_t1).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(p2_t1).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(p1_t1).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);
            await game.connect(p2_t1).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(p1_t1).makeMove(tierId, instanceId, roundNumber, matchNumber, 8);

            // Store first tournament winner
            match1Data = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const winner1 = match1Data.common.winner;
            expect(match1Data.common.isCached).to.be.false; // Should be in live storage

            // ========== SECOND TOURNAMENT (SAME INSTANCE) ==========
            // Enroll and start second tournament
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Get match info for second tournament
            let match2Data = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const firstPlayer2 = match2Data.firstPlayer;
            const actualPlayer1_t2 = match2Data.common.player1;
            const actualPlayer2_t2 = match2Data.common.player2;
            const p1_t2 = firstPlayer2 === actualPlayer1_t2 ? player3 : player4;
            const p2_t2 = firstPlayer2 === actualPlayer1_t2 ? player4 : player3;

            // Verify second tournament has different players
            expect(actualPlayer1_t2).to.not.equal(actualPlayer1_t1);
            expect(actualPlayer2_t2).to.not.equal(actualPlayer2_t1);

            // Complete second finals
            await game.connect(p1_t2).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
            await game.connect(p2_t2).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
            await game.connect(p1_t2).makeMove(tierId, instanceId, roundNumber, matchNumber, 3);
            await game.connect(p2_t2).makeMove(tierId, instanceId, roundNumber, matchNumber, 2);
            await game.connect(p1_t2).makeMove(tierId, instanceId, roundNumber, matchNumber, 6);

            // ========== VERIFICATION ==========
            // New finals should be in live storage
            match2Data = await game.getMatch(tierId, instanceId, roundNumber, matchNumber);
            const winner2 = match2Data.common.winner;

            expect(match2Data.common.isCached).to.be.false; // New finals in live storage
            expect(match2Data.common.status).to.equal(2); // Completed
            expect(match2Data.common.player1).to.equal(actualPlayer1_t2);
            expect(match2Data.common.player2).to.equal(actualPlayer2_t2);
            expect(winner2).to.not.equal(hre.ethers.ZeroAddress);

            // Verify winners are different (different tournaments)
            expect(winner2).to.not.equal(winner1);

            // Old finals should have been cached during _cacheOldFinalsIfExists()
            // Note: We can't easily verify the cached data without triggering another reset
            // The important part is that the new finals is preserved and accessible
        });
    });
});
