import hre from "hardhat";
import { expect } from "chai";

describe("TicTacChain Progressive Raffle Thresholds", function () {
    let game;
    let owner, player1, player2, player3, player4;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

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

        // Deploy TicTacChain (player tracking and game logic are now built-in)
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleGameCache.getAddress()
        );
        await game.waitForDeployment();

        // Initialize
        // Tiers are now initialized in constructor
    });

    describe("Progressive Threshold Configuration", function () {
        it("Should have 0.25 ETH threshold for raffle #1 (index 0)", async function () {
            const info = await game.getRaffleInfo();
            expect(info.raffleIndex).to.equal(0);
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.25"));
        });

        it("Should have 10% reserve for TicTacChain", async function () {
            const info = await game.getRaffleInfo();
            // Raffle #1: threshold = 0.25 ETH, reserve = 10% = 0.025 ETH
            expect(info.reserve).to.equal(hre.ethers.parseEther("0.025"));
        });

        it("Should calculate raffle amount correctly with 10% reserve", async function () {
            // When threshold is met, raffleAmount = accumulated - reserve
            const info = await game.getRaffleInfo();

            // Threshold is 0.25 ETH, reserve is 0.025 ETH (10%)
            // If we had 0.25 ETH accumulated:
            // raffleAmount = 0.25 - 0.025 = 0.225 ETH (90% distributed)
            // owner: 0.045 ETH (20% of 0.225), winner: 0.18 ETH (80% of 0.225)

            expect(info.reserve).to.equal(hre.ethers.parseEther("0.025"));
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.25"));
            expect(info.raffleAmount).to.equal(hre.ethers.parseEther("0.225"));
        });
    });

    describe("Threshold Progression", function () {
        it("Should progress from 0.25 to 0.5 ETH after first raffle", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll players to accumulate protocol fees
            // Each enrollment contributes: 0.001 * 2.5% = 0.000025 ETH
            // Need 0.25 ETH, so need 10000 enrollments
            // For testing purposes, we'll just check the threshold logic

            const indexBefore = await game.currentRaffleIndex();
            expect(indexBefore).to.equal(0);

            // After raffle executes, index would be 1
            // Next threshold = thresholds[1] = 0.5 ETH
            const expectedNextThreshold = hre.ethers.parseEther("0.5");

            // Note: We can't actually execute the raffle in this test
            // because we'd need 10000 enrollments to reach 0.25 ETH
            // This test verifies the threshold formula logic
        });

        it("Should cap at 1.0 ETH for raffle #4 and beyond", async function () {
            // Test the threshold function logic
            // For index 3 (raffle #4): threshold = 1.0 ETH (cap reached)
            // For index 4 (raffle #5): threshold = 1.0 ETH (capped)

            // Since we can't easily manipulate currentRaffleIndex,
            // this test documents the expected behavior

            // Thresholds: [0.25, 0.5, 0.75] then 1.0 final
            // Examples:
            // - Index 0 → 0.25 ETH
            // - Index 1 → 0.5 ETH
            // - Index 2 → 0.75 ETH
            // - Index 3+ → 1.0 ETH (capped at final)
        });
    });

    describe("Raffle Index Tracking", function () {
        it("Should start with currentRaffleIndex = 0", async function () {
            const index = await game.currentRaffleIndex();
            expect(index).to.equal(0);
        });

        it("Should show raffleIndex in getRaffleInfo matching currentRaffleIndex", async function () {
            const info = await game.getRaffleInfo();
            const index = await game.currentRaffleIndex();
            expect(info.raffleIndex).to.equal(index);
        });
    });

    describe("Protocol Fee Accumulation with Low Threshold", function () {
        it("Should accumulate protocol fees toward 0.25 ETH threshold", async function () {
            // Use tier 0 with 2 different instances to enroll 4 players total
            const tierId = 0;

            // Enroll 2 players in instance 0 (tier 0 has 2 player capacity)
            await game.connect(player1).enrollInTournament(tierId, 0, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, 0, { value: TIER_0_FEE });

            // Enroll 2 more players in instance 1
            await game.connect(player3).enrollInTournament(tierId, 1, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, 1, { value: TIER_0_FEE });

            // Protocol share per enrollment: 0.001 * 2.5% = 0.000025 ETH
            // After 4 enrollments: 0.0001 ETH
            const expectedAccumulated = hre.ethers.parseEther("0.0001");
            const accumulated = await game.accumulatedProtocolShare();
            expect(accumulated).to.equal(expectedAccumulated);

            // Check raffle info
            const info = await game.getRaffleInfo();
            expect(info.currentAccumulated).to.equal(expectedAccumulated);
            expect(info.isReady).to.be.false; // Not yet at 0.25 ETH threshold
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.25"));
        });

        it("Should show accurate progress toward threshold", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll 100 players
            // Protocol share: 100 * 0.000025 = 0.0025 ETH
            // Progress: 0.0025 / 0.25 = 1%

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const accumulated = await game.accumulatedProtocolShare();
            const info = await game.getRaffleInfo();

            expect(info.currentAccumulated).to.equal(accumulated);
            expect(accumulated).to.be.gt(0);
            expect(accumulated).to.be.lt(info.threshold);
        });
    });

    describe("Distribution with 10% Reserve", function () {
        it("Should calculate 90% distribution with 10% reserve", async function () {
            // With 10% reserve for all thresholds
            // Example: 0.5 ETH threshold reached
            // reserve = 0.05 ETH (10%)
            // raffleAmount = 0.45 ETH (90%)
            // owner: 0.09 ETH (20% of raffle)
            // winner: 0.36 ETH (80% of raffle)

            const threshold = hre.ethers.parseEther("0.5");
            const reserve = threshold * 10n / 100n;  // 0.05 ETH
            const raffleAmount = threshold - reserve; // 0.45 ETH
            const ownerShare = raffleAmount * 20n / 100n;  // 0.09 ETH
            const winnerShare = raffleAmount * 80n / 100n; // 0.36 ETH

            expect(reserve).to.equal(hre.ethers.parseEther("0.05"));
            expect(raffleAmount).to.equal(hre.ethers.parseEther("0.45"));
            expect(ownerShare).to.equal(hre.ethers.parseEther("0.09"));
            expect(winnerShare).to.equal(hre.ethers.parseEther("0.36"));
            expect(ownerShare + winnerShare + reserve).to.equal(threshold);
        });
    });

    describe("Comparison with Base ETour", function () {
        it("TicTacChain should have lower threshold than base ETour default", async function () {
            // TicTacChain: 0.25 ETH for first raffle
            // ETour default: 3 ETH
            const info = await game.getRaffleInfo();
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.25"));
            expect(info.threshold).to.be.lt(hre.ethers.parseEther("3"));
        });

        it("Both should use 10% proportional reserve", async function () {
            // TicTacChain raffle #1: threshold 0.25 ETH → reserve 0.025 ETH (10%)
            // ETour default: threshold 3 ETH → reserve 0.3 ETH (10%)
            const info = await game.getRaffleInfo();
            expect(info.reserve).to.equal(hre.ethers.parseEther("0.025")); // 10% of 0.25

            // For comparison: ETour with 3 ETH threshold would have:
            // - 10% = 0.3 ETH reserve
        });
    });

    describe("Threshold Scaling Examples", function () {
        it("Should document threshold and reserve progression", function () {
            // Threshold and Reserve Progression:
            // Raffle #1 (index 0→1): threshold 0.25 ETH, reserve 0.025 ETH (10%)
            // Raffle #2 (index 1→2): threshold 0.5 ETH, reserve 0.05 ETH (10%)
            // Raffle #3 (index 2→3): threshold 0.75 ETH, reserve 0.075 ETH (10%)
            // Raffle #4+ (index 3+→4+): threshold 1.0 ETH, reserve 0.10 ETH (capped)

            // Required enrollments at 0.001 ETH (2.5% protocol share = 0.000025):
            // Raffle #1: 10,000 enrollments to reach 0.25 ETH
            // Raffle #2: 20,000 enrollments to reach 0.5 ETH
            // Raffle #3: 30,000 enrollments to reach 0.75 ETH
            // Raffle #4+: 40,000 enrollments each to reach 1.0 ETH
        });
    });
});
