// Test calling player tracking getters correctly
import { expect } from "chai";
import hre from "hardhat";

describe("Test Getter Call", function () {
    let game, player1;

    before(async function () {
        [, player1] = await hre.ethers.getSigners();

        // Deploy TicTacChain using standard deployment
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();

        await (await game.initializeAllInstances()).wait();

        console.log("\n✅ Game initialized");
    });
    
    it("Should call getPlayerEnrollingTournaments (returns array)", async function () {
        try {
            const tournaments = await game.getPlayerEnrollingTournaments(player1.address);
            console.log("✅ getPlayerEnrollingTournaments works! Count:", tournaments.length);
            expect(tournaments).to.be.an('array');
        } catch (error) {
            console.log("❌ getPlayerEnrollingTournaments failed:", error.message);
            throw error;
        }
    });
    
    // NOTE: isPlayerInTournament was removed for gas optimization
    // Use isEnrolled() to check enrollment status instead
    it("Should check enrollment via isEnrolled", async function () {
        // Check initial state
        let isEnrolled = await game.isEnrolled(0, 0, player1.address);
        console.log("✅ Initial isEnrolled:", isEnrolled);
        expect(isEnrolled).to.be.false;

        // Enroll player
        const TIER_0_FEE = hre.ethers.parseEther("0.001");
        await game.connect(player1).enrollInTournament(0, 0, { value: TIER_0_FEE });

        // Check after enrollment
        isEnrolled = await game.isEnrolled(0, 0, player1.address);
        console.log("✅ After enrollment isEnrolled:", isEnrolled);
        expect(isEnrolled).to.be.true;
    });
});
