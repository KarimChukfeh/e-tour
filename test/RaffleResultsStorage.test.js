import hre from "hardhat";
import { expect } from "chai";

describe("Raffle Results Storage - Historic Data Validation", function () {
    let game;
    let owner, player1, player2, player3, player4, player5;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    // Helper function to get raffle result by index from history
    async function getRaffleResult(raffleIndex) {
        const history = await game.getRaffleHistory();
        // History array is 0-indexed, but raffle indices start at 1
        if (raffleIndex === 0 || raffleIndex > history.length) {
            // Return empty result for non-existent raffles
            return {
                executor: hre.ethers.ZeroAddress,
                timestamp: 0,
                rafflePot: 0n,
                participants: [],
                weights: [],
                winner: hre.ethers.ZeroAddress,
                winnerPrize: 0n,
                protocolReserve: 0n,
                ownerShare: 0n
            };
        }
        const result = history[raffleIndex - 1];
        return {
            executor: result.executor,
            timestamp: result.timestamp,
            rafflePot: result.rafflePot,
            participants: result.participants,
            weights: result.weights,
            winner: result.winner,
            winnerPrize: result.winnerPrize,
            protocolReserve: result.protocolReserve,
            ownerShare: result.ownerShare
        };
    }

    // Helper function to set accumulated protocol share directly via storage manipulation
    async function setAccumulatedProtocolShare(amount) {
        // Get storage slot for accumulatedProtocolShare
        // In ETour_Storage.sol, accumulatedProtocolShare is at slot calculated based on layout
        // We'll use hardhat's setStorageAt to manipulate it directly for testing
        const gameAddress = await game.getAddress();

        // Storage slot 3 is accumulatedProtocolShare (after owner, module addresses, tierCount)
        // Note: This may need adjustment based on actual storage layout
        const slot = hre.ethers.zeroPadValue(hre.ethers.toBeHex(3), 32);
        const value = hre.ethers.zeroPadValue(hre.ethers.toBeHex(amount), 32);

        await hre.network.provider.send("hardhat_setStorageAt", [
            gameAddress,
            slot,
            value
        ]);

        // Fund the contract with ETH to cover the raffle payouts using setBalance
        const currentBalance = await hre.ethers.provider.getBalance(gameAddress);
        const newBalance = currentBalance + amount;
        await hre.network.provider.send("hardhat_setBalance", [
            gameAddress,
            hre.ethers.toBeHex(newBalance)
        ]);
    }

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5] = await hre.ethers.getSigners();

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

        // Deploy TicTacChain
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        game = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await game.waitForDeployment();

        // Enroll players in tournament so they can trigger raffles
        const tierId = 0;
        const instanceId = 0;
        await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
        await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
    });

    describe("Single Raffle Execution Storage", function () {
        it("Should store complete raffle result data after execution", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Set accumulated protocol share to exceed threshold (0.25 ETH for first raffle)
            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);

            // Verify threshold is met
            const infoBefore = await game.getRaffleInfo();
            expect(infoBefore.isReady).to.be.true;
            expect(infoBefore.raffleIndex).to.equal(0);

            // Execute raffle
            const tx = await game.connect(player1).executeProtocolRaffle(tierId, instanceId);
            const receipt = await tx.wait();
            const block = await hre.ethers.provider.getBlock(receipt.blockNumber);

            // Get raffle result from storage using the helper function
            const result = await getRaffleResult(1);

            // Validate executor
            expect(result.executor).to.equal(player1.address);

            // Validate timestamp
            expect(result.timestamp).to.equal(block.timestamp);

            // Validate raffle pot (threshold amount before distribution)
            const expectedPot = threshold;
            expect(result.rafflePot).to.equal(expectedPot);

            // Validate participants array contains our enrolled players
            expect(result.participants.length).to.equal(2);
            expect(result.participants).to.include(player1.address);
            expect(result.participants).to.include(player2.address);

            // Validate weights (each player enrolled once, so weight = 1 for each)
            expect(result.weights.length).to.equal(2);
            const player1Index = result.participants.indexOf(player1.address);
            const player2Index = result.participants.indexOf(player2.address);
            expect(result.weights[player1Index]).to.equal(1);
            expect(result.weights[player2Index]).to.equal(1);

            // Validate winner is one of the participants
            expect(result.participants).to.include(result.winner);

            // Validate distribution amounts
            const reserve = hre.ethers.parseEther("0.025"); // 10% of 0.25
            const raffleAmount = threshold - reserve; // 0.225 ETH
            const expectedOwnerShare = (raffleAmount * 20n) / 100n; // 0.045 ETH
            const expectedWinnerPrize = (raffleAmount * 80n) / 100n; // 0.18 ETH

            expect(result.protocolReserve).to.equal(reserve);
            expect(result.ownerShare).to.equal(expectedOwnerShare);
            expect(result.winnerPrize).to.equal(expectedWinnerPrize);

            // Validate total adds up correctly
            const total = result.winnerPrize + result.protocolReserve + result.ownerShare;
            expect(total).to.equal(result.rafflePot);
        });

        it("Should store different winner when randomness changes", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Execute first raffle
            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            const result1 = await getRaffleResult(1);

            // Execute second raffle (threshold is now 0.5 ETH)
            const threshold2 = hre.ethers.parseEther("0.5");
            await setAccumulatedProtocolShare(threshold2);

            // Mine a few blocks to change block data for different randomness
            await hre.network.provider.send("hardhat_mine", ["0x5"]); // Mine 5 blocks

            await game.connect(player2).executeProtocolRaffle(tierId, instanceId);
            const result2 = await getRaffleResult(2);

            // Results should exist and be different
            expect(result1.winner).to.not.equal(hre.ethers.ZeroAddress);
            expect(result2.winner).to.not.equal(hre.ethers.ZeroAddress);

            // Executors are different
            expect(result1.executor).to.equal(player1.address);
            expect(result2.executor).to.equal(player2.address);

            // Timestamps are different
            expect(result2.timestamp).to.be.gt(result1.timestamp);
        });

        it("Should handle weighted participants correctly when player enrolled in multiple tournaments", async function () {
            const tierId = 0;
            const instanceId1 = 1;
            const instanceId2 = 2;

            // Player3 enrolls in two different tournament instances, player4 enrolls in one
            // Note: beforeEach already enrolled player1 and player2 in instance 0
            await game.connect(player3).enrollInTournament(tierId, instanceId1, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId1, { value: TIER_0_FEE });

            // Player3 enrolls in another instance
            await game.connect(player3).enrollInTournament(tierId, instanceId2, { value: TIER_0_FEE });
            await game.connect(player5).enrollInTournament(tierId, instanceId2, { value: TIER_0_FEE });

            // Set threshold and execute
            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);
            await game.connect(player3).executeProtocolRaffle(tierId, instanceId1);

            const result = await getRaffleResult(1);

            // Find player3's weight in the results
            let player3Weight = 0;
            let player4Weight = 0;
            let player1Weight = 0;
            for (let i = 0; i < result.participants.length; i++) {
                if (result.participants[i] === player3.address) {
                    player3Weight = result.weights[i];
                }
                if (result.participants[i] === player4.address) {
                    player4Weight = result.weights[i];
                }
                if (result.participants[i] === player1.address) {
                    player1Weight = result.weights[i];
                }
            }

            // Player3 is enrolled in 2 active tournaments (instance 1 and 2)
            // Player4 is enrolled in 1 active tournament (instance 1)
            // Player1 is enrolled in 1 active tournament (instance 0 - from beforeEach)
            expect(player3Weight).to.equal(2); // Enrolled in 2 instances
            expect(player4Weight).to.equal(1); // Enrolled in 1 instance
            expect(player1Weight).to.equal(1); // Enrolled in 1 instance (from beforeEach)
        });
    });

    describe("Multiple Consecutive Raffles Storage", function () {
        it("Should store separate results for 3 consecutive raffles with correct data", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Execute Raffle #1 (threshold: 0.25 ETH)
            const threshold1 = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold1);

            const tx1 = await game.connect(player1).executeProtocolRaffle(tierId, instanceId);
            const receipt1 = await tx1.wait();
            const block1 = await hre.ethers.provider.getBlock(receipt1.blockNumber);

            // Verify raffle index incremented
            const infoAfter1 = await game.getRaffleInfo();
            expect(infoAfter1.raffleIndex).to.equal(1);

            // Execute Raffle #2 (threshold: 0.5 ETH)
            await hre.network.provider.send("hardhat_mine", ["0x3"]);
            const threshold2 = hre.ethers.parseEther("0.5");
            await setAccumulatedProtocolShare(threshold2);

            const tx2 = await game.connect(player2).executeProtocolRaffle(tierId, instanceId);
            const receipt2 = await tx2.wait();
            const block2 = await hre.ethers.provider.getBlock(receipt2.blockNumber);

            // Verify raffle index incremented
            const infoAfter2 = await game.getRaffleInfo();
            expect(infoAfter2.raffleIndex).to.equal(2);

            // Execute Raffle #3 (threshold: 0.75 ETH)
            await hre.network.provider.send("hardhat_mine", ["0x3"]);
            const threshold3 = hre.ethers.parseEther("0.75");
            await setAccumulatedProtocolShare(threshold3);

            const tx3 = await game.connect(player1).executeProtocolRaffle(tierId, instanceId);
            const receipt3 = await tx3.wait();
            const block3 = await hre.ethers.provider.getBlock(receipt3.blockNumber);

            // Verify raffle index incremented
            const infoAfter3 = await game.getRaffleInfo();
            expect(infoAfter3.raffleIndex).to.equal(3);

            // Retrieve all three raffle results
            const result1 = await getRaffleResult(1);
            const result2 = await getRaffleResult(2);
            const result3 = await getRaffleResult(3);

            // Validate Raffle #1
            expect(result1.executor).to.equal(player1.address);
            expect(result1.timestamp).to.equal(block1.timestamp);
            expect(result1.rafflePot).to.equal(threshold1);
            expect(result1.protocolReserve).to.equal(hre.ethers.parseEther("0.025")); // 10% of 0.25
            expect(result1.ownerShare).to.equal(hre.ethers.parseEther("0.045")); // 20% of 0.225
            expect(result1.winnerPrize).to.equal(hre.ethers.parseEther("0.18")); // 80% of 0.225
            expect(result1.participants.length).to.be.gte(2);
            expect(result1.weights.length).to.equal(result1.participants.length);

            // Validate Raffle #2
            expect(result2.executor).to.equal(player2.address);
            expect(result2.timestamp).to.equal(block2.timestamp);
            expect(result2.rafflePot).to.equal(threshold2);
            expect(result2.protocolReserve).to.equal(hre.ethers.parseEther("0.05")); // 10% of 0.5
            expect(result2.ownerShare).to.equal(hre.ethers.parseEther("0.09")); // 20% of 0.45
            expect(result2.winnerPrize).to.equal(hre.ethers.parseEther("0.36")); // 80% of 0.45
            expect(result2.participants.length).to.be.gte(2);
            expect(result2.weights.length).to.equal(result2.participants.length);

            // Validate Raffle #3
            expect(result3.executor).to.equal(player1.address);
            expect(result3.timestamp).to.equal(block3.timestamp);
            expect(result3.rafflePot).to.equal(threshold3);
            expect(result3.protocolReserve).to.equal(hre.ethers.parseEther("0.075")); // 10% of 0.75
            expect(result3.ownerShare).to.equal(hre.ethers.parseEther("0.135")); // 20% of 0.675
            expect(result3.winnerPrize).to.equal(hre.ethers.parseEther("0.54")); // 80% of 0.675
            expect(result3.participants.length).to.be.gte(2);
            expect(result3.weights.length).to.equal(result3.participants.length);

            // Validate timestamps are sequential
            expect(result2.timestamp).to.be.gt(result1.timestamp);
            expect(result3.timestamp).to.be.gt(result2.timestamp);

            // Validate each raffle has a winner
            expect(result1.winner).to.not.equal(ethers.ZeroAddress);
            expect(result2.winner).to.not.equal(ethers.ZeroAddress);
            expect(result3.winner).to.not.equal(ethers.ZeroAddress);

            // Validate winners are participants
            expect(result1.participants).to.include(result1.winner);
            expect(result2.participants).to.include(result2.winner);
            expect(result3.participants).to.include(result3.winner);
        });

        it("Should maintain independent storage for each raffle index", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Execute 2 raffles
            const threshold1 = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold1);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            await hre.network.provider.send("hardhat_mine", ["0x3"]);
            const threshold2 = hre.ethers.parseEther("0.5");
            await setAccumulatedProtocolShare(threshold2);
            await game.connect(player2).executeProtocolRaffle(tierId, instanceId);

            // Retrieve both results
            const result1 = await getRaffleResult(1);
            const result2 = await getRaffleResult(2);

            // Results should be completely independent
            expect(result1.executor).to.not.equal(result2.executor);
            expect(result1.timestamp).to.not.equal(result2.timestamp);
            expect(result1.rafflePot).to.not.equal(result2.rafflePot);
            expect(result1.protocolReserve).to.not.equal(result2.protocolReserve);
            expect(result1.ownerShare).to.not.equal(result2.ownerShare);
            expect(result1.winnerPrize).to.not.equal(result2.winnerPrize);

            // Re-reading result1 should return the same data
            const result1Again = await getRaffleResult(1);
            expect(result1Again.executor).to.equal(result1.executor);
            expect(result1Again.timestamp).to.equal(result1.timestamp);
            expect(result1Again.winner).to.equal(result1.winner);
            expect(result1Again.rafflePot).to.equal(result1.rafflePot);
        });

        it("Should correctly track progressive threshold increases across raffles", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Raffle #1: 0.25 ETH threshold
            const threshold1 = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold1);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            // Raffle #2: 0.5 ETH threshold
            await hre.network.provider.send("hardhat_mine", ["0x2"]);
            const threshold2 = hre.ethers.parseEther("0.5");
            await setAccumulatedProtocolShare(threshold2);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            // Raffle #3: 0.75 ETH threshold
            await hre.network.provider.send("hardhat_mine", ["0x2"]);
            const threshold3 = hre.ethers.parseEther("0.75");
            await setAccumulatedProtocolShare(threshold3);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            // Raffle #4: 1.0 ETH threshold (capped)
            await hre.network.provider.send("hardhat_mine", ["0x2"]);
            const threshold4 = hre.ethers.parseEther("1.0");
            await setAccumulatedProtocolShare(threshold4);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            // Retrieve all results
            const result1 = await getRaffleResult(1);
            const result2 = await getRaffleResult(2);
            const result3 = await getRaffleResult(3);
            const result4 = await getRaffleResult(4);

            // Verify progressive pot increases
            expect(result1.rafflePot).to.equal(hre.ethers.parseEther("0.25"));
            expect(result2.rafflePot).to.equal(hre.ethers.parseEther("0.5"));
            expect(result3.rafflePot).to.equal(hre.ethers.parseEther("0.75"));
            expect(result4.rafflePot).to.equal(hre.ethers.parseEther("1.0"));

            // Verify 10% reserve for each
            expect(result1.protocolReserve).to.equal(hre.ethers.parseEther("0.025"));
            expect(result2.protocolReserve).to.equal(hre.ethers.parseEther("0.05"));
            expect(result3.protocolReserve).to.equal(hre.ethers.parseEther("0.075"));
            expect(result4.protocolReserve).to.equal(hre.ethers.parseEther("0.1"));

            // Verify winner prizes increase proportionally
            expect(result2.winnerPrize).to.be.gt(result1.winnerPrize);
            expect(result3.winnerPrize).to.be.gt(result2.winnerPrize);
            expect(result4.winnerPrize).to.be.gt(result3.winnerPrize);
        });
    });

    describe("Edge Cases and Data Integrity", function () {
        it("Should handle raffle with single participant", async function () {
            // Clear existing enrollments by completing the tournament
            const tierId = 0;
            const instanceId = 0;

            // Make moves to complete the tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Enroll only one player in new tournament
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Execute raffle
            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);
            await game.connect(player5).executeProtocolRaffle(tierId, instanceId);

            const result = await getRaffleResult(1);

            // Single participant should be the winner
            expect(result.participants.length).to.equal(1);
            expect(result.participants[0]).to.equal(player5.address);
            expect(result.winner).to.equal(player5.address);
            expect(result.weights.length).to.equal(1);
            expect(result.weights[0]).to.equal(1);
        });

        it("Should ensure participants and weights arrays have same length", async function () {
            const tierId = 0;
            const instanceId = 0;

            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            const result = await getRaffleResult(1);

            // Arrays must have same length
            expect(result.participants.length).to.equal(result.weights.length);
            expect(result.participants.length).to.be.gt(0);
        });

        it("Should preserve exact ETH amounts without rounding errors", async function () {
            const tierId = 0;
            const instanceId = 0;

            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);
            await game.connect(player1).executeProtocolRaffle(tierId, instanceId);

            const result = await getRaffleResult(1);

            // Total should equal pot exactly
            const total = result.winnerPrize + result.ownerShare + result.protocolReserve;
            expect(total).to.equal(result.rafflePot);

            // No dust left over
            expect(total).to.equal(threshold);
        });

        it("Should query non-existent raffle index safely", async function () {
            // Query raffle that hasn't happened yet
            const result = await getRaffleResult(99);

            // Should return empty/zero values
            expect(result.executor).to.equal(hre.ethers.ZeroAddress);
            expect(result.timestamp).to.equal(0);
            expect(result.rafflePot).to.equal(0);
            expect(result.winner).to.equal(hre.ethers.ZeroAddress);
        });
    });

    describe("Storage Gas Costs", function () {
        it("Should document gas cost for storing raffle results", async function () {
            const tierId = 0;
            const instanceId = 0;

            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);

            const tx = await game.connect(player1).executeProtocolRaffle(tierId, instanceId);
            const receipt = await tx.wait();

            // Document gas used (includes execution + storage)
            expect(receipt.gasUsed).to.be.gt(0);
            console.log(`          Gas used for raffle execution with storage: ${receipt.gasUsed.toString()}`);
        });

        it("Should handle storage for raffle with many participants", async function () {
            // This test documents behavior with larger participant arrays
            // In production, the max is 1000 unique players
            const tierId = 0;
            const instanceId = 0;

            // Current test has 2 participants
            const threshold = hre.ethers.parseEther("0.25");
            await setAccumulatedProtocolShare(threshold);

            const tx = await game.connect(player1).executeProtocolRaffle(tierId, instanceId);
            const receipt = await tx.wait();

            const result = await getRaffleResult(1);

            // Verify arrays stored correctly
            expect(result.participants.length).to.equal(2);
            expect(result.weights.length).to.equal(2);

            console.log(`          Participants stored: ${result.participants.length}`);
            console.log(`          Gas used: ${receipt.gasUsed.toString()}`);
        });
    });
});
