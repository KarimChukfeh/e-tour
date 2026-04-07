// test/factory/PlayerProfile.test.js
// Tests for:
//   - PlayerProfile: enrollment recording, result push, stats accuracy
//   - PlayerRegistry: clone idempotency, authorization gating
//   - Deferred fee invariant: prizePool + ownerAccrued == entryFee × enrolled
//   - EL0: solo enroll → cancel → 100% refund, owner gets 0
//   - EL2: partial enroll → timeout → claim → 95% to claimant, 5% owner
//   - Normal conclusion: owner gets 5%, winner gets ~95%
//   - Profile auto-updated at conclusion (push model)

import { expect } from "chai";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Constants mirroring the contracts
// ─────────────────────────────────────────────────────────────────────────────

const PARTICIPANTS_SHARE_BPS = 9500n;
const OWNER_SHARE_BPS        = 500n;
const BASIS_POINTS           = 10000n;
const TICTAC_GAME_TYPE       = 0;
const CONNECT_FOUR_GAME_TYPE = 1;

// Resolution code legend:
// - R0  -> Normal Resolution (win)
// - R1  -> Draw Resolution
// - R2  -> Uncontested Finals Resolution (finalist auto-wins because everyone in the previous round drew)
// - EL0 -> Tournament Canceled (by solo enrolled player)
// - EL2 -> Abandoned Pool Claimed (tournament never started so pool was claimed by outsider)
// - ML1 -> Timeout (match/tournament ended because player claimed Timeout victory)
// - ML2 -> Force Elimination (advanced player force eliminated both players in a stalled match)
// - ML3 -> Replacement (outside player replaced both players in a stalled match)
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

const MATCH_REASON = TOURNAMENT_REASON;

// ─────────────────────────────────────────────────────────────────────────────
// Deploy helpers
// ─────────────────────────────────────────────────────────────────────────────

async function deployAll() {
    const [moduleCore, moduleMatchesResolution, modulePrizes, moduleEscalation] = await Promise.all([
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
    ]);

    const moduleMatches = await hre.ethers
        .getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
        .then(async factory => factory.deploy(await moduleMatchesResolution.getAddress()));
    await moduleMatches.waitForDeployment();

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("contracts/TicTacToeFactory.sol:TicTacToeFactory");
    const factory = await Factory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await factory.waitForDeployment();
    await registry.authorizeFactory(await factory.getAddress());

    return { factory, registry, profileImpl };
}

async function deployTwoFactories() {
    const [moduleCore, moduleMatchesResolution, modulePrizes, moduleEscalation] = await Promise.all([
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
    ]);

    const moduleMatches = await hre.ethers
        .getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
        .then(async factory => factory.deploy(await moduleMatchesResolution.getAddress()));
    await moduleMatches.waitForDeployment();

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const TicTacFactory = await hre.ethers.getContractFactory("contracts/TicTacToeFactory.sol:TicTacToeFactory");
    const ticTacFactory = await TicTacFactory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await ticTacFactory.waitForDeployment();

    const ConnectFourFactory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
    const connectFourFactory = await ConnectFourFactory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await connectFourFactory.waitForDeployment();

    await registry.authorizeFactory(await ticTacFactory.getAddress());
    await registry.authorizeFactory(await connectFourFactory.getAddress());

    return { registry, ticTacFactory, connectFourFactory };
}

async function getProfileForGame(registry, player, gameType = TICTAC_GAME_TYPE) {
    return registry.getProfile(player, gameType);
}

function defaultTimeouts() {
    // These must match the validation in ETourFactory:
    // - enrollmentWindow: whole minutes in [2, 30]
    // - matchTimePerPlayer: whole minutes in [1, 20]
    // - timeIncrementPerMove: whole seconds in [0, 60]
    return {
        enrollmentWindow:      2n * 60n,    // 2 minutes
        matchTimePerPlayer:    5n * 60n,    // 5 minutes
        timeIncrementPerMove:  15n,         // 15 seconds
    };
}

function shortTimeouts() {
    // Minimum valid values for quick testing
    return {
        enrollmentWindow:      2n * 60n,    // 2 minutes (minimum allowed)
        matchTimePerPlayer:    1n * 60n,    // 1 minute (minimum allowed)
        timeIncrementPerMove:  0n,          // 0 seconds (minimum allowed)
    };
}

async function createInstance(factory, playerCount, entryFee, signer) {
    const timeouts = defaultTimeouts();
    const tx = await factory.connect(signer).createInstance(
        playerCount,
        entryFee,
        timeouts.enrollmentWindow,
        timeouts.matchTimePerPlayer,
        timeouts.timeIncrementPerMove,
        { value: entryFee }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
        .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "InstanceDeployed");
    return hre.ethers.getContractAt("contracts/TicTacToe.sol:TicTacToe", event.args.instance);
}

async function advanceTime(seconds) {
    await hre.ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await hre.ethers.provider.send("evm_mine", []);
}

async function playAndWin(instance, roundNumber, matchNumber, player1, player2) {
    const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [roundNumber, matchNumber]);
    const matchData = await instance.matches(matchId);
    const first  = matchData.currentTurn === player1.address ? player1 : player2;
    const second = first === player1 ? player2 : player1;
    await instance.connect(first).makeMove(roundNumber, matchNumber, 0);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 3);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 1);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 4);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 2);
    return first.address;
}

async function playDraw(instance, roundNumber, matchNumber, player1, player2) {
    const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [roundNumber, matchNumber]);
    const matchData = await instance.matches(matchId);
    const first = matchData.currentTurn === player1.address ? player1 : player2;
    const second = first === player1 ? player2 : player1;

    await instance.connect(first).makeMove(roundNumber, matchNumber, 0);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 1);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 2);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 4);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 3);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 5);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 7);
    await instance.connect(second).makeMove(roundNumber, matchNumber, 6);
    await instance.connect(first).makeMove(roundNumber, matchNumber, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: PlayerRegistry — authorization & clone idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("PlayerRegistry — authorization & clone idempotency", function () {
    let registry, factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("creates a profile on first enrollment", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);
        await instance.connect(signers[1]).enrollInTournament({ value: entryFee });

        const profileAddr = await getProfileForGame(registry, signers[0].address);
        expect(profileAddr).to.not.equal(hre.ethers.ZeroAddress);
    });

    it("returns the same profile address for repeated enrollments", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const instance1 = await createInstance(factory, 2, entryFee, signers[0]);
        await instance1.connect(signers[1]).enrollInTournament({ value: entryFee });
        const profile1 = await getProfileForGame(registry, signers[0].address);

        // Enroll same player in a second tournament
        const instance2 = await createInstance(factory, 2, entryFee, signers[0]);
        await instance2.connect(signers[1]).enrollInTournament({ value: entryFee });
        const profile2 = await getProfileForGame(registry, signers[0].address);

        expect(profile1).to.equal(profile2);
    });

    it("creates distinct profiles for the same player in different games", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const { registry: sharedRegistry, ticTacFactory, connectFourFactory } = await deployTwoFactories();
        const to = defaultTimeouts();

        await ticTacFactory.connect(signers[0]).createInstance(
            2,
            entryFee,
            to.enrollmentWindow,
            to.matchTimePerPlayer,
            to.timeIncrementPerMove,
            { value: entryFee }
        );

        await connectFourFactory.connect(signers[0]).createInstance(
            2,
            entryFee,
            to.enrollmentWindow,
            to.matchTimePerPlayer,
            to.timeIncrementPerMove,
            { value: entryFee }
        );

        const ticTacProfile = await getProfileForGame(sharedRegistry, signers[0].address, TICTAC_GAME_TYPE);
        const connectFourProfile = await getProfileForGame(sharedRegistry, signers[0].address, CONNECT_FOUR_GAME_TYPE);

        expect(ticTacProfile).to.not.equal(hre.ethers.ZeroAddress);
        expect(connectFourProfile).to.not.equal(hre.ethers.ZeroAddress);
        expect(ticTacProfile).to.not.equal(connectFourProfile);
        expect(await ticTacFactory.getPlayerProfile(signers[0].address)).to.equal(ticTacProfile);
        expect(await connectFourFactory.getPlayerProfile(signers[0].address)).to.equal(connectFourProfile);
    });

    it("rejects recordEnrollment from unauthorized caller", async function () {
        const [, , rando] = signers;
        await expect(
            registry.connect(rando).recordEnrollment(
                rando.address, hre.ethers.ZeroAddress, 0, hre.ethers.parseEther("0.001")
            )
        ).to.be.revertedWithCustomError(registry, "Unauthorized");
    });

    it("allows owner to authorize and deauthorize factories", async function () {
        const [owner, rando] = signers;
        const fakeFactory = rando.address;

        await registry.connect(owner).authorizeFactory(fakeFactory);
        expect(await registry.authorizedFactories(fakeFactory)).to.equal(true);

        await registry.connect(owner).deauthorizeFactory(fakeFactory);
        expect(await registry.authorizedFactories(fakeFactory)).to.equal(false);
    });

    it("rejects authorizeFactory from non-owner", async function () {
        const [, rando] = signers;
        await expect(
            registry.connect(rando).authorizeFactory(rando.address)
        ).to.be.revertedWithCustomError(registry, "Unauthorized");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: PlayerProfile — enrollment & result recording
// ─────────────────────────────────────────────────────────────────────────────

describe("PlayerProfile — enrollment & result recording", function () {
    let registry, factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("recordEnrollment only callable by registry", async function () {
        // Deploy a profile directly (not via registry) to test access control
        const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
        const profile = await ProfileImpl.deploy();
        await profile.waitForDeployment();
        await profile.initialize(signers[0].address, await registry.getAddress());

        await expect(
            profile.connect(signers[1]).recordEnrollment(
                hre.ethers.ZeroAddress, 0, hre.ethers.parseEther("0.001")
            )
        ).to.be.revertedWithCustomError(profile, "Unauthorized");
    });

    it("profile enrollment count increases after enrolling in instances", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);
        await instance.connect(signers[1]).enrollInTournament({ value: entryFee });

        const profileAddr = await getProfileForGame(registry, signers[0].address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);

        expect(await profile.getEnrollmentCount()).to.equal(1n);
    });

    it("profile enrollment record has correct fields", async function () {
        const entryFee = hre.ethers.parseEther("0.002");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);

        const profileAddr = await getProfileForGame(registry, signers[0].address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);

        const records = await profile.getEnrollments(0, 10);
        expect(records.length).to.equal(1);
        expect(records[0].instance).to.equal(await instance.getAddress());
        expect(records[0].entryFee).to.equal(entryFee);
        expect(records[0].gameType).to.equal(BigInt(TICTAC_GAME_TYPE));
        expect(records[0].concluded).to.equal(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Deferred fees invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("Deferred fees — invariant: prizePool + ownerAccrued == entryFee × enrolled", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("holds for 1 enrolled player", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);

        const t = await instance.tournament();
        expect(t.prizePool + t.ownerAccrued).to.equal(entryFee);
    });

    it("holds for 2 enrolled players", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);
        await instance.connect(signers[1]).enrollInTournament({ value: entryFee });

        const t = await instance.tournament();
        expect(t.prizePool + t.ownerAccrued).to.equal(entryFee * 2n);
    });

    it("instance ETH balance equals total deferred fees", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);
        await instance.connect(signers[1]).enrollInTournament({ value: entryFee });

        const balance = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(balance).to.equal(entryFee * 2n);
    });

    it("fee buckets match expected BPS splits", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);

        const t = await instance.tournament();
        expect(t.prizePool).to.equal(entryFee * PARTICIPANTS_SHARE_BPS / BASIS_POINTS);
        expect(t.ownerAccrued).to.equal(entryFee * OWNER_SHARE_BPS / BASIS_POINTS);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: EL0 — solo cancel → 100% refund
// ─────────────────────────────────────────────────────────────────────────────

describe("EL0 — solo enroll → cancel → 100% refund", function () {
    let factory, registry, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("solo player receives 100% of entry fee back", async function () {
        const [solo] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        // Use short enrollment window so we can cancel quickly.
        const timeouts = shortTimeouts();
        const tx = await factory.connect(solo).createInstance(
            2, entryFee, timeouts.enrollmentWindow, timeouts.matchTimePerPlayer, timeouts.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );

        const balanceBefore = await hre.ethers.provider.getBalance(solo.address);
        const cancelTx = await instance.connect(solo).cancelTournament();
        const cancelReceipt = await cancelTx.wait();
        const gasUsed = cancelReceipt.gasUsed * cancelReceipt.gasPrice;
        const balanceAfter = await hre.ethers.provider.getBalance(solo.address);

        // Net change should be ~+entryFee (got full refund back, minus gas)
        const netChange = balanceAfter - balanceBefore + gasUsed;
        expect(netChange).to.equal(entryFee);
    });

    it("owner receives nothing on EL0", async function () {
        const [solo] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        const ownerBalanceBefore = await factory.ownerBalance();

        const timeouts = shortTimeouts();
        const tx = await factory.connect(solo).createInstance(
            2, entryFee, timeouts.enrollmentWindow, timeouts.matchTimePerPlayer, timeouts.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );

        await instance.connect(solo).cancelTournament();

        const ownerBalanceAfter = await factory.ownerBalance();
        expect(ownerBalanceAfter).to.equal(ownerBalanceBefore);
    });

    it("instance balance is 0 after EL0", async function () {
        const [solo] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        const timeouts = shortTimeouts();
        const tx = await factory.connect(solo).createInstance(
            2, entryFee, timeouts.enrollmentWindow, timeouts.matchTimePerPlayer, timeouts.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );

        await instance.connect(solo).cancelTournament();

        const balance = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(balance).to.equal(0n);
    });

    it("profile result stores refund separately from prize on EL0 cancel", async function () {
        const [solo] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        const timeouts = shortTimeouts();
        const tx = await factory.connect(solo).createInstance(
            2, entryFee, timeouts.enrollmentWindow, timeouts.matchTimePerPlayer, timeouts.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );

        await instance.connect(solo).cancelTournament();

        const profileAddr = await getProfileForGame(registry, solo.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const [record, stats] = await Promise.all([
            profile.getEnrollmentByInstance(await instance.getAddress()),
            profile.getStats(),
        ]);

        expect(record.prize).to.equal(0n);
        expect(record.payout).to.equal(entryFee);
        expect(record.payoutReason).to.equal(4n); // Cancelation
        expect(record.tournamentResolutionReason).to.equal(BigInt(TOURNAMENT_REASON.EL0)); // EL0: SoloEnrollCancelled
        expect(stats.totalNetEarnings).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: EL2 — abandoned pool claim → standard fee splits
// ─────────────────────────────────────────────────────────────────────────────

describe("EL2 — partial enroll → abandoned claim → standard fee splits", function () {
    let factory, registry, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("claimer receives 95% of all enrolled entry fees", async function () {
        const [p1, p2, claimer] = signers;
        const entryFee = hre.ethers.parseEther("0.01");
        const expectedPrize = entryFee * 2n * PARTICIPANTS_SHARE_BPS / BASIS_POINTS;

        // Create a 4-player instance; only 2 enroll (p1 auto-enrolled, then p2)
        const to = shortTimeouts();
        const tx = await factory.connect(p1).createInstance(
            4, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        // Advance past EL2 threshold (enrollmentWindow + ENROLLMENT_LEVEL_2_DELAY)
        // enrollmentWindow = 2 minutes, EL2 delay = 2 minutes hardcoded
        await advanceTime(121 + 121); // (2min + 1s) + (2min + 1s)

        const claimerBefore = await hre.ethers.provider.getBalance(claimer.address);
        const claimTx = await instance.connect(claimer).claimAbandonedPool();
        const claimReceipt = await claimTx.wait();
        const gasUsed = claimReceipt.gasUsed * claimReceipt.gasPrice;
        const claimerAfter = await hre.ethers.provider.getBalance(claimer.address);

        // Claimer should receive the 95% prize pool from both enrolled fees.
        const netGain = claimerAfter - claimerBefore + gasUsed;
        expect(netGain).to.equal(expectedPrize);
    });

    it("owner wallet receives the 5% share on EL2", async function () {
        const [owner, p1, , claimer] = signers;
        const entryFee = hre.ethers.parseEther("0.01");
        const expectedOwnerShare = entryFee * OWNER_SHARE_BPS / BASIS_POINTS;
        const ownerBefore = await hre.ethers.provider.getBalance(owner.address);

        const to = shortTimeouts();
        const tx = await factory.connect(p1).createInstance(
            4, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );

        // Wait for enrollment window + EL2 delay (2 min + 2 min = 4 min + buffer)
        await advanceTime(121 + 121);
        await instance.connect(claimer).claimAbandonedPool();

        const ownerAfter = await hre.ethers.provider.getBalance(owner.address);
        expect(ownerAfter - ownerBefore).to.equal(expectedOwnerShare);
        expect(await factory.ownerBalance()).to.equal(0n);
    });

    it("non-enrolled EL2 claimer gets a zero-fee profile enrollment and winning result", async function () {
        const [p1, p2, claimer] = signers;
        const entryFee = hre.ethers.parseEther("0.01");
        const expectedPrize = entryFee * 2n * PARTICIPANTS_SHARE_BPS / BASIS_POINTS;

        const to = shortTimeouts();
        const tx = await factory.connect(p1).createInstance(
            4, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacToe.sol:TicTacToe", event.args.instance
        );
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        await advanceTime(121 + 121);
        await instance.connect(claimer).claimAbandonedPool();

        const profileAddr = await getProfileForGame(registry, claimer.address);
        expect(profileAddr).to.not.equal(hre.ethers.ZeroAddress);

        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const [record, stats] = await Promise.all([
            profile.getEnrollmentByInstance(await instance.getAddress()),
            profile.getStats(),
        ]);

        expect(record.entryFee).to.equal(0n);
        expect(record.concluded).to.equal(true);
        expect(record.won).to.equal(true);
        expect(record.prize).to.equal(expectedPrize);
        expect(record.payout).to.equal(expectedPrize);
        expect(record.payoutReason).to.equal(1n); // Victory
        expect(record.tournamentResolutionReason).to.equal(BigInt(TOURNAMENT_REASON.EL2)); // EL2: AbandonedTournamentClaimed

        expect(stats.totalPlayed).to.equal(1n);
        expect(stats.totalWins).to.equal(1n);
        expect(stats.totalLosses).to.equal(0n);
        expect(stats.totalNetEarnings).to.equal(expectedPrize);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6: Normal 2-player conclusion — fee distribution
// ─────────────────────────────────────────────────────────────────────────────

describe("Normal 2-player conclusion — fee distribution", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("owner wallet receives exactly 5% × 2 players at conclusion", async function () {
        const [owner, p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");
        const ownerBefore = await hre.ethers.provider.getBalance(owner.address);

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        // Play and win
        await playAndWin(instance, 0, 0, p1, p2);

        const ownerAfter = await hre.ethers.provider.getBalance(owner.address);
        const expectedOwnerCut = entryFee * 2n * OWNER_SHARE_BPS / BASIS_POINTS;
        expect(ownerAfter - ownerBefore).to.equal(expectedOwnerCut);
        expect(await factory.ownerBalance()).to.equal(0n);
    });

    it("instance balance is 0 after conclusion", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        await playAndWin(instance, 0, 0, p1, p2);

        const balance = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(balance).to.equal(0n);
    });

    it("winner receives ~95% of total pot", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");
        const totalPot  = entryFee * 2n;
        const expectedPrize = totalPot * PARTICIPANTS_SHARE_BPS / BASIS_POINTS;

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        // Capture balances before conclusion move
        const p1Before = await hre.ethers.provider.getBalance(p1.address);
        const p2Before = await hre.ethers.provider.getBalance(p2.address);

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const isP1Winner = winner === p1.address;

        const p1After = await hre.ethers.provider.getBalance(p1.address);
        const p2After = await hre.ethers.provider.getBalance(p2.address);

        // The winner's net gain (ignoring gas) should roughly equal the prize.
        if (isP1Winner) {
            expect(p1After - p1Before).to.be.gte(expectedPrize - hre.ethers.parseEther("0.002")); // gas tolerance
        } else {
            expect(p2After - p2Before).to.be.gte(expectedPrize - hre.ethers.parseEther("0.002"));
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 8: Profile auto-updated at conclusion (push model)
// ─────────────────────────────────────────────────────────────────────────────

describe("Profile push — stats updated automatically at conclusion", function () {
    let factory, registry, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("finalizes both winner and loser profiles when the winning move uses estimated gas", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await instance.matches(matchId);
        const first = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;

        await instance.connect(first).makeMove(0, 0, 0);
        await instance.connect(second).makeMove(0, 0, 3);
        await instance.connect(first).makeMove(0, 0, 1);
        await instance.connect(second).makeMove(0, 0, 4);

        const estimatedGas = await instance.connect(first).makeMove.estimateGas(0, 0, 2);
        await (await instance.connect(first).makeMove(0, 0, 2, { gasLimit: estimatedGas })).wait();

        const winnerProfileAddr = await getProfileForGame(registry, first.address);
        const loserProfileAddr = await getProfileForGame(registry, second.address);

        const winnerProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", winnerProfileAddr);
        const loserProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", loserProfileAddr);
        const instanceAddress = await instance.getAddress();

        const [winnerRecord, loserRecord] = await Promise.all([
            winnerProfile.getEnrollmentByInstance(instanceAddress),
            loserProfile.getEnrollmentByInstance(instanceAddress),
        ]);

        expect(winnerRecord.concluded).to.equal(true);
        expect(winnerRecord.won).to.equal(true);
        expect(loserRecord.concluded).to.equal(true);
        expect(loserRecord.won).to.equal(false);
    });

    it("winner profile: totalWins=1, totalPlayed=1 after conclusion", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const winnerSigner = winner === p1.address ? p1 : p2;

        const profileAddr = await getProfileForGame(registry, winnerSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const stats = await profile.getStats();

        expect(stats.totalPlayed).to.equal(1n);
        expect(stats.totalWins).to.equal(1n);
        expect(stats.totalLosses).to.equal(0n);
    });

    it("loser profile: totalLosses=1, totalWins=0 after conclusion", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const loserSigner = winner === p1.address ? p2 : p1;

        const profileAddr = await getProfileForGame(registry, loserSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const stats = await profile.getStats();

        expect(stats.totalPlayed).to.equal(1n);
        expect(stats.totalWins).to.equal(0n);
        expect(stats.totalLosses).to.equal(1n);
    });

    it("records EvenSplit payout metadata for every player when an entire round draws", async function () {
        const [p1, p2, p3, p4] = signers;
        const entryFee = hre.ethers.parseEther("0.002");
        const expectedPayout = (entryFee * 4n * PARTICIPANTS_SHARE_BPS / BASIS_POINTS) / 4n;

        const instance = await createInstance(factory, 4, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });
        await instance.connect(p3).enrollInTournament({ value: entryFee });
        await instance.connect(p4).enrollInTournament({ value: entryFee });

        for (const matchNumber of [0, 1]) {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, matchNumber]);
            const match = await instance.matches(matchId);
            const player1 = signers.find(signer => signer.address === match.player1);
            const player2 = signers.find(signer => signer.address === match.player2);
            await playDraw(instance, 0, matchNumber, player1, player2);
        }

        const instanceAddress = await instance.getAddress();
        for (const player of [p1, p2, p3, p4]) {
            const profileAddr = await getProfileForGame(registry, player.address);
            const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
            const record = await profile.getEnrollmentByInstance(instanceAddress);

            expect(record.concluded).to.equal(true);
            expect(record.won).to.equal(false);
            expect(record.prize).to.equal(entryFee * 4n * PARTICIPANTS_SHARE_BPS / BASIS_POINTS);
            expect(record.payout).to.equal(expectedPayout);
            expect(record.payoutReason).to.equal(2n); // EvenSplit
            expect(record.tournamentResolutionReason).to.equal(BigInt(TOURNAMENT_REASON.R1)); // R1: Draw
        }
    });

    it("winner profile: concluded=true, won=true on enrollment record", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const winnerSigner = winner === p1.address ? p1 : p2;

        const profileAddr = await getProfileForGame(registry, winnerSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const record = await profile.getEnrollmentByInstance(await instance.getAddress());

        expect(record.concluded).to.equal(true);
        expect(record.won).to.equal(true);
    });

    it("stores tournament resolution metadata and per-match outcomes separately", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const loser = winner === p1.address ? p2.address : p1.address;

        const winnerProfileAddr = await getProfileForGame(registry, winner);
        const loserProfileAddr = await getProfileForGame(registry, loser);

        const winnerProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", winnerProfileAddr);
        const loserProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", loserProfileAddr);

        const instanceAddress = await instance.getAddress();
        const [winnerTournamentRecord, loserTournamentRecord, winnerMatchRecord, loserMatchRecord] = await Promise.all([
            winnerProfile.getEnrollmentByInstance(instanceAddress),
            loserProfile.getEnrollmentByInstance(instanceAddress),
            winnerProfile.getMatchRecordByKey(instanceAddress, 0, 0),
            loserProfile.getMatchRecordByKey(instanceAddress, 0, 0),
        ]);

        expect(winnerTournamentRecord.tournamentResolutionReason).to.equal(BigInt(TOURNAMENT_REASON.R0)); // R0: NormalWin
        expect(loserTournamentRecord.tournamentResolutionReason).to.equal(BigInt(TOURNAMENT_REASON.R0));

        expect(winnerMatchRecord.outcome).to.equal(1n); // NormalVictory
        expect(winnerMatchRecord.category).to.equal(1n); // Victory
        expect(winnerMatchRecord.resolutionReason).to.equal(BigInt(MATCH_REASON.R0));
        expect(loserMatchRecord.outcome).to.equal(2n); // NormalDefeat
        expect(loserMatchRecord.category).to.equal(2n); // Defeat
        expect(loserMatchRecord.resolutionReason).to.equal(BigInt(MATCH_REASON.R0));
    });

    it("loser profile: concluded=true, won=false on enrollment record", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const loserSigner = winner === p1.address ? p2 : p1;

        const profileAddr = await getProfileForGame(registry, loserSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const record = await profile.getEnrollmentByInstance(await instance.getAddress());

        expect(record.concluded).to.equal(true);
        expect(record.won).to.equal(false);
    });

    it("winner net earnings = prize - entryFee (positive)", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");
        const totalPot  = entryFee * 2n;
        const prizePool = totalPot * PARTICIPANTS_SHARE_BPS / BASIS_POINTS;

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const winnerSigner = winner === p1.address ? p1 : p2;

        const profileAddr = await getProfileForGame(registry, winnerSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const stats = await profile.getStats();

        // net = prize - entryFee = prizePool - entryFee (should be positive for 2-player)
        const expectedNet = BigInt(prizePool) - BigInt(entryFee);
        expect(stats.totalNetEarnings).to.equal(expectedNet);
    });

    it("loser net earnings = 0 - entryFee (negative)", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const loserSigner = winner === p1.address ? p2 : p1;

        const profileAddr = await getProfileForGame(registry, loserSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const stats = await profile.getStats();

        expect(stats.totalNetEarnings).to.equal(-BigInt(entryFee));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 9: Player count cap at 32
// ─────────────────────────────────────────────────────────────────────────────

describe("Player count cap", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("rejects playerCount of 64", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const to = defaultTimeouts();
        await expect(
            factory.createInstance(64, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee })
        ).to.be.revertedWithCustomError(factory, "InvalidPlayerCount");
    });

    it("accepts playerCount of 32", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const to = defaultTimeouts();
        await expect(
            factory.createInstance(32, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee })
        ).to.not.be.reverted;
    });
});
