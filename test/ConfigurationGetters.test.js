import { expect } from "chai";
import hre from "hardhat";

describe("Configuration Getter Functions", function() {
    let connectFour, chess, ticTac;

    beforeEach(async function() {
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");

        connectFour = await ConnectFourOnChain.deploy();
        await connectFour.waitForDeployment();

        chess = await ChessOnChain.deploy();
        await chess.waitForDeployment();

        ticTac = await TicTacChain.deploy();
        await ticTac.waitForDeployment();
    });

    describe("Game Metadata", function() {
        it("Should return correct metadata for ConnectFourOnChain", async function() {
            const [name, version, description] = await connectFour.getGameMetadata();
            expect(name).to.equal("ConnectFourOnChain");
            expect(version).to.equal("1.0.0");
            expect(description).to.include("Connect Four");
        });

        it("Should return correct metadata for ChessOnChain", async function() {
            const [name, version, description] = await chess.getGameMetadata();
            expect(name).to.equal("ChessOnChain");
            expect(version).to.equal("1.0.0");
            expect(description).to.include("chess");
        });

        it("Should return correct metadata for TicTacChain", async function() {
            const [name, version, description] = await ticTac.getGameMetadata();
            expect(name).to.equal("TicTacChain");
            expect(version).to.equal("1.0.0");
            expect(description).to.include("TicTacToe");
        });
    });

    describe("Tier Count", function() {
        it("Should return correct tier count for ConnectFour (4 tiers)", async function() {
            const tierCount = await connectFour.tierCount();
            expect(tierCount).to.equal(4);
        });

        it("Should return correct tier count for Chess (2 tiers)", async function() {
            const tierCount = await chess.tierCount();
            expect(tierCount).to.equal(2);
        });

        it("Should return correct tier count for TicTacToe (3 tiers)", async function() {
            const tierCount = await ticTac.tierCount();
            expect(tierCount).to.equal(3);
        });
    });

    describe("Get All Tier IDs", function() {
        it("Should return all tier IDs for ConnectFour", async function() {
            const tierIds = await connectFour.getAllTierIds();
            expect(tierIds.length).to.equal(4);
            expect(tierIds[0]).to.equal(0);
            expect(tierIds[1]).to.equal(1);
            expect(tierIds[2]).to.equal(2);
            expect(tierIds[3]).to.equal(3);
        });

        it("Should return all tier IDs for Chess", async function() {
            const tierIds = await chess.getAllTierIds();
            expect(tierIds.length).to.equal(2);
            expect(tierIds[0]).to.equal(0);
            expect(tierIds[1]).to.equal(1);
        });

        it("Should return all tier IDs for TicTacToe", async function() {
            const tierIds = await ticTac.getAllTierIds();
            expect(tierIds.length).to.equal(3);
            expect(tierIds[0]).to.equal(0);
            expect(tierIds[1]).to.equal(1);
            expect(tierIds[2]).to.equal(2);
        });
    });

    describe("Get Tier Info", function() {
        it("Should return correct tier 0 info for ConnectFour", async function() {
            const [playerCount, instanceCount, entryFee] = await connectFour.getTierInfo(0);
            expect(playerCount).to.equal(2);
            expect(instanceCount).to.equal(100);
            expect(entryFee).to.equal(hre.ethers.parseEther("0.002"));
        });

        it("Should return correct tier 1 info for ConnectFour", async function() {
            const [playerCount, instanceCount, entryFee] = await connectFour.getTierInfo(1);
            expect(playerCount).to.equal(4);
            expect(instanceCount).to.equal(50);
            expect(entryFee).to.equal(hre.ethers.parseEther("0.004"));
        });

        it("Should return correct tier 2 info for ConnectFour", async function() {
            const [playerCount, instanceCount, entryFee] = await connectFour.getTierInfo(2);
            expect(playerCount).to.equal(8);
            expect(instanceCount).to.equal(30);
            expect(entryFee).to.equal(hre.ethers.parseEther("0.008"));
        });

        it("Should return correct tier 3 info for ConnectFour", async function() {
            const [playerCount, instanceCount, entryFee] = await connectFour.getTierInfo(3);
            expect(playerCount).to.equal(16);
            expect(instanceCount).to.equal(20);
            expect(entryFee).to.equal(hre.ethers.parseEther("0.01"));
        });
    });

    describe("Get Tier Timeouts", function() {
        it("Should return correct timeout configuration for ConnectFour tier 0", async function() {
            const [
                matchTimePerPlayer,
                timeIncrementPerMove,
                matchLevel2Delay,
                matchLevel3Delay,
                enrollmentWindow,
                enrollmentLevel2Delay
            ] = await connectFour.getTierTimeouts(0);

            expect(matchTimePerPlayer).to.equal(300); // 5 minutes
            expect(timeIncrementPerMove).to.equal(15); // 15 seconds
            expect(matchLevel2Delay).to.equal(120); // 2 minutes
            expect(matchLevel3Delay).to.equal(240); // 4 minutes
            expect(enrollmentWindow).to.equal(300); // 5 minutes
            expect(enrollmentLevel2Delay).to.equal(120); // 2 minutes
        });

        it("Should return correct timeout configuration for ConnectFour tier 3", async function() {
            const [
                matchTimePerPlayer,
                timeIncrementPerMove,
                matchLevel2Delay,
                matchLevel3Delay,
                enrollmentWindow,
                enrollmentLevel2Delay
            ] = await connectFour.getTierTimeouts(3);

            expect(matchTimePerPlayer).to.equal(300); // 5 minutes
            expect(timeIncrementPerMove).to.equal(15); // 15 seconds
            expect(matchLevel2Delay).to.equal(120); // 2 minutes
            expect(matchLevel3Delay).to.equal(240); // 4 minutes
            expect(enrollmentWindow).to.equal(1200); // 20 minutes
            expect(enrollmentLevel2Delay).to.equal(120); // 2 minutes
        });
    });

    describe("Get Tier Configuration (Complete)", function() {
        it("Should return complete configuration for ConnectFour tier 0", async function() {
            const config = await connectFour.getTierConfiguration(0);

            expect(config.playerCount).to.equal(2);
            expect(config.instanceCount).to.equal(100);
            expect(config.entryFee).to.equal(hre.ethers.parseEther("0.002"));
            expect(config.matchTimePerPlayer).to.equal(300);
            expect(config.timeIncrementPerMove).to.equal(15);
            expect(config.matchLevel2Delay).to.equal(120);
            expect(config.matchLevel3Delay).to.equal(240);
            expect(config.enrollmentWindow).to.equal(300);
            expect(config.enrollmentLevel2Delay).to.equal(120);
            expect(config.prizeDistribution.length).to.equal(2);
            expect(config.prizeDistribution[0]).to.equal(100);
            expect(config.prizeDistribution[1]).to.equal(0);
        });

        it("Should return complete configuration for ConnectFour tier 2", async function() {
            const config = await connectFour.getTierConfiguration(2);

            expect(config.playerCount).to.equal(8);
            expect(config.instanceCount).to.equal(30);
            expect(config.entryFee).to.equal(hre.ethers.parseEther("0.008"));
            expect(config.prizeDistribution.length).to.equal(8);
            expect(config.prizeDistribution[0]).to.equal(80); // 80%
            expect(config.prizeDistribution[1]).to.equal(20); // 20%
            expect(config.prizeDistribution[2]).to.equal(0);
        });
    });

    describe("Get Tier Capacity", function() {
        it("Should calculate correct capacity for ConnectFour tier 0", async function() {
            const capacity = await connectFour.getTierCapacity(0);
            expect(capacity).to.equal(200); // 2 players * 100 instances
        });

        it("Should calculate correct capacity for ConnectFour tier 3", async function() {
            const capacity = await connectFour.getTierCapacity(3);
            expect(capacity).to.equal(320); // 16 players * 20 instances
        });
    });

    describe("Get Total Capacity", function() {
        it("Should calculate correct total capacity for ConnectFour", async function() {
            const totalCapacity = await connectFour.getTotalCapacity();
            // Tier 0: 2 * 100 = 200
            // Tier 1: 4 * 50 = 200
            // Tier 2: 8 * 30 = 240
            // Tier 3: 16 * 20 = 320
            // Total: 960
            expect(totalCapacity).to.equal(960);
        });

        it("Should calculate correct total capacity for Chess", async function() {
            const totalCapacity = await chess.getTotalCapacity();
            // Tier 0: 2 * 100 = 200
            // Tier 1: 4 * 50 = 200
            // Total: 400
            expect(totalCapacity).to.equal(400);
        });

        it("Should calculate correct total capacity for TicTacToe", async function() {
            const totalCapacity = await ticTac.getTotalCapacity();
            // Tier 0: 2 * 100 = 200
            // Tier 1: 4 * 40 = 160
            // Tier 2: 8 * 20 = 160
            // Total: 520
            expect(totalCapacity).to.equal(520);
        });
    });

    describe("Get Fee Distribution", function() {
        it("Should return correct fee distribution percentages", async function() {
            const [prizePool, owner, protocol, basisPoints] = await connectFour.getFeeDistribution();

            expect(prizePool).to.equal(9000); // 90%
            expect(owner).to.equal(750); // 7.5%
            expect(protocol).to.equal(250); // 2.5%
            expect(basisPoints).to.equal(10000); // 100%

            // Verify they sum to 100%
            expect(prizePool + owner + protocol).to.equal(basisPoints);
        });
    });

    describe("Get Raffle Configuration", function() {
        it("Should return correct raffle configuration for current raffle", async function() {
            const [threshold, reserve, ownerPercent, winnerPercent] = await connectFour.getRaffleConfiguration();

            // Current raffle index is 0, so threshold should be 0.2 ETH (first in array)
            expect(threshold).to.equal(hre.ethers.parseEther("0.2")); // 0.2 ETH threshold
            expect(reserve).to.equal(hre.ethers.parseEther("0.02")); // 10% of 0.2 ETH = 0.02 ETH
            expect(ownerPercent).to.equal(20); // 20%
            expect(winnerPercent).to.equal(80); // 80%

            // Verify percentages sum to 100%
            expect(ownerPercent + winnerPercent).to.equal(100);
        });

        it("Should return complete raffle threshold configuration", async function() {
            const [thresholds, finalThreshold, currentThreshold] = await connectFour.getRaffleThresholds();

            // Should have 5 configured thresholds
            expect(thresholds.length).to.equal(5);
            expect(thresholds[0]).to.equal(hre.ethers.parseEther("0.2"));
            expect(thresholds[1]).to.equal(hre.ethers.parseEther("0.4"));
            expect(thresholds[2]).to.equal(hre.ethers.parseEther("0.6"));
            expect(thresholds[3]).to.equal(hre.ethers.parseEther("0.8"));
            expect(thresholds[4]).to.equal(hre.ethers.parseEther("1.0"));

            // Final threshold (after array exhausted) should be 1.0 ETH
            expect(finalThreshold).to.equal(hre.ethers.parseEther("1.0"));

            // Current threshold should match first threshold (index 0)
            expect(currentThreshold).to.equal(hre.ethers.parseEther("0.2"));
        });

        it("Should return same configuration for all three games", async function() {
            const [cfThresholds, cfFinal] = await connectFour.getRaffleThresholds();
            const [chessThresholds, chessFinal] = await chess.getRaffleThresholds();
            const [ttThresholds, ttFinal] = await ticTac.getRaffleThresholds();

            // All games should have the same raffle configuration
            expect(cfThresholds.length).to.equal(5);
            expect(chessThresholds.length).to.equal(5);
            expect(ttThresholds.length).to.equal(5);

            expect(cfFinal).to.equal(hre.ethers.parseEther("1.0"));
            expect(chessFinal).to.equal(hre.ethers.parseEther("1.0"));
            expect(ttFinal).to.equal(hre.ethers.parseEther("1.0"));

            // Verify first and last thresholds match
            expect(cfThresholds[0]).to.equal(hre.ethers.parseEther("0.2"));
            expect(cfThresholds[4]).to.equal(hre.ethers.parseEther("1.0"));
        });
    });

    describe("Error Handling", function() {
        it("Should revert when getting info for invalid tier", async function() {
            await expect(
                connectFour.getTierInfo(99)
            ).to.be.revertedWith("Invalid tier");
        });

        it("Should revert when getting timeouts for invalid tier", async function() {
            await expect(
                connectFour.getTierTimeouts(99)
            ).to.be.revertedWith("Invalid tier");
        });

        it("Should revert when getting configuration for invalid tier", async function() {
            await expect(
                connectFour.getTierConfiguration(99)
            ).to.be.revertedWith("Invalid tier");
        });

        it("Should revert when getting capacity for invalid tier", async function() {
            await expect(
                connectFour.getTierCapacity(99)
            ).to.be.revertedWith("Invalid tier");
        });
    });
});
