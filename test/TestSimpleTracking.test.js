// Simplest possible test of player tracking
import { expect } from "chai";
import hre from "hardhat";

describe("Test Simple Tracking", function () {
    it("Should test that player tracking storage exists in game contract", async function () {
        const [, player1] = await hre.ethers.getSigners();
        
        // Deploy minimal modules
        const ETour_Core = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
        const moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        const GameCacheModule = await hre.ethers.getContractFactory("contracts/modules/GameCacheModule.sol:GameCacheModule");
        const moduleGameCache = await GameCacheModule.deploy();
        await moduleGameCache.waitForDeployment();

        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        const modulePlayerTracking = await PlayerTrackingModule.deploy();
        await modulePlayerTracking.waitForDeployment();

        const TicTacToeGameModule = await hre.ethers.getContractFactory("contracts/modules/TicTacToeGameModule.sol:TicTacToeGameModule");
        const moduleTicTacToeGame = await TicTacToeGameModule.deploy();
        await moduleTicTacToeGame.waitForDeployment();

        // Deploy TicTacChain
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        const game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress(),
            await modulePlayerTracking.getAddress(),
            await moduleTicTacToeGame.getAddress()
        );
        await game.waitForDeployment();

        // Initialize
        await (await game.initializeAllInstances()).wait();
        
        console.log("\n✅ Game deployed and initialized");
        console.log("Game address:", await game.getAddress());
        console.log("MODULE_PLAYER_TRACKING:", await game.MODULE_PLAYER_TRACKING());
        
        // Try to read player enrolling tournaments directly (should work even if empty)
        try {
            // This calls the public getter on the game contract
            const tournaments = await game.playerEnrollingTournaments(player1.address, 0);
            console.log("✅ Can read playerEnrollingTournaments from game");
            console.log("   Result:", tournaments);
        } catch (error) {
            console.log("❌ Cannot read playerEnrollingTournaments:", error.message);
        }
    });
});
