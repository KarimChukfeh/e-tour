// Debug storage layout alignment
import { expect } from "chai";
import hre from "hardhat";

describe("Debug Storage Layout", function () {
    let game, modulePlayerTracking;
    let deployer, player1;

    before(async function () {
        [deployer, player1] = await hre.ethers.getSigners();

        // Deploy all modules
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

        console.log("\n=== Addresses ===");
        console.log("TicTacChain:", await game.getAddress());
        console.log("PlayerTracking Module:", await modulePlayerTracking.getAddress());
        console.log("MODULE_PLAYER_TRACKING in game:", await game.MODULE_PLAYER_TRACKING());

        // Initialize
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("Initialized\n");
    });

    it("Should verify MODULE_PLAYER_TRACKING is set correctly", async function () {
        const moduleAddr = await game.MODULE_PLAYER_TRACKING();
        console.log("MODULE_PLAYER_TRACKING:", moduleAddr);
        expect(moduleAddr).to.not.equal(hre.ethers.ZeroAddress);
        expect(moduleAddr).to.equal(await modulePlayerTracking.getAddress());
    });

    it("Should check if delegatecall works with simple data", async function () {
        // Try to manually trigger the delegatecall via low-level
        const iface = new hre.ethers.Interface([
            "function onPlayerEnrolled(uint8,uint8,address)"
        ]);
        const calldata = iface.encodeFunctionData("onPlayerEnrolled", [0, 0, player1.address]);

        console.log("Calldata:", calldata);
        console.log("Target:", await game.MODULE_PLAYER_TRACKING());
    });

    it("Should attempt enrollment and capture error", async function () {
        const entryFee = hre.ethers.parseEther("0.001");

        try {
            const tx = await game.connect(player1).enrollInTournament(0, 0, { value: entryFee, gasLimit: 500000 });
            await tx.wait();
            console.log("✅ Enrollment succeeded!");
        } catch (error) {
            console.log("\n❌ Enrollment failed");
            console.log("Error:", error.message);

            // Try to get revert reason
            if (error.data) {
                console.log("Error data:", error.data);
            }

            throw error;
        }
    });
});
