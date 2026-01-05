// Test delegatecall directly
import { expect } from "chai";
import hre from "hardhat";

describe("Test Delegatecall Direct", function () {
    let game, modulePlayerTracking, player1;

    before(async function () {
        [, player1] = await hre.ethers.getSigners();

        // Deploy modules
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
        modulePlayerTracking = await PlayerTrackingModule.deploy();
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

        console.log("\nTicTacChain:", await game.getAddress());
        console.log("PlayerTracking Module:", await modulePlayerTracking.getAddress());

        // Initialize
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("Initialized\n");
    });

    it("Should test delegatecall to onPlayerEnrolled with more gas", async function () {
        const iface = new hre.ethers.Interface([
            "function onPlayerEnrolled(uint8,uint8,address)"
        ]);
        
        const calldata = iface.encodeFunctionData("onPlayerEnrolled", [0, 0, player1.address]);
        
        try {
            // Make a low-level call to test delegatecall
            const tx = await game.runner.sendTransaction({
                to: await game.getAddress(),
                data: calldata,
                gasLimit: 1000000  // Much higher gas
            });
            await tx.wait();
            console.log("✅ Delegatecall succeeded!");
        } catch (error) {
            console.log("❌ Delegatecall failed:", error.message);
            
            // Try calling module directly from game's address
            const code = await hre.ethers.provider.getCode(await modulePlayerTracking.getAddress());
            console.log("Module has code:", code.length > 2);
        }
    });
});
