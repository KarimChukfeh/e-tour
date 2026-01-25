import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * @title PlayerMatches Test Suite
 * @dev Comprehensive tests for MatchRecord creation across ALL completion scenarios
 *
 * Tests cover:
 * - Normal wins
 * - Timeout wins (ML1)
 * - Draws
 * - Force elimination (ML2) - both players get records, no winner
 * - Replacement (ML3) - all 3 players (original p1, p2, replacement) get records
 *
 * Uses 8-player tournaments (3 rounds: QF, SF, Finals) to exercise all paths
 */
describe("PlayerMatches - Complete MatchRecord Tracking", function () {
    let ticTacChain;
    let moduleCore, moduleMatches, modulePrizes, moduleRaffle, moduleEscalation;
    let owner, p1, p2, p3, p4, p5, p6, p7, p8, external;
    let players;

    const TIER_2_PLAYER = 2; // 8-player tier
    const INSTANCE = 0;
    const ENTRY_FEE = hre.ethers.parseEther("0.0013");

    // CompletionReason enum
    const CompletionReason = {
        NormalWin: 0,
        Timeout: 1,
        Draw: 2,
        ForceElimination: 3,
        Replacement: 4,
        AllDrawScenario: 5
    };

    beforeEach(async function () {
        [owner, p1, p2, p3, p4, p5, p6, p7, p8, external] = await hre.ethers.getSigners();
        players = [p1, p2, p3, p4, p5, p6, p7, p8];

        // Deploy modules
        const ETourModuleCore = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
        const ETourModuleMatches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
        const ETourModulePrizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
        const ETourModuleRaffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
        const ETourModuleEscalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");

        moduleCore = await ETourModuleCore.deploy();
        moduleMatches = await ETourModuleMatches.deploy();
        modulePrizes = await ETourModulePrizes.deploy();
        moduleRaffle = await ETourModuleRaffle.deploy();
        moduleEscalation = await ETourModuleEscalation.deploy();

        // Deploy TicTacChain game contract
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        ticTacChain = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
    });

    // Helper to enroll 8 players
    async function enrollEightPlayers() {
        for (let i = 0; i < 8; i++) {
            await ticTacChain.connect(players[i]).enrollInTournament(TIER_2_PLAYER, INSTANCE, { value: ENTRY_FEE });
        }
    }

    // Helper to make a winning move (row 0 for player 1)
    async function makeWinningMoves(tierId, instanceId, roundNumber, matchNumber, winner, loser) {
        // Winner is player1 (X), makes moves to win top row: 0, 1, 2
        // Loser is player2 (O), makes moves: 3, 4
        await ticTacChain.connect(winner).makeMove(tierId, instanceId, roundNumber, matchNumber, 0);
        await ticTacChain.connect(loser).makeMove(tierId, instanceId, roundNumber, matchNumber, 3);
        await ticTacChain.connect(winner).makeMove(tierId, instanceId, roundNumber, matchNumber, 1);
        await ticTacChain.connect(loser).makeMove(tierId, instanceId, roundNumber, matchNumber, 4);
        await ticTacChain.connect(winner).makeMove(tierId, instanceId, roundNumber, matchNumber, 2); // Wins
    }

    // Helper to check MatchRecord fields
    function verifyMatchRecord(record, expected) {
        expect(record.tierId).to.equal(expected.tierId);
        expect(record.instanceId).to.equal(expected.instanceId);
        expect(record.roundNumber).to.equal(expected.roundNumber);
        expect(record.matchNumber).to.equal(expected.matchNumber);
        expect(record.player1).to.equal(expected.player1);
        expect(record.player2).to.equal(expected.player2);
        expect(record.winner).to.equal(expected.winner);
        expect(record.completionReason).to.equal(expected.completionReason);
        expect(record.isDraw).to.equal(expected.isDraw);
    }

    describe("Normal Win Scenario", function () {
        it("Should create MatchRecords for both players on normal win", async function () {
            await enrollEightPlayers();

            // Get match info to determine player1 and player2
            const matchInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 0);
            const player1 = matchInfo.common.player1;
            const player2 = matchInfo.common.player2;

            // Find signers
            const p1Signer = players.find(p => p.address === player1);
            const p2Signer = players.find(p => p.address === player2);

            // Determine who goes first
            const currentTurn = matchInfo.currentTurn;
            const firstPlayer = currentTurn === player1 ? p1Signer : p2Signer;
            const secondPlayer = currentTurn === player1 ? p2Signer : p1Signer;

            // Play game where first player wins
            await ticTacChain.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 0);
            await ticTacChain.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 3);
            await ticTacChain.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 1);
            await ticTacChain.connect(secondPlayer).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 4);
            await ticTacChain.connect(firstPlayer).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 2); // Wins top row

            // Check player1's match history
            const p1Matches = await ticTacChain.connect(p1Signer).getPlayerMatches();
            expect(p1Matches.length).to.equal(1);
            verifyMatchRecord(p1Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: firstPlayer.address,
                completionReason: CompletionReason.NormalWin,
                isDraw: false
            });

            // Check player2's match history
            const p2Matches = await ticTacChain.connect(p2Signer).getPlayerMatches();
            expect(p2Matches.length).to.equal(1);
            verifyMatchRecord(p2Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: firstPlayer.address,
                completionReason: CompletionReason.NormalWin,
                isDraw: false
            });
        });
    });

    describe("Timeout Win (ML1) Scenario", function () {
        it("Should create MatchRecords for both players on timeout win", async function () {
            await enrollEightPlayers();

            // Get match info
            const matchInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 0);
            const player1 = matchInfo.common.player1;
            const player2 = matchInfo.common.player2;
            const currentTurn = matchInfo.currentTurn;

            const timedOutPlayer = currentTurn === player1 ? player1 : player2;
            const claimingPlayer = currentTurn === player1 ? player2 : player1;

            const timedOutSigner = players.find(p => p.address === timedOutPlayer);
            const claimingSigner = players.find(p => p.address === claimingPlayer);

            // Wait for timeout (120 seconds + 1)
            await time.increase(121);

            // Claiming player calls timeout
            await ticTacChain.connect(claimingSigner).claimTimeoutWin(TIER_2_PLAYER, INSTANCE, 0, 0);

            // Check both players got MatchRecords
            const timedOutMatches = await ticTacChain.connect(timedOutSigner).getPlayerMatches();
            expect(timedOutMatches.length).to.equal(1);
            verifyMatchRecord(timedOutMatches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: claimingPlayer,
                completionReason: CompletionReason.Timeout,
                isDraw: false
            });

            const claimingMatches = await ticTacChain.connect(claimingSigner).getPlayerMatches();
            expect(claimingMatches.length).to.equal(1);
            verifyMatchRecord(claimingMatches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: claimingPlayer,
                completionReason: CompletionReason.Timeout,
                isDraw: false
            });
        });
    });

    describe("Draw Scenario", function () {
        it("Should create MatchRecords for both players on draw", async function () {
            await enrollEightPlayers();

            // Get match info
            const matchInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 0);
            const player1 = matchInfo.common.player1;
            const player2 = matchInfo.common.player2;
            const currentTurn = matchInfo.currentTurn;

            const firstSigner = players.find(p => p.address === currentTurn);
            const secondSigner = players.find(p => p.address === (currentTurn === player1 ? player2 : player1));

            // Play a draw game (fill board with no winner)
            // X plays: 0, 1, 5, 6, 7
            // O plays: 2, 3, 4, 8
            await ticTacChain.connect(firstSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 0);
            await ticTacChain.connect(secondSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 2);
            await ticTacChain.connect(firstSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 1);
            await ticTacChain.connect(secondSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 3);
            await ticTacChain.connect(firstSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 5);
            await ticTacChain.connect(secondSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 4);
            await ticTacChain.connect(firstSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 6);
            await ticTacChain.connect(secondSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 8);
            await ticTacChain.connect(firstSigner).makeMove(TIER_2_PLAYER, INSTANCE, 0, 0, 7); // Draw

            // Check both players got draw records
            const p1Matches = await ticTacChain.connect(players.find(p => p.address === player1)).getPlayerMatches();
            expect(p1Matches.length).to.equal(1);
            verifyMatchRecord(p1Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: hre.ethers.ZeroAddress,
                completionReason: CompletionReason.Draw,
                isDraw: true
            });

            const p2Matches = await ticTacChain.connect(players.find(p => p.address === player2)).getPlayerMatches();
            expect(p2Matches.length).to.equal(1);
            verifyMatchRecord(p2Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: hre.ethers.ZeroAddress,
                completionReason: CompletionReason.Draw,
                isDraw: true
            });
        });
    });

    describe("Force Elimination (ML2) Scenario", function () {
        it("Should create MatchRecords for both eliminated players with no winner", async function () {
            await enrollEightPlayers();

            // Get match info for match 0
            const matchInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 0);
            const player1 = matchInfo.common.player1;
            const player2 = matchInfo.common.player2;

            const p1Signer = players.find(p => p.address === player1);
            const p2Signer = players.find(p => p.address === player2);

            // Complete other matches to advance players
            for (let matchNum = 1; matchNum < 4; matchNum++) {
                const mInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, matchNum);
                const mp1 = mInfo.common.player1;
                const mp2 = mInfo.common.player2;
                const mCurrentTurn = mInfo.currentTurn;

                const winner = players.find(p => p.address === mCurrentTurn);
                const loser = players.find(p => p.address === (mCurrentTurn === mp1 ? mp2 : mp1));

                // Play quick win
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 0);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 3);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 1);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 4);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 2);
            }

            // Wait for match 0 to timeout + ML2 delay (120 + 120 seconds)
            await time.increase(241);

            // Advanced player (winner from match 1) force eliminates match 0
            const match1Info = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 1);
            const advancedPlayer = players.find(p => p.address === match1Info.common.winner);

            await ticTacChain.connect(advancedPlayer).forceEliminateStalledMatch(TIER_2_PLAYER, INSTANCE, 0, 0);

            // Check both original players got records with no winner
            const p1Matches = await ticTacChain.connect(p1Signer).getPlayerMatches();
            expect(p1Matches.length).to.equal(1);
            verifyMatchRecord(p1Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: hre.ethers.ZeroAddress, // No winner in ML2
                completionReason: CompletionReason.ForceElimination,
                isDraw: false // Not a draw, both eliminated
            });

            const p2Matches = await ticTacChain.connect(p2Signer).getPlayerMatches();
            expect(p2Matches.length).to.equal(1);
            verifyMatchRecord(p2Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: hre.ethers.ZeroAddress,
                completionReason: CompletionReason.ForceElimination,
                isDraw: false
            });
        });
    });

    describe("Replacement (ML3) Scenario", function () {
        it("Should create MatchRecords for all 3 players (original p1, p2, and replacement)", async function () {
            await enrollEightPlayers();

            // Get match info for match 0
            const matchInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, 0);
            const player1 = matchInfo.common.player1;
            const player2 = matchInfo.common.player2;

            const p1Signer = players.find(p => p.address === player1);
            const p2Signer = players.find(p => p.address === player2);

            // Complete other matches
            for (let matchNum = 1; matchNum < 4; matchNum++) {
                const mInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, matchNum);
                const mp1 = mInfo.common.player1;
                const mp2 = mInfo.common.player2;
                const mCurrentTurn = mInfo.currentTurn;

                const winner = players.find(p => p.address === mCurrentTurn);
                const loser = players.find(p => p.address === (mCurrentTurn === mp1 ? mp2 : mp1));

                // Play quick win
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 0);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 3);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 1);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 4);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 2);
            }

            // Wait for match 0 to timeout + ML3 delay (120 + 240 seconds)
            await time.increase(361);

            // External player claims the match slot
            await ticTacChain.connect(external).claimMatchSlotByReplacement(TIER_2_PLAYER, INSTANCE, 0, 0);

            // Check all 3 players got records
            const p1Matches = await ticTacChain.connect(p1Signer).getPlayerMatches();
            expect(p1Matches.length).to.equal(1);
            verifyMatchRecord(p1Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: external.address, // Replacement player wins
                completionReason: CompletionReason.Replacement,
                isDraw: false
            });

            const p2Matches = await ticTacChain.connect(p2Signer).getPlayerMatches();
            expect(p2Matches.length).to.equal(1);
            verifyMatchRecord(p2Matches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: external.address,
                completionReason: CompletionReason.Replacement,
                isDraw: false
            });

            const externalMatches = await ticTacChain.connect(external).getPlayerMatches();
            expect(externalMatches.length).to.equal(1);
            verifyMatchRecord(externalMatches[0], {
                tierId: TIER_2_PLAYER,
                instanceId: INSTANCE,
                roundNumber: 0,
                matchNumber: 0,
                player1: player1,
                player2: player2,
                winner: external.address,
                completionReason: CompletionReason.Replacement,
                isDraw: false
            });
        });
    });

    describe("Multi-Round Tracking", function () {
        it("Should track all matches for a player across multiple rounds", async function () {
            await enrollEightPlayers();

            // Round 0 - Quarter Finals (4 matches)
            for (let matchNum = 0; matchNum < 4; matchNum++) {
                const mInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 0, matchNum);
                const mp1 = mInfo.common.player1;
                const mp2 = mInfo.common.player2;
                const mCurrentTurn = mInfo.currentTurn;

                const winner = players.find(p => p.address === mCurrentTurn);
                const loser = players.find(p => p.address === (mCurrentTurn === mp1 ? mp2 : mp1));

                // Play quick win
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 0);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 3);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 1);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 4);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 0, matchNum, 2);
            }

            // Round 1 - Semi Finals (2 matches)
            for (let matchNum = 0; matchNum < 2; matchNum++) {
                const mInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 1, matchNum);
                const mp1 = mInfo.common.player1;
                const mp2 = mInfo.common.player2;
                const mCurrentTurn = mInfo.currentTurn;

                const winner = players.find(p => p.address === mCurrentTurn);
                const loser = players.find(p => p.address === (mCurrentTurn === mp1 ? mp2 : mp1));

                // Play quick win
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 1, matchNum, 0);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 1, matchNum, 3);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 1, matchNum, 1);
                await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 1, matchNum, 4);
                await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 1, matchNum, 2);
            }

            // Round 2 - Finals (1 match)
            const finalInfo = await ticTacChain.getMatch(TIER_2_PLAYER, INSTANCE, 2, 0);
            const fp1 = finalInfo.common.player1;
            const fp2 = finalInfo.common.player2;
            const fCurrentTurn = finalInfo.currentTurn;

            const winner = players.find(p => p.address === fCurrentTurn);
            const loser = players.find(p => p.address === (fCurrentTurn === fp1 ? fp2 : fp1));

            // Play final
            await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 2, 0, 0);
            await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 2, 0, 3);
            await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 2, 0, 1);
            await ticTacChain.connect(loser).makeMove(TIER_2_PLAYER, INSTANCE, 2, 0, 4);
            await ticTacChain.connect(winner).makeMove(TIER_2_PLAYER, INSTANCE, 2, 0, 2);

            // Winner should have 3 match records (one per round)
            const winnerMatches = await ticTacChain.connect(winner).getPlayerMatches();
            expect(winnerMatches.length).to.equal(3);
            expect(winnerMatches[0].roundNumber).to.equal(0); // Quarter final
            expect(winnerMatches[1].roundNumber).to.equal(1); // Semi final
            expect(winnerMatches[2].roundNumber).to.equal(2); // Final
            expect(winnerMatches[0].winner).to.equal(winner.address);
            expect(winnerMatches[1].winner).to.equal(winner.address);
            expect(winnerMatches[2].winner).to.equal(winner.address);
        });
    });
});
