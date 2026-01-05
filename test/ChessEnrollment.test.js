// test/ChessEnrollment.test.js
// Quick test to verify ChessOnChain enrollment works with shared modules

import { expect } from "chai";
import hre from "hardhat";

describe("ChessOnChain - Enrollment Test", function () {
    let game;
    let owner, player1, player2;

    before(async function () {
        [owner, player1, player2] = await hre.ethers.getSigners();

        // Deploy all ETour modules (these will be shared)
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

        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        const modulePlayerTracking = await PlayerTrackingModule.deploy();
        await modulePlayerTracking.waitForDeployment();

        // Deploy ChessRulesModule (game-specific)
        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        const moduleChessRules = await ChessRulesModule.deploy();
        await moduleChessRules.waitForDeployment();

        // Deploy ChessOnChain with all module addresses
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        game = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress(),
            await moduleChessRules.getAddress(),
            await modulePlayerTracking.getAddress()
        );
        await game.waitForDeployment();

        console.log("ChessOnChain deployed to:", await game.getAddress());

        // Initialize all instances
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("ChessOnChain initialized");
    });

    it("Should have 2 tiers configured", async function () {
        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(2);
    });

    it("Should have correct tier 0 configuration (2-player)", async function () {
        const tier0 = await game.getTierInfo(0);
        expect(tier0.playerCount).to.equal(2);
        expect(tier0.instanceCount).to.equal(100);
        expect(tier0.entryFee).to.equal(hre.ethers.parseEther("0.01"));
    });

    it("Should allow player enrollment in tier 0", async function () {
        const entryFee = hre.ethers.parseEther("0.01");

        const tx = await game.connect(player1).enrollInTournament(0, 0, { value: entryFee });
        await tx.wait();

        // Verify enrollment
        const isEnrolled = await game.isEnrolled(0, 0, player1.address);
        expect(isEnrolled).to.be.true;
    });

    it("Should allow second player enrollment and auto-start tournament", async function () {
        const entryFee = hre.ethers.parseEther("0.01");

        const tx = await game.connect(player2).enrollInTournament(0, 0, { value: entryFee });
        await tx.wait();

        // Verify enrollment
        const isEnrolled = await game.isEnrolled(0, 0, player2.address);
        expect(isEnrolled).to.be.true;

        // Verify tournament started
        const tournament = await game.getTournamentInfo(0, 0);
        expect(tournament.status).to.equal(1); // TournamentStatus.InProgress
    });

    it("Should have created initial match", async function () {
        // Get match data for round 0, match 0
        const matchData = await game.getMatch(0, 0, 0, 0);

        expect(matchData.common.status).to.equal(1); // MatchStatus.InProgress
        expect(matchData.common.player1).to.not.equal(hre.ethers.ZeroAddress);
        expect(matchData.common.player2).to.not.equal(hre.ethers.ZeroAddress);
    });
});
