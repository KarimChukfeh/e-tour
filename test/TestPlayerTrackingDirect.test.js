// Test PlayerTrackingModule directly
import { expect } from "chai";
import hre from "hardhat";

describe("Test PlayerTracking Direct", function () {
    let module, player1;

    before(async function () {
        [, player1] = await hre.ethers.getSigners();

        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        module = await PlayerTrackingModule.deploy();
        await module.waitForDeployment();

        console.log("\nPlayerTrackingModule:", await module.getAddress());
    });

    it("Should call onPlayerEnrolled directly", async function () {
        try {
            const tx = await module.onPlayerEnrolled(0, 0, player1.address);
            await tx.wait();
            console.log("✅ onPlayerEnrolled succeeded!");
        } catch (error) {
            console.log("❌ onPlayerEnrolled failed:", error.message);
            throw error;
        }
    });

    it("Should check player enrolling tournaments", async function () {
        const tournaments = await module.getPlayerEnrollingTournaments(player1.address);
        console.log("Player enrolling tournaments:", tournaments.length);
        expect(tournaments.length).to.equal(1);
    });
});
