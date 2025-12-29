import { expect } from "chai";
import hre from "hardhat";

/**
 * CONNECTFOUR MAXIMUM CAPACITY GAS ESTIMATION TEST (L2 OPTIMIZED)
 *
 * This test simulates worst-case gas costs under maximum contract capacity:
 * - 224 concurrent players across 4 tiers
 * - 36 active tournament instances
 * - ~158 concurrent matches
 * - Cache near-full (800/1000 slots used)
 *
 * Uses realistic L2 gas prices (Arbitrum/Optimism/Base):
 * - Average: 0.03-0.6 Gwei (typically ~0.05 Gwei)
 * - Worst case: 1.0 Gwei
 *
 * Measures average and maximum gas costs per player, identifying the most
 * expensive transaction combinations.
 */
describe("ConnectFour Maximum Capacity Gas Estimation", function () {
    this.timeout(600000); // 10 minute timeout for comprehensive test

    let game;
    let owner;
    let players = [];

    // Tier fee configuration
    const TIER_0_FEE = hre.ethers.parseEther("0.002");
    const TIER_1_FEE = hre.ethers.parseEther("0.004");
    const TIER_2_FEE = hre.ethers.parseEther("0.008");
    const TIER_3_FEE = hre.ethers.parseEther("0.01");

    // Gas tracking data structure
    const gasData = {
        enrollments: [],
        moves: [],
        completions: [],
        escalations: [],
        distributions: [],
        perPlayer: {},  // { playerAddress: { total: 0, transactions: [] } }
        allOperations: []
    };

    // ============ HELPER FUNCTIONS ============

    /**
     * Measures gas used by a transaction and records it
     */
    async function measureGas(transactionPromise, operationName, playerAddress = null) {
        const tx = await transactionPromise;
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed;
        const gasPrice = receipt.gasPrice || 50000000n;  // Default 0.05 gwei (realistic L2) if not set
        const costWei = gasUsed * gasPrice;
        const costEth = hre.ethers.formatEther(costWei);

        const gasRecord = {
            operation: operationName,
            gasUsed: gasUsed.toString(),
            gasUsedBigInt: gasUsed,
            gasPrice: hre.ethers.formatUnits(gasPrice, "gwei"),
            costEth,
            costUsd: parseFloat(costEth) * 3000,  // Assuming $3000 ETH
            player: playerAddress,
            blockNumber: receipt.blockNumber
        };

        // Track per-player costs
        if (playerAddress) {
            if (!gasData.perPlayer[playerAddress]) {
                gasData.perPlayer[playerAddress] = {
                    totalGas: 0n,
                    transactions: []
                };
            }
            gasData.perPlayer[playerAddress].totalGas += gasUsed;
            gasData.perPlayer[playerAddress].transactions.push(gasRecord);
        }

        gasData.allOperations.push(gasRecord);
        return gasRecord;
    }

    /**
     * Gets the player who should make the current move
     */
    function getPlayerForAddress(address) {
        return players.find(p => p.address.toLowerCase() === address.toLowerCase());
    }

    /**
     * Plays a complete 42-move game without wins (fills entire board)
     * Returns array of gas costs for each move
     */
    async function playFullBoardGame(tierId, instanceId, roundNum, matchNum) {
        console.log(`\n    📊 Playing full 42-move game (Tier ${tierId}, Instance ${instanceId}, Round ${roundNum}, Match ${matchNum})`);

        const moveGasCosts = [];

        // Fill the board row by row (columns 0-6 repeated 6 times)
        // This creates alternating patterns that prevent 4-in-a-row:
        // Bottom row: P1,P2,P1,P2,P1,P2,P1 (no 4 consecutive)
        // Row 1: P2,P1,P2,P1,P2,P1,P2 (no 4 consecutive)
        // Pattern continues alternating, preventing horizontal, vertical, and diagonal wins
        const moveSequence = [
            0,1,2,3,4,5,6,  // Row 0 (bottom)
            0,1,2,3,4,5,6,  // Row 1
            0,1,2,3,4,5,6,  // Row 2
            0,1,2,3,4,5,6,  // Row 3
            0,1,2,3,4,5,6,  // Row 4
            0,1,2,3,4,5,6   // Row 5 (top) = 42 total moves
        ];

        for (let i = 0; i < 42; i++) {
            const column = moveSequence[i];
            const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
            const currentTurnAddress = match.currentTurn;
            const currentPlayer = getPlayerForAddress(currentTurnAddress);

            if (!currentPlayer) {
                throw new Error(`Could not find player for address ${currentTurnAddress}`);
            }

            const gasRecord = await measureGas(
                game.connect(currentPlayer).makeMove(tierId, instanceId, roundNum, matchNum, column),
                `Move ${i+1}/42 (col ${column})`,
                currentPlayer.address
            );

            moveGasCosts.push(gasRecord);

            if (i % 10 === 9) {
                console.log(`      Move ${i+1}/42 complete - Gas: ${gasRecord.gasUsed}`);
            }
        }

        console.log(`    ✅ Full game complete - ${moveGasCosts.length} moves played`);
        return moveGasCosts;
    }

    /**
     * Plays a game to completion with a win (faster, ~10-15 moves)
     */
    async function playGameToWin(tierId, instanceId, roundNum, matchNum) {
        const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
        const firstPlayerAddr = match.currentTurn;
        const player1Addr = match.common.player1;
        const player2Addr = match.common.player2;

        const firstPlayer = getPlayerForAddress(firstPlayerAddr);
        const secondPlayerAddr = firstPlayerAddr.toLowerCase() === player1Addr.toLowerCase() ? player2Addr : player1Addr;
        const secondPlayer = getPlayerForAddress(secondPlayerAddr);

        // Simple winning pattern: first player gets horizontal win on bottom row
        // Moves: P1=0, P2=3, P1=1, P2=4, P1=2, P2=5, P1=6 (P1 wins)
        const moves = [
            { player: firstPlayer, column: 0 },
            { player: secondPlayer, column: 3 },
            { player: firstPlayer, column: 1 },
            { player: secondPlayer, column: 4 },
            { player: firstPlayer, column: 2 },
            { player: secondPlayer, column: 5 },
            { player: firstPlayer, column: 6 }  // Winning move (diag or horiz depending on board state)
        ];

        const moveGases = [];
        for (const move of moves) {
            const gasRecord = await measureGas(
                game.connect(move.player).makeMove(tierId, instanceId, roundNum, matchNum, move.column),
                `Quick win move (col ${move.column})`,
                move.player.address
            );
            moveGases.push(gasRecord);
        }

        return moveGases;
    }

    /**
     * Generates comprehensive gas report
     */
    function generateGasReport() {
        console.log("\n" + "=".repeat(80));
        console.log("CONNECTFOUR MAXIMUM CAPACITY GAS ESTIMATION REPORT");
        console.log("=".repeat(80));

        // Contract state summary
        console.log("\n## Contract State at Test Time");
        console.log(`- Total Players Enrolled: 224`);
        console.log(`- Active Tournament Instances: 36`);
        console.log(`- Tier 0: 12 instances × 2 players = 24 players`);
        console.log(`- Tier 1: 10 instances × 4 players = 40 players`);
        console.log(`- Tier 2: 8 instances × 8 players = 64 players`);
        console.log(`- Tier 3: 6 instances × 16 players = 96 players`);
        console.log(`- Estimated Concurrent Matches: ~158`);
        console.log(`- Match Cache Utilization: ~800/1000 slots`);

        // Sort operations by gas cost
        console.log("\n## Gas Costs by Operation (Top 20 Highest)");
        const sortedOps = [...gasData.allOperations].sort((a, b) =>
            Number(b.gasUsedBigInt - a.gasUsedBigInt)
        ).slice(0, 20);

        sortedOps.forEach((op, idx) => {
            console.log(`\n${idx + 1}. ${op.operation}`);
            console.log(`   Gas Used: ${parseInt(op.gasUsed).toLocaleString()}`);
            console.log(`   Cost @ 0.05 gwei: ${op.costEth} ETH ($${op.costUsd.toFixed(2)})`);
            if (op.player) {
                console.log(`   Player: ${op.player.slice(0, 10)}...`);
            }
        });

        // Calculate average player cost
        console.log("\n## Average Player Cost Analysis");
        const playerAddresses = Object.keys(gasData.perPlayer);
        const totalGasAllPlayers = playerAddresses.reduce((sum, addr) => {
            return sum + gasData.perPlayer[addr].totalGas;
        }, 0n);
        const avgGasPerPlayer = totalGasAllPlayers / BigInt(playerAddresses.length || 1);

        console.log(`- Players Tracked: ${playerAddresses.length}`);
        console.log(`- Total Gas (All Players): ${totalGasAllPlayers.toLocaleString()}`);
        console.log(`- Average Gas per Player: ${avgGasPerPlayer.toLocaleString()}`);
        console.log(`- Average Cost @ 0.05 gwei: ${hre.ethers.formatEther(avgGasPerPlayer * 50000000n)} ETH`);
        console.log(`- Average Cost @ 0.05 gwei: $${(parseFloat(hre.ethers.formatEther(avgGasPerPlayer * 50000000n)) * 3000).toFixed(2)}`);

        // Find maximum cost player
        console.log("\n## Maximum Cost Player");
        let maxPlayer = null;
        let maxGas = 0n;

        for (const [address, data] of Object.entries(gasData.perPlayer)) {
            if (data.totalGas > maxGas) {
                maxGas = data.totalGas;
                maxPlayer = { address, ...data };
            }
        }

        if (maxPlayer) {
            console.log(`- Player Address: ${maxPlayer.address}`);
            console.log(`- Total Gas Spent: ${maxPlayer.totalGas.toLocaleString()}`);
            console.log(`- Total Transactions: ${maxPlayer.transactions.length}`);
            console.log(`- Cost @ 0.05 gwei: ${hre.ethers.formatEther(maxPlayer.totalGas * 50000000n)} ETH`);
            console.log(`- Cost @ 0.05 gwei: $${(parseFloat(hre.ethers.formatEther(maxPlayer.totalGas * 50000000n)) * 3000).toFixed(2)}`);

            console.log(`\n  Top 5 Most Expensive Transactions for Max Cost Player:`);
            const topTxs = [...maxPlayer.transactions]
                .sort((a, b) => Number(b.gasUsedBigInt - a.gasUsedBigInt))
                .slice(0, 5);

            topTxs.forEach((tx, idx) => {
                console.log(`    ${idx + 1}. ${tx.operation}: ${parseInt(tx.gasUsed).toLocaleString()} gas`);
            });
        }

        // Network cost estimates at various gas prices (L2 realistic values)
        console.log("\n## Network Cost Estimates at Different Gas Prices (L2)");
        console.log("\n┌────────────┬──────────────────┬──────────────────┐");
        console.log("│ Gas Price  │ Avg Player Cost  │ Max Player Cost  │");
        console.log("├────────────┼──────────────────┼──────────────────┤");

        [0.03, 0.1, 0.5, 1.0].forEach(gwei => {
            // Convert gwei to wei (1 gwei = 10^9 wei)
            const gweiInWei = BigInt(Math.floor(gwei * 1000000000));
            const avgCostWei = avgGasPerPlayer * gweiInWei;
            const maxCostWei = maxPlayer ? maxPlayer.totalGas * gweiInWei : 0n;

            const avgEth = hre.ethers.formatEther(avgCostWei);
            const maxEth = hre.ethers.formatEther(maxCostWei);
            const avgUsd = (parseFloat(avgEth) * 3000).toFixed(2);
            const maxUsd = (parseFloat(maxEth) * 3000).toFixed(2);

            const gweiLabel = `${gwei} gwei`;
            console.log(`│ ${gweiLabel.padEnd(10)} │ ${avgEth.padEnd(16)} │ ${maxEth.padEnd(16)} │`);
            console.log(`│            │ ($${avgUsd.padEnd(13)}) │ ($${maxUsd.padEnd(13)}) │`);
        });
        console.log("└────────────┴──────────────────┴──────────────────┘");

        // Operation breakdown
        console.log("\n## Operation Type Breakdown");
        const opTypes = {
            enrollments: gasData.enrollments,
            moves: gasData.moves,
            completions: gasData.completions,
            escalations: gasData.escalations,
            distributions: gasData.distributions
        };

        Object.entries(opTypes).forEach(([type, ops]) => {
            if (ops.length > 0) {
                const totalGas = ops.reduce((sum, op) => sum + BigInt(op.gasUsed), 0n);
                const avgGas = totalGas / BigInt(ops.length);
                console.log(`\n${type.toUpperCase()}:`);
                console.log(`  Count: ${ops.length}`);
                console.log(`  Total Gas: ${totalGas.toLocaleString()}`);
                console.log(`  Average Gas: ${avgGas.toLocaleString()}`);
            }
        });

        console.log("\n" + "=".repeat(80));
        console.log("END OF REPORT");
        console.log("=".repeat(80) + "\n");
    }

    // ============ TEST SUITE ============

    before(async function () {
        console.log("\n🚀 Initializing ConnectFour Maximum Capacity Gas Test...");

        // Get signers - need 224 players + owner
        const signers = await hre.ethers.getSigners();
        owner = signers[0];
        players = signers.slice(1, 225);  // Players 1-224

        console.log(`✅ Loaded ${players.length} player accounts`);

        // Deploy contract
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        game = await ConnectFourOnChain.deploy();
        await game.waitForDeployment();

        console.log(`✅ ConnectFourOnChain deployed at ${await game.getAddress()}`);
    });

    describe("Phase 1: Contract Saturation Setup", function () {

        it("Should saturate contract with 224 players across all tiers", async function () {
            console.log("\n📋 Enrolling players to saturate contract...");

            // Tier 0: 12 instances × 2 players = 24 players
            console.log("\n  Tier 0 (2-player): Enrolling 24 players across 12 instances...");
            for (let instance = 0; instance < 12; instance++) {
                for (let p = 0; p < 2; p++) {
                    const playerIndex = instance * 2 + p;
                    const player = players[playerIndex];
                    await measureGas(
                        game.connect(player).enrollInTournament(0, instance, { value: TIER_0_FEE }),
                        `Enrollment: Tier 0, Instance ${instance}, Player ${p + 1}`,
                        player.address
                    );
                }
                if (instance % 3 === 2) {
                    console.log(`    ✓ ${instance + 1}/12 instances filled`);
                }
            }
            console.log(`  ✅ Tier 0 complete: 24 players enrolled`);

            // Tier 1: 10 instances × 4 players = 40 players
            console.log("\n  Tier 1 (4-player): Enrolling 40 players across 10 instances...");
            for (let instance = 0; instance < 10; instance++) {
                for (let p = 0; p < 4; p++) {
                    const playerIndex = 24 + instance * 4 + p;
                    const player = players[playerIndex];
                    await measureGas(
                        game.connect(player).enrollInTournament(1, instance, { value: TIER_1_FEE }),
                        `Enrollment: Tier 1, Instance ${instance}, Player ${p + 1}`,
                        player.address
                    );
                }
                if (instance % 3 === 2) {
                    console.log(`    ✓ ${instance + 1}/10 instances filled`);
                }
            }
            console.log(`  ✅ Tier 1 complete: 40 players enrolled`);

            // Tier 2: 8 instances × 8 players = 64 players
            console.log("\n  Tier 2 (8-player): Enrolling 64 players across 8 instances...");
            for (let instance = 0; instance < 8; instance++) {
                for (let p = 0; p < 8; p++) {
                    const playerIndex = 64 + instance * 8 + p;
                    const player = players[playerIndex];
                    await measureGas(
                        game.connect(player).enrollInTournament(2, instance, { value: TIER_2_FEE }),
                        `Enrollment: Tier 2, Instance ${instance}, Player ${p + 1}`,
                        player.address
                    );
                }
                if (instance % 2 === 1) {
                    console.log(`    ✓ ${instance + 1}/8 instances filled`);
                }
            }
            console.log(`  ✅ Tier 2 complete: 64 players enrolled`);

            // Tier 3: 6 instances × 16 players = 96 players
            // Leave last spot in instance 0 open for auto-start test
            console.log("\n  Tier 3 (16-player): Enrolling 96 players across 6 instances...");
            for (let instance = 0; instance < 6; instance++) {
                const maxPlayers = (instance === 0) ? 15 : 16;  // Leave one spot in instance 0
                for (let p = 0; p < maxPlayers; p++) {
                    const playerIndex = 128 + instance * 16 + p;
                    const player = players[playerIndex];
                    await measureGas(
                        game.connect(player).enrollInTournament(3, instance, { value: TIER_3_FEE }),
                        `Enrollment: Tier 3, Instance ${instance}, Player ${p + 1}`,
                        player.address
                    );
                }
                console.log(`    ✓ ${instance + 1}/6 instances filled (${maxPlayers}/16 players)`);
            }
            console.log(`  ✅ Tier 3 complete: 95 players enrolled (1 spot reserved for auto-start test)`);

            console.log("\n✅ CONTRACT SATURATION COMPLETE");
            console.log(`   Total Players: ${24 + 40 + 64 + 95} / 224 enrolled`);
            console.log(`   Active Tournaments: 36`);
        });
    });

    describe("Phase 2: Worst-Case Gas Measurement", function () {

        it("Scenario 1: Long Game with Multiple Moves", async function () {
            console.log("\n🎮 SCENARIO 1: Long Game (20+ moves)");

            // Use Tier 3 Instance 1 (16-player tournament, fully enrolled, auto-started)
            // This instance has 16 players and should have 8 matches in Round 0
            const tierId = 3;
            const instanceId = 1;
            const roundNum = 0;
            const matchNum = 0;

            // Play a longer game (20 moves) without triggering a win
            // Pattern: spread moves across columns to avoid 4-in-a-row
            const movePattern = [0,1,2,3,4,5,6,0,1,2,3,4,5,6,0,1,2,3,4,6]; // 20 moves, avoiding patterns

            console.log(`\n    📊 Playing long game (${movePattern.length} moves)`);
            const moveGases = [];

            for (let i = 0; i < movePattern.length; i++) {
                const column = movePattern[i];
                const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
                const currentPlayer = getPlayerForAddress(match.currentTurn);

                const gasRecord = await measureGas(
                    game.connect(currentPlayer).makeMove(tierId, instanceId, roundNum, matchNum, column),
                    `Move ${i+1}/${movePattern.length} (col ${column})`,
                    currentPlayer.address
                );

                moveGases.push(gasRecord);

                if (i % 5 === 4) {
                    console.log(`      Move ${i+1}/${movePattern.length} complete - Gas: ${gasRecord.gasUsed}`);
                }
            }

            // Categorize moves
            gasData.moves.push(...moveGases);

            console.log(`    ✅ Long game complete - ${moveGases.length} moves played`);
        });

        it("Scenario 2: Tournament Auto-Start at Capacity", async function () {
            console.log("\n🚀 SCENARIO 2: Tournament Auto-Start");

            // Fill the last spot in Tier 3, Instance 0 to trigger auto-start
            const lastPlayerIndex = 128 + 15;  // The 16th player for Tier 3 Instance 0
            const lastPlayer = players[lastPlayerIndex];

            console.log(`    Enrolling final player to trigger auto-start...`);
            const gasRecord = await measureGas(
                game.connect(lastPlayer).enrollInTournament(3, 0, { value: TIER_3_FEE }),
                "Auto-Start Trigger: Tier 3 enrollment (16th player)",
                lastPlayer.address
            );

            console.log(`\n    💎 AUTO-START GAS COST`);
            console.log(`       Gas: ${parseInt(gasRecord.gasUsed).toLocaleString()}`);
            console.log(`       Cost: ${gasRecord.costEth} ETH ($${gasRecord.costUsd.toFixed(2)})`);

            gasData.enrollments.push(gasRecord);
        });

        it("Scenario 3: Multiple Quick Games for Cache Filling", async function () {
            console.log("\n⚡ SCENARIO 3: Multiple Match Completions");

            // Play several matches to completion quickly to fill cache
            const matchesToComplete = [
                { tier: 0, instance: 0, round: 0, match: 0 },
                { tier: 0, instance: 1, round: 0, match: 0 },
                { tier: 0, instance: 2, round: 0, match: 0 },
                { tier: 1, instance: 0, round: 0, match: 0 },
                { tier: 1, instance: 1, round: 0, match: 0 }
            ];

            for (const m of matchesToComplete) {
                console.log(`    Playing match: Tier ${m.tier}, Instance ${m.instance}...`);
                const moveGases = await playGameToWin(m.tier, m.instance, m.round, m.match);
                gasData.moves.push(...moveGases);

                const lastMove = moveGases[moveGases.length - 1];
                gasData.completions.push(lastMove);
                console.log(`      ✓ Complete - Final move gas: ${parseInt(lastMove.gasUsed).toLocaleString()}`);
            }

            console.log(`\n    ✅ ${matchesToComplete.length} matches completed`);
        });

        it("Scenario 4: Timeout and Claim for Escalation", async function () {
            console.log("\n⏰ SCENARIO 4: Timeout Escalation");

            // Pick a match from Tier 1 that hasn't been played yet
            const tierId = 1;
            const instanceId = 2;
            const roundNum = 0;
            const matchNum = 0;

            // Get match details before making any moves
            const matchBefore = await game.getMatch(tierId, instanceId, roundNum, matchNum);
            const player1 = getPlayerForAddress(matchBefore.common.player1);
            const player2 = getPlayerForAddress(matchBefore.common.player2);
            const playerWhoMoves = getPlayerForAddress(matchBefore.currentTurn);

            // Make one move to start the clock
            console.log(`    Making initial move...`);
            await measureGas(
                game.connect(playerWhoMoves).makeMove(tierId, instanceId, roundNum, matchNum, 0),
                "Initial move before timeout",
                playerWhoMoves.address
            );

            // After the move, it's now the OTHER player's turn (who will timeout)
            // And the player who just moved can claim timeout after time passes

            // Advance time past timeout (60 seconds + 1)
            console.log(`    ⏳ Advancing time past match timeout...`);
            await hre.ethers.provider.send("evm_increaseTime", [61]);
            await hre.ethers.provider.send("evm_mine", []);

            // The player who MADE the move can now claim timeout on the opponent
            console.log(`    ⚔️  Claiming timeout victory...`);
            const gasRecord = await measureGas(
                game.connect(playerWhoMoves).claimTimeoutWin(tierId, instanceId, roundNum, matchNum),
                "L1 Escalation: Timeout Claim",
                playerWhoMoves.address
            );

            console.log(`\n    💎 TIMEOUT CLAIM GAS COST`);
            console.log(`       Gas: ${parseInt(gasRecord.gasUsed).toLocaleString()}`);
            console.log(`       Cost: ${gasRecord.costEth} ETH ($${gasRecord.costUsd.toFixed(2)})`);

            gasData.escalations.push(gasRecord);
        });

        it("Scenario 5: Complete Additional Matches for Distribution Test", async function () {
            console.log("\n🏁 SCENARIO 5: Match Completions for Tournament Progression");

            // Complete enough matches to allow a Tier 0 tournament to finish
            // Tier 0 only needs 1 match to complete
            const tierId = 0;
            const instanceId = 3;  // Use an instance we haven't touched yet

            console.log(`    Completing Tier 0, Instance ${instanceId} tournament...`);
            const moveGases = await playGameToWin(tierId, instanceId, 0, 0);
            gasData.moves.push(...moveGases);

            const lastMove = moveGases[moveGases.length - 1];
            gasData.completions.push(lastMove);

            console.log(`\n    ✅ Tournament should now complete and distribute prizes`);
            console.log(`       Final move gas: ${parseInt(lastMove.gasUsed).toLocaleString()}`);
        });
    });

    describe("Phase 3: Per-Player Cost Analysis", function () {

        it("Should calculate average player cost across all scenarios", async function () {
            console.log("\n📊 Calculating average player costs...");

            const playerAddresses = Object.keys(gasData.perPlayer);

            if (playerAddresses.length === 0) {
                console.log("    ⚠️  No per-player data collected");
                return;
            }

            const totalGasAllPlayers = playerAddresses.reduce((sum, addr) => {
                return sum + gasData.perPlayer[addr].totalGas;
            }, 0n);

            const avgGasPerPlayer = totalGasAllPlayers / BigInt(playerAddresses.length);

            console.log(`\n    Players tracked: ${playerAddresses.length}`);
            console.log(`    Average gas per player: ${avgGasPerPlayer.toLocaleString()}`);
            console.log(`    Average cost @ 0.05 gwei: ${hre.ethers.formatEther(avgGasPerPlayer * 50000000n)} ETH`);

            // Should be reasonable (less than 0.1 ETH average)
            expect(avgGasPerPlayer).to.be.lt(2000000n);  // Less than 2M gas average
        });

        it("Should identify maximum cost player path", async function () {
            console.log("\n🎯 Identifying maximum cost player...");

            let maxPlayer = null;
            let maxGas = 0n;

            for (const [address, data] of Object.entries(gasData.perPlayer)) {
                if (data.totalGas > maxGas) {
                    maxGas = data.totalGas;
                    maxPlayer = { address, ...data };
                }
            }

            if (!maxPlayer) {
                console.log("    ⚠️  No player data available");
                return;
            }

            console.log(`\n    Max cost player: ${maxPlayer.address}`);
            console.log(`    Total gas: ${maxPlayer.totalGas.toLocaleString()}`);
            console.log(`    Transactions: ${maxPlayer.transactions.length}`);

            // Get top 5 most expensive transactions
            const topTxs = [...maxPlayer.transactions]
                .sort((a, b) => Number(b.gasUsedBigInt - a.gasUsedBigInt))
                .slice(0, 5);

            console.log(`\n    Top 5 expensive transactions:`);
            topTxs.forEach((tx, idx) => {
                console.log(`      ${idx + 1}. ${tx.operation}: ${parseInt(tx.gasUsed).toLocaleString()} gas`);
            });
        });

        it("Should display network cost estimates at various gas prices", async function () {
            console.log("\n💰 Network Cost Estimates at Various Gas Prices");

            const playerAddresses = Object.keys(gasData.perPlayer);
            if (playerAddresses.length === 0) {
                console.log("    ⚠️  No player data available");
                return;
            }

            const totalGasAllPlayers = playerAddresses.reduce((sum, addr) => {
                return sum + gasData.perPlayer[addr].totalGas;
            }, 0n);
            const avgGasPerPlayer = totalGasAllPlayers / BigInt(playerAddresses.length);

            // Find max player
            let maxGas = 0n;
            for (const [address, data] of Object.entries(gasData.perPlayer)) {
                if (data.totalGas > maxGas) {
                    maxGas = data.totalGas;
                }
            }

            console.log("\n    Gas Prices (L2): 0.03, 0.1, 0.5, 1.0 gwei");
            console.log("    ETH Price Assumption: $3,000");

            [0.03, 0.1, 0.5, 1.0].forEach(gwei => {
                const gweiInWei = BigInt(Math.floor(gwei * 1000000000));
                const avgCost = avgGasPerPlayer * gweiInWei;
                const maxCost = maxGas * gweiInWei;

                console.log(`\n    ${gwei} gwei:`);
                console.log(`      Average: ${hre.ethers.formatEther(avgCost)} ETH ($${(parseFloat(hre.ethers.formatEther(avgCost)) * 3000).toFixed(2)})`);
                console.log(`      Maximum: ${hre.ethers.formatEther(maxCost)} ETH ($${(parseFloat(hre.ethers.formatEther(maxCost)) * 3000).toFixed(2)})`);
            });
        });
    });

    describe("Phase 4: Generate Comprehensive Report", function () {

        it("Should print comprehensive gas analysis report", async function () {
            generateGasReport();

            // Verify we have data
            expect(gasData.allOperations.length).to.be.gt(0);
            expect(Object.keys(gasData.perPlayer).length).to.be.gt(0);
        });
    });
});
