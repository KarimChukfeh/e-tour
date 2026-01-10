import hre from "hardhat";
import { expect } from "chai";

describe("Enrollment Debug Test", function () {
    let game;
    let player1;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [player1] = await hre.ethers.getSigners();

        // Deploy all ETour modules
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
        
        console.log("Contract deployed successfully");
        const tierCount = await game.tierCount();
        console.log("Tier count:", tierCount.toString());
    });

    it("Should enroll player in tier 0", async function () {
        console.log("Attempting to enroll with fee:", TIER_0_FEE.toString());
        await game.connect(player1).enrollInTournament(0, 0, { value: TIER_0_FEE });
        console.log("Enrollment successful!");
    });
});
