// Test delegatecall behavior in TicTacChain
import { expect } from "chai";
import hre from "hardhat";

describe("Test Delegatecall Direct", function () {
    let game, player1;

    before(async function () {
        [, player1] = await hre.ethers.getSigners();

        // Deploy TicTacChain using standard deployment
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();

        // Initialize
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("TicTacChain deployed and initialized\n");
    });

    it("Should test delegatecall behavior via enrollment", async function () {
        const TIER_0_FEE = hre.ethers.parseEther("0.001");

        // Enroll player - this triggers delegatecalls internally
        await game.connect(player1).enrollInTournament(0, 0, { value: TIER_0_FEE });

        // Verify enrollment worked (which means delegatecalls succeeded)
        const isEnrolled = await game.isEnrolled(0, 0, player1.address);
        expect(isEnrolled).to.be.true;
        console.log("✅ Delegatecall via enrollment succeeded!");
    });
});
