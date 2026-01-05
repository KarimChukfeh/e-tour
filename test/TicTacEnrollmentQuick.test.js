// Quick TicTacChain enrollment test
import { expect } from "chai";
import hre from "hardhat";

describe("TicTacChain Enrollment Quick Test", function () {
    let game, player1, player2;

    before(async function () {
        [, player1, player2] = await hre.ethers.getSigners();

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

        console.log("\nTicTacChain:", await game.getAddress());

        // Initialize
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("Initialized\n");
    });

    it("Should enroll player1", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const tx = await game.connect(player1).enrollInTournament(0, 0, { value: entryFee, gasLimit: 500000 });
        const receipt = await tx.wait();
        console.log("✅ Player1 enrolled! Gas:", receipt.gasUsed.toString());
        expect(receipt.status).to.equal(1);
    });

    it("Should enroll player2 and start", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const tx = await game.connect(player2).enrollInTournament(0, 0, { value: entryFee, gasLimit: 500000 });
        const receipt = await tx.wait();
        console.log("✅ Player2 enrolled! Gas:", receipt.gasUsed.toString());
        expect(receipt.status).to.equal(1);
    });
});
