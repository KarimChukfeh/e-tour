import hre from "hardhat";
import { expect } from "chai";

describe("Tournament Reset and Enrollment Edge Cases", function () {
    let game;
    let owner, player1, player2, player3, player4, player5;
    const TIER_0_FEE = hre.ethers.parseEther("0.0003");
    const TIER_1_FEE = hre.ethers.parseEther("0.0007");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4, player5] = await hre.ethers.getSigners();

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
    });

    describe("Tournament Reset State Management", function () {
        it("Should allow enrollment after tournament completes and resets", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete first tournament
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Quick win pattern
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2); // Wins

            // Verify tournament completed and reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (auto-reset)
            expect(tournament.enrolledCount).to.equal(0);
            expect(tournament.winner).to.equal(hre.ethers.ZeroAddress); // Winner cleared on reset

            // Second tournament - should work immediately
            await expect(
                game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            await expect(
                game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            // Verify second tournament started
            const tournament2 = await game.tournaments(tierId, instanceId);
            expect(tournament2.status).to.equal(1); // InProgress
            expect(tournament2.enrolledCount).to.equal(2);
        });

        it("Should clear all round data on tournament reset", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            // Complete a 4-player tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Verify round 0 initialized
            let round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(2); // 4 players = 2 semi-final matches

            // Complete tournament (abbreviated - just forfeit both matches)
            await hre.ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
            await hre.ethers.provider.send("evm_mine", []);

            // Claim timeout on match 0
            const match0 = await game.getMatch(tierId, instanceId, 0, 0);
            const nonCurrentPlayer0 = match0.currentTurn === player1.address ? player2 : player1;
            await game.connect(nonCurrentPlayer0).claimTimeoutWin(tierId, instanceId, 0, 0);

            // Claim timeout on match 1
            const match1 = await game.getMatch(tierId, instanceId, 0, 1);
            const nonCurrentPlayer1 = match1.currentTurn === player3.address ? player4 : player3;
            await game.connect(nonCurrentPlayer1).claimTimeoutWin(tierId, instanceId, 0, 1);

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
            await game.connect(finalsFirst).makeMove(tierId, instanceId, 1, 0, 2); // Wins

            // Verify tournament completed and reset
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling

            // Verify round 0 cleared
            round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.false;
            expect(round0.totalMatches).to.equal(0);
            expect(round0.completedMatches).to.equal(0);

            // Verify round 1 cleared
            const round1 = await game.rounds(tierId, instanceId, 1);
            expect(round1.initialized).to.be.false;
            expect(round1.totalMatches).to.equal(0);
        });

        it("Should clear player enrollment status on reset", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify players enrolled
            const isEnrolled1 = await game.isEnrolled(tierId, instanceId, player1.address);
            const isEnrolled2 = await game.isEnrolled(tierId, instanceId, player2.address);
            expect(isEnrolled1).to.be.true;
            expect(isEnrolled2).to.be.true;

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Verify enrollment cleared
            const isEnrolled1After = await game.isEnrolled(tierId, instanceId, player1.address);
            const isEnrolled2After = await game.isEnrolled(tierId, instanceId, player2.address);
            expect(isEnrolled1After).to.be.false;
            expect(isEnrolled2After).to.be.false;

            // Same players should be able to enroll again
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;

            await expect(
                game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.not.be.reverted;
        });
    });

    describe("Enrollment State Protection", function () {
        it("Should reject enrollment during active tournament", async function () {
            const tierId = 1; // 4-player
            const instanceId = 0;

            // Fill tournament to capacity
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Tournament should be InProgress
            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress

            // New player tries to enroll - should fail
            await expect(
                game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE })
            ).to.be.revertedWith("Enrollment failed");
        });

        it("Should reject duplicate enrollment in same tournament", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Try to enroll same player again
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE })
            ).to.be.revertedWith("Enrollment failed");
        });

        it("Should allow same player in different instances", async function () {
            const tierId = 0;
            const instanceId1 = 0;
            const instanceId2 = 1;

            // Enroll in instance 0
            await game.connect(player1).enrollInTournament(tierId, instanceId1, { value: TIER_0_FEE });

            // Should be able to enroll in instance 1
            await expect(
                game.connect(player1).enrollInTournament(tierId, instanceId2, { value: TIER_0_FEE })
            ).to.not.be.reverted;
        });

        it("Should allow same player in different tiers", async function () {
            const tier0 = 0;
            const tier1 = 1;
            const instanceId = 0;

            // Enroll in tier 0
            await game.connect(player1).enrollInTournament(tier0, instanceId, { value: TIER_0_FEE });

            // Should be able to enroll in tier 1
            await expect(
                game.connect(player1).enrollInTournament(tier1, instanceId, { value: TIER_1_FEE })
            ).to.not.be.reverted;
        });
    });

    describe("Prize Pool Reset", function () {
        it("Should reset prize pool to zero after distribution", async function () {
            const tierId = 0;
            const instanceId = 0;

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify prize pool accumulated
            let tournament = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = TIER_0_FEE * 2n * 90n / 100n; // 90% of fees
            expect(tournament.prizePool).to.equal(expectedPrizePool);

            // Complete tournament
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            // Verify prize pool reset to zero
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.prizePool).to.equal(0);
        });

        it("Should accumulate new prize pool for second tournament", async function () {
            const tierId = 0;
            const instanceId = 0;

            // First tournament
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Complete first tournament
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer1 = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer1 = firstPlayer1 === player1 ? player2 : player1;

            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer1).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer1).makeMove(tierId, instanceId, 0, 0, 2);

            // Second tournament
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_0_FEE });

            // Verify new prize pool
            const tournament2 = await game.tournaments(tierId, instanceId);
            const expectedPrizePool = TIER_0_FEE * 2n * 90n / 100n;
            expect(tournament2.prizePool).to.equal(expectedPrizePool);
        });
    });

    describe("CRITICAL BUG: Match Data Persistence Across Tournaments", function () {
        it("Should NOT reuse old match data after tournament reset - Finals should not have loser from semifinals", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 1; // Using instance 1 as in the bug report

            // ============================================
            // FIRST TOURNAMENT: 2 players, force start
            // ============================================
            console.log("\n=== FIRST TOURNAMENT (2 players, force start) ===");
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past enrollment window for tier 1 (300 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [301]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with EL1 (escalation level 1)
            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Verify tournament started with 2 players
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(2);

            // Player A wins the single match
            const match1 = await game.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match1.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;
            console.log(`Match 0-0: ${firstPlayer.address.slice(0, 6)} vs ${secondPlayer.address.slice(0, 6)}`);

            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2); // firstPlayer wins

            console.log(`${firstPlayer.address.slice(0, 6)} wins first tournament`);

            // Verify tournament completed and reset
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (auto-reset)
            expect(tournament.enrolledCount).to.equal(0);

            // CRITICAL: Match data is cleared IMMEDIATELY on reset to prevent security vulnerability
            // Without immediate clearing, stale match actions could be called between tournaments
            console.log("\n=== VERIFYING IMMEDIATE MATCH DATA CLEARING ===");

            const finalsAfterReset = await game.getMatch(tierId, instanceId, 1, 0);
            console.log(`Finals 1-0 after reset:`);
            console.log(`  player1: ${finalsAfterReset.common.player1.slice(0, 6)}`);
            console.log(`  player2: ${finalsAfterReset.common.player2.slice(0, 6)}`);
            expect(finalsAfterReset.common.player1).to.equal(hre.ethers.ZeroAddress, "Finals should be cleared immediately on reset");
            expect(finalsAfterReset.common.player2).to.equal(hre.ethers.ZeroAddress, "Finals should be cleared immediately on reset");
            console.log("✓ Stale match data cleared immediately on reset!");
            console.log("✓ Security gap closed - no window for stale match actions");

            // ============================================
            // SECOND TOURNAMENT: 4 players, full bracket
            // ============================================
            console.log("\n=== SECOND TOURNAMENT (4 players, full bracket) ===");
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Verify tournament auto-started with 4 players
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(4);

            // Round 0 should have 2 semifinal matches
            const round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            expect(round0.totalMatches).to.equal(2);
            console.log("Round 0: 2 semifinal matches initialized");

            // Get the semifinal matches
            const semifinal1 = await game.getMatch(tierId, instanceId, 0, 0);
            const semifinal2 = await game.getMatch(tierId, instanceId, 0, 1);
            console.log(`Semifinal 0-0: ${semifinal1.common.player1.slice(0, 6)} vs ${semifinal1.common.player2.slice(0, 6)}`);
            console.log(`Semifinal 0-1: ${semifinal2.common.player1.slice(0, 6)} vs ${semifinal2.common.player2.slice(0, 6)}`);

            // In second tournament, we need B to win against A
            // Identify which player is A (player1) and which is B (player2) from the first tournament
            const playerA = firstPlayer;
            const playerB = secondPlayer;

            // Check who is player1 and player2 in semifinal 0-0 of second tournament
            const isAinSlot1 = semifinal1.common.player1 === playerA.address;
            const isBinSlot1 = semifinal1.common.player1 === playerB.address;

            let semi1PlayerA, semi1PlayerB;
            if (isAinSlot1) {
                semi1PlayerA = playerA;
                semi1PlayerB = playerB;
            } else if (isBinSlot1) {
                semi1PlayerA = playerB;
                semi1PlayerB = playerA;
            } else {
                // A and B aren't in match 0-0, they must be in 0-1
                console.log("A and B are not in semifinal 0-0, test needs adjustment");
            }

            // Find who has the first move
            const semi1FirstMover = semifinal1.currentTurn === semi1PlayerA.address ? semi1PlayerA : semi1PlayerB;
            const semi1SecondMover = semi1FirstMover === semi1PlayerA ? semi1PlayerB : semi1PlayerA;

            // Make moves such that B WINS (opposite of first tournament where A won)
            if (semi1FirstMover === playerB) {
                // B goes first and wins
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 0);
                await game.connect(semi1SecondMover).makeMove(tierId, instanceId, 0, 0, 3);
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 1);
                await game.connect(semi1SecondMover).makeMove(tierId, instanceId, 0, 0, 4);
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 2); // B wins
            } else {
                // A goes first, but we want B to win, so B needs to block and win
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 0);
                await game.connect(semi1SecondMover).makeMove(tierId, instanceId, 0, 0, 4); // B takes center
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 1);
                await game.connect(semi1SecondMover).makeMove(tierId, instanceId, 0, 0, 3); // B blocks
                await game.connect(semi1FirstMover).makeMove(tierId, instanceId, 0, 0, 6); // A plays bottom-left
                await game.connect(semi1SecondMover).makeMove(tierId, instanceId, 0, 0, 5); // B wins (3-4-5 middle row)
            }

            console.log(`${playerB.address.slice(0, 6)} (B) wins semifinal 0-0`);
            console.log(`${playerA.address.slice(0, 6)} (A) LOSES semifinal 0-0`);

            // ============================================
            // BUG CHECK: Check for stale match data
            // ============================================
            console.log("\n=== CHECKING FOR BUG ===");

            // First, check the semifinal match data to see if it contains stale info
            const semifinal1After = await game.getMatch(tierId, instanceId, 0, 0);
            console.log(`Semifinal 0-0 after completion:`);
            console.log(`  player1: ${semifinal1After.common.player1.slice(0, 6)}`);
            console.log(`  player2: ${semifinal1After.common.player2.slice(0, 6)}`);
            console.log(`  winner: ${semifinal1After.common.winner.slice(0, 6)}`);
            console.log(`  status: ${semifinal1After.common.status}`);

            // Check if round 1 (finals) was initialized
            const round1 = await game.rounds(tierId, instanceId, 1);
            console.log(`\nFinals initialized: ${round1.initialized}`);

            if (round1.initialized) {
                // Finals was initialized - check the players
                const finalsMatch = await game.getMatch(tierId, instanceId, 1, 0);
                console.log(`Finals 1-0: player1=${finalsMatch.common.player1.slice(0, 6)}, player2=${finalsMatch.common.player2.slice(0, 6)}`);
                console.log(`  winner: ${finalsMatch.common.winner.slice(0, 6)}`);
                console.log(`  status: ${finalsMatch.common.status}`);
                console.log(`  currentTurn: ${finalsMatch.currentTurn.slice(0, 6)}`);

                // The LOSER (A) of semifinal 0-0 should NOT be in the finals
                // The WINNER (B) of semifinal 0-0 should be in the finals
                const loserAddress = playerA.address;
                const winnerAddress = playerB.address;
                console.log(`\nWinner of semifinal: ${winnerAddress.slice(0, 6)} (B)`);
                console.log(`Loser of semifinal: ${loserAddress.slice(0, 6)} (A)`);

                // BUG REPRODUCTION: Check if the loser (A) is in the finals
                const loserInFinalsAsP1 = finalsMatch.common.player1 === loserAddress;
                const loserInFinalsAsP2 = finalsMatch.common.player2 === loserAddress;

                if (loserInFinalsAsP1 || loserInFinalsAsP2) {
                    console.log("\n🐛 BUG REPRODUCED! The loser (A) from semifinals is in the finals!");
                    console.log(`   This is stale data from the first tournament where A beat B!`);
                    expect.fail(`BUG: Player A (${loserAddress.slice(0, 6)}) lost semifinal 0-0 to B but is in the finals! This is stale match data from the first tournament.`);
                }

                // Check if there's stale data: both slots filled when other semifinal isn't done
                const semifinal2After = await game.getMatch(tierId, instanceId, 0, 1);
                console.log(`\nSemifinal 0-1 status: ${semifinal2After.common.status}`);
                console.log(`  winner: ${semifinal2After.common.winner.slice(0, 6)}`);

                if (semifinal2After.common.winner === hre.ethers.ZeroAddress) {
                    // Semifinal 0-1 is NOT completed
                    console.log("Semifinal 0-1 is NOT completed yet");

                    // If both finals slots are filled, that's the bug!
                    if (finalsMatch.common.player1 !== hre.ethers.ZeroAddress &&
                        finalsMatch.common.player2 !== hre.ethers.ZeroAddress) {
                        console.log("\n🐛 BUG REPRODUCED! Finals has both players filled when other semifinal isn't done!");
                        expect.fail(`BUG: Finals has both slots filled (${finalsMatch.common.player1.slice(0, 6)} vs ${finalsMatch.common.player2.slice(0, 6)}) but semifinal 0-1 hasn't completed yet!`);
                    }
                }

                // The winner should be in the finals
                const winnerInFinalsAsP1 = finalsMatch.common.player1 === winnerAddress;
                const winnerInFinalsAsP2 = finalsMatch.common.player2 === winnerAddress;
                expect(winnerInFinalsAsP1 || winnerInFinalsAsP2).to.be.true;

                // If the other slot is filled, it should NOT be the loser from our match
                if (finalsMatch.common.player1 !== hre.ethers.ZeroAddress &&
                    finalsMatch.common.player2 !== hre.ethers.ZeroAddress) {
                    // Both slots filled - neither should be the loser from semifinal 0-0
                    expect(finalsMatch.common.player1).to.not.equal(loserAddress);
                    expect(finalsMatch.common.player2).to.not.equal(loserAddress);
                }
            }

            console.log("\n✓ Test completed successfully!");
            console.log("Match data is properly cleared on tournament reset.");
            console.log("No stale data persists across tournament instances.");
        });
    });
});
