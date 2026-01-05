// test/InitializeAllInstances.test.js
// Test to verify initializeAllInstances() works correctly

import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain - initializeAllInstances()", function () {
    let game;
    let owner;
    let gameNotInitialized;

    before(async function () {
        [owner] = await hre.ethers.getSigners();

        // Deploy TicTacChain without initializing
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        gameNotInitialized = await TicTacChain.deploy();
        await gameNotInitialized.waitForDeployment();
    });

    beforeEach(async function () {
        // Deploy a fresh instance for each test
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
    });

    it("Should have 0 tiers before initialization", async function () {
        const tierCount = await gameNotInitialized.tierCount();
        expect(tierCount).to.equal(0);
    });

    // NOTE: allInstancesInitialized was removed for gas optimization
    it.skip("Should have allInstancesInitialized = false before initialization (DEPRECATED)", async function () {
        // This function was removed for gas optimization
    });

    it("Should initialize all tiers when initializeAllInstances() is called", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(3);
    });

    // NOTE: allInstancesInitialized was removed for gas optimization
    // Verify initialization by checking tier count instead
    it("Should have tiers registered after initialization", async function () {
        const tx = await game.initializeAllInstances();
        await tx.wait();

        const tierCount = await game.tierCount();
        expect(tierCount).to.be.gt(0);
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
