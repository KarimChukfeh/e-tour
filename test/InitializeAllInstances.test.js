// test/InitializeAllInstances.test.js
// Test to verify initializeAllInstances() works correctly

import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain - initializeAllInstances()", function () {
    let game;
    let owner;

    beforeEach(async function () {
        [owner] = await hre.ethers.getSigners();

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

        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        const modulePlayerTracking = await PlayerTrackingModule.deploy();
        await modulePlayerTracking.waitForDeployment();

        const TicTacToeGameModule = await hre.ethers.getContractFactory("contracts/modules/TicTacToeGameModule.sol:TicTacToeGameModule");
        const moduleTicTacToeGame = await TicTacToeGameModule.deploy();
        await moduleTicTacToeGame.waitForDeployment();

        // Deploy TicTacChain with all module addresses
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress(),
            await modulePlayerTracking.getAddress(),
            await moduleTicTacToeGame.getAddress()
        );
        await game.waitForDeployment();
    });

    it("Should have 0 tiers before initialization", async function () {
        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(0);
    });

    it("Should have allInstancesInitialized = false before initialization", async function () {
        const initialized = await game.allInstancesInitialized();
        expect(initialized).to.equal(false);
    });

    it("Should initialize all tiers when initializeAllInstances() is called", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(3);
    });

    it("Should have allInstancesInitialized = true after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const initialized = await game.allInstancesInitialized();
        expect(initialized).to.equal(true);
    });

    it("Should emit AllInstancesInitialized event", async function () {
        await expect(game.initializeAllInstances())
            .to.emit(game, "AllInstancesInitialized")
            .withArgs(owner.address, 3);
    });

    it("Should not allow calling initializeAllInstances() twice", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        await expect(game.initializeAllInstances())
            .to.be.revertedWith("I");
    });

    it("Should have correct tier 0 configuration after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tier0 = await game.getTierInfo(0);
        expect(tier0.playerCount).to.equal(2);
        expect(tier0.instanceCount).to.equal(100);
        expect(tier0.entryFee).to.equal(hre.ethers.parseEther("0.001"));
    });

    it("Should have correct tier 1 configuration after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tier1 = await game.getTierInfo(1);
        expect(tier1.playerCount).to.equal(4);
        expect(tier1.instanceCount).to.equal(40);
        expect(tier1.entryFee).to.equal(hre.ethers.parseEther("0.002"));
    });

    it("Should have correct tier 2 configuration after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tier2 = await game.getTierInfo(2);
        expect(tier2.playerCount).to.equal(8);
        expect(tier2.instanceCount).to.equal(20);
        expect(tier2.entryFee).to.equal(hre.ethers.parseEther("0.004"));
    });

    it("Should allow enrollment after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const entryFee = hre.ethers.parseEther("0.001");
        await expect(game.enrollInTournament(0, 0, { value: entryFee }))
            .to.not.be.reverted;
    });

    it("Should fail enrollment before initialization", async function () {
        const entryFee = hre.ethers.parseEther("0.001");

        // This should fail because tier 0 is not initialized yet
        await expect(game.enrollInTournament(0, 0, { value: entryFee }))
            .to.be.reverted;
    });
});
