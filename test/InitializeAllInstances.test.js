// test/InitializeAllInstances.test.js
// Test to verify tiers are initialized in constructor

import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain - Constructor Initialization", function () {
    let game;
    let owner;

    before(async function () {
        [owner] = await hre.ethers.getSigners();

        // Deploy TicTacChain - tiers initialized in constructor
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
    });

    it("Should have 3 tiers initialized after deployment", async function () {
        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(3);
    });

    it("Should have valid tier configurations after deployment", async function () {
        const tierCount = await game.tierCount();

        // Verify each tier is properly initialized
        for (let i = 0; i < tierCount; i++) {
            const tournamentInfo = await game.getTournamentInfo(i, 0);
            // Tournament should be in Enrolling status initially
            expect(tournamentInfo[0]).to.equal(0); // TournamentStatus.Enrolling
        }
    });
});
