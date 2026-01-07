// Test getPlayerActivityCounts to see if storage is accessible
import { expect } from "chai";
import hre from "hardhat";

describe("Test Player Activity Counts", function () {
    let game, player1;

    before(async function () {
        [, player1] = await hre.ethers.getSigners();

        // Deploy TicTacChain using standard deployment
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();


        console.log("\n✅ Game initialized");
    });
    
    // NOTE: getPlayerActivityCounts was removed for gas optimization
    // Activity is tracked differently now - enrollment status can be checked directly
    it("Should verify enrollment status works (replaces activity counts)", async function () {
        // Check initial state
        const isEnrolled = await game.isEnrolled(0, 0, player1.address);
        console.log("✅ Initial enrollment state:", isEnrolled);
        expect(isEnrolled).to.be.false;

        // Enroll player
        const TIER_0_FEE = hre.ethers.parseEther("0.001");
        await game.connect(player1).enrollInTournament(0, 0, { value: TIER_0_FEE });

        // Check enrollment
        const isEnrolledAfter = await game.isEnrolled(0, 0, player1.address);
        console.log("✅ After enrollment:", isEnrolledAfter);
        expect(isEnrolledAfter).to.be.true;
    });
});
