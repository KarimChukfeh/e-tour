// Test calling player tracking getters correctly
import { expect } from "chai";
import hre from "hardhat";

describe("Test Getter Call", function () {
    let game, player1;
    
    before(async function () {
        [, player1] = await hre.ethers.getSigners();
        
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
        game = await TicTacChain.deploy(
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
    
    it("Should call isPlayerInTournament", async function () {
        try {
            const [isEnrolling, isActive] = await game.isPlayerInTournament(player1.address, 0, 0);
            console.log("✅ isPlayerInTournament works! enrolling:", isEnrolling, "active:", isActive);
        } catch (error) {
            console.log("❌ isPlayerInTournament failed:", error.message);
            throw error;
        }
    });
});
