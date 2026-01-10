import { expect } from "chai";
import hre from "hardhat";

// NOTE: tierConfigs was removed for gas optimization.
// The timeouts are now hardcoded in the contract.
// Tier 1: 120s match time, 120s L2 delay, 240s L3 delay
describe("L2/L3 Ordering Test", function() {
    let game, players;
    const TIER_ID = 1; // Use tier 1 (4-player) to test L2/L3 escalation
    const INSTANCE_ID = 0;
    const TIER_FEE = hre.ethers.parseEther("0.0007");

    // Hardcoded timeouts for Tier 1
    const MATCH_TIME_PER_PLAYER = 120; // seconds
    const L2_DELAY = 120; // seconds (starts after match timeout)
    const L3_DELAY = 240; // seconds (starts after match timeout)

    beforeEach(async function() {
        const signers = await hre.ethers.getSigners();
        players = signers.slice(1, 5); // Need 4 players for tier 1

        // Deploy modules first
        const ETour_Core = await hre.ethers.getContractFactory("ETour_Core");
        const moduleCore = await ETour_Core.deploy();

        const ETour_Matches = await hre.ethers.getContractFactory("ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();

        const ETour_Prizes = await hre.ethers.getContractFactory("ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();

        const ETour_Raffle = await hre.ethers.getContractFactory("ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();

        const ETour_Escalation = await hre.ethers.getContractFactory("ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();

        // Deploy TicTacChain with module addresses
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();
    });

    it("Should ensure L3 escalation respects L2 -> L3 ordering", async function() {
        this.timeout(120000);

        // Enroll 4 players (creates 2 matches)
        for (const player of players) {
            await game.connect(player).enrollInTournament(TIER_ID, INSTANCE_ID, { value: TIER_FEE });
        }

        // Make one move in match 0 to start the clock
        const match = await game.getMatch(TIER_ID, INSTANCE_ID, 0, 0);
        await game.connect(await hre.ethers.getSigner(match.currentTurn)).makeMove(TIER_ID, INSTANCE_ID, 0, 0, 0);

        console.log("Testing L2/L3 ordering:");
        console.log("- Match time:", MATCH_TIME_PER_PLAYER, "seconds");
        console.log("- L2 delay:", L2_DELAY, "seconds (starts after timeout)");
        console.log("- L3 delay:", L3_DELAY, "seconds (starts after timeout)");

        // Get an outsider who will try to claim via L3
        const signers = await hre.ethers.getSigners();
        const outsider = signers[10];

        // Wait just past timeout but BEFORE L2 delay completes
        // L3 requires L2 delay to have passed first
        await hre.network.provider.send("evm_increaseTime", [MATCH_TIME_PER_PLAYER + (L2_DELAY / 2)]); // Timeout + half L2 delay
        await hre.network.provider.send("evm_mine");

        console.log("\n=== BEFORE L2 delay completes ===");
        // Try L3 claim - should FAIL because L2 delay hasn't passed yet
        await expect(
            game.connect(outsider).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 0)
        ).to.be.reverted;
        console.log("✓ L3 claim correctly blocked before L2 delay passes");

        // Now wait for L3 delay to complete (which is > L2 delay)
        await hre.network.provider.send("evm_increaseTime", [L3_DELAY - (L2_DELAY / 2) + 1]);
        await hre.network.provider.send("evm_mine");

        console.log("\n=== AFTER L3 delay completes ===");
        // Try L3 claim again - should SUCCEED now
        await expect(
            game.connect(outsider).claimMatchSlotByReplacement(TIER_ID, INSTANCE_ID, 0, 0)
        ).to.not.be.reverted;
        console.log("✓ L3 claim succeeds after L3 delay passes");
    });
});
