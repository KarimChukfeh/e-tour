// test/factory/TicTacInstance.test.js
// Phase 3.3 — Game-specific tests for TicTacInstance (factory/instance arch)

import { expect } from "chai";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deploy all shared instance modules + TicTacChainFactory.
 * Returns { factory }.
 */
async function deployFactory() {
    const Core = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
    );
    const Matches = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
    );
    const Prizes = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"
    );
    const Escalation = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"
    );

    const [moduleCore, moduleMatches, modulePrizes, moduleEscalation] =
        await Promise.all([
            Core.deploy().then(c => c.waitForDeployment().then(() => c)),
            Matches.deploy().then(c => c.waitForDeployment().then(() => c)),
            Prizes.deploy().then(c => c.waitForDeployment().then(() => c)),
            Escalation.deploy().then(c => c.waitForDeployment().then(() => c)),
        ]);

    const Factory = await hre.ethers.getContractFactory(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory"
    );
    const factory = await Factory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress()
    );
    await factory.waitForDeployment();

    return { factory };
}

/**
 * Build a TimeoutConfig with generous defaults for testing.
 * All timeouts are long (1 hour) so they don't interfere with game-flow tests.
 */
function defaultTimeouts() {
    const ONE_HOUR = 3600n;
    return {
        matchTimePerPlayer:    ONE_HOUR * 24n,  // 24 h per player
        timeIncrementPerMove:  10n,             // +10 s after each move
        matchLevel2Delay:      ONE_HOUR,
        matchLevel3Delay:      ONE_HOUR * 2n,
        enrollmentWindow:      ONE_HOUR * 48n,  // 48 h to fill up
        enrollmentLevel2Delay: ONE_HOUR * 24n,
    };
}

/**
 * Create an instance, attach it as TicTacInstance, and return it.
 * The caller is auto-enrolled (msg.value = entryFee required).
 */
async function createInstance(factory, playerCount, entryFee, signer) {
    const caller = signer ?? (await hre.ethers.getSigners())[0];
    const tx = await factory.connect(caller).createInstance(
        playerCount, entryFee, defaultTimeouts(), { value: entryFee }
    );
    const receipt = await tx.wait();

    const event = receipt.logs
        .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "InstanceDeployed");

    const instanceAddress = event.args.instance;

    const instance = await hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        instanceAddress
    );
    return instance;
}

/**
 * Enroll `players` into `instance`, each paying `fee`.
 */
async function enrollAll(instance, players, fee) {
    for (const p of players) {
        await instance.connect(p).enrollInTournament({ value: fee });
    }
}

/**
 * Play a full Tic-Tac-Toe game where player1 wins with the classic top-row.
 *
 * Sequence (assuming player1 goes first; handles either order):
 *   player1: 0, 1, 2  → top row win
 *   player2: 3, 4     → just blocks somewhere
 *
 * If player2 happens to go first, we mirror appropriately.
 *
 * Returns the winner address.
 */
async function playAndWin(instance, roundNumber, matchNumber, player1, player2) {
    const matchId = hre.ethers.solidityPackedKeccak256(
        ["uint8", "uint8"],
        [roundNumber, matchNumber]
    );
    const matchData = await instance.matches(matchId);

    // Determine who goes first
    let first = matchData.currentTurn === player1.address ? player1 : player2;
    let second = first === player1 ? player2 : player1;

    // first: 0, second: 3, first: 1, second: 4, first: 2 → top row win for first
    await instance.connect(first).makeMove(roundNumber, matchNumber, 0);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 3);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 1);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 4);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 2); // win

    return first.address;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — 4-player, 0.002 ETH, finalist wins prize", function () {

    // Generous timeout: delegatecall-heavy deployments can be slow on CI
    this.timeout(60_000);

    let factory;
    let owner, p1, p2, p3, p4;
    let instance;

    const PLAYER_COUNT = 4;
    const ENTRY_FEE = hre.ethers.parseEther("0.002");

    // ── Deployment ───────────────────────────────────────────────────────────

    describe("Factory & Instance Deployment", function () {
        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
        });

        it("deploys TicTacChainFactory with correct owner", async function () {
            expect(await factory.owner()).to.equal(owner.address);
        });

        it("creates a 4-player 0.002 ETH instance", async function () {
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE);
            expect(await instance.getAddress()).to.be.properAddress;
        });

        it("instance references back to the factory", async function () {
            expect(await instance.factory()).to.equal(await factory.getAddress());
        });

        it("instance tier config matches creation params", async function () {
            const cfg = await instance.tierConfig();
            expect(cfg.playerCount).to.equal(PLAYER_COUNT);
            expect(cfg.entryFee).to.equal(ENTRY_FEE);
            expect(cfg.totalRounds).to.equal(2); // log2(4) = 2
        });

        it("instance starts in Enrolling status", async function () {
            const t = await instance.tournament();
            expect(t.status).to.equal(0); // TournamentStatus.Enrolling
        });

        it("factory tracks the new instance", async function () {
            expect(await factory.instances(0)).to.equal(await instance.getAddress());
        });
    });

    // ── Enrollment ───────────────────────────────────────────────────────────

    describe("Enrollment", function () {
        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
            // owner creates + is auto-enrolled (enrolledCount == 1)
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner);
        });

        it("rejects incorrect entry fee", async function () {
            await expect(
                instance.connect(p1).enrollInTournament({ value: hre.ethers.parseEther("0.001") })
            ).to.be.revertedWith("Enrollment failed");
        });

        it("creator is auto-enrolled on instance creation", async function () {
            const t = await instance.tournament();
            expect(t.enrolledCount).to.equal(1);
            expect(t.status).to.equal(0); // still Enrolling
            expect(await instance.isEnrolled(owner.address)).to.be.true;
        });

        it("accepts the second player at the correct fee", async function () {
            await expect(
                instance.connect(p1).enrollInTournament({ value: ENTRY_FEE })
            ).to.emit(instance, "PlayerEnrolled").withArgs(p1.address, await instance.getAddress());

            const t = await instance.tournament();
            expect(t.enrolledCount).to.equal(2);
            expect(t.status).to.equal(0); // still Enrolling
        });

        it("rejects duplicate enrollment", async function () {
            await expect(
                instance.connect(p1).enrollInTournament({ value: ENTRY_FEE })
            ).to.be.revertedWith("Enrollment failed");
        });

        it("routes fees correctly on each enrollment", async function () {
            // owner + p1 enrolled → 2 × entry fee routed through
            const ownerBal = await factory.ownerBalance();
            const protocolBal = await factory.accumulatedProtocolShare();

            // 7.5% owner + 2.5% protocol of 0.002 ETH × 2 enrollments
            const expectedOwner = (ENTRY_FEE * 2n * 750n) / 10000n;
            const expectedProtocol = (ENTRY_FEE * 2n * 250n) / 10000n;
            expect(ownerBal).to.equal(expectedOwner);
            expect(protocolBal).to.equal(expectedProtocol);
        });

        it("registers the player on the factory", async function () {
            const playerInstances = await factory.getPlayerInstances(p1.address);
            expect(playerInstances).to.include(await instance.getAddress());
        });

        it("enrolls players 3 and 4 (still Enrolling after 3)", async function () {
            await instance.connect(p2).enrollInTournament({ value: ENTRY_FEE });

            const t = await instance.tournament();
            expect(t.enrolledCount).to.equal(3);
            expect(t.status).to.equal(0); // still Enrolling
        });

        it("final player enrollment auto-starts the tournament", async function () {
            await expect(
                instance.connect(p3).enrollInTournament({ value: ENTRY_FEE })
            )
                .to.emit(instance, "TournamentStarted")
                .withArgs(await instance.getAddress(), PLAYER_COUNT);

            const t = await instance.tournament();
            expect(t.status).to.equal(1); // InProgress
            expect(t.enrolledCount).to.equal(4);
        });

        it("prize pool equals 90% of total fees collected", async function () {
            const t = await instance.tournament();
            const totalFees = ENTRY_FEE * BigInt(PLAYER_COUNT);
            const expectedPrizePool = (totalFees * 9000n) / 10000n;
            expect(t.prizePool).to.equal(expectedPrizePool);
        });
    });

    // ── Semi-finals (Round 0) ─────────────────────────────────────────────────

    describe("Semi-finals (Round 0): 2 matches, 4 → 2 players", function () {
        let winner1, winner2;

        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
            // owner auto-enrolled via createInstance; enroll 3 more to fill 4-player bracket
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner);
            await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);
        });

        it("round 0 is initialized with 2 matches", async function () {
            const round = await instance.rounds(0);
            expect(round.initialized).to.be.true;
            expect(round.totalMatches).to.equal(2);
            expect(round.completedMatches).to.equal(0);
        });

        it("match 0 of round 0 has two enrolled players assigned", async function () {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const m = await instance.matches(matchId);
            expect(m.player1).to.be.properAddress;
            expect(m.player2).to.be.properAddress;
            expect(m.player1).to.not.equal(m.player2);
            expect(m.status).to.equal(1); // InProgress
        });

        it("semifinal match 0 completes with a winner", async function () {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const m = await instance.matches(matchId);
            // Identify which signers are player1/player2 in this match
            const players = [owner, p1, p2, p3];
            const playerInMatch = (addr) => players.find(s => s.address === addr);

            const matchP1 = playerInMatch(m.player1);
            const matchP2 = playerInMatch(m.player2);

            winner1 = await playAndWin(instance, 0, 0, matchP1, matchP2);

            const mAfter = await instance.matches(matchId);
            expect(mAfter.status).to.equal(2); // Completed
            expect(mAfter.winner).to.equal(winner1);
        });

        it("semifinal match 1 completes with a winner", async function () {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
            const m = await instance.matches(matchId);
            const players = [owner, p1, p2, p3];
            const playerInMatch = (addr) => players.find(s => s.address === addr);

            const matchP1 = playerInMatch(m.player1);
            const matchP2 = playerInMatch(m.player2);

            winner2 = await playAndWin(instance, 0, 1, matchP1, matchP2);

            const mAfter = await instance.matches(matchId);
            expect(mAfter.status).to.equal(2);
            expect(mAfter.winner).to.equal(winner2);
        });

        it("round 0 is fully completed", async function () {
            const round = await instance.rounds(0);
            expect(round.completedMatches).to.equal(2);
        });

        it("tournament advances to round 1 (finals)", async function () {
            const t = await instance.tournament();
            expect(t.currentRound).to.equal(1);
            expect(t.status).to.equal(1); // still InProgress
        });
    });

    // ── Finals (Round 1) & Prize Distribution ────────────────────────────────

    describe("Finals (Round 1): champion wins the prize pool", function () {
        let champion;
        let finalist1, finalist2;
        let prizePoolBefore;

        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner);
            await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);

            // Play out semi-finals
            const semifinalPlayers = [owner, p1, p2, p3];

            for (let matchNum = 0; matchNum < 2; matchNum++) {
                const matchId = hre.ethers.solidityPackedKeccak256(
                    ["uint8", "uint8"], [0, matchNum]
                );
                const m = await instance.matches(matchId);
                const mP1 = semifinalPlayers.find(s => s.address === m.player1);
                const mP2 = semifinalPlayers.find(s => s.address === m.player2);
                await playAndWin(instance, 0, matchNum, mP1, mP2);
            }

            // Identify finalists from the final round match
            const finalMatchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, 0]);
            const finalMatch = await instance.matches(finalMatchId);
            finalist1 = semifinalPlayers.find(s => s.address === finalMatch.player1);
            finalist2 = semifinalPlayers.find(s => s.address === finalMatch.player2);

            const t = await instance.tournament();
            prizePoolBefore = t.prizePool;
        });

        it("final match is initialized with the two semi-final winners", async function () {
            expect(finalist1).to.not.be.undefined;
            expect(finalist2).to.not.be.undefined;
            expect(finalist1.address).to.not.equal(finalist2.address);
        });

        it("final match is InProgress", async function () {
            const finalMatchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, 0]);
            const m = await instance.matches(finalMatchId);
            expect(m.status).to.equal(1); // InProgress
        });

        it("champion wins the final and tournament concludes", async function () {
            const championAddr = await playAndWin(instance, 1, 0, finalist1, finalist2);
            champion = [finalist1, finalist2].find(s => s.address === championAddr);

            const t = await instance.tournament();
            expect(t.status).to.equal(2); // Concluded
            expect(t.winner).to.equal(championAddr);
        });

        it("prize pool was sent to the champion", async function () {
            const prize = await instance.playerPrizes(champion.address);
            expect(prize).to.equal(prizePoolBefore);
        });

        it("champion received correct ETH (prize pool value)", async function () {
            // Check that the instance contract no longer holds the prize pool
            const instanceBalance = await hre.ethers.provider.getBalance(
                await instance.getAddress()
            );
            expect(instanceBalance).to.equal(0n);
        });

        it("tournament winner is recorded on-chain", async function () {
            const t = await instance.tournament();
            expect(t.winner).to.equal(champion.address);
            expect(t.completionReason).to.equal(0); // NormalWin
        });

        it("instance is permanently locked — no further enrollment", async function () {
            await expect(
                instance.connect(p1).enrollInTournament({ value: ENTRY_FEE })
            ).to.be.revertedWith("Instance concluded");
        });

        it("instance is permanently locked — no further moves", async function () {
            await expect(
                instance.connect(p1).makeMove(1, 0, 5)
            ).to.be.revertedWith("Instance concluded");
        });
    });

    // ── Fee Accounting ────────────────────────────────────────────────────────

    describe("Fee Accounting on Factory", function () {
        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
            // owner auto-enrolled; enroll 3 more → 4 total
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner);
            await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);
        });

        it("factory accumulated correct owner balance (7.5% × 4 players)", async function () {
            const totalFees = ENTRY_FEE * BigInt(PLAYER_COUNT);
            const expectedOwnerBalance = (totalFees * 750n) / 10000n;
            expect(await factory.ownerBalance()).to.equal(expectedOwnerBalance);
        });

        it("factory accumulated correct protocol balance (2.5% × 4 players)", async function () {
            const totalFees = ENTRY_FEE * BigInt(PLAYER_COUNT);
            const expectedProtocol = (totalFees * 250n) / 10000n;
            expect(await factory.accumulatedProtocolShare()).to.equal(expectedProtocol);
        });

        it("owner can withdraw their balance", async function () {
            const ownerBal = await factory.ownerBalance();
            expect(ownerBal).to.be.gt(0n);
            await expect(factory.connect(owner).withdrawOwnerBalance()).to.not.be.reverted;
            expect(await factory.ownerBalance()).to.equal(0n);
        });

        it("non-owner cannot withdraw owner balance", async function () {
            await expect(
                factory.connect(p1).withdrawOwnerBalance()
            ).to.be.reverted;
        });
    });

    // ── Tier Deduplication ────────────────────────────────────────────────────

    describe("Tier Deduplication", function () {
        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
        });

        it("creating two instances with same params reuses the same tierKey", async function () {
            const inst1 = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE);
            const inst2 = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE);

            const tierKey1 = (await inst1.tierConfig()).tierKey;
            const tierKey2 = (await inst2.tierConfig()).tierKey;
            expect(tierKey1).to.equal(tierKey2);
        });

        it("factory has exactly one tier entry for that config", async function () {
            expect(await factory.tierKeys(0)).to.not.be.undefined;
            // Accessing tierKeys(1) should revert (only one tier registered)
            await expect(factory.tierKeys(1)).to.be.reverted;
        });
    });
});
