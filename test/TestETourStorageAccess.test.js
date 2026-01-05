// Test if TicTacChain can access any ETour_Storage variables
import { expect } from "chai";
import hre from "hardhat";

describe("Test ETour_Storage Access", function () {
    let game;
    
    before(async function () {
        const [deployer] = await hre.ethers.getSigners();
        
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
    
    it("Should access allInstancesInitialized from TicTacChain", async function () {
        try {
            const initialized = await game.allInstancesInitialized();
            console.log("✅ allInstancesInitialized:", initialized);
            expect(initialized).to.equal(true);
        } catch (error) {
            console.log("❌ Cannot read allInstancesInitialized:", error.message);
            throw error;
        }
    });
});
