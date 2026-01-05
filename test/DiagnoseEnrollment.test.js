// test/DiagnoseEnrollment.test.js
// Diagnostic test to identify enrollment failure

import { expect } from "chai";
import hre from "hardhat";

describe("Diagnose Enrollment Failure", function () {
    let game, modules;
    let owner, player1;

    before(async function () {
        [owner, player1] = await hre.ethers.getSigners();

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
        const modulePlayerTracking = await PlayerTrackingModule.deploy();
        await modulePlayerTracking.waitForDeployment();

        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        const moduleChessRules = await ChessRulesModule.deploy();
        await moduleChessRules.waitForDeployment();

        modules = {
            core: await moduleCore.getAddress(),
            matches: await moduleMatches.getAddress(),
            prizes: await modulePrizes.getAddress(),
            raffle: await moduleRaffle.getAddress(),
            escalation: await moduleEscalation.getAddress(),
            gameCache: await moduleGameCache.getAddress(),
            playerTracking: await modulePlayerTracking.getAddress(),
            chessRules: await moduleChessRules.getAddress()
        };

        console.log("\n=== Module Addresses ===");
        console.log("PlayerTracking:", modules.playerTracking);
        console.log("Core:", modules.core);

        // Deploy ChessOnChain
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        game = await ChessOnChain.deploy(
            modules.core,
            modules.matches,
            modules.prizes,
            modules.raffle,
            modules.escalation,
            modules.gameCache,
            modules.chessRules,
            modules.playerTracking
        );
        await game.waitForDeployment();

        console.log("ChessOnChain:", await game.getAddress());

        // Initialize
        const initTx = await game.initializeAllInstances();
        await initTx.wait();
        console.log("Initialized successfully\n");
    });

    it("Should have allInstancesInitialized = true", async function () {
        const initialized = await game.allInstancesInitialized();
        expect(initialized).to.be.true;
    });

    it("Should have 2 tiers", async function () {
        const tierCount = await game.tierCount();
        expect(tierCount).to.equal(2);
    });

    it("Should have correct tier 0 config", async function () {
        const tier0 = await game.getTierInfo(0);
        expect(tier0.playerCount).to.equal(2);
        expect(tier0.instanceCount).to.equal(100);
        expect(tier0.entryFee).to.equal(hre.ethers.parseEther("0.01"));
    });

    it("Should allow enrollment WITHOUT revert", async function () {
        this.timeout(30000);
        const entryFee = hre.ethers.parseEther("0.01");

        console.log("\n=== Attempting Enrollment ===");
        console.log("Player:", player1.address);
        console.log("Entry Fee:", hre.ethers.formatEther(entryFee), "ETH");
        console.log("Tier: 0, Instance: 0");

        try {
            // Try enrollment with explicit gas limit
            const tx = await game.connect(player1).enrollInTournament(0, 0, {
                value: entryFee,
                gasLimit: 500000
            });
            console.log("Transaction sent:", tx.hash);

            const receipt = await tx.wait();
            console.log("Transaction mined!");
            console.log("Gas used:", receipt.gasUsed.toString());
            console.log("Status:", receipt.status);
            console.log("Logs:", receipt.logs.length);

            expect(receipt.status).to.equal(1);
        } catch (error) {
            console.error("\n=== ENROLLMENT FAILED ===");
            console.error("Error type:", error.code);
            console.error("Error message:", error.message);
            if (error.receipt) {
                console.error("Receipt status:", error.receipt.status);
                console.error("Gas used:", error.receipt.gasUsed.toString());
            }
            throw error;
        }
    });
});
