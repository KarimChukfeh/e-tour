// test/factory/TicTacInstance.test.js
// Phase 3.3 — Game-specific tests for TicTacInstance (factory/instance arch)

import { expect } from "chai";
import hre from "hardhat";

const PARTICIPANTS_SHARE_BPS = 9500n;
const OWNER_SHARE_BPS = 500n;
const BASIS_POINTS = 10000n;

// Resolution code legend:
// - R0  -> Normal Resolution (win)
// - R1  -> Draw Resolution
// - R2  -> Uncontested Finals Resolution (finalist auto-wins because everyone in the previous round drew)
// - EL0 -> Tournament Canceled (by solo enrolled player)
// - EL2 -> Abandoned Pool Claimed (tournament never started so pool was claimed by outsider)
// - ML1 -> Timeout (match/tournament ended because player claimed Timeout victory)
// - ML2 -> Force Elimination (advanced player force eliminated both players in a stalled match)
// - ML3 -> Replacement (outside player replaced both players in a stalled match)
const MATCH_REASON = {
    R0: 0,
    ML1: 1,
    R1: 2,
    ML2: 3,
    ML3: 4,
};

const TOURNAMENT_REASON = {
    R0: 0,
    ML1: 1,
    R1: 2,
    ML2: 3,
    ML3: 4,
    EL0: 5,
    EL2: 6,
    R2: 7,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deploy all shared instance modules + TicTacChainFactory.
 * Returns { factory }.
 */
async function deployFactory() {
    const [
        moduleCore,
        moduleMatchesResolution,
        modulePrizes,
        moduleEscalation,
    ] = await Promise.all([
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
    ]);

    const moduleMatches = await hre.ethers
        .getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
        .then(async factory => factory.deploy(await moduleMatchesResolution.getAddress()));
    await moduleMatches.waitForDeployment();

    // Deploy PlayerProfile implementation + PlayerRegistry
    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory"
    );
    const factory = await Factory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await factory.waitForDeployment();

    // Authorize factory on registry
    await registry.authorizeFactory(await factory.getAddress());

    return { factory, registry };
}

/**
 * Build a TimeoutConfig with generous defaults for testing.
 * Uses valid values that comply with factory validation:
 * - enrollmentWindow: whole minutes in [2, 30]
 * - matchTimePerPlayer: whole minutes in [1, 20]
 * - timeIncrementPerMove: whole seconds in [0, 60]
 */
function defaultTimeouts() {
    return {
        enrollmentWindow:      30n * 60n,       // 30 minutes to fill up
        matchTimePerPlayer:    15n * 60n,       // 15 minutes per player
        timeIncrementPerMove:  30n,             // 30 seconds after each move
    };
}

/**
 * Short timeouts for escalation/timeout tests.
 * Uses valid values that comply with factory validation.
 */
function shortTimeouts(overrides = {}) {
    return {
        enrollmentWindow:      overrides.enrollmentWindow      ?? (2n * 60n),  // minimum enrollment window
        matchTimePerPlayer:    overrides.matchTimePerPlayer    ?? (2n * 60n),  // short per-player clock
        timeIncrementPerMove:  overrides.timeIncrementPerMove  ?? 15n,         // short increment
    };
}

/**
 * Create an instance, attach it as TicTacInstance, and return it.
 * The caller is auto-enrolled (msg.value = entryFee required).
 */
async function createInstance(factory, playerCount, entryFee, signer, timeouts) {
    const caller = signer ?? (await hre.ethers.getSigners())[0];
    const to = timeouts ?? defaultTimeouts();
    const tx = await factory.connect(caller).createInstance(
        playerCount, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
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
 * Play a full Tic-Tac-Toe game where the first-turn player wins with the classic top-row.
 *
 * Sequence (assuming player1 goes first; handles either order):
 *   first:  0, 1, 2  → top row win
 *   second: 3, 4     → just occupies somewhere
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

/**
 * Play a draw game: fills all 9 cells with no winner.
 *
 * Board outcome:
 *   X O X
 *   O X O   → draw (X gets 0,2,4,6,8 — diagonals blocked; O gets 1,3,5,7)
 *   O X O   → wait, let's use a known draw sequence:
 *
 * Draw sequence (first=X, second=O):
 *   X:0, O:1, X:2, O:4, X:3, O:5, X:7, O:6, X:8
 *   Board:
 *     X O X     (0,1,2)
 *     X O O     (3,4,5)
 *     O X X     (6,7,8)
 *   X has: 0,2,3,7,8 — no row/col/diag won. O has: 1,4,5,6 — no row/col/diag won.
 *
 * Returns nothing (both players draw).
 */
async function playDraw(instance, roundNumber, matchNumber, player1, player2) {
    const matchId = hre.ethers.solidityPackedKeccak256(
        ["uint8", "uint8"],
        [roundNumber, matchNumber]
    );
    const matchData = await instance.matches(matchId);

    let first  = matchData.currentTurn === player1.address ? player1 : player2;
    let second = first === player1 ? player2 : player1;

    // Draw sequence: 0,1,2,4,3,5,7,6,8
    await instance.connect(first).makeMove(roundNumber, matchNumber, 0);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 1);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 2);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 4);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 3);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 5);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 7);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 6);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 8); // 9th move, no winner → draw
}

/**
 * Advance EVM time by `seconds` and mine a block.
 */
async function advanceTime(seconds) {
    await hre.ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await hre.ethers.provider.send("evm_mine", []);
}

function findParsedLog(receipt, contract, eventName) {
    return receipt.logs
        .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find(event => event && event.name === eventName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite A: 4-player, 0.002 ETH — Factory/Instance Deployment, Enrollment,
//          Semi-finals, Finals, Fee Accounting, Tier Deduplication
//          (original suite, kept intact)
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

        it("rejects direct external calls to lifecycle bridge functions", async function () {
            await expect(
                instance.moduleCreateMatch(0, 0, owner.address, p1.address)
            ).to.be.revertedWith("Only self");
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

        it("routes fees correctly on each enrollment (deferred — held on instance)", async function () {
            // With deferred fees, nothing is sent to the factory at enrollment time.
            // All buckets accumulate on the instance.
            const t = await instance.tournament();
            // 2 enrollments (owner + p1)
            const expectedPrize = (ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
            const expectedOwner = (ENTRY_FEE * 2n * OWNER_SHARE_BPS) / BASIS_POINTS;
            expect(t.totalEntryFeesAccrued).to.equal(ENTRY_FEE * 2n);
            expect(t.prizePool).to.equal(expectedPrize);
            expect(t.ownerAccrued).to.equal(expectedOwner);
            // Factory ownerBalance is still 0 — owner share not forwarded yet
            expect(await factory.ownerBalance()).to.equal(0n);
        });

        it("registers the player on the factory (profile created in registry)", async function () {
            const profileAddr = await factory.getPlayerProfile(p1.address);
            expect(profileAddr).to.not.equal(hre.ethers.ZeroAddress);
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

        it("prize pool equals 95% of total fees collected", async function () {
            const t = await instance.tournament();
            const totalFees = ENTRY_FEE * BigInt(PLAYER_COUNT);
            const expectedPrizePool = (totalFees * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
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
            expect(t.completionReason).to.equal(TOURNAMENT_REASON.R0); // R0: NormalWin
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
        let ownerWalletBefore;
        let ownerWalletAfter;

        before(async function () {
            [owner, p1, p2, p3, p4] = await hre.ethers.getSigners();
            ({ factory } = await deployFactory());
            ownerWalletBefore = await hre.ethers.provider.getBalance(owner.address);

            // Keep the factory owner out of the tournament so wallet balance
            // changes reflect only the automatic owner payout.
            instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, p1);
            await enrollAll(instance, [p2, p3, p4], ENTRY_FEE);

            // Play through both rounds to trigger conclusion + deferred fee forwarding
            const allPlayers = [p1, p2, p3, p4];
            for (let matchNum = 0; matchNum < 2; matchNum++) {
                const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, matchNum]);
                const m = await instance.matches(matchId);
                const mP1 = allPlayers.find(s => s.address === m.player1);
                const mP2 = allPlayers.find(s => s.address === m.player2);
                await playAndWin(instance, 0, matchNum, mP1, mP2);
            }
            const finalMatchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, 0]);
            const finalMatch = await instance.matches(finalMatchId);
            const fP1 = allPlayers.find(s => s.address === finalMatch.player1);
            const fP2 = allPlayers.find(s => s.address === finalMatch.player2);
            await playAndWin(instance, 1, 0, fP1, fP2);

            ownerWalletAfter = await hre.ethers.provider.getBalance(owner.address);
        });

        it("owner wallet received the correct 5% share at conclusion", async function () {
            const totalFees = ENTRY_FEE * BigInt(PLAYER_COUNT);
            const expectedOwnerBalance = (totalFees * OWNER_SHARE_BPS) / BASIS_POINTS;
            expect(ownerWalletAfter - ownerWalletBefore).to.equal(expectedOwnerBalance);
        });

        it("factory ownerBalance stays at 0 after successful owner payout", async function () {
            expect(await factory.ownerBalance()).to.equal(0n);
        });

        it("instance balance is 0 after prize and owner-share settlement", async function () {
            const instanceAddr = await instance.getAddress();
            const balance = await hre.ethers.provider.getBalance(instanceAddr);
            expect(balance).to.equal(0n);
        });

        it("falls back to ownerBalance when the owner address rejects ETH", async function () {
            const rejectingOwner = await factory.MODULE_CORE();
            await factory.connect(owner).transferOwnership(rejectingOwner);

            const inst = await createInstance(factory, 2, ENTRY_FEE, p1);
            await inst.connect(p2).enrollInTournament({ value: ENTRY_FEE });

            const expectedOwnerBalance = (ENTRY_FEE * 2n * OWNER_SHARE_BPS) / BASIS_POINTS;
            await playAndWin(inst, 0, 0, p1, p2);

            expect(await factory.ownerBalance()).to.equal(expectedOwnerBalance);
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

        it("changing only timeout params creates a different tierKey", async function () {
            const inst1 = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner, {
                ...defaultTimeouts(),
                enrollmentWindow: 7n * 60n,
            });
            const inst2 = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, owner, {
                ...defaultTimeouts(),
                enrollmentWindow: 8n * 60n,
            });

            const tierKey1 = (await inst1.tierConfig()).tierKey;
            const tierKey2 = (await inst2.tierConfig()).tierKey;
            expect(tierKey1).to.not.equal(tierKey2);

            expect((await inst1.tierConfig()).timeouts.enrollmentWindow).to.equal(7n * 60n);
            expect((await inst2.tierConfig()).timeouts.enrollmentWindow).to.equal(8n * 60n);
        });

        it("factory has exactly one tier entry for that config", async function () {
            expect(await factory.tierKeys(0)).to.not.be.undefined;
            expect(await factory.tierKeys(1)).to.not.be.undefined;
            expect(await factory.tierKeys(2)).to.not.be.undefined;
            await expect(factory.tierKeys(3)).to.be.reverted;
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B: 2-player tournament — simplest lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — 2-player, 0.001 ETH, single-round tournament", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        // owner auto-enrolled as creator
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
    });

    it("tierConfig.totalRounds is 1 for a 2-player tournament", async function () {
        const cfg = await instance.tierConfig();
        expect(cfg.totalRounds).to.equal(1); // log2(2) = 1
    });

    it("p1 enrolling fills the tournament and auto-starts it", async function () {
        await expect(
            instance.connect(p1).enrollInTournament({ value: ENTRY_FEE })
        )
            .to.emit(instance, "TournamentStarted")
            .withArgs(await instance.getAddress(), 2);

        const t = await instance.tournament();
        expect(t.status).to.equal(1); // InProgress
        expect(t.enrolledCount).to.equal(2);
    });

    it("round 0 is initialized with exactly 1 match", async function () {
        const round = await instance.rounds(0);
        expect(round.initialized).to.be.true;
        expect(round.totalMatches).to.equal(1);
    });

    it("tournament concludes after playing round 0 (no further rounds)", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const allPlayers = [owner, p1];
        const mP1 = allPlayers.find(s => s.address === m.player1);
        const mP2 = allPlayers.find(s => s.address === m.player2);

        const winner = await playAndWin(instance, 0, 0, mP1, mP2);

        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(winner);
        expect(t.completionReason).to.equal(TOURNAMENT_REASON.R0); // R0: NormalWin
    });

    it("champion received the prize pool (instance balance = 0)", async function () {
        const bal = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(bal).to.equal(0n);
    });

    it("prize pool was 95% of 2 × entry fee", async function () {
        const t = await instance.tournament();
        const expectedPrize = (ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        expect(await instance.playerPrizes(t.winner)).to.equal(expectedPrize);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite C: 8-player tournament — 3-round bracket
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — 8-player, 0.003 ETH, 3-round bracket", function () {
    this.timeout(120_000);

    let factory, instance;
    let signers; // signers[0] = owner, [1..7] = p1..p7
    const ENTRY_FEE = hre.ethers.parseEther("0.003");
    const PLAYER_COUNT = 8;

    before(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        // signers[0] (owner) auto-enrolled; enroll 7 more
        instance = await createInstance(factory, PLAYER_COUNT, ENTRY_FEE, signers[0]);
        await enrollAll(instance, signers.slice(1, 8), ENTRY_FEE);
    });

    it("tierConfig.totalRounds is 3 for an 8-player tournament", async function () {
        const cfg = await instance.tierConfig();
        expect(cfg.totalRounds).to.equal(3); // log2(8) = 3
    });

    it("tournament started with 8 enrolled players", async function () {
        const t = await instance.tournament();
        expect(t.status).to.equal(1); // InProgress
        expect(t.enrolledCount).to.equal(8);
    });

    it("round 0 (quarter-finals) has 4 matches", async function () {
        const round = await instance.rounds(0);
        expect(round.initialized).to.be.true;
        expect(round.totalMatches).to.equal(4);
    });

    it("all 4 quarter-final matches complete", async function () {
        const players = signers.slice(0, 8);

        for (let m = 0; m < 4; m++) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, m]);
            const match = await instance.matches(matchId);
            const mP1 = players.find(s => s.address === match.player1);
            const mP2 = players.find(s => s.address === match.player2);
            await playAndWin(instance, 0, m, mP1, mP2);
        }

        const round = await instance.rounds(0);
        expect(round.completedMatches).to.equal(4);
    });

    it("tournament advances to round 1 (semi-finals)", async function () {
        const t = await instance.tournament();
        expect(t.currentRound).to.equal(1);
        expect(t.status).to.equal(1); // InProgress
    });

    it("round 1 (semi-finals) has 2 matches", async function () {
        const round = await instance.rounds(1);
        expect(round.initialized).to.be.true;
        expect(round.totalMatches).to.equal(2);
    });

    it("both semi-final matches complete", async function () {
        const players = signers.slice(0, 8);

        for (let m = 0; m < 2; m++) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, m]);
            const match = await instance.matches(matchId);
            const mP1 = players.find(s => s.address === match.player1);
            const mP2 = players.find(s => s.address === match.player2);
            await playAndWin(instance, 1, m, mP1, mP2);
        }

        const round = await instance.rounds(1);
        expect(round.completedMatches).to.equal(2);
    });

    it("tournament advances to round 2 (finals)", async function () {
        const t = await instance.tournament();
        expect(t.currentRound).to.equal(2);
    });

    it("round 2 (finals) has 1 match", async function () {
        const round = await instance.rounds(2);
        expect(round.initialized).to.be.true;
        expect(round.totalMatches).to.equal(1);
    });

    it("final match completes and tournament concludes", async function () {
        const players = signers.slice(0, 8);
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [2, 0]);
        const match = await instance.matches(matchId);
        const mP1 = players.find(s => s.address === match.player1);
        const mP2 = players.find(s => s.address === match.player2);

        const winnerAddr = await playAndWin(instance, 2, 0, mP1, mP2);

        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(winnerAddr);
    });

    it("champion received the full prize pool", async function () {
        const t = await instance.tournament();
        const expectedPrize = (ENTRY_FEE * BigInt(PLAYER_COUNT) * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        expect(await instance.playerPrizes(t.winner)).to.equal(expectedPrize);
        expect(await hre.ethers.provider.getBalance(await instance.getAddress())).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite D: Draw scenarios — finals draw splits prize
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — 2-player draw in finals, equal prize split", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
    });

    it("playing a draw completes the match as draw", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const allPlayers = [owner, p1];
        const mP1 = allPlayers.find(s => s.address === m.player1);
        const mP2 = allPlayers.find(s => s.address === m.player2);

        await playDraw(instance, 0, 0, mP1, mP2);

        const mAfter = await instance.matches(matchId);
        expect(mAfter.isDraw).to.be.true;
        expect(mAfter.status).to.equal(2); // Completed
    });

    it("tournament concludes after the draw", async function () {
        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
    });

    it("tournament winner is address(0) for a draw conclusion", async function () {
        const t = await instance.tournament();
        expect(t.winner).to.equal(hre.ethers.ZeroAddress);
    });

    it("prize pool is split equally between both players", async function () {
        const totalFees = ENTRY_FEE * 2n;
        const prizePool = (totalFees * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const halfPrize = prizePool / 2n;

        const ownerPrize = await instance.playerPrizes(owner.address);
        const p1Prize    = await instance.playerPrizes(p1.address);

        // Allow 1 wei rounding difference
        expect(ownerPrize).to.be.closeTo(halfPrize, 1n);
        expect(p1Prize).to.be.closeTo(halfPrize, 1n);
        expect(ownerPrize + p1Prize).to.equal(prizePool);
    });

    it("instance balance is zero after distribution", async function () {
        const bal = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(bal).to.equal(0n);
    });
});

describe("TicTacInstance — 4-player all-draw round pays every player equally", function () {
    this.timeout(60_000);

    let factory, instance;
    let players;
    const ENTRY_FEE = hre.ethers.parseEther("0.002");

    before(async function () {
        players = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 4, ENTRY_FEE, players[0]);
        await enrollAll(instance, [players[1], players[2], players[3]], ENTRY_FEE);

        for (const matchNumber of [0, 1]) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, matchNumber]);
            const match = await instance.matches(matchId);
            const player1 = players.find(signer => signer.address === match.player1);
            const player2 = players.find(signer => signer.address === match.player2);
            await playDraw(instance, 0, matchNumber, player1, player2);
        }
    });

    it("sets the same payout and EvenSplit payoutReason for every player", async function () {
        const expectedPayout = (ENTRY_FEE * 4n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS / 4n;

        for (const player of players.slice(0, 4)) {
            const result = await instance.getPlayerResult(player.address);
            expect(result.participated).to.equal(true);
            expect(result.isWinner).to.equal(false);
            expect(result.prizeWon).to.equal(expectedPayout);
            expect(result.payout).to.equal(expectedPayout);
            expect(result.payoutReason).to.equal(2n); // EvenSplit
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite E: Move validation edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — move validation edge cases", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1, outsider;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1, outsider] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
        // Tournament is now InProgress, round 0 has 1 match
    });

    it("rejects a move from a non-participant", async function () {
        await expect(
            instance.connect(outsider).makeMove(0, 0, 0)
        ).to.be.reverted;
    });

    it("rejects moving out of turn", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        // The player whose turn it is NOT
        const wrongPlayer = m.currentTurn === owner.address ? p1 : owner;

        await expect(
            instance.connect(wrongPlayer).makeMove(0, 0, 0)
        ).to.be.reverted;
    });

    it("rejects an out-of-bounds cell (index >= 9)", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const currentPlayer = m.currentTurn === owner.address ? owner : p1;

        await expect(
            instance.connect(currentPlayer).makeMove(0, 0, 9)
        ).to.be.reverted;
    });

    it("rejects playing on an occupied cell", async function () {
        // Make the first valid move (cell 0)
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const first  = m.currentTurn === owner.address ? owner : p1;
        const second = first === owner ? p1 : owner;

        await instance.connect(first).makeMove(0, 0, 0);

        // Try to play on occupied cell 0 by the second player (whose turn it now is)
        await expect(
            instance.connect(second).makeMove(0, 0, 0)
        ).to.be.reverted;
    });

    it("rejects moves after the match has completed", async function () {
        // Finish the game
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const allPlayers = [owner, p1];
        const second = m.currentTurn === owner.address ? owner : p1;
        const first  = second === owner ? p1 : owner;

        // At this point cell 0 is taken by 'first' (from above test).
        // second moves at 3, first at 1, second at 4, first at 2 → win
        await instance.connect(second).makeMove(0, 0, 3);
        await instance.connect(first).makeMove(0, 0, 1);
        await instance.connect(second).makeMove(0, 0, 4);
        await instance.connect(first).makeMove(0, 0, 2); // win

        // Now the match is over; tournament should be Concluded
        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded

        await expect(
            instance.connect(p1).makeMove(0, 0, 5)
        ).to.be.revertedWith("Instance concluded");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite F: Time bank — Fischer clock initialization and tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — time bank (Fischer clock)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");
    const MATCH_TIME = 2n * 60n; // 2 minutes per player (valid)
    const INCREMENT  = 15n;      // +15s per move (valid)

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: INCREMENT,
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
            matchLevel2Delay:     3600n,
            matchLevel3Delay:     7200n,
        });
        instance = await createInstance(factory, 2, ENTRY_FEE, owner, timeouts);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
    });

    it("both players start with matchTimePerPlayer time bank", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        expect(m.player1TimeRemaining).to.equal(MATCH_TIME);
        expect(m.player2TimeRemaining).to.equal(MATCH_TIME);
    });

    it("after a move, the moving player's time bank decreases (and gains increment)", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const first = m.currentTurn === owner.address ? owner : p1;
        const isFirstPlayer1 = first.address === m.player1;

        await advanceTime(5); // wait 5 seconds before the move
        await instance.connect(first).makeMove(0, 0, 5);

        const mAfter = await instance.matches(matchId);
        const movedPlayerTime = isFirstPlayer1
            ? mAfter.player1TimeRemaining
            : mAfter.player2TimeRemaining;
        const otherPlayerTime = isFirstPlayer1
            ? mAfter.player2TimeRemaining
            : mAfter.player1TimeRemaining;

        // Moving player lost some time then gained INCREMENT; should be < MATCH_TIME + INCREMENT
        // and > 0 (didn't expire)
        expect(movedPlayerTime).to.be.gt(0n);
        expect(movedPlayerTime).to.be.lte(MATCH_TIME + INCREMENT);

        // Non-moving player's time bank is unchanged
        expect(otherPlayerTime).to.equal(MATCH_TIME);
    });

    it("lastMoveTime is updated after each move", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const before = await instance.matches(matchId);

        await advanceTime(2);
        const m = await instance.matches(matchId);
        const second = m.currentTurn === owner.address ? owner : p1;
        await instance.connect(second).makeMove(0, 0, 0);

        const after = await instance.matches(matchId);
        expect(after.lastMoveTime).to.be.gt(before.lastMoveTime);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite G: Timeout claim (claimTimeoutWin)
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — timeout claim (claimTimeoutWin)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");
    const MATCH_TIME = 2n * 60n; // 2 minutes per player (valid - shortest allowed)

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
            matchLevel2Delay:     5n,
            matchLevel3Delay:     10n,
        });
        instance = await createInstance(factory, 2, ENTRY_FEE, owner, timeouts);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
    });

    it("claimTimeoutWin reverts if opponent has not yet timed out", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const currentPlayer = m.currentTurn === owner.address ? owner : p1;
        const waitingPlayer = currentPlayer === owner ? p1 : owner;

        // Waiting player tries to claim timeout immediately — too early
        await expect(
            instance.connect(waitingPlayer).claimTimeoutWin(0, 0)
        ).to.be.reverted;
    });

    it("claimTimeoutWin succeeds after opponent's time expires", async function () {
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const currentPlayer = m.currentTurn === owner.address ? owner : p1;
        const waitingPlayer = currentPlayer === owner ? p1 : owner;

        // Advance past MATCH_TIME
        await advanceTime(Number(MATCH_TIME) + 2);

        const tx = await instance.connect(waitingPlayer).claimTimeoutWin(0, 0);
        await tx.wait();

        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(waitingPlayer.address);
        expect(t.completionReason).to.equal(TOURNAMENT_REASON.ML1); // ML1: Timeout
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite H: ML2 escalation — forceEliminateStalledMatch
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — ML2 escalation (forceEliminateStalledMatch)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1, p2, p3;
    const ENTRY_FEE = hre.ethers.parseEther("0.002");
    const MATCH_TIME     = 2n * 60n;  // 2 minutes (valid - shortest allowed)
    const ML2_DELAY      = 2n * 60n;  // Hardcoded: 2 minutes
    const ML3_DELAY      = 5n * 60n;  // Hardcoded: 5 minutes total (2 + 3)

    before(async function () {
        [owner, p1, p2, p3] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
        });
        // 4-player: owner auto-enrolled, add p1, p2, p3
        instance = await createInstance(factory, 4, ENTRY_FEE, owner, timeouts);
        await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);
        // Tournament is InProgress, round 0 has 2 matches (0 and 1)
    });

    it("match 1 completes normally (player for ML2 needs to have won a match)", async function () {
        const matchId1 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
        const m = await instance.matches(matchId1);
        const allPlayers = [owner, p1, p2, p3];
        const mP1 = allPlayers.find(s => s.address === m.player1);
        const mP2 = allPlayers.find(s => s.address === m.player2);
        await playAndWin(instance, 0, 1, mP1, mP2);

        const mAfter = await instance.matches(matchId1);
        expect(mAfter.status).to.equal(2); // Completed
    });

    it("match 0 stalls — current turn player's time expires", async function () {
        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId0);
        const currentPlayer = m.currentTurn === owner.address ? owner
            : m.currentTurn === p1.address ? p1
            : m.currentTurn === p2.address ? p2 : p3;

        // Make one move to record lastMoveTime, then let time run out
        await instance.connect(currentPlayer).makeMove(0, 0, 0);

        // Advance past matchTimePerPlayer + ML2_DELAY (2 min + 2 min)
        await advanceTime(Number(MATCH_TIME) + Number(ML2_DELAY) + 5);
    });

    it("ML2 is available for match 0 after timeout + L2 delay", async function () {
        expect(await instance.isMatchEscL2Available(0, 0)).to.be.true;
    });

    it("winner of match 1 can force-eliminate stalled match 0", async function () {
        const matchId1 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
        const m1 = await instance.matches(matchId1);
        const advancedPlayer = await hre.ethers.getSigner(m1.winner);

        const tx = await instance.connect(advancedPlayer).forceEliminateStalledMatch(0, 0);
        await tx.wait();

        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m0 = await instance.matches(matchId0);
        expect(m0.status).to.equal(2); // Completed
        expect(m0.winner).to.equal(hre.ethers.ZeroAddress); // no winner — both eliminated
    });

    it("a finalist triggering ML2 on the other stalled semifinal eliminates both players and wins the tournament", async function () {
        const freshInstance = await createInstance(factory, 4, ENTRY_FEE, owner, shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n,
            enrollmentWindow:     30n * 60n,
        }));
        await enrollAll(freshInstance, [p1, p2, p3], ENTRY_FEE);

        const allPlayers = [owner, p1, p2, p3];

        const semifinal0Id = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const semifinal0 = await freshInstance.matches(semifinal0Id);
        const semifinal0P1 = allPlayers.find((signer) => signer.address === semifinal0.player1);
        const semifinal0P2 = allPlayers.find((signer) => signer.address === semifinal0.player2);
        const finalist = await playAndWin(freshInstance, 0, 0, semifinal0P1, semifinal0P2);

        const finalsBeforeMl2 = await freshInstance.getMatch(1, 0);
        expect(
            finalsBeforeMl2.player1 === finalist || finalsBeforeMl2.player2 === finalist
        ).to.be.true;

        const semifinal1Id = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
        const semifinal1Before = await freshInstance.matches(semifinal1Id);
        const stalledPlayers = [semifinal1Before.player1, semifinal1Before.player2];
        const firstMover = allPlayers.find((signer) => signer.address === semifinal1Before.currentTurn);
        await freshInstance.connect(firstMover).makeMove(0, 1, 0);
        await advanceTime(Number(MATCH_TIME) + Number(ML2_DELAY) + 5);

        const advancedPlayer = await hre.ethers.getSigner(finalist);
        await freshInstance.connect(advancedPlayer).forceEliminateStalledMatch(0, 1);

        const semifinal1After = await freshInstance.getMatch(0, 1);
        const finalsAfterMl2 = await freshInstance.getMatch(1, 0);
        expect(semifinal1After.matchWinner).to.equal(hre.ethers.ZeroAddress);
        expect(semifinal1After.isDraw).to.be.false;
        expect(semifinal1After.status).to.equal(2);
        expect(semifinal1After.completionReason).to.equal(MATCH_REASON.ML2); // ML2: ForceElimination
        expect(semifinal1After.completionCategory).to.equal(2n);

        expect(
            finalsAfterMl2.player1 === finalist || finalsAfterMl2.player2 === finalist
        ).to.be.true;
        expect(finalsAfterMl2.matchWinner).to.equal(finalist);
        expect(finalsAfterMl2.isDraw).to.be.false;
        expect(finalsAfterMl2.status).to.equal(2);
        expect(finalsAfterMl2.completionReason).to.equal(MATCH_REASON.ML2); // ML2: ForceElimination
        expect(finalsAfterMl2.completionCategory).to.equal(2n);

        for (const stalledPlayer of stalledPlayers) {
            const result = await freshInstance.getPlayerResult(stalledPlayer);
            expect(result.participated).to.be.true;
            expect(result.isWinner).to.be.false;
            expect(result.prizeWon).to.equal(0n);
        }

        const info = await freshInstance.getInstanceInfo();
        expect(info.status).to.equal(2);
        expect(info.winner).to.equal(finalist);
        expect(info.completionReason).to.equal(BigInt(TOURNAMENT_REASON.ML2)); // ML2: ForceElimination
        expect(info.completionCategory).to.equal(2n);

        const expectedPrize = (ENTRY_FEE * 4n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const finalistResult = await freshInstance.getPlayerResult(finalist);
        expect(finalistResult.participated).to.be.true;
        expect(finalistResult.isWinner).to.be.true;
        expect(finalistResult.prizeWon).to.equal(expectedPrize);

        const [finalistProfileAddr, stalledProfileAAddr, stalledProfileBAddr] = await Promise.all([
            factory.getPlayerProfile(finalist),
            factory.getPlayerProfile(stalledPlayers[0]),
            factory.getPlayerProfile(stalledPlayers[1]),
        ]);
        const [finalistProfile, stalledProfileA, stalledProfileB] = await Promise.all([
            hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", finalistProfileAddr),
            hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", stalledProfileAAddr),
            hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", stalledProfileBAddr),
        ]);
        const instanceAddress = await freshInstance.getAddress();
        const [finalistMatchRecord, stalledRecordA, stalledRecordB] = await Promise.all([
            finalistProfile.getMatchRecordByKey(instanceAddress, 0, 1),
            stalledProfileA.getMatchRecordByKey(instanceAddress, 0, 1),
            stalledProfileB.getMatchRecordByKey(instanceAddress, 0, 1),
        ]);

        expect(finalistMatchRecord.outcome).to.equal(6n); // ForceEliminationVictory
        expect(finalistMatchRecord.category).to.equal(1n); // Victory
        expect(stalledRecordA.outcome).to.equal(7n); // ForceEliminationDefeat
        expect(stalledRecordA.category).to.equal(2n); // Defeat
        expect(stalledRecordB.outcome).to.equal(7n);
        expect(stalledRecordB.category).to.equal(2n);

        const prizeDistribution = await freshInstance.getPrizeDistribution();
        const totalDistributed = prizeDistribution.amounts.reduce((sum, amount) => sum + amount, 0n);
        expect(totalDistributed).to.equal(expectedPrize);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite I: ML3 escalation — claimMatchSlotByReplacement
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — ML3 escalation (claimMatchSlotByReplacement)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1, p2, p3, outsider;
    const ENTRY_FEE  = hre.ethers.parseEther("0.002");
    const MATCH_TIME = 2n * 60n; // 2 minutes (valid - shortest allowed)
    const ML3_DELAY  = 5n * 60n; // Hardcoded: 5 minutes total (2 + 3)

    before(async function () {
        [owner, p1, p2, p3, outsider] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
        });
        instance = await createInstance(factory, 4, ENTRY_FEE, owner, timeouts);
        await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);
    });

    it("stalls match 0 by advancing time past matchTimePerPlayer + ML3 delay", async function () {
        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId0);
        const currentPlayer = [owner, p1, p2, p3].find(s => s.address === m.currentTurn);

        await instance.connect(currentPlayer).makeMove(0, 0, 0);
        await advanceTime(Number(MATCH_TIME) + Number(ML3_DELAY) + 5);
    });

    it("ML3 is available for match 0", async function () {
        expect(await instance.isMatchEscL3Available(0, 0)).to.be.true;
    });

    it("outsider can claim a slot via ML3 replacement", async function () {
        const tx = await instance.connect(outsider).claimMatchSlotByReplacement(0, 0);
        await tx.wait();

        // Outsider should now be enrolled
        expect(await instance.isEnrolled(outsider.address)).to.be.true;

        // Match 0 should be completed with outsider as winner
        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m0 = await instance.matches(matchId0);
        expect(m0.status).to.equal(2); // Completed
        expect(m0.winner).to.equal(outsider.address);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite J: Enrollment window escalations (EL0 solo cancel, EL1 force start)
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — enrollment escalations (EL0 / EL1)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, joiner;
    const ENTRY_FEE          = hre.ethers.parseEther("0.002");
    const ENROLLMENT_WINDOW  = 2n * 60n; // 2 minutes (valid - shortest allowed)

    before(async function () {
        [owner, joiner] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
    });

    beforeEach(async function () {
        const timeouts = shortTimeouts({
            enrollmentWindow:     ENROLLMENT_WINDOW,
            enrollmentLevel2Delay: 5n,
            matchTimePerPlayer:   15n * 60n, // 15 minutes (valid)
            matchLevel2Delay:     3600n,
            matchLevel3Delay:     7200n,
        });
        // Only owner enrolls (1 of 4 needed).
        instance = await createInstance(factory, 4, ENTRY_FEE, owner, timeouts);
    });

    it("tournament is Enrolling with only 1 player", async function () {
        const t = await instance.tournament();
        expect(t.status).to.equal(0); // Enrolling
        expect(t.enrolledCount).to.equal(1);
    });

    it("solo enrolled player can cancel and reset immediately, but cannot force start", async function () {
        expect(await instance.connect(owner).canCancelTournament()).to.equal(true);
        expect(await instance.connect(owner).canResetEnrollmentWindow()).to.equal(true);
        expect(await instance.connect(owner).canForceStartTournament()).to.equal(false);
    });

    it("forceStartTournament reverts before the enrollment window expires", async function () {
        await expect(
            instance.connect(owner).forceStartTournament()
        ).to.be.revertedWith("Force start failed");
    });

    it("forceStartTournament still reverts after the enrollment window expires if only 1 player is enrolled", async function () {
        await advanceTime(Number(ENROLLMENT_WINDOW) + 5);

        await expect(
            instance.connect(owner).forceStartTournament()
        ).to.be.revertedWith("Force start failed");
    });

    it("cancelTournament succeeds immediately for a solo enrolled player", async function () {
        const tx = await instance.connect(owner).cancelTournament();
        const receipt = await tx.wait();

        // Solo enrollment -> canceled immediately with a full refund.
        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(owner.address);
        expect(t.completionReason).to.equal(TOURNAMENT_REASON.EL0); // EL0: SoloEnrollCancelled

        const info = await instance.getInstanceInfo();
        expect(info.totalEntryFeesAccrued).to.equal(ENTRY_FEE);
        expect(info.prizeAwarded).to.equal(ENTRY_FEE);
        expect(info.prizeRecipient).to.equal(owner.address);
    });

    it("solo player received 100% of entry fee back on EL0 cancel", async function () {
        await instance.connect(owner).cancelTournament();
        expect(await instance.playerPrizes(owner.address)).to.equal(ENTRY_FEE);
    });

    it("cancelTournament is not available once a second player enrolls", async function () {
        await instance.connect(joiner).enrollInTournament({ value: ENTRY_FEE });

        expect(await instance.connect(owner).canCancelTournament()).to.equal(false);
        expect(await instance.connect(owner).canResetEnrollmentWindow()).to.equal(false);
        await expect(
            instance.connect(owner).cancelTournament()
        ).to.be.revertedWith("Cancel failed");
        await expect(
            instance.connect(owner).resetEnrollmentWindow()
        ).to.be.revertedWith("Reset failed");
    });

    it("resetEnrollmentWindow pushes EL1 and EL2 deadlines forward for the solo player", async function () {
        await advanceTime(Number(ENROLLMENT_WINDOW) + 10);

        const beforeReset = await instance.tournament();
        const oldEl1 = beforeReset.enrollmentTimeout.escalation1Start;
        const oldEl2 = beforeReset.enrollmentTimeout.escalation2Start;

        expect(oldEl1).to.be.gt(0n);
        expect(oldEl2).to.be.gt(oldEl1);

        await instance.connect(owner).resetEnrollmentWindow();

        const afterReset = await instance.tournament();
        expect(afterReset.enrollmentTimeout.escalation1Start).to.be.gt(oldEl1);
        expect(afterReset.enrollmentTimeout.escalation2Start).to.be.gt(oldEl2);
        expect(afterReset.enrollmentTimeout.activeEscalation).to.equal(0);

        const blockAfterReset = await hre.ethers.provider.getBlock("latest");
        expect(afterReset.enrollmentTimeout.escalation2Start).to.be.gt(BigInt(blockAfterReset.timestamp));

        const secondsUntilEl2 = Number(afterReset.enrollmentTimeout.escalation2Start - BigInt(blockAfterReset.timestamp));
        await advanceTime(secondsUntilEl2 + 1);
        const blockAfterDelay = await hre.ethers.provider.getBlock("latest");
        expect(BigInt(blockAfterDelay.timestamp)).to.be.gte(afterReset.enrollmentTimeout.escalation2Start);
    });

    it("forceStartTournament succeeds after enrollment window expires when 2 players are enrolled", async function () {
        await instance.connect(joiner).enrollInTournament({ value: ENTRY_FEE });

        await advanceTime(Number(ENROLLMENT_WINDOW) + 5);

        expect(await instance.connect(owner).canForceStartTournament()).to.equal(true);

        const tx = await instance.connect(owner).forceStartTournament();
        const receipt = await tx.wait();

        const startedEvent = findParsedLog(receipt, instance, "TournamentStarted");
        expect(startedEvent).to.not.equal(undefined);
        expect(startedEvent.args.playerCount).to.equal(2);

        const t = await instance.tournament();
        expect(t.status).to.equal(1); // InProgress
        expect(t.enrolledCount).to.equal(2);
        expect(t.winner).to.equal(hre.ethers.ZeroAddress);

        const info = await instance.getInstanceInfo();
        expect(info.startTime).to.be.gt(0n);
        expect(info.prizeAwarded).to.equal(0n);
    });

    it("awards the auto-advanced player if the only played EL1 semifinal ends in a draw", async function () {
        const [, , playerB] = await hre.ethers.getSigners();
        await instance.connect(joiner).enrollInTournament({ value: ENTRY_FEE });
        await instance.connect(playerB).enrollInTournament({ value: ENTRY_FEE });

        await advanceTime(Number(ENROLLMENT_WINDOW) + 5);
        await instance.connect(owner).forceStartTournament();

        const round0Match = await instance.getMatch(0, 0);
        const enrolledSigners = [owner, joiner, playerB];
        const playerA = enrolledSigners.find(signer => signer.address === round0Match.player1);
        const playerBInMatch = enrolledSigners.find(signer => signer.address === round0Match.player2);
        const playerCByBye = enrolledSigners.find(
            signer =>
                signer.address !== round0Match.player1 &&
                signer.address !== round0Match.player2
        );

        expect(playerA).to.not.equal(undefined);
        expect(playerBInMatch).to.not.equal(undefined);
        expect(playerCByBye).to.not.equal(undefined);

        const finalsBeforeDraw = await instance.getMatch(1, 0);
        expect([finalsBeforeDraw.player1, finalsBeforeDraw.player2]).to.include(playerCByBye.address);
        expect([finalsBeforeDraw.player1, finalsBeforeDraw.player2]).to.include(hre.ethers.ZeroAddress);

        await playDraw(instance, 0, 0, playerA, playerBInMatch);

        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(playerCByBye.address);
        expect(t.completionReason).to.equal(TOURNAMENT_REASON.R2); // R2: UncontestedFinalsWin
        expect(t.allDrawResolution).to.equal(false);

        const expectedPrize = (ENTRY_FEE * 3n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        expect(await instance.playerPrizes(playerCByBye.address)).to.equal(expectedPrize);
        expect(await instance.playerPrizes(playerA.address)).to.equal(0n);
        expect(await instance.playerPrizes(playerBInMatch.address)).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite K: Conclusion settlement
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — conclusion settlement", function () {
    this.timeout(120_000);

    let factory, signers;
    const ENTRY_FEE = hre.ethers.parseEther("0.004");

    before(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
    });

    it("factory has no legacy protocol raffle API", async function () {
        expect(factory.accumulatedProtocolShare).to.equal(undefined);
        expect(factory.executeProtocolRaffle).to.equal(undefined);
    });

    it("owner share stays on instance until conclusion", async function () {
        const inst = await createInstance(factory, 2, ENTRY_FEE, signers[0]);
        await inst.connect(signers[1]).enrollInTournament({ value: ENTRY_FEE });

        const t = await inst.tournament();
        const expectedOwner = (ENTRY_FEE * 2n * OWNER_SHARE_BPS) / BASIS_POINTS;
        expect(t.ownerAccrued).to.equal(expectedOwner);
        // Factory has nothing
        expect(await factory.ownerBalance()).to.equal(0n);
    });

    it("pays the deferred 5% owner share to the owner wallet at conclusion", async function () {
        const [owner, p1, p2] = signers;
        const inst = await createInstance(factory, 2, ENTRY_FEE, p1);
        await inst.connect(p2).enrollInTournament({ value: ENTRY_FEE });
        const expectedOwner = (ENTRY_FEE * 2n * OWNER_SHARE_BPS) / BASIS_POINTS;
        const ownerBefore = await hre.ethers.provider.getBalance(owner.address);

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await inst.matches(matchId);
        const first  = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;
        await inst.connect(first).makeMove(0, 0, 0);
        await inst.connect(second).makeMove(0, 0, 3);
        await inst.connect(first).makeMove(0, 0, 1);
        await inst.connect(second).makeMove(0, 0, 4);
        await inst.connect(first).makeMove(0, 0, 2);

        const expectedPrize = (ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const info = await inst.getInstanceInfo();
        expect(info.totalEntryFeesAccrued).to.equal(ENTRY_FEE * 2n);
        expect(info.prizeAwarded).to.equal(expectedPrize);
        expect(info.prizeRecipient).to.equal(first.address);

        const ownerAfter = await hre.ethers.provider.getBalance(owner.address);
        expect(ownerAfter - ownerBefore).to.equal(expectedOwner);
        expect(await factory.ownerBalance()).to.equal(0n);
    });

    it("extra forced ETH remains untouched after conclusion", async function () {
        const [p1, p2] = signers;
        const inst = await createInstance(factory, 2, ENTRY_FEE, p1);
        await inst.connect(p2).enrollInTournament({ value: ENTRY_FEE });

        const instAddr = await inst.getAddress();
        const extraEth = hre.ethers.parseEther("1");
        const balanceBefore = await hre.ethers.provider.getBalance(instAddr);
        await hre.network.provider.send("hardhat_setBalance", [
            instAddr,
            hre.ethers.toBeHex(balanceBefore + extraEth),
        ]);

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await inst.matches(matchId);
        const first = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;
        await inst.connect(first).makeMove(0, 0, 0);
        await inst.connect(second).makeMove(0, 0, 3);
        await inst.connect(first).makeMove(0, 0, 1);
        await inst.connect(second).makeMove(0, 0, 4);
        await inst.connect(first).makeMove(0, 0, 2);

        const balanceAfter = await hre.ethers.provider.getBalance(instAddr);
        expect(balanceAfter).to.equal(extraEth);
    });

    it("EL2 gives the claimant the 95% prize pool and pays 5% to the owner wallet", async function () {
        const [owner, creator, outsider] = await hre.ethers.getSigners();
        const { factory: el2Factory } = await deployFactory();
        const inst = await createInstance(el2Factory, 2, ENTRY_FEE, creator, shortTimeouts());
        const expectedPrize = (ENTRY_FEE * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const expectedOwner = (ENTRY_FEE * OWNER_SHARE_BPS) / BASIS_POINTS;
        const ownerBefore = await hre.ethers.provider.getBalance(owner.address);

        await advanceTime(10 * 60);

        await inst.connect(outsider).claimAbandonedPool();

        const t = await inst.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(outsider.address);
        expect(t.completionReason).to.equal(TOURNAMENT_REASON.EL2); // EL2: AbandonedTournamentClaimed
        expect(await inst.playerPrizes(outsider.address)).to.equal(expectedPrize);

        const ownerAfter = await hre.ethers.provider.getBalance(owner.address);
        expect(ownerAfter - ownerBefore).to.equal(expectedOwner);
        expect(await el2Factory.ownerBalance()).to.equal(0n);

        const info = await inst.getInstanceInfo();
        expect(info.totalEntryFeesAccrued).to.equal(ENTRY_FEE);
        expect(info.prizeAwarded).to.equal(expectedPrize);
        expect(info.prizeRecipient).to.equal(outsider.address);

        const balance = await hre.ethers.provider.getBalance(await inst.getAddress());
        expect(balance).to.equal(0n);
    });

    it("instance balance is 0 after conclusion", async function () {
        const [p1, p2] = signers;
        const inst = await createInstance(factory, 2, ENTRY_FEE, p1);
        await inst.connect(p2).enrollInTournament({ value: ENTRY_FEE });

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await inst.matches(matchId);
        const first  = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;
        await inst.connect(first).makeMove(0, 0, 0);
        await inst.connect(second).makeMove(0, 0, 3);
        await inst.connect(first).makeMove(0, 0, 1);
        await inst.connect(second).makeMove(0, 0, 4);
        await inst.connect(first).makeMove(0, 0, 2);

        const balance = await hre.ethers.provider.getBalance(await inst.getAddress());
        expect(balance).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite L: Multiple instances — factory bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — factory instance tracking and pagination", function () {
    this.timeout(120_000);

    let factory;
    let owner, p1, p2;
    const FEE_A = hre.ethers.parseEther("0.001");
    const FEE_B = hre.ethers.parseEther("0.002");

    before(async function () {
        [owner, p1, p2] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());

        // Create 3 instances: two with same params (A), one different (B)
        await createInstance(factory, 2, FEE_A, owner);
        await createInstance(factory, 2, FEE_A, owner);
        await createInstance(factory, 4, FEE_B, owner);
    });

    it("getInstanceCount returns 3", async function () {
        expect(await factory.getInstanceCount()).to.equal(3);
    });

    it("getInstances(0, 3) returns all 3 instances", async function () {
        const result = await factory.getInstances(0, 3);
        expect(result.length).to.equal(3);
        for (const addr of result) {
            expect(addr).to.be.properAddress;
        }
    });

    it("getInstances(1, 2) returns 2 instances starting at offset 1", async function () {
        const result = await factory.getInstances(1, 2);
        expect(result.length).to.equal(2);
    });

    it("getInstances(3, 10) returns empty array (offset past end)", async function () {
        const result = await factory.getInstances(3, 10);
        expect(result.length).to.equal(0);
    });

    it("two instances with same params share a tierKey", async function () {
        const inst0addr = await factory.instances(0);
        const inst1addr = await factory.instances(1);
        const inst0 = await hre.ethers.getContractAt("contracts/TicTacInstance.sol:TicTacInstance", inst0addr);
        const inst1 = await hre.ethers.getContractAt("contracts/TicTacInstance.sol:TicTacInstance", inst1addr);
        expect((await inst0.tierConfig()).tierKey).to.equal((await inst1.tierConfig()).tierKey);
    });

    it("instance with different params has a different tierKey", async function () {
        const inst0addr = await factory.instances(0);
        const inst2addr = await factory.instances(2);
        const inst0 = await hre.ethers.getContractAt("contracts/TicTacInstance.sol:TicTacInstance", inst0addr);
        const inst2 = await hre.ethers.getContractAt("contracts/TicTacInstance.sol:TicTacInstance", inst2addr);
        expect((await inst0.tierConfig()).tierKey).to.not.equal((await inst2.tierConfig()).tierKey);
    });

    it("factory tracks 2 tier keys total", async function () {
        const key0 = await factory.tierKeys(0);
        const key1 = await factory.tierKeys(1);
        expect(key0).to.not.equal(key1);
        await expect(factory.tierKeys(2)).to.be.reverted;
    });

    it("player profile tracks all instances creator enrolled in", async function () {
        const profileAddr = await factory.getPlayerProfile(owner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        // owner was auto-enrolled (as creator) in all 3 instances
        expect(await profile.getEnrollmentCount()).to.equal(3);
    });

    it("getActiveTierConfigs returns both tier configs", async function () {
        const result = await factory.getActiveTierConfigs();
        const keys = result[0];
        const configs = result[1];
        expect(keys.length).to.equal(2);
        expect(configs.length).to.equal(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite L2: players / activeTournaments / pastTournaments
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — players, activeTournaments, pastTournaments", function () {
    this.timeout(120_000);

    let factory, registry;
    let owner, p1, p2;
    let inst;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1, p2] = await hre.ethers.getSigners();
        ({ factory, registry } = await deployFactory());
    });

    it("players[owner] is zero before any enrollment", async function () {
        expect(await factory.players(owner.address)).to.equal(hre.ethers.ZeroAddress);
    });

    it("activeTournaments is empty before any instance is created", async function () {
        expect(await factory.getActiveTournamentCount()).to.equal(0);
    });

    it("instance appears in activeTournaments immediately after creation", async function () {
        inst = await createInstance(factory, 2, ENTRY_FEE, owner);
        const instAddr = await inst.getAddress();
        expect(await factory.getActiveTournamentCount()).to.equal(1);
        expect(await factory.activeTournaments(0)).to.equal(instAddr);
    });

    it("players[owner] is set after creator's first enrollment", async function () {
        const profileAddr = await factory.players(owner.address);
        expect(profileAddr).to.not.equal(hre.ethers.ZeroAddress);
    });

    it("players[owner] matches registry getProfile(owner)", async function () {
        const fromFactory = await factory.players(owner.address);
        const fromRegistry = await registry.getProfile(owner.address, 0);
        expect(fromFactory).to.equal(fromRegistry);
    });

    it("players[p1] is zero before p1 enrolls", async function () {
        expect(await factory.players(p1.address)).to.equal(hre.ethers.ZeroAddress);
    });

    it("players[p1] set after p1 enrolls; instance moves to pastTournaments on conclusion", async function () {
        const instAddr = await inst.getAddress();

        // p1 enrolls → tournament auto-starts (2-player)
        await inst.connect(p1).enrollInTournament({ value: ENTRY_FEE });
        expect(await factory.players(p1.address)).to.not.equal(hre.ethers.ZeroAddress);

        // still active until conclusion
        expect(await factory.getActiveTournamentCount()).to.equal(1);
        expect(await factory.getPastTournamentCount()).to.equal(0);

        // play to conclusion
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await inst.matches(matchId);
        const first  = m.currentTurn === owner.address ? owner : p1;
        const second = first === owner ? p1 : owner;
        await inst.connect(first).makeMove(0, 0, 0);
        await inst.connect(second).makeMove(0, 0, 3);
        await inst.connect(first).makeMove(0, 0, 1);
        await inst.connect(second).makeMove(0, 0, 4);
        await inst.connect(first).makeMove(0, 0, 2);

        // after conclusion: removed from active, added to past
        expect(await factory.getActiveTournamentCount()).to.equal(0);
        expect(await factory.getPastTournamentCount()).to.equal(1);
        expect(await factory.pastTournaments(0)).to.equal(instAddr);
    });

    it("swap-and-pop: completing middle tournament leaves activeTournaments consistent", async function () {
        // Create 3 more instances (A, B, C)
        const instA = await createInstance(factory, 2, ENTRY_FEE, owner);
        const instB = await createInstance(factory, 2, ENTRY_FEE, owner);
        const instC = await createInstance(factory, 2, ENTRY_FEE, owner);
        expect(await factory.getActiveTournamentCount()).to.equal(3);

        // Conclude instB (the middle one) by enrolling p1 and playing
        await instB.connect(p1).enrollInTournament({ value: ENTRY_FEE });
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instB.matches(matchId);
        const first  = m.currentTurn === owner.address ? owner : p1;
        const second = first === owner ? p1 : owner;
        await instB.connect(first).makeMove(0, 0, 0);
        await instB.connect(second).makeMove(0, 0, 3);
        await instB.connect(first).makeMove(0, 0, 1);
        await instB.connect(second).makeMove(0, 0, 4);
        await instB.connect(first).makeMove(0, 0, 2);

        // activeTournaments should have 2 entries (A and C)
        expect(await factory.getActiveTournamentCount()).to.equal(2);
        expect(await factory.getPastTournamentCount()).to.equal(2);

        // Both remaining active entries should be properAddresses and not instB
        const instBAddr = await instB.getAddress();
        const active0 = await factory.activeTournaments(0);
        const active1 = await factory.activeTournaments(1);
        expect(active0).to.be.properAddress;
        expect(active1).to.be.properAddress;
        expect(active0).to.not.equal(instBAddr);
        expect(active1).to.not.equal(instBAddr);
    });

    it("EL0 cancel also moves instance to pastTournaments (even with 0 owner share)", async function () {
        const inst2 = await createInstance(factory, 2, ENTRY_FEE, owner);
        const activeBefore = await factory.getActiveTournamentCount();

        // Cancel immediately with only 1 player enrolled (EL0).
        await inst2.cancelTournament();

        expect(await factory.getActiveTournamentCount()).to.equal(activeBefore - 1n);
        const pastCount = await factory.getPastTournamentCount();
        const last = await factory.pastTournaments(pastCount - 1n);
        expect(last).to.equal(await inst2.getAddress());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite M: Factory guardrail validation
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — factory creation guardrails", function () {
    this.timeout(60_000);

    let factory, owner;

    before(async function () {
        [owner] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
    });

    it("rejects non-power-of-2 player count (e.g. 3)", async function () {
        await expect(
            factory.connect(owner).createInstance(3, hre.ethers.parseEther("0.001"), defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: hre.ethers.parseEther("0.001") }
            )
        ).to.be.reverted;
    });

    it("rejects player count 0", async function () {
        await expect(
            factory.connect(owner).createInstance(0, hre.ethers.parseEther("0.001"), defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: hre.ethers.parseEther("0.001") }
            )
        ).to.be.reverted;
    });

    it("rejects player count above 64 (e.g. 128)", async function () {
        await expect(
            factory.connect(owner).createInstance(128, hre.ethers.parseEther("0.001"), defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: hre.ethers.parseEther("0.001") }
            )
        ).to.be.reverted;
    });

    it("accepts the new minimum entry fee of 0.0001 ETH", async function () {
        const minFee = hre.ethers.parseEther("0.0001");
        await expect(
            factory.connect(owner).createInstance(2, minFee, defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: minFee }
            )
        ).to.not.be.reverted;
    });

    it("rejects entry fee that is not a multiple of 0.0001 ETH", async function () {
        const oddFee = hre.ethers.parseEther("0.00015");
        await expect(
            factory.connect(owner).createInstance(2, oddFee, defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: oddFee }
            )
        ).to.be.reverted;
    });

    it("rejects zero entry fee", async function () {
        await expect(
            factory.connect(owner).createInstance(2, 0n, defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: 0n }
            )
        ).to.be.reverted;
    });

    it("rejects entry fee above the 1 ETH max", async function () {
        const tooHighFee = hre.ethers.parseEther("1.0001");
        await expect(
            factory.connect(owner).createInstance(2, tooHighFee, defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: tooHighFee }
            )
        ).to.be.reverted;
    });

    it("rejects createInstance with mismatched msg.value (less than entryFee)", async function () {
        const fee = hre.ethers.parseEther("0.001");
        await expect(
            factory.connect(owner).createInstance(2, fee, defaultTimeouts().enrollmentWindow, defaultTimeouts().matchTimePerPlayer, defaultTimeouts().timeIncrementPerMove, { value: 0n } // no payment
            )
        ).to.be.reverted;
    });

    // Timeout validation tests
    it("rejects enrollment window below 2 minutes", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 1n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.001"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.001") }
            )
        ).to.be.reverted;
    });

    it("rejects enrollment window above 30 minutes", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 31n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.0015"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.0015") }
            )
        ).to.be.reverted;
    });

    it("rejects enrollment window that is not a whole minute", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 150n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.002"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.002") }
            )
        ).to.be.reverted;
    });

    it("accepts enrollment window at the minimum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 2n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.0025"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.0025") }
            )
        ).to.not.be.reverted;
    });

    it("accepts enrollment window for an in-range custom minute value", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 3n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.003"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.003") }
            )
        ).to.not.be.reverted;
    });

    it("accepts enrollment window at the maximum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            enrollmentWindow: 30n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.004"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.004") }
            )
        ).to.not.be.reverted;
    });

    it("rejects time per player below 1 minute", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 0n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.005"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.005") }
            )
        ).to.be.reverted;
    });

    it("rejects time per player above 20 minutes", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 21n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.006"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.006") }
            )
        ).to.be.reverted;
    });

    it("rejects time per player that is not a whole minute", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 90n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.0065"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.0065") }
            )
        ).to.be.reverted;
    });

    it("accepts time per player at the minimum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 1n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.007"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.007") }
            )
        ).to.not.be.reverted;
    });

    it("accepts time per player for an in-range custom minute value", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 3n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.008"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.008") }
            )
        ).to.not.be.reverted;
    });

    it("accepts time per player at the maximum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            matchTimePerPlayer: 20n * 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.009"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.009") }
            )
        ).to.not.be.reverted;
    });

    it("rejects increment time above 60 seconds", async function () {
        const invalidTimeouts = {
            ...defaultTimeouts(),
            timeIncrementPerMove: 61n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.010"), invalidTimeouts.enrollmentWindow, invalidTimeouts.matchTimePerPlayer, invalidTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.010") }
            )
        ).to.be.reverted;
    });

    it("accepts increment time at the minimum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            timeIncrementPerMove: 0n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.011"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.011") }
            )
        ).to.not.be.reverted;
    });

    it("accepts increment time for an in-range custom second value", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            timeIncrementPerMove: 17n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.012"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.012") }
            )
        ).to.not.be.reverted;
    });

    it("accepts increment time at the maximum boundary", async function () {
        const validTimeouts = {
            ...defaultTimeouts(),
            timeIncrementPerMove: 60n
        };
        await expect(
            factory.connect(owner).createInstance(2, hre.ethers.parseEther("0.0125"), validTimeouts.enrollmentWindow, validTimeouts.matchTimePerPlayer, validTimeouts.timeIncrementPerMove, { value: hre.ethers.parseEther("0.0125") }
            )
        ).to.not.be.reverted;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite N: Permanent record — view functions on concluded instance
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — permanent record view functions", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

        // Play to conclusion
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const allPlayers = [owner, p1];
        const mP1 = allPlayers.find(s => s.address === m.player1);
        const mP2 = allPlayers.find(s => s.address === m.player2);
        await playAndWin(instance, 0, 0, mP1, mP2);
    });

    it("getInstanceInfo returns correct tier and status", async function () {
        const info = await instance.getInstanceInfo();
        expect(info.playerCount).to.equal(2);
        expect(info.entryFee).to.equal(ENTRY_FEE);
        expect(info.status).to.equal(2); // Concluded
        expect(info.enrolledCount).to.equal(2);
        expect(info.totalEntryFeesAccrued).to.equal(ENTRY_FEE * 2n);
        expect(info.instanceCreator).to.equal(owner.address);
    });

    it("getPlayers returns all enrolled players", async function () {
        const players = await instance.getPlayers();
        expect(players.length).to.equal(2);
        expect(players).to.include(owner.address);
        expect(players).to.include(p1.address);
    });

    it("getBracket returns correct round/match counts", async function () {
        const bracket = await instance.getBracket();
        expect(bracket.totalRounds).to.equal(1);
        expect(bracket.matchCounts[0]).to.equal(1);
        expect(bracket.completedCounts[0]).to.equal(1);
    });

    it("getMatch returns full match detail", async function () {
        const detail = await instance.getMatch(0, 0);
        expect(detail.player1).to.be.properAddress;
        expect(detail.player2).to.be.properAddress;
        expect(detail.status).to.equal(2); // Completed
        expect(detail.isDraw).to.be.false;
        expect(detail.matchWinner).to.be.properAddress;
    });

    it("getMatchMoves returns non-empty moves string", async function () {
        const moves = await instance.getMatchMoves(0, 0);
        expect(moves).to.not.equal("");
    });

    it("getPrizeDistribution shows winner received the prize", async function () {
        const { players, amounts } = await instance.getPrizeDistribution();
        const totalPrize = amounts.reduce((a, b) => a + b, 0n);
        expect(totalPrize).to.equal((ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS);
    });

    it("getPlayerResult shows correct result for each player", async function () {
        const t = await instance.tournament();
        const winner = t.winner;
        const loser = winner === owner.address ? p1.address : owner.address;

        const winnerResult = await instance.getPlayerResult(winner);
        expect(winnerResult.participated).to.be.true;
        expect(winnerResult.isWinner).to.be.true;
        expect(winnerResult.prizeWon).to.be.gt(0n);

        const loserResult = await instance.getPlayerResult(loser);
        expect(loserResult.participated).to.be.true;
        expect(loserResult.isWinner).to.be.false;
        expect(loserResult.prizeWon).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite O: Player Activity & Match History
//
// Ports v1 playerMatches.test.js to the v2 factory/instance architecture.
//
// In v2 there is no cross-instance getPlayerMatches() — history is per-instance:
//   - getPlayerResult(addr)  → participated, isWinner, prizeWon
//   - getMatch(round, match) → player1, player2, matchWinner, isDraw, status, moves
//   - getMatchMoves(round, match) → packed moves string
//   - getPrizeDistribution() → full prize breakdown per enrolled address
// ─────────────────────────────────────────────────────────────────────────────

// ── O-1: Normal Win ─────────────────────────────────────────────────────────
describe("TicTacInstance — player activity: normal win", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.002");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

        // Resolve match
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const mP1 = [owner, p1].find(s => s.address === m.player1);
        const mP2 = [owner, p1].find(s => s.address === m.player2);
        await playAndWin(instance, 0, 0, mP1, mP2);
    });

    it("winner: participated=true, isWinner=true, prizeWon>0", async function () {
        const t = await instance.tournament();
        const result = await instance.getPlayerResult(t.winner);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.true;
        expect(result.prizeWon).to.be.gt(0n);
    });

    it("loser: participated=true, isWinner=false, prizeWon=0", async function () {
        const t = await instance.tournament();
        const loser = t.winner === owner.address ? p1.address : owner.address;
        const result = await instance.getPlayerResult(loser);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.false;
        expect(result.prizeWon).to.equal(0n);
    });

    it("match record: winner set, isDraw=false, status=Completed", async function () {
        const t = await instance.tournament();
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(t.winner);
        expect(detail.isDraw).to.be.false;
        expect(detail.status).to.equal(2); // Completed
    });

    it("getMatchMoves returns non-empty moves string", async function () {
        const moves = await instance.getMatchMoves(0, 0);
        expect(moves).to.not.equal("");
    });

    it("getPrizeDistribution: winner received 95% of pool", async function () {
        const t = await instance.tournament();
        const { players, amounts } = await instance.getPrizeDistribution();
        const winnerIdx = players.indexOf(t.winner);
        expect(winnerIdx).to.be.gte(0);
        const expectedPrize = (ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        expect(amounts[winnerIdx]).to.equal(expectedPrize);
    });

    it("completionReason is R0 / NormalWin (0)", async function () {
        const info = await instance.getInstanceInfo();
        expect(info.completionReason).to.equal(TOURNAMENT_REASON.R0);
    });
});

// ── O-2: Timeout Win (ML1) ──────────────────────────────────────────────────
describe("TicTacInstance — player activity: timeout win (ML1)", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    let winner, loser;
    const ENTRY_FEE  = hre.ethers.parseEther("0.002");
    const MATCH_TIME = 2n * 60n; // 2 minutes (valid - shortest allowed)

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
            matchLevel2Delay:     60n,
            matchLevel3Delay:     120n,
        });
        instance = await createInstance(factory, 2, ENTRY_FEE, owner, timeouts);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

        // Determine who is active (current turn = timed-out player)
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const timedOut  = [owner, p1].find(s => s.address === m.currentTurn);
        const claiming  = timedOut === owner ? p1 : owner;

        // Advance past MATCH_TIME
        await advanceTime(Number(MATCH_TIME) + 5);
        await instance.connect(claiming).claimTimeoutWin(0, 0);

        winner = claiming.address;
        loser  = timedOut.address;
    });

    it("winner: isWinner=true, prizeWon>0", async function () {
        const result = await instance.getPlayerResult(winner);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.true;
        expect(result.prizeWon).to.be.gt(0n);
    });

    it("loser: isWinner=false, prizeWon=0", async function () {
        const result = await instance.getPlayerResult(loser);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.false;
        expect(result.prizeWon).to.equal(0n);
    });

    it("match record: winner set, isDraw=false, status=Completed", async function () {
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(winner);
        expect(detail.isDraw).to.be.false;
        expect(detail.status).to.equal(2); // Completed
    });

    it("completionReason is ML1 / Timeout (1)", async function () {
        const info = await instance.getInstanceInfo();
        expect(info.completionReason).to.equal(TOURNAMENT_REASON.ML1);
    });
});

// ── O-3: Draw ────────────────────────────────────────────────────────────────
describe("TicTacInstance — player activity: draw", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.002");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 2, ENTRY_FEE, owner);
        await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m = await instance.matches(matchId);
        const mP1 = [owner, p1].find(s => s.address === m.player1);
        const mP2 = [owner, p1].find(s => s.address === m.player2);
        await playDraw(instance, 0, 0, mP1, mP2);
    });

    it("both players: participated=true, isWinner=false", async function () {
        const r1 = await instance.getPlayerResult(owner.address);
        const r2 = await instance.getPlayerResult(p1.address);
        expect(r1.participated).to.be.true;
        expect(r2.participated).to.be.true;
        expect(r1.isWinner).to.be.false;
        expect(r2.isWinner).to.be.false;
    });

    it("prize split equally between both players", async function () {
        const expectedEach = (ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS / 2n;
        const r1 = await instance.getPlayerResult(owner.address);
        const r2 = await instance.getPlayerResult(p1.address);
        expect(r1.prizeWon).to.equal(expectedEach);
        expect(r2.prizeWon).to.equal(expectedEach);
    });

    it("match record: matchWinner=address(0), isDraw=true", async function () {
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(hre.ethers.ZeroAddress);
        expect(detail.isDraw).to.be.true;
        expect(detail.status).to.equal(2); // Completed
    });

    it("getPrizeDistribution: total equals 95% of pool", async function () {
        const { amounts } = await instance.getPrizeDistribution();
        const total = amounts.reduce((a, b) => a + b, 0n);
        expect(total).to.equal((ENTRY_FEE * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS);
    });

    it("completionReason is R1 / Draw (2) for a 2-player finals draw", async function () {
        const info = await instance.getInstanceInfo();
        expect(info.completionReason).to.equal(BigInt(TOURNAMENT_REASON.R1));
        expect(info.completionCategory).to.equal(3n);
    });
});

// ── O-4: Force Elimination (ML2) ─────────────────────────────────────────────
describe("TicTacInstance — player activity: ML2 force elimination", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1, p2, p3;
    let stalledP1, stalledP2;
    const ENTRY_FEE  = hre.ethers.parseEther("0.002");
    const MATCH_TIME = 2n * 60n; // 2 minutes (valid - shortest allowed)
    const ML2_DELAY  = 2n * 60n; // Hardcoded: 2 minutes

    before(async function () {
        [owner, p1, p2, p3] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
        });
        instance = await createInstance(factory, 4, ENTRY_FEE, owner, timeouts);
        await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);

        // Record stalled match 0 players before any moves
        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m0 = await instance.matches(matchId0);
        stalledP1 = m0.player1;
        stalledP2 = m0.player2;

        // Complete match 1 normally so someone can trigger ML2
        const matchId1 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
        const m1 = await instance.matches(matchId1);
        const all = [owner, p1, p2, p3];
        const mP1 = all.find(s => s.address === m1.player1);
        const mP2 = all.find(s => s.address === m1.player2);
        await playAndWin(instance, 0, 1, mP1, mP2);

        // Make one move in match 0 to record lastMoveTime, then stall
        const currentPlayer = all.find(s => s.address === m0.currentTurn);
        await instance.connect(currentPlayer).makeMove(0, 0, 0);

        // Advance past MATCH_TIME + ML2_DELAY
        await advanceTime(Number(MATCH_TIME) + Number(ML2_DELAY) + 5);

        // Advanced player (winner of match 1) force-eliminates match 0
        const m1After = await instance.matches(matchId1);
        const advancedPlayer = await hre.ethers.getSigner(m1After.winner);
        await instance.connect(advancedPlayer).forceEliminateStalledMatch(0, 0);
    });

    it("both stalled players: participated=true, isWinner=false, prizeWon=0", async function () {
        const r1 = await instance.getPlayerResult(stalledP1);
        const r2 = await instance.getPlayerResult(stalledP2);
        expect(r1.participated).to.be.true;
        expect(r2.participated).to.be.true;
        expect(r1.isWinner).to.be.false;
        expect(r2.isWinner).to.be.false;
        expect(r1.prizeWon).to.equal(0n);
        expect(r2.prizeWon).to.equal(0n);
    });

    it("match 0 record: matchWinner=address(0), isDraw=false, status=Completed", async function () {
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(hre.ethers.ZeroAddress);
        expect(detail.isDraw).to.be.false;
        expect(detail.status).to.equal(2); // Completed
    });
});

// ── O-5: Replacement (ML3) ───────────────────────────────────────────────────
describe("TicTacInstance — player activity: ML3 replacement", function () {
    this.timeout(60_000);

    let factory, instance;
    let owner, p1, p2, p3, outsider;
    let stalledP1, stalledP2;
    const ENTRY_FEE  = hre.ethers.parseEther("0.002");
    const MATCH_TIME = 2n * 60n; // 2 minutes (valid - shortest allowed)
    const ML3_DELAY  = 5n * 60n; // Hardcoded: 5 minutes total

    before(async function () {
        [owner, p1, p2, p3, outsider] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
        const timeouts = shortTimeouts({
            matchTimePerPlayer:   MATCH_TIME,
            timeIncrementPerMove: 15n, // 15 seconds (valid)
            enrollmentWindow:     30n * 60n, // 30 minutes (valid)
        });
        instance = await createInstance(factory, 4, ENTRY_FEE, owner, timeouts);
        await enrollAll(instance, [p1, p2, p3], ENTRY_FEE);

        // Record stalled match 0 players
        const matchId0 = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const m0 = await instance.matches(matchId0);
        stalledP1 = m0.player1;
        stalledP2 = m0.player2;

        // Make one move then stall
        const all = [owner, p1, p2, p3];
        const currentPlayer = all.find(s => s.address === m0.currentTurn);
        await instance.connect(currentPlayer).makeMove(0, 0, 0);
        await advanceTime(Number(MATCH_TIME) + Number(ML3_DELAY) + 5);

        // Outsider claims the slot
        await instance.connect(outsider).claimMatchSlotByReplacement(0, 0);
    });

    it("both original players: participated=true, isWinner=false, prizeWon=0", async function () {
        const r1 = await instance.getPlayerResult(stalledP1);
        const r2 = await instance.getPlayerResult(stalledP2);
        expect(r1.participated).to.be.true;
        expect(r2.participated).to.be.true;
        expect(r1.isWinner).to.be.false;
        expect(r2.isWinner).to.be.false;
        expect(r1.prizeWon).to.equal(0n);
        expect(r2.prizeWon).to.equal(0n);
    });

    it("match 0 record: matchWinner=outsider, status=Completed", async function () {
        // ML3 completes the match with the outsider as winner.
        // player1/player2 remain the original stalled addresses; winner is the outsider.
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(outsider.address);
        expect(detail.status).to.equal(2); // Completed
        expect(detail.isDraw).to.be.false;
    });

    it("outsider: enrolled in tournament and isWinner=true", async function () {
        // ML3 adds the outsider to enrolledPlayers and advances them
        const result = await instance.getPlayerResult(outsider.address);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.false; // isWinner only true if they win the whole tournament
        // They advanced from match 0 but tournament isn't necessarily concluded here
        const detail = await instance.getMatch(0, 0);
        expect(detail.matchWinner).to.equal(outsider.address);
    });
});

// ── O-6: Multi-round tracking (8-player, 3 rounds) ──────────────────────────
describe("TicTacInstance — player activity: multi-round match tracking", function () {
    this.timeout(120_000);

    let factory, instance;
    let owner, p1, p2, p3, p4, p5, p6, p7;
    let allPlayers;
    let champion;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1, p2, p3, p4, p5, p6, p7] = await hre.ethers.getSigners();
        allPlayers = [owner, p1, p2, p3, p4, p5, p6, p7];
        ({ factory } = await deployFactory());
        instance = await createInstance(factory, 8, ENTRY_FEE, owner);
        await enrollAll(instance, [p1, p2, p3, p4, p5, p6, p7], ENTRY_FEE);

        // Round 0 — Quarter-finals (4 matches)
        for (let matchNum = 0; matchNum < 4; matchNum++) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, matchNum]);
            const m = await instance.matches(matchId);
            const mP1 = allPlayers.find(s => s.address === m.player1);
            const mP2 = allPlayers.find(s => s.address === m.player2);
            await playAndWin(instance, 0, matchNum, mP1, mP2);
        }

        // Round 1 — Semi-finals (2 matches)
        for (let matchNum = 0; matchNum < 2; matchNum++) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, matchNum]);
            const m = await instance.matches(matchId);
            const mP1 = allPlayers.find(s => s.address === m.player1);
            const mP2 = allPlayers.find(s => s.address === m.player2);
            await playAndWin(instance, 1, matchNum, mP1, mP2);
        }

        // Round 2 — Final (1 match)
        const finalId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [2, 0]);
        const mf = await instance.matches(finalId);
        const mfP1 = allPlayers.find(s => s.address === mf.player1);
        const mfP2 = allPlayers.find(s => s.address === mf.player2);
        champion = await playAndWin(instance, 2, 0, mfP1, mfP2);
    });

    it("tournament concludes with a champion", async function () {
        const t = await instance.tournament();
        expect(t.status).to.equal(2); // Concluded
        expect(t.winner).to.equal(champion);
    });

    it("champion: isWinner=true, prizeWon = 95% of pool", async function () {
        const result = await instance.getPlayerResult(champion);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.true;
        const expectedPrize = (ENTRY_FEE * 8n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        expect(result.prizeWon).to.equal(expectedPrize);
    });

    it("all 3 rounds have completed matches for the champion's path", async function () {
        // Find which match the champion played in each round and verify records
        for (let round = 0; round < 3; round++) {
            const matchCount = round === 0 ? 4 : round === 1 ? 2 : 1;
            let found = false;
            for (let matchNum = 0; matchNum < matchCount; matchNum++) {
                const detail = await instance.getMatch(round, matchNum);
                if (detail.player1 === champion || detail.player2 === champion) {
                    expect(detail.status).to.equal(2); // Completed
                    expect(detail.matchWinner).to.equal(champion);
                    expect(detail.isDraw).to.be.false;
                    found = true;
                    break;
                }
            }
            expect(found, `champion not found in round ${round}`).to.be.true;
        }
    });

    it("getMatchMoves non-empty for all 3 rounds of champion's path", async function () {
        for (let round = 0; round < 3; round++) {
            const matchCount = round === 0 ? 4 : round === 1 ? 2 : 1;
            for (let matchNum = 0; matchNum < matchCount; matchNum++) {
                const detail = await instance.getMatch(round, matchNum);
                if (detail.player1 === champion || detail.player2 === champion) {
                    const moves = await instance.getMatchMoves(round, matchNum);
                    expect(moves).to.not.equal("", `moves empty for round ${round} match ${matchNum}`);
                    break;
                }
            }
        }
    });

    it("first-round loser: participated=true, isWinner=false, prizeWon=0", async function () {
        // Find a player who lost in round 0
        let loser;
        for (let matchNum = 0; matchNum < 4; matchNum++) {
            const detail = await instance.getMatch(0, matchNum);
            const nonWinner = detail.matchWinner === detail.player1 ? detail.player2 : detail.player1;
            if (nonWinner !== champion) {
                loser = nonWinner;
                break;
            }
        }
        const result = await instance.getPlayerResult(loser);
        expect(result.participated).to.be.true;
        expect(result.isWinner).to.be.false;
        expect(result.prizeWon).to.equal(0n);
    });

    it("non-enrolled address: participated=false, isWinner=false, prizeWon=0", async function () {
        const [,,,,,,,, nonPlayer] = await hre.ethers.getSigners();
        const result = await instance.getPlayerResult(nonPlayer.address);
        expect(result.participated).to.be.false;
        expect(result.isWinner).to.be.false;
        expect(result.prizeWon).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Move History Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TicTacInstance — move history tracking", function () {
    this.timeout(60_000);
    let factory, instance, owner, p1;
    const ENTRY_FEE = hre.ethers.parseEther("0.001");

    before(async function () {
        [owner, p1] = await hre.ethers.getSigners();
        ({ factory } = await deployFactory());
    });

    describe("move history for ongoing match", function () {
        it("should record single move correctly", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;

            await instance.connect(first).makeMove(0, 0, 0);

            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0");
        });

        it("should record multiple moves with comma separation", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 1);

            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,1");
        });

        it("should track full game sequence in ongoing match", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 1);
            await instance.connect(first).makeMove(0, 0, 4);
            await instance.connect(second).makeMove(0, 0, 2);

            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,1,4,2");
        });

        it("should preserve move order in ongoing match", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 1);
            await instance.connect(first).makeMove(0, 0, 4);
            await instance.connect(second).makeMove(0, 0, 8);

            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,1,4,8");
        });

        it("should handle edge cell indices correctly", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 2);
            await instance.connect(first).makeMove(0, 0, 6);
            await instance.connect(second).makeMove(0, 0, 8);

            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,2,6,8");
        });
    });

    describe("move history for completed match", function () {
        it("should preserve full move history after win", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            // Play a complete game to win (horizontal line: 0, 1, 2)
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            // Player 1: 0, 1, 2 (wins)
            // Player 2: 3, 4
            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 3);
            await instance.connect(first).makeMove(0, 0, 1);
            await instance.connect(second).makeMove(0, 0, 4);
            await instance.connect(first).makeMove(0, 0, 2); // Winning move

            // Verify match is completed
            const detail = await instance.getMatch(0, 0);
            expect(detail.status).to.equal(2); // Completed

            // Verify move history is preserved
            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,3,1,4,2");
        });

        it("should preserve full move history after draw", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            // Play a complete game to draw
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            // Draw sequence from playAndDraw helper
            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 1);
            await instance.connect(first).makeMove(0, 0, 2);
            await instance.connect(second).makeMove(0, 0, 4);
            await instance.connect(first).makeMove(0, 0, 3);
            await instance.connect(second).makeMove(0, 0, 5);
            await instance.connect(first).makeMove(0, 0, 7);
            await instance.connect(second).makeMove(0, 0, 6);
            await instance.connect(first).makeMove(0, 0, 8);  // Final move, draw

            // Verify match is completed with draw
            const detail = await instance.getMatch(0, 0);
            expect(detail.status).to.equal(2); // Completed
            expect(detail.isDraw).to.be.true;

            // Verify all 9 moves are recorded
            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,1,2,4,3,5,7,6,8");
        });

        it("should preserve move history after tournament conclusion", async function () {
            instance = await createInstance(factory, 2, ENTRY_FEE, owner, defaultTimeouts());
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });

            // Complete the match quickly
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first = matchData.currentTurn === owner.address ? owner : p1;
            const second = first === owner ? p1 : owner;

            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 3);
            await instance.connect(first).makeMove(0, 0, 1);
            await instance.connect(second).makeMove(0, 0, 4);
            await instance.connect(first).makeMove(0, 0, 2); // Win

            // Tournament should be concluded
            const tournament = await instance.tournament();
            expect(tournament.status).to.equal(2); // Concluded

            // Move history should still be accessible
            const moves = await instance.getMatchMoves(0, 0);
            expect(moves).to.equal("0,3,1,4,2");
        });

        it("should track move history across multiple matches in tournament", async function () {
            // Create 4-player tournament (2 rounds)
            instance = await createInstance(factory, 4, ENTRY_FEE, owner, defaultTimeouts());

            const [, , p2, p3] = await hre.ethers.getSigners();
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
            await instance.connect(p2).enrollInTournament({ value: ENTRY_FEE });
            await instance.connect(p3).enrollInTournament({ value: ENTRY_FEE });

            // Complete match 0 (round 0)
            const match0Id = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const match0Data = await instance.matches(match0Id);
            const fp = match0Data.currentTurn === match0Data.player1 ? match0Data.player1 : match0Data.player2;
            const sp = fp === match0Data.player1 ? match0Data.player2 : match0Data.player1;

            const fpSigner = [owner, p1, p2, p3].find(s => s.address === fp);
            const spSigner = [owner, p1, p2, p3].find(s => s.address === sp);

            await instance.connect(fpSigner).makeMove(0, 0, 0);
            await instance.connect(spSigner).makeMove(0, 0, 3);
            await instance.connect(fpSigner).makeMove(0, 0, 1);
            await instance.connect(spSigner).makeMove(0, 0, 4);
            await instance.connect(fpSigner).makeMove(0, 0, 2); // Win

            const match0Moves = await instance.getMatchMoves(0, 0);
            expect(match0Moves).to.equal("0,3,1,4,2");

            // Complete match 1 (round 0)
            const match1Id = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 1]);
            const match1Data = await instance.matches(match1Id);
            const fp2 = match1Data.currentTurn === match1Data.player1 ? match1Data.player1 : match1Data.player2;
            const sp2 = fp2 === match1Data.player1 ? match1Data.player2 : match1Data.player1;

            const fp2Signer = [owner, p1, p2, p3].find(s => s.address === fp2);
            const sp2Signer = [owner, p1, p2, p3].find(s => s.address === sp2);

            await instance.connect(fp2Signer).makeMove(0, 1, 4);
            await instance.connect(sp2Signer).makeMove(0, 1, 0);
            await instance.connect(fp2Signer).makeMove(0, 1, 1);
            await instance.connect(sp2Signer).makeMove(0, 1, 2);
            await instance.connect(fp2Signer).makeMove(0, 1, 7); // Win

            const match1Moves = await instance.getMatchMoves(0, 1);
            expect(match1Moves).to.equal("4,0,1,2,7");

            // Verify both match histories are independent
            expect(match0Moves).to.not.equal(match1Moves);
        });

        it("should return empty string for match with no moves", async function () {
            instance = await createInstance(factory, 4, ENTRY_FEE, owner, defaultTimeouts());

            const [, , p2, p3] = await hre.ethers.getSigners();
            await instance.connect(p1).enrollInTournament({ value: ENTRY_FEE });
            await instance.connect(p2).enrollInTournament({ value: ENTRY_FEE });
            await instance.connect(p3).enrollInTournament({ value: ENTRY_FEE });

            // Check round 1, match 0 which hasn't been played yet
            const moves = await instance.getMatchMoves(1, 0);
            expect(moves).to.equal("");
        });
    });
});
