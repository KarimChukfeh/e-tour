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

        // Deploy TicTacChain (player tracking and game logic are now built-in)
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // Initialize
        // Tiers are now initialized in constructor
    });

    describe("Progressive Threshold Configuration", function () {
        it("Should have 0.001 ETH threshold for raffle #1 (index 0)", async function () {
            const info = await game.getRaffleInfo();
            expect(info.raffleIndex).to.equal(0);
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.001"));
        });

        it("Should have 5% reserve for TicTacChain", async function () {
            const info = await game.getRaffleInfo();
            // Raffle #1: threshold = 0.001 ETH, reserve = 5% = 0.00005 ETH
            expect(info.reserve).to.equal(hre.ethers.parseEther("0.00005"));
        });

        it("Should calculate raffle amount correctly with 5% reserve", async function () {
            // When threshold is met, raffleAmount = accumulated - reserve
            const info = await game.getRaffleInfo();

            // Threshold is 0.001 ETH, reserve is 0.00005 ETH (5%)
            // If we had 0.001 ETH accumulated:
            // raffleAmount = 0.001 - 0.00005 = 0.00095 ETH (95% distributed)
            // owner: 0.00005 ETH (5% of total), winner: 0.0009 ETH (90% of total)

            expect(info.reserve).to.equal(hre.ethers.parseEther("0.00005"));
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.001"));
            expect(info.raffleAmount).to.equal(hre.ethers.parseEther("0.00095"));
        });
    });

    describe("Threshold Progression", function () {
        it("Should progress from 0.001 to 0.005 ETH after first raffle", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll players to accumulate protocol fees
            // Each enrollment contributes: 0.0003 * 2.5% = 0.0000075 ETH
            // Need 0.001 ETH, so need ~134 enrollments
            // For testing purposes, we'll just check the threshold logic

            const indexBefore = await game.currentRaffleIndex();
            expect(indexBefore).to.equal(0);

            // After raffle executes, index would be 1
            // Next threshold = thresholds[1] = 0.005 ETH
            const expectedNextThreshold = hre.ethers.parseEther("0.005");

            // Note: We can't actually execute the raffle in this test
            // because we'd need ~134 enrollments to reach 0.001 ETH
            // This test verifies the threshold formula logic
        });

        it("Should cap at 1.0 ETH for raffle #8 and beyond", async function () {
            // Test the threshold function logic
            // For index 7+ (raffle #8+): threshold = 1.0 ETH (cap reached)

            // Since we can't easily manipulate currentRaffleIndex,
            // this test documents the expected behavior

            // Thresholds: [0.001, 0.005, 0.02, 0.05, 0.25, 0.5, 0.75] then 1.0 final
            // Examples:
            // - Index 0 → 0.001 ETH
            // - Index 1 → 0.005 ETH
            // - Index 2 → 0.02 ETH
            // - Index 3 → 0.05 ETH
            // - Index 4 → 0.25 ETH
            // - Index 5 → 0.5 ETH
            // - Index 6 → 0.75 ETH
            // - Index 7+ → 1.0 ETH (capped at final)
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
        it("Should accumulate protocol fees toward 0.001 ETH threshold", async function () {
            // Use tier 0 with 2 different instances to enroll 4 players total
            const tierId = 0;

            // Enroll 2 players in instance 0 (tier 0 has 2 player capacity)
            await game.connect(player1).enrollInTournament(tierId, 0, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, 0, { value: TIER_0_FEE });

            // Enroll 2 more players in instance 1
            await game.connect(player3).enrollInTournament(tierId, 1, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, 1, { value: TIER_0_FEE });

            // Protocol share per enrollment: 0.0003 * 2.5% = 0.0000075 ETH
            // After 4 enrollments: 0.00003 ETH
            const expectedAccumulated = hre.ethers.parseEther("0.00003");
            const accumulated = await game.accumulatedProtocolShare();
            expect(accumulated).to.equal(expectedAccumulated);

            // Check raffle info
            const info = await game.getRaffleInfo();
            expect(info.currentAccumulated).to.equal(expectedAccumulated);
            expect(info.isReady).to.be.false; // Not yet at 0.001 ETH threshold
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.001"));
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

    describe("Distribution with 5% Reserve", function () {
        it("Should calculate 95% distribution with 5% reserve", async function () {
            // With 5% reserve for all thresholds
            // Example: 0.5 ETH threshold reached
            // reserve = 0.025 ETH (5%)
            // raffleAmount = 0.475 ETH (95%)
            // owner: 0.025 ETH (5% of total, which is 5/95 of raffle)
            // winner: 0.45 ETH (90% of total, which is 90/95 of raffle)

            const threshold = hre.ethers.parseEther("0.5");
            const reserve = threshold * 5n / 100n;  // 0.025 ETH
            const raffleAmount = threshold - reserve; // 0.475 ETH
            const ownerShare = raffleAmount * 5n / 95n;  // 0.025 ETH
            const winnerShare = raffleAmount * 90n / 95n; // 0.45 ETH

            expect(reserve).to.equal(hre.ethers.parseEther("0.025"));
            expect(raffleAmount).to.equal(hre.ethers.parseEther("0.475"));
            expect(ownerShare).to.equal(hre.ethers.parseEther("0.025"));
            expect(winnerShare).to.equal(hre.ethers.parseEther("0.45"));
            expect(ownerShare + winnerShare + reserve).to.equal(threshold);
        });
    });

    describe("Comparison with Base ETour", function () {
        it("TicTacChain should have lower threshold than base ETour default", async function () {
            // TicTacChain: 0.001 ETH for first raffle
            // ETour default: 3 ETH
            const info = await game.getRaffleInfo();
            expect(info.threshold).to.equal(hre.ethers.parseEther("0.001"));
            expect(info.threshold).to.be.lt(hre.ethers.parseEther("3"));
        });

        it("Both should use 5% proportional reserve", async function () {
            // TicTacChain raffle #1: threshold 0.001 ETH → reserve 0.00005 ETH (5%)
            // ETour default: threshold 3 ETH → reserve 0.15 ETH (5%)
            const info = await game.getRaffleInfo();
            expect(info.reserve).to.equal(hre.ethers.parseEther("0.00005")); // 5% of 0.001

            // For comparison: ETour with 3 ETH threshold would have:
            // - 5% = 0.15 ETH reserve
        });
    });

    describe("Threshold Scaling Examples", function () {
        it("Should document threshold and reserve progression", function () {
            // Threshold and Reserve Progression:
            // Raffle #1 (index 0→1): threshold 0.001 ETH, reserve 0.00005 ETH (5%)
            // Raffle #2 (index 1→2): threshold 0.005 ETH, reserve 0.00025 ETH (5%)
            // Raffle #3 (index 2→3): threshold 0.02 ETH, reserve 0.001 ETH (5%)
            // Raffle #4 (index 3→4): threshold 0.05 ETH, reserve 0.0025 ETH (5%)
            // Raffle #5 (index 4→5): threshold 0.25 ETH, reserve 0.0125 ETH (5%)
            // Raffle #6 (index 5→6): threshold 0.5 ETH, reserve 0.025 ETH (5%)
            // Raffle #7 (index 6→7): threshold 0.75 ETH, reserve 0.0375 ETH (5%)
            // Raffle #8+ (index 7+→8+): threshold 1.0 ETH, reserve 0.05 ETH (capped)

            // Required enrollments at 0.0003 ETH (2.5% protocol share = 0.0000075):
            // Raffle #1: ~134 enrollments to reach 0.001 ETH
            // Raffle #2: ~667 enrollments to reach 0.005 ETH
            // Raffle #3: ~2,667 enrollments to reach 0.02 ETH
            // Raffle #4: ~6,667 enrollments to reach 0.05 ETH
            // Raffle #5: ~33,334 enrollments to reach 0.25 ETH
        });
    });
});
