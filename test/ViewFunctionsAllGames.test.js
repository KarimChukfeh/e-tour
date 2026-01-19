import { expect } from "chai";
import hre from "hardhat";

/**
 * Comprehensive tests for view functions across all three games
 * Tests: isPlayerInAdvancedRound, isMatchEscL2Available, isMatchEscL3Available
 * Games: TicTacChain, ConnectFourOnChain, ChessOnChain
 */
describe("View Functions - All Games", function () {
    let owner, player1, player2, player3, player4;

    const TIER_ID = 1;
    const INSTANCE_ID = 0;
    const ROUND_NUMBER = 0;
    const MATCH_NUMBER = 0;

    before(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();
    });

    // ============ TicTacChain Tests ============
    describe("TicTacChain View Functions", function () {
        let game;
        const TIER_FEE = hre.ethers.parseEther("0.0007");
        const MATCH_TIME = 120;
        const L2_DELAY = 120;
        const L3_DELAY = 240;

        beforeEach(async function () {
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

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player2).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player3).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player4).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });

            await hre.network.provider.send("evm_mine");
        });

        describe("isMatchEscL2Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L2 delay", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L2_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isMatchEscL3Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L3 delay", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 4);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L3_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isPlayerInAdvancedRound", function () {
            it("Should return false for non-enrolled player", async function () {
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, owner.address)).to.be.false;
            });

            it("Should return false for enrolled player who hasn't won any matches yet", async function () {
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, player1.address)).to.be.false;
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, player2.address)).to.be.false;
            });
        });
    });

    // ============ ConnectFourOnChain Tests ============
    describe("ConnectFourOnChain View Functions", function () {
        let game;
        const TIER_FEE = hre.ethers.parseEther("0.002");
        const MATCH_TIME = 300;
        const L2_DELAY = 120;
        const L3_DELAY = 240;

        beforeEach(async function () {
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

            // Deploy ConnectFourOnChain
            const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
            game = await ConnectFourOnChain.deploy(
                await moduleCore.getAddress(),
                await moduleMatches.getAddress(),
                await modulePrizes.getAddress(),
                await moduleRaffle.getAddress(),
                await moduleEscalation.getAddress()
            );

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player2).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player3).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player4).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });

            await hre.network.provider.send("evm_mine");
        });

        describe("isMatchEscL2Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 3);

                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L2 delay", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 3);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L2_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isMatchEscL3Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 3);

                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L3 delay", async function () {
                const match = await game.getMatch(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 3);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L3_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isPlayerInAdvancedRound", function () {
            it("Should return false for non-enrolled player", async function () {
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, owner.address)).to.be.false;
            });

            it("Should return false for enrolled player who hasn't won any matches yet", async function () {
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, player1.address)).to.be.false;
                expect(await game.isPlayerInAdvancedRound(TIER_ID, INSTANCE_ID, ROUND_NUMBER, player2.address)).to.be.false;
            });
        });
    });

    // ============ ChessOnChain Tests ============
    describe("ChessOnChain View Functions", function () {
        let game;
        const CHESS_TIER_ID = 0;
        const TIER_FEE = hre.ethers.parseEther("0.003");
        const MATCH_TIME = 600;
        const L2_DELAY = 180;
        const L3_DELAY = 360;

        beforeEach(async function () {
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

            const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
            const chessRules = await ChessRulesModule.deploy();

            // Deploy ChessOnChain
            const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
            game = await ChessOnChain.deploy(
                await moduleCore.getAddress(),
                await moduleMatches.getAddress(),
                await modulePrizes.getAddress(),
                await moduleRaffle.getAddress(),
                await moduleEscalation.getAddress(),
                await chessRules.getAddress()
            );

            // Enroll 2 players (tier 0 is 2-player)
            await game.connect(player1).enrollInTournament(CHESS_TIER_ID, INSTANCE_ID, { value: TIER_FEE });
            await game.connect(player2).enrollInTournament(CHESS_TIER_ID, INSTANCE_ID, { value: TIER_FEE });

            await hre.network.provider.send("evm_mine");
        });

        describe("isMatchEscL2Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL2Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                // Make a simple pawn move (e2 to e4 or e7 to e5)
                await game.connect(currentPlayer).makeMove(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 12, 28, 0);

                expect(await game.isMatchEscL2Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L2 delay", async function () {
                const match = await game.getMatch(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 12, 28, 0);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L2_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL2Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isMatchEscL3Available", function () {
            it("Should return false for non-existent match", async function () {
                expect(await game.isMatchEscL3Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, 99)).to.be.false;
            });

            it("Should return false when player has not timed out", async function () {
                const match = await game.getMatch(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 12, 28, 0);

                expect(await game.isMatchEscL3Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.false;
            });

            it("Should return true after timeout + L3 delay", async function () {
                const match = await game.getMatch(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER);
                const currentPlayer = match.currentTurn === player1.address ? player1 : player2;
                await game.connect(currentPlayer).makeMove(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER, 12, 28, 0);

                await hre.network.provider.send("evm_increaseTime", [Number(MATCH_TIME) + Number(L3_DELAY) + 10]);
                await hre.network.provider.send("evm_mine");

                expect(await game.isMatchEscL3Available(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, MATCH_NUMBER)).to.be.true;
            });
        });

        describe("isPlayerInAdvancedRound", function () {
            it("Should return false for non-enrolled player", async function () {
                expect(await game.isPlayerInAdvancedRound(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, owner.address)).to.be.false;
            });

            it("Should return false for enrolled player who hasn't won any matches yet", async function () {
                expect(await game.isPlayerInAdvancedRound(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, player1.address)).to.be.false;
                expect(await game.isPlayerInAdvancedRound(CHESS_TIER_ID, INSTANCE_ID, ROUND_NUMBER, player2.address)).to.be.false;
            });
        });
    });
});
