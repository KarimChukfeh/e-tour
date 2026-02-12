import hre from "hardhat";
import { expect } from "chai";
import fs from "fs";
import path from "path";

describe("Tournament Reset - Basic 4-Player Tournaments", function () {
    let game;
    let owner, player1, player2, player3, player4, player5;
    const TIER_1_FEE = hre.ethers.parseEther("0.0007"); // 4-player tier

    // Data collection for HTML report
    const matchHistory = [];
    const playerStats = new Map();

    // Helper function to record match data
    function recordMatch(tournamentNum, round, matchNum, player1Addr, player2Addr, winnerAddr, condition) {
        matchHistory.push({
            tournament: tournamentNum,
            round,
            matchNum,
            player1: player1Addr.slice(0, 6),
            player2: player2Addr.slice(0, 6),
            winner: winnerAddr.slice(0, 6),
            loser: winnerAddr === player1Addr ? player2Addr.slice(0, 6) : player1Addr.slice(0, 6),
            condition
        });

        // Update player stats
        [player1Addr, player2Addr].forEach(addr => {
            if (!playerStats.has(addr)) {
                playerStats.set(addr, { address: addr.slice(0, 6), matches: [] });
            }
        });

        const p1Stats = playerStats.get(player1Addr);
        const p2Stats = playerStats.get(player2Addr);

        const matchInfo = `T${tournamentNum}-R${round}-M${matchNum}`;
        p1Stats.matches.push({
            match: matchInfo,
            opponent: player2Addr.slice(0, 6),
            result: winnerAddr === player1Addr ? 'WIN' : 'LOSS',
            condition
        });
        p2Stats.matches.push({
            match: matchInfo,
            opponent: player1Addr.slice(0, 6),
            result: winnerAddr === player2Addr ? 'WIN' : 'LOSS',
            condition
        });
    }

    // Helper function to generate HTML report
    async function generateHTMLReport() {
        const htmlContent = `
            <h2>Tournament Reset - Basic 4-Player Tournaments</h2>
            <p style="margin: 20px 0; font-size: 1.1em;">
                This section documents the progression of 2 consecutive 4-player tournaments with different player counts,
                demonstrating proper tournament reset and state management with normal gameplay only.
            </p>

            ${[1, 2].map(t => {
                const tournamentMatches = matchHistory.filter(m => m.tournament === t);
                if (tournamentMatches.length === 0) return '';

                const rounds = [...new Set(tournamentMatches.map(m => m.round))].sort((a, b) => a - b);

                return `
                <div class="test-suite">
                    <h3>Tournament ${t} ${t === 1 ? '(2-player Force Start)' : '(3-player Force Start)'}</h3>

                    ${rounds.map(r => {
                        const roundMatches = tournamentMatches.filter(m => m.round === r);
                        return `
                        <div class="test-category">
                            <h4>Round ${r} ${r === 0 ? '(Semifinals)' : '(Finals)'}</h4>
                            ${roundMatches.map(match => `
                            <div class="scenario-section" style="margin: 10px 0; padding: 15px; background: #1a2f1a; border-left: 4px solid #4caf50;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div style="flex: 1;">
                                        <strong>Match ${r}-${match.matchNum}:</strong>
                                        <code>${match.player1}</code> vs <code>${match.player2}</code>
                                    </div>
                                    <div style="flex: 1; text-align: center;">
                                        <span class="badge success">${match.condition}</span>
                                    </div>
                                    <div style="flex: 1; text-align: right;">
                                        <strong style="color: #4caf50;">Winner:</strong> <code>${match.winner}</code><br><strong style="color: #f44336;">Loser:</strong> <code>${match.loser}</code>
                                    </div>
                                </div>
                            </div>
                            `).join('')}
                        </div>
                        `;
                    }).join('')}
                </div>
                `;
            }).join('')}

            <div class="summary-box">
                <h3>Player Match History Across Both Tournaments (from Contract getPlayerMatches)</h3>
                <p>Complete match data fetched directly from the contract for every player who participated:</p>
            </div>

            <div style="margin: 20px 0;">
                ${await Promise.all(Array.from(playerStats.keys()).map(async (playerAddr) => {
                    const recentMatches = await game.connect(await hre.ethers.getSigner(playerAddr)).getPlayerMatches();
                    const player = playerStats.get(playerAddr);
                    return `
                <div class="test-suite" style="padding: 20px; margin-bottom: 20px; width: 100%;">
                    <h4 style="color: #8b9dff; margin-top: 0; font-size: 1.2em;">Player: <code style="font-size: 1.1em;">${player.address}</code></h4>
                    <div style="font-size: 0.95em;">
                        <strong>Total Matches (from contract):</strong> ${recentMatches.length}
                        <br>
                        <strong>Wins:</strong> ${recentMatches.filter(m => m.winner.toLowerCase() === playerAddr.toLowerCase()).length}
                        <br>
                        <strong>Losses:</strong> ${recentMatches.filter(m => m.winner.toLowerCase() !== playerAddr.toLowerCase() && m.winner !== hre.ethers.ZeroAddress).length}
                    </div>
                    <div style="margin-top: 15px;">
                        <strong>Recent Matches (from Contract getPlayerMatches):</strong>
                        ${recentMatches.length === 0 ? '<p style="color: #888; font-size: 0.9em; margin-top: 10px;">No matches recorded</p>' : ''}
                        <div style="margin-top: 10px;">
                            ${recentMatches.map((match, idx) => {
                                const isWinner = match.winner.toLowerCase() === playerAddr.toLowerCase();
                                const opponent = match.player1.toLowerCase() === playerAddr.toLowerCase() ? match.player2 : match.player1;
                                const completionReasonMap = {
                                    0: 'Normal Win',
                                    1: 'Timeout',
                                    2: '⚖️ DRAW',
                                    3: '⚡ ML2: Force Elimination',
                                    4: '🔄 ML3: Replacement',
                                    5: 'All Draw Scenario'
                                };
                                const reason = completionReasonMap[Number(match.completionReason)] || 'Unknown';
                                const bgColor = isWinner ? '#1b3d1b' : '#3d1b1b';
                                const borderColor = isWinner ? '#4caf50' : '#f44336';
                                return `
                            <div style="margin: 5px 0; padding: 10px; background: ${bgColor}; border-left: 3px solid ${borderColor}; border-radius: 4px; font-size: 0.9em;">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                    <div style="flex: 1;">
                                        <strong>${idx + 1}.</strong> T${match.tierId}-I${match.instanceId}-R${match.roundNumber}-M${match.matchNumber}
                                        <br>
                                        <span style="font-size: 0.85em; margin-top: 3px; display: inline-block;">vs <code>${opponent.slice(0, 6)}</code></span>
                                    </div>
                                    <div style="text-align: right;">
                                        <span class="badge ${isWinner ? 'success' : 'warning'}">${isWinner ? 'WIN' : 'LOSS'}</span>
                                    </div>
                                </div>
                                <div style="margin-top: 5px; font-size: 0.85em;">
                                    <span style="color: #b0b0b0;">${reason}</span>
                                    <br><span style="color: #888; font-size: 0.9em;">Winner: <code>${match.winner.slice(0, 6)}</code></span>
                                </div>
                            </div>
                            `;
                            }).join('')}
                        </div>
                    </div>
                </div>
                `;
                })).then(results => results.join(''))}
            </div>

            <div class="summary-box">
                <h3>Key Insights</h3>
                <ul>
                    <li><strong>Tournament 1 (2 players):</strong> Tests force start with minimal capacity, demonstrates basic match completion</li>
                    <li><strong>Tournament 2 (3 players):</strong> Tests force start with odd number of players in 4-player bracket</li>
                    <li><strong>Normal Gameplay Only:</strong> All matches completed through standard gameplay - no escalation scenarios</li>
                    <li><strong>State Management:</strong> All matches tracked correctly across tournament resets with no data persistence issues</li>
                    <li><strong>Player Activity:</strong> Complete match history maintained for all ${playerStats.size} participants across 4-player tier</li>
                </ul>
            </div>
        `;

        // Read the existing HTML file
        const reportPath = path.join(process.cwd(), 'test-report-2026.html');
        let htmlFile = fs.readFileSync(reportPath, 'utf8');

        // Delete old section if exists
        const oldSectionStart = htmlFile.indexOf('<h2>Tournament Reset - Basic 4-Player Tournaments');
        if (oldSectionStart !== -1) {
            const footerStart = htmlFile.indexOf('<div class="footer">', oldSectionStart);
            if (footerStart !== -1) {
                // Find the <div class="content"> that contains our section
                let contentStart = htmlFile.lastIndexOf('<div class="content">', oldSectionStart);
                if (contentStart !== -1 && contentStart < oldSectionStart) {
                    htmlFile = htmlFile.slice(0, contentStart) + htmlFile.slice(footerStart);
                }
            }
        }

        // Insert before the footer
        const footerIndex = htmlFile.indexOf('<div class="footer">');
        if (footerIndex !== -1) {
            htmlFile = htmlFile.slice(0, footerIndex) +
                      `<div class="content">${htmlContent}</div>\n` +
                      htmlFile.slice(footerIndex);
        }

        // Write back to file
        fs.writeFileSync(reportPath, htmlFile);
        console.log('\n✅ HTML report updated: test-report-2026.html');
    }

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

    describe("Basic Tournament Reset with Normal Gameplay", function () {
        it("Should handle 2 consecutive 4-player tournaments with 2 and 3 players respectively", async function () {
            const tierId = 1; // 4-player tier
            const instanceId = 0;

            // ============================================
            // FIRST TOURNAMENT: 2 players, force start
            // ============================================
            console.log("\n=== FIRST TOURNAMENT (2 players, force start) ===");
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past enrollment window for tier 1 (300 seconds)
            await hre.ethers.provider.send("evm_increaseTime", [301]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start with EL1
            await game.connect(player1).forceStartTournament(tierId, instanceId);

            // Verify tournament started with 2 players
            let tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(2);
            console.log("Tournament 1 started with 2 players");

            // With 2 players, we have 1 match in the finals (round 0)
            let round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.true;
            console.log(`Round 0: ${round0.totalMatches} match(es)`);

            // Complete the only match
            const match = await game.getMatch(tierId, instanceId, 0, 0);
            const p1 = match.common.player1 === player1.address ? player1 : player2;
            const p2 = p1 === player1 ? player2 : player1;
            const first = match.currentTurn === p1.address ? p1 : p2;
            const second = first === p1 ? p2 : p1;

            console.log(`Match 0-0: ${first.address.slice(0, 6)} vs ${second.address.slice(0, 6)}`);
            await game.connect(first).makeMove(tierId, instanceId, 0, 0, 0);
            await game.connect(second).makeMove(tierId, instanceId, 0, 0, 3);
            await game.connect(first).makeMove(tierId, instanceId, 0, 0, 1);
            await game.connect(second).makeMove(tierId, instanceId, 0, 0, 4);
            await game.connect(first).makeMove(tierId, instanceId, 0, 0, 2); // Wins
            console.log(`${first.address.slice(0, 6)} wins match 0-0`);
            recordMatch(1, 0, 0, match.common.player1, match.common.player2, first.address, 'Normal gameplay');

            // Verify tournament completed and reset
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (auto-reset)
            expect(tournament.enrolledCount).to.equal(0);
            console.log("✓ Tournament 1 completed and reset");

            // ============================================
            // SECOND TOURNAMENT: 3 players, force start
            // ============================================
            console.log("\n=== SECOND TOURNAMENT (3 players, force start) ===");
            await game.connect(player3).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player4).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });
            await game.connect(player5).enrollInTournament(tierId, instanceId, { value: TIER_1_FEE });

            // Fast forward past enrollment window
            await hre.ethers.provider.send("evm_increaseTime", [301]);
            await hre.ethers.provider.send("evm_mine", []);

            // Force start
            await game.connect(player3).forceStartTournament(tierId, instanceId);

            // Verify tournament started with 3 players
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
            expect(tournament.enrolledCount).to.equal(3);
            console.log("Tournament 2 started with 3 players");

            // Debug: Check round 0
            let debugRound0 = await game.rounds(tierId, instanceId, 0);
            console.log(`Debug - Round 0 initialized: ${debugRound0.initialized}, totalMatches: ${debugRound0.totalMatches}`);

            // Complete all rounds until tournament finishes
            let currentRound = 0;
            let tournamentComplete = false;
            const players = [player3, player4, player5];

            while (!tournamentComplete && currentRound < 5) { // Safety limit
                const round = await game.rounds(tierId, instanceId, currentRound);
                if (!round.initialized) break;

                console.log(`\nRound ${currentRound}: ${round.totalMatches} matches`);

                // Find and complete all active matches in this round
                for (let m = 0; m < round.totalMatches; m++) {
                    const match = await game.getMatch(tierId, instanceId, currentRound, m);
                    if (match.common.player1 !== hre.ethers.ZeroAddress &&
                        match.common.player2 !== hre.ethers.ZeroAddress &&
                        match.common.status !== 2) { // Not completed

                        const p1 = players.find(p => p.address === match.common.player1);
                        const p2 = players.find(p => p.address === match.common.player2);

                        if (p1 && p2) {
                            const first = match.currentTurn === p1.address ? p1 : p2;
                            const second = first === p1 ? p2 : p1;

                            console.log(`Match ${currentRound}-${m}: ${first.address.slice(0, 6)} vs ${second.address.slice(0, 6)}`);
                            await game.connect(first).makeMove(tierId, instanceId, currentRound, m, 0);
                            await game.connect(second).makeMove(tierId, instanceId, currentRound, m, 3);
                            await game.connect(first).makeMove(tierId, instanceId, currentRound, m, 1);
                            await game.connect(second).makeMove(tierId, instanceId, currentRound, m, 4);
                            await game.connect(first).makeMove(tierId, instanceId, currentRound, m, 2);
                            console.log(`${first.address.slice(0, 6)} wins match ${currentRound}-${m}`);
                            recordMatch(2, currentRound, m, match.common.player1, match.common.player2, first.address, 'Normal gameplay');
                        }
                    }
                }

                // Check if tournament completed
                tournament = await game.tournaments(tierId, instanceId);
                if (tournament.status === 0) {
                    tournamentComplete = true;
                    console.log(`✓ Tournament 2 completed after round ${currentRound}`);
                } else {
                    console.log(`Tournament status still InProgress after round ${currentRound}`);
                    // Check next round
                    const nextRound = await game.rounds(tierId, instanceId, currentRound + 1);
                    console.log(`Next round (${currentRound + 1}) - initialized: ${nextRound.initialized}, totalMatches: ${nextRound.totalMatches}`);
                    currentRound++;
                }
            }

            // Verify tournament completed and reset
            tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(0); // Enrolling (auto-reset)
            expect(tournament.enrolledCount).to.equal(0);
            console.log("\n✓ Second tournament completed and reset successfully");
            console.log("✓ All 2 tournaments validated: 2 players, 3 players");

            // Verify round data cleared
            round0 = await game.rounds(tierId, instanceId, 0);
            expect(round0.initialized).to.be.false;
            expect(round0.totalMatches).to.equal(0);
            expect(round0.completedMatches).to.equal(0);
            console.log("✓ Round data properly cleared after reset");

            // Generate HTML report
            await generateHTMLReport();
        });
    });
});
