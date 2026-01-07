// Simplest possible test of player tracking
import { expect } from "chai";
import hre from "hardhat";

describe("Test Simple Tracking", function () {
    it("Should test that player tracking storage exists in game contract", async function () {
        const [, player1] = await hre.ethers.getSigners();

        // Deploy TicTacChain using the standard deployment pattern from setup.cjs
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        const game = await TicTacChain.deploy();
        await game.waitForDeployment();

        // Initialize

        console.log("\n✅ Game deployed and initialized");
        console.log("Game address:", await game.getAddress());

        // Verify the contract works by enrolling a player
        const TIER_0_FEE = hre.ethers.parseEther("0.001");
        await game.connect(player1).enrollInTournament(0, 0, { value: TIER_0_FEE });

        // Check enrollment status
        const isEnrolled = await game.isEnrolled(0, 0, player1.address);
        expect(isEnrolled).to.be.true;
        console.log("✅ Player enrolled and tracking works");
    });
});
