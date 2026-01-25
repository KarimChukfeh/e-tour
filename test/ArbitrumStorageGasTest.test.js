// ArbitrumStorageGasTest.test.js
// Comprehensive gas cost analysis for playerMatches storage growth on Arbitrum
// Tests 200 wallets × 200 matches = 40,000 total matches to stress-test storage

import { expect } from "chai";
import hre from "hardhat";

/**
 * @title Arbitrum Storage Gas Cost Analysis - EXTREME STRESS TEST
 * @dev Tests how unbounded playerMatches storage affects gas costs at massive scale
 *
 * Test Strategy:
 * - Use ALL 200 available hardhat wallets
 * - Each wallet plays 10,000 matches (via duels - 2-player tournaments)
 * - Total: 2,000,000 matches = 4,000,000 MatchRecords written to storage
 * - Measure gas at intervals throughout the 10,000 match journey
 * - Track gas for: enrollment, moves, match completion
 *
 * Storage Being Tested:
 * - playerMatches[address] => MatchRecord[] (unbounded array)
 * - Each MatchRecord is ~10+ storage slots
 * - This test creates EXTREME worst-case storage bloat
 * - 10,000 MatchRecords per wallet = ultimate stress test
 *
 * Quick Checkmate Sequence (Fool's Mate - 4 moves):
 * 1. f2→f3 (White)
 * 2. e7→e6 (Black)
 * 3. g2→g4 (White)
 * 4. Qd8→h4 (Black) - Checkmate!
 *
 * WARNING: This test will take HOURS to complete!
 */
describe("Arbitrum Storage Gas Cost Analysis - playerMatches Growth", function () {
    let chess;
    let moduleCore, moduleMatches, modulePrizes, moduleRaffle, moduleEscalation, chessRulesModule;
    let wallets = [];

    // Use tier 0 (2-player duels for fast matches)
    const TIER = 0;
    const ENTRY_FEE = hre.ethers.parseEther("0.003");

    // Number of wallets and matches per wallet
    // EXTREME STRESS TEST: 200 wallets × 10,000 matches = 2,000,000 total matches (4,000,000 MatchRecords)
    // This is the ULTIMATE test of unbounded storage growth
    const NUM_WALLETS = 200;
    const MATCHES_PER_WALLET = 10000;

    // Track gas measurements at these intervals across the 10,000 match journey
    const MEASUREMENT_POINTS = [
        1, 10, 25, 50, 100,           // Early matches
        250, 500, 750, 1000,          // First thousand
        2000, 3000, 4000, 5000,       // Mid-range
        6000, 7000, 8000, 9000,       // Late stage
        10000                          // Final match
    ];

    // Square positions for Fool's Mate
    const sq = {
        f2: 13, f3: 21,
        e7: 52, e6: 44,
        g2: 14, g4: 30,
        d8: 59, h4: 31
    };

    const PieceType = { None: 0 };

    // Gas tracking data structure
    const gasData = {
        enrollment: {},      // wallet index → [match1, match50, match100, ...]
        firstMove: {},       // wallet index → [match1, match50, match100, ...]
        secondMove: {},
        thirdMove: {},
        fourthMove: {},      // This completes the match
        totalPerMatch: {}    // Total gas per complete match
    };

    before(async function () {
        this.timeout(0); // Disable timeout for long-running test

        console.log("\n==========================================");
        console.log("ARBITRUM STORAGE GAS COST ANALYSIS");
        console.log("🚨 EXTREME STRESS TEST 🚨");
        console.log("==========================================");
        console.log(`Wallets: ${NUM_WALLETS}`);
        console.log(`Matches per wallet: ${MATCHES_PER_WALLET.toLocaleString()}`);
        console.log(`Total matches: ${(NUM_WALLETS * MATCHES_PER_WALLET).toLocaleString()}`);
        console.log(`Total MatchRecords: ${(NUM_WALLETS * MATCHES_PER_WALLET * 2).toLocaleString()} (2 per match)`);
        console.log("");
        console.log("⚠️  WARNING: This test will take HOURS to complete!");
        console.log("⚠️  Each wallet will accumulate 10,000 MatchRecords");
        console.log("⚠️  Testing unbounded array growth at extreme scale");
        console.log("==========================================\n");

        // Get all available signers
        const allSigners = await hre.ethers.getSigners();
        wallets = allSigners.slice(0, NUM_WALLETS);

        console.log(`✓ Loaded ${wallets.length} wallets\n`);

        // Deploy all modules
        console.log("Deploying modules...");
        const ETour_Core = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
        moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
        moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
        modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
        moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");
        moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        const ChessRulesModule = await hre.ethers.getContractFactory("ChessRulesModule");
        chessRulesModule = await ChessRulesModule.deploy();
        await chessRulesModule.waitForDeployment();

        console.log("✓ Modules deployed\n");

        // Deploy ChessOnChain
        console.log("Deploying ChessOnChain...");
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await chessRulesModule.getAddress()
        );
        await chess.waitForDeployment();
        console.log("✓ ChessOnChain deployed\n");

        // Initialize gas tracking for all wallets
        for (let i = 0; i < NUM_WALLETS; i++) {
            gasData.enrollment[i] = [];
            gasData.firstMove[i] = [];
            gasData.secondMove[i] = [];
            gasData.thirdMove[i] = [];
            gasData.fourthMove[i] = [];
            gasData.totalPerMatch[i] = [];
        }
    });

    /**
     * Play a single duel match using Fool's Mate
     * Returns gas costs for each operation
     */
    async function playFoolsMateDuel(wallet1Index, wallet2Index, instanceId) {
        const w1 = wallets[wallet1Index];
        const w2 = wallets[wallet2Index];

        const roundNumber = 0;
        const matchNumber = 0;

        // Enroll both players
        const tx1 = await chess.connect(w1).enrollInTournament(TIER, instanceId, { value: ENTRY_FEE });
        const receipt1 = await tx1.wait();
        const enrollGas1 = receipt1.gasUsed;

        const tx2 = await chess.connect(w2).enrollInTournament(TIER, instanceId, { value: ENTRY_FEE });
        const receipt2 = await tx2.wait();
        const enrollGas2 = receipt2.gasUsed;

        // Get match info to determine who is white/black
        const matchData = await chess.getMatch(TIER, instanceId, roundNumber, matchNumber);
        const whitePlayer = matchData.common.player1 === w1.address ? w1 : w2;
        const blackPlayer = matchData.common.player1 === w1.address ? w2 : w1;

        // Play Fool's Mate
        // Move 1: f2→f3 (White)
        const move1Tx = await chess.connect(whitePlayer).makeMove(TIER, instanceId, roundNumber, matchNumber, sq.f2, sq.f3, PieceType.None);
        const move1Receipt = await move1Tx.wait();
        const move1Gas = move1Receipt.gasUsed;

        // Move 2: e7→e6 (Black)
        const move2Tx = await chess.connect(blackPlayer).makeMove(TIER, instanceId, roundNumber, matchNumber, sq.e7, sq.e6, PieceType.None);
        const move2Receipt = await move2Tx.wait();
        const move2Gas = move2Receipt.gasUsed;

        // Move 3: g2→g4 (White)
        const move3Tx = await chess.connect(whitePlayer).makeMove(TIER, instanceId, roundNumber, matchNumber, sq.g2, sq.g4, PieceType.None);
        const move3Receipt = await move3Tx.wait();
        const move3Gas = move3Receipt.gasUsed;

        // Move 4: Qd8→h4 (Black) - Checkmate! This completes the match
        const move4Tx = await chess.connect(blackPlayer).makeMove(TIER, instanceId, roundNumber, matchNumber, sq.d8, sq.h4, PieceType.None);
        const move4Receipt = await move4Tx.wait();
        const move4Gas = move4Receipt.gasUsed;

        return {
            enrollGas1,
            enrollGas2,
            move1Gas,
            move2Gas,
            move3Gas,
            move4Gas, // This includes MatchRecord creation for both players
            totalGas: enrollGas1 + enrollGas2 + move1Gas + move2Gas + move3Gas + move4Gas
        };
    }

    /**
     * Main test: Run 10,000 matches for each of 200 wallets
     * EXTREME STRESS TEST - 2 MILLION MATCHES TOTAL
     */
    it.skip("Should measure gas costs across 2,000,000 matches with extreme playerMatches storage growth", async function () {
        this.timeout(0); // Disable timeout

        console.log("\n🚀 Starting mass match simulation...\n");

        let totalMatches = 0;

        // For each wallet, play MATCHES_PER_WALLET matches
        for (let walletIdx = 0; walletIdx < NUM_WALLETS; walletIdx++) {
            const wallet = wallets[walletIdx];

            console.log(`\n📊 Wallet ${walletIdx + 1}/${NUM_WALLETS} (${wallet.address.slice(0, 10)}...)`);

            for (let matchIdx = 0; matchIdx < MATCHES_PER_WALLET; matchIdx++) {
                const matchNum = matchIdx + 1;

                // Pair this wallet with the next wallet (circular), offset by match number to avoid reuse
                const opponentIdx = (walletIdx + 1 + matchIdx * 2) % NUM_WALLETS;

                // Use unique instance per wallet-match combination to avoid all conflicts
                // Each wallet gets its own range of instances
                const instanceId = (walletIdx * 2 + (matchIdx % 50)) % 100;

                // Play the match
                const gasResults = await playFoolsMateDuel(walletIdx, opponentIdx, instanceId);

                totalMatches++;

                // Record gas data at measurement points
                if (MEASUREMENT_POINTS.includes(matchNum)) {
                    gasData.enrollment[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.enrollGas1
                    });
                    gasData.firstMove[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.move1Gas
                    });
                    gasData.secondMove[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.move2Gas
                    });
                    gasData.thirdMove[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.move3Gas
                    });
                    gasData.fourthMove[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.move4Gas
                    });
                    gasData.totalPerMatch[walletIdx].push({
                        matchNumber: matchNum,
                        gas: gasResults.totalGas
                    });

                    console.log(`  Match ${matchNum}/${MATCHES_PER_WALLET}: Total gas = ${gasResults.totalGas.toLocaleString()}, Move4 (w/ MatchRecord) = ${gasResults.move4Gas.toLocaleString()}`);
                }

                // Progress indicator for non-measurement matches (every 500 matches)
                if (matchNum % 500 === 0 && !MEASUREMENT_POINTS.includes(matchNum)) {
                    const pct = ((matchNum / MATCHES_PER_WALLET) * 100).toFixed(1);
                    console.log(`  Progress: ${matchNum.toLocaleString()}/${MATCHES_PER_WALLET.toLocaleString()} matches (${pct}%)`);
                }
            }

            // Verify this wallet has accumulated MatchRecords
            // Note: Wallets accumulate records from their own matches PLUS when paired as opponents
            const walletMatches = await chess.connect(wallet).getPlayerMatches();
            console.log(`  ✓ Wallet now has ${walletMatches.length} MatchRecords in storage`);
            expect(walletMatches.length).to.be.at.least(MATCHES_PER_WALLET);
        }

        console.log(`\n✅ Completed ${totalMatches} total matches\n`);
    });

    /**
     * Analyze and report gas trends
     */
    after(async function () {
        console.log("\n==========================================");
        console.log("GAS ANALYSIS REPORT");
        console.log("==========================================\n");

        // Calculate averages across all wallets for each measurement point
        const avgGasByMeasurement = {};

        for (const point of MEASUREMENT_POINTS) {
            avgGasByMeasurement[point] = {
                enrollment: 0,
                firstMove: 0,
                secondMove: 0,
                thirdMove: 0,
                fourthMove: 0,
                total: 0,
                count: 0
            };
        }

        // Aggregate data
        for (let walletIdx = 0; walletIdx < NUM_WALLETS; walletIdx++) {
            for (let i = 0; i < gasData.enrollment[walletIdx].length; i++) {
                const point = gasData.enrollment[walletIdx][i].matchNumber;

                avgGasByMeasurement[point].enrollment += Number(gasData.enrollment[walletIdx][i].gas);
                avgGasByMeasurement[point].firstMove += Number(gasData.firstMove[walletIdx][i].gas);
                avgGasByMeasurement[point].secondMove += Number(gasData.secondMove[walletIdx][i].gas);
                avgGasByMeasurement[point].thirdMove += Number(gasData.thirdMove[walletIdx][i].gas);
                avgGasByMeasurement[point].fourthMove += Number(gasData.fourthMove[walletIdx][i].gas);
                avgGasByMeasurement[point].total += Number(gasData.totalPerMatch[walletIdx][i].gas);
                avgGasByMeasurement[point].count++;
            }
        }

        // Calculate and display averages
        console.log("Average Gas Costs by Match Number (across all wallets):\n");
        console.log("Match# | Enrollment | Move 1  | Move 2  | Move 3  | Move 4* | Total   | Δ from 1st");
        console.log("-------|------------|---------|---------|---------|---------|---------|------------");

        let firstMatchTotal = 0;

        for (const point of MEASUREMENT_POINTS) {
            const data = avgGasByMeasurement[point];
            const count = data.count;

            const avgEnroll = Math.round(data.enrollment / count);
            const avgMove1 = Math.round(data.firstMove / count);
            const avgMove2 = Math.round(data.secondMove / count);
            const avgMove3 = Math.round(data.thirdMove / count);
            const avgMove4 = Math.round(data.fourthMove / count);
            const avgTotal = Math.round(data.total / count);

            if (point === 1) {
                firstMatchTotal = avgTotal;
            }

            const delta = avgTotal - firstMatchTotal;
            const deltaStr = delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
            const pctChange = ((delta / firstMatchTotal) * 100).toFixed(2);
            const pctStr = delta !== 0 ? ` (${pctChange}%)` : "";

            console.log(
                `${point.toString().padStart(6)} | ` +
                `${avgEnroll.toLocaleString().padStart(10)} | ` +
                `${avgMove1.toLocaleString().padStart(7)} | ` +
                `${avgMove2.toLocaleString().padStart(7)} | ` +
                `${avgMove3.toLocaleString().padStart(7)} | ` +
                `${avgMove4.toLocaleString().padStart(7)} | ` +
                `${avgTotal.toLocaleString().padStart(7)} | ` +
                `${deltaStr.padStart(10)}${pctStr}`
            );
        }

        console.log("\n* Move 4 includes MatchRecord creation for both players\n");

        // Analysis
        const firstTotal = avgGasByMeasurement[1].total / avgGasByMeasurement[1].count;
        const lastTotal = avgGasByMeasurement[MATCHES_PER_WALLET].total / avgGasByMeasurement[MATCHES_PER_WALLET].count;
        const totalIncrease = lastTotal - firstTotal;
        const pctIncrease = ((totalIncrease / firstTotal) * 100).toFixed(2);

        console.log("==========================================");
        console.log("SUMMARY");
        console.log("==========================================");
        console.log(`First match avg gas:     ${Math.round(firstTotal).toLocaleString()}`);
        console.log(`${MATCHES_PER_WALLET}th match avg gas:   ${Math.round(lastTotal).toLocaleString()}`);
        console.log(`Absolute increase:       ${Math.round(totalIncrease).toLocaleString()} gas`);
        console.log(`Percentage increase:     ${pctIncrease}%`);
        console.log("\n");

        // Additional insights
        const firstMove4 = avgGasByMeasurement[1].fourthMove / avgGasByMeasurement[1].count;
        const lastMove4 = avgGasByMeasurement[MATCHES_PER_WALLET].fourthMove / avgGasByMeasurement[MATCHES_PER_WALLET].count;
        const move4Increase = lastMove4 - firstMove4;
        const move4PctIncrease = ((move4Increase / firstMove4) * 100).toFixed(2);

        console.log("Move 4 Analysis (MatchRecord creation):");
        console.log(`First match Move 4:      ${Math.round(firstMove4).toLocaleString()} gas`);
        console.log(`${MATCHES_PER_WALLET}th match Move 4:    ${Math.round(lastMove4).toLocaleString()} gas`);
        console.log(`Increase:                ${Math.round(move4Increase).toLocaleString()} gas (${move4PctIncrease}%)`);
        console.log("\n");

        console.log("Interpretation:");
        if (Math.abs(parseFloat(pctIncrease)) < 5) {
            console.log("✓ Gas costs remain stable despite storage growth");
            console.log("✓ playerMatches[address].push() pattern is efficient");
            console.log("✓ No significant degradation with unbounded array growth");
            console.log(`✓ Safe to scale beyond ${MATCHES_PER_WALLET.toLocaleString()} matches per player`);
        } else if (parseFloat(pctIncrease) > 0) {
            console.log("⚠ Gas costs increase as playerMatches storage grows");
            console.log(`⚠ ${pctIncrease}% increase after ${MATCHES_PER_WALLET.toLocaleString()} matches per wallet`);
            console.log("⚠ Consider architectural changes for production");
        } else {
            console.log("✓ Gas costs actually decreased (likely due to warm storage)");
        }

        console.log("\n==========================================");
        console.log("CONTRACT STORAGE SIZE ANALYSIS");
        console.log("==========================================\n");

        // Calculate total MatchRecords created
        const totalMatchRecords = NUM_WALLETS * MATCHES_PER_WALLET * 2; // 2 records per match (both players)

        // MatchRecord structure size estimation (in bytes):
        // Each MatchRecord contains:
        // - 4 uint8s (tierId, instanceId, roundNumber, matchNumber) = 4 bytes
        // - 4 addresses (player1, player2, winner, firstPlayer) = 80 bytes
        // - 1 MatchStatus enum = 1 byte
        // - 1 bool (isDraw) = 1 byte
        // - 4 uint256s (packedBoard, packedState, startTime, endTime) = 128 bytes
        // - 1 CompletionReason enum = 1 byte
        // Total raw data: ~215 bytes per MatchRecord

        // However, EVM storage works in 32-byte slots with packing rules
        // Conservative estimate: ~8 storage slots per MatchRecord = 256 bytes
        const BYTES_PER_MATCH_RECORD = 256;

        // Additional overhead:
        // - Array length slot per wallet: 32 bytes × NUM_WALLETS
        // - Mapping storage overhead (minimal on reads, but exists)
        const arrayLengthOverhead = 32 * NUM_WALLETS;

        // Total storage calculation
        const matchRecordStorage = totalMatchRecords * BYTES_PER_MATCH_RECORD;
        const totalStorageBytes = matchRecordStorage + arrayLengthOverhead;

        // Convert to human-readable units
        const KB = totalStorageBytes / 1024;
        const MB = KB / 1024;
        const GB = MB / 1024;

        console.log("playerMatches Storage Breakdown:");
        console.log(`  Total MatchRecords:        ${totalMatchRecords.toLocaleString()}`);
        console.log(`  Bytes per MatchRecord:     ~${BYTES_PER_MATCH_RECORD} bytes (${BYTES_PER_MATCH_RECORD / 32} storage slots)`);
        console.log(`  Array length overhead:     ${arrayLengthOverhead.toLocaleString()} bytes (${NUM_WALLETS} wallets × 32 bytes)`);
        console.log("");
        console.log("Total Storage Size:");
        console.log(`  Bytes:     ${totalStorageBytes.toLocaleString()} bytes`);
        console.log(`  Kilobytes: ${KB.toLocaleString(undefined, {maximumFractionDigits: 2})} KB`);
        console.log(`  Megabytes: ${MB.toLocaleString(undefined, {maximumFractionDigits: 2})} MB`);
        if (GB >= 1) {
            console.log(`  Gigabytes: ${GB.toLocaleString(undefined, {maximumFractionDigits: 3})} GB`);
        }
        console.log("");

        // Storage cost analysis
        console.log("Arbitrum L2 Storage Notes:");
        console.log("  • Arbitrum uses calldata compression for L1 storage");
        console.log("  • playerMatches data is only stored on L2 (not posted to L1)");
        console.log("  • Storage is cheap on L2, but grows linearly with MatchRecords");
        console.log(`  • ${MATCHES_PER_WALLET.toLocaleString()} matches = ~${(MATCHES_PER_WALLET * BYTES_PER_MATCH_RECORD / 1024).toFixed(1)} KB per player`);
        console.log("");

        // Per-player storage breakdown
        const bytesPerPlayer = MATCHES_PER_WALLET * BYTES_PER_MATCH_RECORD;
        const kbPerPlayer = bytesPerPlayer / 1024;
        const mbPerPlayer = kbPerPlayer / 1024;

        console.log("Per-Player Storage:");
        console.log(`  ${MATCHES_PER_WALLET.toLocaleString()} matches = ${bytesPerPlayer.toLocaleString()} bytes`);
        console.log(`                     = ${kbPerPlayer.toFixed(2)} KB`);
        if (mbPerPlayer >= 1) {
            console.log(`                     = ${mbPerPlayer.toFixed(3)} MB`);
        }
        console.log("");

        // Scaling projections
        console.log("Scaling Projections:");
        const projectScenarios = [
            { players: 1000, matchesEach: MATCHES_PER_WALLET },
            { players: 10000, matchesEach: MATCHES_PER_WALLET },
            { players: 100000, matchesEach: MATCHES_PER_WALLET }
        ];

        projectScenarios.forEach(scenario => {
            const totalRecords = scenario.players * scenario.matchesEach * 2;
            const totalBytes = totalRecords * BYTES_PER_MATCH_RECORD;
            const totalMB = totalBytes / (1024 * 1024);
            const totalGB = totalMB / 1024;

            console.log(`  ${scenario.players.toLocaleString()} players × ${scenario.matchesEach.toLocaleString()} matches:`);
            if (totalGB >= 1) {
                console.log(`    Storage: ${totalGB.toFixed(2)} GB (${totalRecords.toLocaleString()} records)`);
            } else {
                console.log(`    Storage: ${totalMB.toFixed(2)} MB (${totalRecords.toLocaleString()} records)`);
            }
        });

        console.log("\n==========================================\n");
    });
});
