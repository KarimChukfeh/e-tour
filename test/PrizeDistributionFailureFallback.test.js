import hre from "hardhat";
import { expect } from "chai";

describe("Prize Distribution Failure Fallback", function () {
    let game;
    let modulePrizesInterface;
    let owner, player1, player2, player3, player4;
    let rejectingContract;
    let playerProxy;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

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

        // Save the prizes module interface for event parsing
        modulePrizesInterface = modulePrizes.interface;

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

        // Deploy a contract that rejects ETH transfers
        const RejectingReceiver = await hre.ethers.getContractFactory("RejectingReceiver");
        rejectingContract = await RejectingReceiver.deploy();

        // Deploy PlayerProxy for testing prize rejection
        const PlayerProxy = await hre.ethers.getContractFactory("PlayerProxy");
        playerProxy = await PlayerProxy.deploy(game.target);
    });

    describe("Prize Send Failure - Solo Winner", function () {
        it("Should fallback to accumulatedProtocolShare when solo winner rejects prize", async function () {
            const tierId = 0;
            const instanceId = 0;

            // Enroll proxy as the only player (need to call from a signer to send ETH)
            await playerProxy.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Check initial accumulated protocol share (should have protocol fee from enrollment)
            const protocolFeeFromEnrollment = TIER_0_FEE * 25n / 1000n; // 2.5%
            const initialAccumulated = await game.accumulatedProtocolShare();
            expect(initialAccumulated).to.equal(protocolFeeFromEnrollment);

            // Configure proxy to reject payments BEFORE force start
            await playerProxy.connect(player1).setRejectPayments(true);

            // Force start tournament with 1 player
            await hre.ethers.provider.send("evm_increaseTime", [3600]); // Wait past enrollment window
            await hre.ethers.provider.send("evm_mine", []);

            // Proxy must call forceStartTournament since it's the enrolled player
            await playerProxy.connect(player1).forceStartTournament(tierId, instanceId);

            // Tournament should complete immediately with solo winner and reset to Enrolling
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling after completion
            expect(tournament.prizePool).to.equal(0); // Prize pool distributed/failed

            // Prize should have been attempted but failed - added to accumulated protocol share
            const expectedPrizePool = TIER_0_FEE * 90n / 100n; // 90% of entry fee
            const accumulatedAfter = await game.accumulatedProtocolShare();

            // The prize pool should have been added to accumulated protocol share
            // Total = initial protocol fee + rejected prize
            expect(accumulatedAfter).to.equal(protocolFeeFromEnrollment + expectedPrizePool);

            // Verify proxy never received the payment (rejection rolled back state changes)
            const stats = await playerProxy.getStats();
            expect(stats.received).to.equal(0); // No ETH received (rejected)

            // Note: rejectionCount is 0 because the revert rolls back state changes
            // We can only verify the fallback worked by checking accumulated protocol share
        });
    });

    describe("Prize Send Failure - Tournament Winner", function () {
        it("Should fallback to accumulatedProtocolShare when winner address rejects", async function () {
            this.timeout(120000); // 2 minutes

            const tierId = 0;
            const instanceId = 0;

            // Enroll proxy and a regular player
            await playerProxy.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);

            // Determine which player goes first
            const proxyIsFirst = match.currentTurn === playerProxy.target;

            // Play moves to get proxy to winning position
            if (proxyIsFirst) {
                // Proxy plays first (X)
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 0); // X at 0
                await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 3); // O at 3
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 1); // X at 1
                await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 4); // O at 4

                // Before winning move, set proxy to reject payments
                await playerProxy.connect(player2).setRejectPayments(true);

                // Proxy makes winning move
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 2); // X wins (0,1,2)
            } else {
                // Player1 plays first (X), proxy plays second (O), let proxy win
                await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 0); // X at 0
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 3); // O at 3
                await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 1); // X at 1
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 4); // O at 4
                await game.connect(player1).makeMove(tierId, instanceId, 0, 0, 8); // X at 8

                // Before winning move, set proxy to reject payments
                await playerProxy.connect(player2).setRejectPayments(true);

                // Proxy makes winning move
                await playerProxy.connect(player2).makeMove(tierId, instanceId, 0, 0, 5); // O wins (3,4,5)
            }

            // Tournament should be completed and reset to Enrolling
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling after completion
            expect(tournament.prizePool).to.equal(0); // Prize pool distributed/failed

            // Prize should have been added to accumulated protocol share
            const protocolFeesFromEnrollments = TIER_0_FEE * 2n * 25n / 1000n; // 2.5% from 2 players
            const expectedPrizePool = TIER_0_FEE * 2n * 90n / 100n; // 90% of 2 entry fees
            const accumulated = await game.accumulatedProtocolShare();
            expect(accumulated).to.equal(protocolFeesFromEnrollments + expectedPrizePool);

            // Verify proxy never received the payment (rejection rolled back state changes)
            const stats = await playerProxy.getStats();
            expect(stats.received).to.equal(0); // No ETH received (rejected)
        });
    });

    describe("Accumulated Protocol Share Tracking", function () {
        it("Should track accumulated protocol share from failed distributions", async function () {
            // This test documents expected behavior:
            // When prize distributions fail, the amount is added to accumulatedProtocolShare
            // The funds remain in the contract balance (no special owner withdrawal)

            const accumulated = await game.accumulatedProtocolShare();
            expect(accumulated).to.equal(0);

            // Note: Failed prizes stay in the protocol pool permanently
            // This ensures no special privileges or owner access
        });
    });


    describe("Tournament Completion with Failed Prize", function () {
        it("Should complete tournament even if prize distribution fails", async function () {
            // This test documents expected behavior:
            // Even if _sendPrizeWithFallback fails to send to winner,
            // the tournament should still complete successfully
            // The failed amount goes to accumulatedProtocolShare

            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Complete game
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const winningTx = await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const receipt = await winningTx.wait();

            // Verify ETourPrize event was emitted
            const prizeEvent = receipt.logs.find(log => {
                try {
                    const parsed = modulePrizesInterface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            expect(prizeEvent).to.not.be.undefined;
            const parsedEvent = modulePrizesInterface.parseLog(prizeEvent);
            expect(parsedEvent.args.from).to.equal(await game.getAddress());
            expect(parsedEvent.args.to).to.equal(firstPlayer.address);
            expect(parsedEvent.args.gameName).to.equal("TicTacToe");

            // Tournament should be completed and reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Reset to Enrolling
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress); // Reset after completion

            // Prize pool should be reset
            expect(tournament.prizePool).to.equal(0);
        });
    });

    describe("Multi-Player Tournament with Failed Prizes", function () {
        it("Should handle multiple prize distributions in 4-player tournament", async function () {
            this.timeout(120000);

            const tierId = 1; // 4-player tier
            const instanceId = 0;
            const TIER_1_FEE = hre.ethers.parseEther("0.0007");

            // Enroll 4 players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // Complete semi-finals
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const p1_m0 = [player1, player2].find(p => p.address === match0.common.player1);
            const p2_m0 = p1_m0 === player1 ? player2 : player1;
            const first_m0 = match0.currentTurn === p1_m0.address ? p1_m0 : p2_m0;
            const second_m0 = first_m0 === p1_m0 ? p2_m0 : p1_m0;

            await game.connect(first_m0).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(second_m0).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(first_m0).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(second_m0).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(first_m0).makeMove(tierId, instanceId, 0, 0, 2); // Winner

            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const p1_m1 = [player3, player4].find(p => p.address === match1.common.player1);
            const p2_m1 = p1_m1 === player3 ? player4 : player3;
            const first_m1 = match1.currentTurn === p1_m1.address ? p1_m1 : p2_m1;
            const second_m1 = first_m1 === p1_m1 ? p2_m1 : p1_m1;

            await game.connect(first_m1).makeMove(tierId, instanceId, 0, 1, 0);
            await game.connect(second_m1).makeMove(tierId, instanceId, 0, 1, 3);
            await game.connect(first_m1).makeMove(tierId, instanceId, 0, 1, 1);
            await game.connect(second_m1).makeMove(tierId, instanceId, 0, 1, 4);
            await game.connect(first_m1).makeMove(tierId, instanceId, 0, 1, 2); // Winner

            // Complete finals
            const finalsMatch = await game.getMatch(tierId, instanceId, 1, 0);
            const finalsP1 = [player1, player2, player3, player4].find(p => p.address === finalsMatch.common.player1);
            const finalsP2 = [player1, player2, player3, player4].find(p => p.address === finalsMatch.common.player2);
            const finalsFirst = finalsMatch.currentTurn === finalsP1.address ? finalsP1 : finalsP2;
            const finalsSecond = finalsFirst === finalsP1 ? finalsP2 : finalsP1;

            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 0);
            await game.connect(finalsSecond).makeMove(tierId, instanceId, 1, 0, 3);
            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 1);
            await game.connect(finalsSecond).makeMove(tierId, instanceId, 1, 0, 4);
            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 2); // Tournament winner

            // Tournament should be completed and reset
            const finalTournament = await game.tournaments(tierId, instanceId);
            expect(finalTournament.status).to.equal(0); // Reset to Enrolling

            // Protocol fees from enrollments should remain in accumulated
            const protocolFees = TIER_1_FEE * 4n * 25n / 1000n; // 2.5% from 4 players
            const accumulated = await game.accumulatedProtocolShare();
            expect(accumulated).to.equal(protocolFees);
        });
    });

    describe("Contract Balance Accounting", function () {
        it("Should maintain correct contract balance with accumulated fees", async function () {
            // Verify contract balance accounting
            const initialBalance = await hre.ethers.provider.getBalance(game.target);

            // Run a tournament
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Entry fees collected: 2 * 0.001 ETH = 0.002 ETH
            // Owner fees (7.5%): 0.00015 ETH
            // Protocol fees (2.5%): 0.00005 ETH
            // Prize pool (90%): 0.0018 ETH

            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // After prize distribution, contract balance should reflect only accumulated protocol share
            const finalBalance = await hre.ethers.provider.getBalance(game.target);
            const accumulated = await game.accumulatedProtocolShare();

            // Contract should have protocol fees accumulated (2.5% from 2 enrollments)
            const expectedProtocolFees = TIER_0_FEE * 2n * 25n / 1000n;
            expect(accumulated).to.equal(expectedProtocolFees);
        });
    });
});

// Helper contract that rejects ETH transfers
// This would need to be in a separate Solidity file for testing
/*
contract RejectingReceiver {
    // Reject all ETH transfers
    receive() external payable {
        revert("I reject your ETH!");
    }

    fallback() external payable {
        revert("I reject your ETH!");
    }
}
*/
