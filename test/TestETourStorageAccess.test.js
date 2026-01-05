// Test if TicTacChain can access ETour_Storage variables
import { expect } from "chai";
import hre from "hardhat";

describe("Test ETour_Storage Access", function () {
    let game;

    before(async function () {
        // Deploy TicTacChain using standard deployment
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();

        await (await game.initializeAllInstances()).wait();
    });
    
    it("Should access tierCount from ETour_Storage", async function () {
        try {
            const tierCount = await game.tierCount();
            console.log("✅ tierCount:", tierCount.toString());
            expect(tierCount).to.be.gte(0);
        } catch (error) {
            console.log("❌ Cannot read tierCount:", error.message);
            throw error;
        }
    });
    
    it("Should access owner from ETour_Storage", async function () {
        try {
            const owner = await game.owner();
            console.log("✅ owner:", owner);
            expect(owner).to.not.equal(hre.ethers.ZeroAddress);
        } catch (error) {
            console.log("❌ Cannot read owner:", error.message);
            throw error;
        }
    });
    
    // NOTE: allInstancesInitialized was removed for gas optimization
    // Initialization is now checked by verifying tier registration
    it("Should verify contract is initialized by checking tiers", async function () {
        const tierCount = await game.tierCount();
        console.log("✅ Contract initialized with", tierCount.toString(), "tiers");
        expect(tierCount).to.be.gt(0);
    });
});
