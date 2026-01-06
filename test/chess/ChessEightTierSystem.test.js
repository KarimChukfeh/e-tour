// test/chess/ChessEightTierSystem.test.js
// Comprehensive tests for ChessOnChain 8-tier tournament system
// Tests enrollment, progression, prize distribution, and cross-tier independence

import { expect } from "chai";
import hre from "hardhat";

describe("ChessOnChain 8-Tier System Tests", function () {
    let chess;
    let owner, player1, player2, player3, player4, player5, player6, player7, player8;

    const PieceType = {
        None: 0,
        Pawn: 1,
        Knight: 2,
        Bishop: 3,
        Rook: 4,
        Queen: 5,
        King: 6
    };

    const TournamentStatus = {
        Enrolling: 0,
        InProgress: 1,
        Completed: 2,
        Abandoned: 3
    };

    const MatchStatus = {
        NotStarted: 0,
        InProgress: 1,
        Completed: 2
    };

    // Tier configurations
    const TIER_CONFIGS = [
        { id: 0, players: 2, instances: 100, fee: "0.01", enrollWindow: 600 },
        { id: 1, players: 2, instances: 100, fee: "0.02", enrollWindow: 600 },
        { id: 2, players: 2, instances: 100, fee: "0.03", enrollWindow: 600 },
        { id: 3, players: 2, instances: 100, fee: "0.1", enrollWindow: 600 },
        { id: 4, players: 4, instances: 50, fee: "0.015", enrollWindow: 1800 },
        { id: 5, players: 4, instances: 50, fee: "0.025", enrollWindow: 1800 },
        { id: 6, players: 4, instances: 50, fee: "0.035", enrollWindow: 1800 },
        { id: 7, players: 4, instances: 50, fee: "0.15", enrollWindow: 1800 },
    ];

    const BOUNDARY_TIERS = [
        TIER_CONFIGS[0], // Tier 0 - lowest 2-player
        TIER_CONFIGS[3], // Tier 3 - highest 2-player
        TIER_CONFIGS[4], // Tier 4 - lowest 4-player
        TIER_CONFIGS[7], // Tier 7 - highest 4-player
    ];

    // Chess square positions (row * 8 + col)
    const squares = {
        e2: 12, e4: 28, e7: 52, e5: 36,
        f1: 5, c4: 26, b8: 57, c6: 42,
        d1: 3, h5: 39, g8: 62, f6: 45,
        f7: 53
    };

    // Helper functions
    async function enrollPlayers(tierId, instanceId, count, fee) {
        const signers = await hre.ethers.getSigners();
        const players = signers.slice(1, count + 1); // Skip owner

        for (const player of players) {
            await chess.connect(player).enrollInTournament(tierId, instanceId, { value: fee });
        }

        return players;
    }

    async function playScholarsMate(tierId, instanceId, roundNum, matchNum) {
        const matchData = await chess.getMatch(tierId, instanceId, roundNum, matchNum);
        const whitePlayerAddr = matchData.common.player1;
        const blackPlayerAddr = matchData.common.player2;

        const signers = await hre.ethers.getSigners();
        const whitePlayer = signers.find(s => s.address === whitePlayerAddr);
        const blackPlayer = signers.find(s => s.address === blackPlayerAddr);

        // Scholar's Mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#
        await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.e2, squares.e4, PieceType.None);
        await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.e7, squares.e5, PieceType.None);
        await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.f1, squares.c4, PieceType.None);
        await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.b8, squares.c6, PieceType.None);
        await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.d1, squares.h5, PieceType.None);
        await chess.connect(blackPlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.g8, squares.f6, PieceType.None);
        await chess.connect(whitePlayer).makeMove(tierId, instanceId, roundNum, matchNum, squares.h5, squares.f7, PieceType.None);

        return whitePlayer.address; // Winner
    }

    async function claimTimeoutWin(tierId, instanceId, roundNum, matchNum) {
        const matchData = await chess.getMatch(tierId, instanceId, roundNum, matchNum);
        const currentTurnAddr = matchData.currentTurn;
        const waitingPlayerAddr = currentTurnAddr === matchData.common.player1
            ? matchData.common.player2
            : matchData.common.player1;

        const signers = await hre.ethers.getSigners();
        const waitingPlayer = signers.find(s => s.address === waitingPlayerAddr);

        // Fast forward past timeout (600 seconds)
        await hre.ethers.provider.send("evm_increaseTime", [601]);
        await hre.ethers.provider.send("evm_mine", []);

        await chess.connect(waitingPlayer).claimTimeoutWin(tierId, instanceId, roundNum, matchNum);

        return waitingPlayer.address; // Winner
    }

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5, player6, player7, player8] = await hre.ethers.getSigners();

        // Deploy all modules
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        const GameCacheModule = await hre.ethers.getContractFactory("GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();
        await moduleGameCache.waitForDeployment();

        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        const chessRulesModule = await ChessRulesModule.deploy();
        await chessRulesModule.waitForDeployment();

        // Deploy ChessOnChain
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress(),
            await chessRulesModule.getAddress()
        );
        await chess.waitForDeployment();

        // Initialize tiers - required before enrollments
        await chess.initializeAllInstances();
    });

    describe("Tier Configuration Validation", function () {
        it("Should have exactly 8 tiers configured", async function () {
            const tierCount = await chess.tierCount();
            expect(tierCount).to.equal(8);
        });

        it("Should have correct parameters for all 8 tiers", async function () {
            for (const config of TIER_CONFIGS) {
                const tierConfig = await chess.tierConfigs(config.id);
                expect(tierConfig.playerCount).to.equal(config.players);
                expect(tierConfig.instanceCount).to.equal(config.instances);
                expect(tierConfig.entryFee).to.equal(hre.ethers.parseEther(config.fee));
                expect(tierConfig.timeouts.enrollmentWindow).to.equal(config.enrollWindow);
            }
        });
    });

    describe("Boundary Tier Enrollment Tests", function () {
        describe("Tier 0 (Lowest Fee 2-Player)", function () {
            const tierConfig = BOUNDARY_TIERS[0];
            const fee = hre.ethers.parseEther(tierConfig.fee);

            it("Should accept correct entry fee", async function () {
                const instanceId = 0;
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "PlayerEnrolled");
            });

            it("Should reject incorrect entry fee", async function () {
                const instanceId = 1;
                const wrongFee = hre.ethers.parseEther("0.02");
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: wrongFee })
                ).to.be.reverted;
            });

            it("Should auto-start when last slot fills", async function () {
                const instanceId = 2;
                await chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee });

                await expect(
                    chess.connect(player2).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "TournamentStarted");
            });

            it("Should split entry fees correctly (90/7.5/2.5)", async function () {
                const instanceId = 3;
                const ownerBalanceBefore = await hre.ethers.provider.getBalance(owner.address);

                await enrollPlayers(tierConfig.id, instanceId, tierConfig.players, fee);

                const tournament = await chess.tournaments(tierConfig.id, instanceId);
                const totalFees = fee * BigInt(tierConfig.players);
                const expectedPool = (totalFees * 9000n) / 10000n;
                const expectedProtocol = (totalFees * 250n) / 10000n;

                expect(tournament.prizePool).to.equal(expectedPool);

                const protocolShare = await chess.accumulatedProtocolShare();
                expect(protocolShare).to.be.gte(expectedProtocol);
            });
        });

        describe("Tier 3 (Highest Fee 2-Player)", function () {
            const tierConfig = BOUNDARY_TIERS[1];
            const fee = hre.ethers.parseEther(tierConfig.fee);

            it("Should accept correct entry fee", async function () {
                const instanceId = 0;
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "PlayerEnrolled");
            });

            it("Should reject incorrect entry fee", async function () {
                const instanceId = 1;
                const wrongFee = hre.ethers.parseEther("0.01");
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: wrongFee })
                ).to.be.reverted;
            });

            it("Should auto-start when last slot fills", async function () {
                const instanceId = 2;
                await chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee });

                await expect(
                    chess.connect(player2).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "TournamentStarted");
            });

            it("Should split entry fees correctly (90/7.5/2.5)", async function () {
                const instanceId = 3;

                await enrollPlayers(tierConfig.id, instanceId, tierConfig.players, fee);

                const tournament = await chess.tournaments(tierConfig.id, instanceId);
                const totalFees = fee * BigInt(tierConfig.players);
                const expectedPool = (totalFees * 9000n) / 10000n;

                expect(tournament.prizePool).to.equal(expectedPool);
            });
        });

        describe("Tier 4 (Lowest Fee 4-Player)", function () {
            const tierConfig = BOUNDARY_TIERS[2];
            const fee = hre.ethers.parseEther(tierConfig.fee);

            it("Should accept correct entry fee", async function () {
                const instanceId = 0;
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "PlayerEnrolled");
            });

            it("Should reject incorrect entry fee", async function () {
                const instanceId = 1;
                const wrongFee = hre.ethers.parseEther("0.02");
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: wrongFee })
                ).to.be.reverted;
            });

            it("Should auto-start when last slot fills", async function () {
                const instanceId = 2;
                await chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee });
                await chess.connect(player2).enrollInTournament(tierConfig.id, instanceId, { value: fee });
                await chess.connect(player3).enrollInTournament(tierConfig.id, instanceId, { value: fee });

                await expect(
                    chess.connect(player4).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "TournamentStarted");
            });

            it("Should split entry fees correctly (90/7.5/2.5)", async function () {
                const instanceId = 3;

                await enrollPlayers(tierConfig.id, instanceId, tierConfig.players, fee);

                const tournament = await chess.tournaments(tierConfig.id, instanceId);
                const totalFees = fee * BigInt(tierConfig.players);
                const expectedPool = (totalFees * 9000n) / 10000n;

                expect(tournament.prizePool).to.equal(expectedPool);
            });
        });

        describe("Tier 7 (Highest Fee 4-Player)", function () {
            const tierConfig = BOUNDARY_TIERS[3];
            const fee = hre.ethers.parseEther(tierConfig.fee);

            it("Should accept correct entry fee", async function () {
                const instanceId = 0;
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "PlayerEnrolled");
            });

            it("Should reject incorrect entry fee", async function () {
                const instanceId = 1;
                const wrongFee = hre.ethers.parseEther("0.01");
                await expect(
                    chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: wrongFee })
                ).to.be.reverted;
            });

            it("Should auto-start when last slot fills", async function () {
                const instanceId = 2;
                await chess.connect(player1).enrollInTournament(tierConfig.id, instanceId, { value: fee });
                await chess.connect(player2).enrollInTournament(tierConfig.id, instanceId, { value: fee });
                await chess.connect(player3).enrollInTournament(tierConfig.id, instanceId, { value: fee });

                await expect(
                    chess.connect(player4).enrollInTournament(tierConfig.id, instanceId, { value: fee })
                ).to.emit(chess, "TournamentStarted");
            });

            it("Should split entry fees correctly (90/7.5/2.5)", async function () {
                const instanceId = 3;

                await enrollPlayers(tierConfig.id, instanceId, tierConfig.players, fee);

                const tournament = await chess.tournaments(tierConfig.id, instanceId);
                const totalFees = fee * BigInt(tierConfig.players);
                const expectedPool = (totalFees * 9000n) / 10000n;

                expect(tournament.prizePool).to.equal(expectedPool);
            });
        });
    });

    describe("2-Player Tier Progression", function () {
        it("Should complete Tier 0 tournament via checkmate", async function () {
            const tierId = 0;
            const instanceId = 10;
            const fee = hre.ethers.parseEther("0.01");

            await enrollPlayers(tierId, instanceId, 2, fee);

            const winnerAddr = await playScholarsMate(tierId, instanceId, 0, 0);

            // Verify from cached match data
            const matchData = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchData.common.winner).to.equal(winnerAddr);
            expect(matchData.common.isDraw).to.be.false;
        });

        it("Should complete Tier 3 tournament via checkmate", async function () {
            const tierId = 3;
            const instanceId = 10;
            const fee = hre.ethers.parseEther("0.1");

            await enrollPlayers(tierId, instanceId, 2, fee);

            const winnerAddr = await playScholarsMate(tierId, instanceId, 0, 0);

            const matchData = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchData.common.winner).to.equal(winnerAddr);
        });

        it("Should complete Tier 0 tournament via timeout", async function () {
            const tierId = 0;
            const instanceId = 11;
            const fee = hre.ethers.parseEther("0.01");

            await enrollPlayers(tierId, instanceId, 2, fee);

            const winnerAddr = await claimTimeoutWin(tierId, instanceId, 0, 0);

            const matchData = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchData.common.winner).to.equal(winnerAddr);
        });

        it("Should complete Tier 3 tournament via timeout", async function () {
            const tierId = 3;
            const instanceId = 11;
            const fee = hre.ethers.parseEther("0.1");

            await enrollPlayers(tierId, instanceId, 2, fee);

            const winnerAddr = await claimTimeoutWin(tierId, instanceId, 0, 0);

            const matchData = await chess.getMatch(tierId, instanceId, 0, 0);
            expect(matchData.common.winner).to.equal(winnerAddr);
        });
    });

    describe("4-Player Tier Progression", function () {
        it("Should complete Tier 4 semi-finals and finals via checkmate", async function () {
            const tierId = 4;
            const instanceId = 10;
            const fee = hre.ethers.parseEther("0.015");

            await enrollPlayers(tierId, instanceId, 4, fee);

            // Verify round 0 has 2 matches (semi-finals)
            const round0Before = await chess.rounds(tierId, instanceId, 0);
            expect(round0Before.totalMatches).to.equal(2);

            // Complete semi-final 0
            await playScholarsMate(tierId, instanceId, 0, 0);

            // Complete semi-final 1
            await playScholarsMate(tierId, instanceId, 0, 1);

            // Verify round 0 completed
            const round0After = await chess.rounds(tierId, instanceId, 0);
            expect(round0After.completedMatches).to.equal(2);

            // Verify round 1 (finals) initialized
            const round1Before = await chess.rounds(tierId, instanceId, 1);
            expect(round1Before.initialized).to.be.true;
            expect(round1Before.totalMatches).to.equal(1);

            // Complete finals
            await playScholarsMate(tierId, instanceId, 1, 0);

            // Verify finals completed
            const finalsMatch = await chess.getMatch(tierId, instanceId, 1, 0);
            expect(finalsMatch.common.winner).to.not.equal(hre.ethers.ZeroAddress);
        });

        it("Should complete Tier 7 semi-finals and finals via checkmate", async function () {
            const tierId = 7;
            const instanceId = 10;
            const fee = hre.ethers.parseEther("0.15");

            await enrollPlayers(tierId, instanceId, 4, fee);

            // Complete semi-finals
            await playScholarsMate(tierId, instanceId, 0, 0);
            await playScholarsMate(tierId, instanceId, 0, 1);

            // Verify finals initialized
            const round1 = await chess.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;
            expect(round1.totalMatches).to.equal(1);

            // Complete finals
            await playScholarsMate(tierId, instanceId, 1, 0);

            const finalsMatch = await chess.getMatch(tierId, instanceId, 1, 0);
            expect(finalsMatch.common.winner).to.not.equal(hre.ethers.ZeroAddress);
        });

        it("Should handle mixed completion methods (timeout + checkmate)", async function () {
            const tierId = 4;
            const instanceId = 11;
            const fee = hre.ethers.parseEther("0.015");

            await enrollPlayers(tierId, instanceId, 4, fee);

            // Semi-final 0: Checkmate
            await playScholarsMate(tierId, instanceId, 0, 0);

            // Semi-final 1: Timeout
            await claimTimeoutWin(tierId, instanceId, 0, 1);

            // Verify round 1 initialized
            const round1 = await chess.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.true;

            // Finals: Checkmate
            await playScholarsMate(tierId, instanceId, 1, 0);

            const finalsMatch = await chess.getMatch(tierId, instanceId, 1, 0);
            expect(finalsMatch.common.winner).to.not.equal(hre.ethers.ZeroAddress);
        });

        it("Should handle Tier 7 mixed completion methods", async function () {
            const tierId = 7;
            const instanceId = 11;
            const fee = hre.ethers.parseEther("0.15");

            await enrollPlayers(tierId, instanceId, 4, fee);

            // Semi-final 0: Timeout
            await claimTimeoutWin(tierId, instanceId, 0, 0);

            // Semi-final 1: Checkmate
            await playScholarsMate(tierId, instanceId, 0, 1);

            // Finals: Timeout
            await claimTimeoutWin(tierId, instanceId, 1, 0);

            const finalsMatch = await chess.getMatch(tierId, instanceId, 1, 0);
            expect(finalsMatch.common.winner).to.not.equal(hre.ethers.ZeroAddress);
        });
    });

    describe("Prize Distribution Validation", function () {
        it("Should distribute winner-takes-all correctly in Tier 0", async function () {
            const tierId = 0;
            const instanceId = 20;
            const fee = hre.ethers.parseEther("0.01");

            const players = await enrollPlayers(tierId, instanceId, 2, fee);
            const tournament = await chess.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            const winnerAddr = await playScholarsMate(tierId, instanceId, 0, 0);

            const winnerPrize = await chess.playerPrizes(tierId, instanceId, winnerAddr);
            expect(winnerPrize).to.equal(prizePool);
        });

        it("Should distribute winner-takes-all correctly in Tier 3", async function () {
            const tierId = 3;
            const instanceId = 20;
            const fee = hre.ethers.parseEther("0.1");

            await enrollPlayers(tierId, instanceId, 2, fee);
            const tournament = await chess.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            const winnerAddr = await playScholarsMate(tierId, instanceId, 0, 0);

            const winnerPrize = await chess.playerPrizes(tierId, instanceId, winnerAddr);
            expect(winnerPrize).to.equal(prizePool);
        });

        it("Should distribute winner-takes-all correctly in Tier 4", async function () {
            const tierId = 4;
            const instanceId = 20;
            const fee = hre.ethers.parseEther("0.015");

            await enrollPlayers(tierId, instanceId, 4, fee);
            const tournament = await chess.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Complete tournament
            await playScholarsMate(tierId, instanceId, 0, 0);
            await playScholarsMate(tierId, instanceId, 0, 1);
            const winnerAddr = await playScholarsMate(tierId, instanceId, 1, 0);

            const winnerPrize = await chess.playerPrizes(tierId, instanceId, winnerAddr);
            expect(winnerPrize).to.equal(prizePool);
        });

        it("Should distribute winner-takes-all correctly in Tier 7", async function () {
            const tierId = 7;
            const instanceId = 20;
            const fee = hre.ethers.parseEther("0.15");

            await enrollPlayers(tierId, instanceId, 4, fee);
            const tournament = await chess.tournaments(tierId, instanceId);
            const prizePool = tournament.prizePool;

            // Complete tournament
            await playScholarsMate(tierId, instanceId, 0, 0);
            await playScholarsMate(tierId, instanceId, 0, 1);
            const winnerAddr = await playScholarsMate(tierId, instanceId, 1, 0);

            const winnerPrize = await chess.playerPrizes(tierId, instanceId, winnerAddr);
            expect(winnerPrize).to.equal(prizePool);
        });
    });

    describe("Cross-Tier Independence", function () {
        it("Should allow player to enroll in multiple tiers simultaneously", async function () {
            const player = player1;

            // Enroll in Tier 0
            await chess.connect(player).enrollInTournament(0, 0, {
                value: hre.ethers.parseEther("0.01")
            });

            // Enroll in Tier 4
            await chess.connect(player).enrollInTournament(4, 0, {
                value: hre.ethers.parseEther("0.015")
            });

            // Enroll in Tier 7
            await chess.connect(player).enrollInTournament(7, 0, {
                value: hre.ethers.parseEther("0.15")
            });

            // Verify all enrollments are valid
            expect(await chess.isEnrolled(0, 0, player.address)).to.be.true;
            expect(await chess.isEnrolled(4, 0, player.address)).to.be.true;
            expect(await chess.isEnrolled(7, 0, player.address)).to.be.true;
        });

        it("Should track prizes independently per tier", async function () {
            // Complete tournament in Tier 0
            await enrollPlayers(0, 30, 2, hre.ethers.parseEther("0.01"));
            const winner_t0 = await playScholarsMate(0, 30, 0, 0);
            const prize_t0 = await chess.playerPrizes(0, 30, winner_t0);

            // Complete tournament in Tier 3
            await enrollPlayers(3, 30, 2, hre.ethers.parseEther("0.1"));
            const winner_t3 = await playScholarsMate(3, 30, 0, 0);
            const prize_t3 = await chess.playerPrizes(3, 30, winner_t3);

            // Prizes should be tracked independently and should exist
            expect(prize_t0).to.be.gt(0);
            expect(prize_t3).to.be.gt(0);

            // Prize amounts should be different (different entry fees)
            expect(prize_t0).to.not.equal(prize_t3);
        });

        it("Should allow player in different instances of same tier", async function () {
            const player = player1;

            // Enroll in Tier 0, instance 0
            await chess.connect(player).enrollInTournament(0, 40, {
                value: hre.ethers.parseEther("0.01")
            });

            // Enroll in Tier 0, instance 1
            await chess.connect(player).enrollInTournament(0, 41, {
                value: hre.ethers.parseEther("0.01")
            });

            expect(await chess.isEnrolled(0, 40, player.address)).to.be.true;
            expect(await chess.isEnrolled(0, 41, player.address)).to.be.true;
        });
    });
});
