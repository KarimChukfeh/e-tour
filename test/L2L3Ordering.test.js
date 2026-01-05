import { expect } from "chai";
import hre from "hardhat";

describe("L2/L3 Ordering Test", function() {
    let game, players;
    const TIER_ID = 0;
    const INSTANCE_ID = 0;
    const TIER_FEE = hre.ethers.parseEther("0.001");

    beforeEach(async function() {
        const signers = await hre.ethers.getSigners();
        players = signers.slice(1, 3);

        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy();
        await game.waitForDeployment();
        await game.initializeAllInstances();
    });

    it("Should ensure L3 is NEVER available before L2", async function() {
        this.timeout(120000);

        // Enroll 2 players
        for (const player of players) {
            await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
        }

        // Make one move to start the clock
        const match = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(TIER_ID, INSTANCE_ID, 0, 0, 0);

        // Get timeout config
        const tierConfig = await game.tierConfigs(TIER_ID);
        console.log("Match time per player:", tierConfig.timeouts.matchTimePerPlayer.toString(), "seconds");
        console.log("L2 delay:", tierConfig.timeouts.matchLevel2Delay.toString(), "seconds");
        console.log("L3 delay:", tierConfig.timeouts.matchLevel3Delay.toString(), "seconds");

        // Wait for player timeout
        await hre.network.provider.send("evm_increaseTime", [Number(tierConfig.timeouts.matchTimePerPlayer) + 1]);
        await hre.network.provider.send("evm_mine");

        console.log("\n=== After player timeout ===");
        let l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
        let l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
        console.log("L2 available:", l2);
        console.log("L3 available:", l3);
        expect(l3).to.equal(false, "L3 should NOT be available yet");

        // Wait for L2 delay
        await hre.network.provider.send("evm_increaseTime", [Number(tierConfig.timeouts.matchLevel2Delay) + 1]);
        await hre.network.provider.send("evm_mine");

        console.log("\n=== After L2 delay ===");
        l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
        l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
        console.log("L2 available:", l2);
        console.log("L3 available:", l3);
        expect(l2).to.equal(true, "L2 should be available");
        expect(l3).to.equal(false, "L3 should still NOT be available");

        // Wait for remaining time to L3
        const l3Remaining = Number(tierConfig.timeouts.matchLevel3Delay) - Number(tierConfig.timeouts.matchLevel2Delay);
        await hre.network.provider.send("evm_increaseTime", [l3Remaining + 1]);
        await hre.network.provider.send("evm_mine");

        console.log("\n=== After L3 delay ===");
        l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
        l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
        console.log("L2 available:", l2);
        console.log("L3 available:", l3);
        expect(l2).to.equal(true, "L2 should still be available");
        expect(l3).to.equal(true, "L3 should now be available");
    });

    it("Should BLOCK L3 claim attempt before L2 delay passes", async function() {
        this.timeout(120000);

        // Enroll 2 players
        for (const player of players) {
            await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
        }

        // Make one move
        const match = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(TIER_ID, INSTANCE_ID, 0, 0, 0);

        // Get config
        const tierConfig = await game.tierConfigs(TIER_ID);
        const matchTime = Number(tierConfig.timeouts.matchTimePerPlayer);
        const l2Delay = Number(tierConfig.timeouts.matchLevel2Delay);

        // Wait for timeout but NOT for L2 delay
        await hre.network.provider.send("evm_increaseTime", [matchTime + 10]); // timeout + 10 seconds (L2 needs 60 more)
        await hre.network.provider.send("evm_mine");

        console.log("\n=== Attempting L3 claim BEFORE L2 delay ===");
        const l2 = await game.isMatchEscL2Available(TIER_ID, INSTANCE_ID, 0, 0);
        const l3 = await game.isMatchEscL3Available(TIER_ID, INSTANCE_ID, 0, 0);
        console.log("L2 available:", l2);
        console.log("L3 available:", l3);

        // Get an outsider
        const signers = await hre.ethers.getSigners();
        const outsider = signers[10];

        // Try to claim L3 - should FAIL
        await expect(
            game.connect(outsider).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 0)
        ).to.be.reverted;

        console.log("✓ L3 claim correctly blocked before L2 delay passes");
    });
});
