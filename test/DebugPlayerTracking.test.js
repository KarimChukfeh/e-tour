// Debug player tracking module
import { expect } from "chai";
import hre from "hardhat";

describe("Debug Player Tracking", function () {
    let module;
    let deployer, player1;

    before(async function () {
        [deployer, player1] = await hre.ethers.getSigners();

        // Deploy PlayerTrackingModule standalone
        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        module = await PlayerTrackingModule.deploy();
        await module.waitForDeployment();

        console.log("\nModule address:", await module.getAddress());
        console.log("Deployer:", deployer.address);
    });

    it("Should call onPlayerEnrolled directly", async function () {
        try {
            const tx = await module.onPlayerEnrolled(0, 0, player1.address);
            await tx.wait();
            console.log("✅ Direct call succeeded");
        } catch (e) {
            console.log("❌ Direct call failed:", e.message);
            throw e;
        }
    });

    it("Should read player enrolling tournaments", async function () {
        const tournaments = await module.getPlayerEnrollingTournaments(player1.address);
        console.log("Tournaments:", tournaments);
        expect(tournaments.length).to.equal(1);
    });
});
