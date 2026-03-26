// test/factory/PlayerProfile.test.js
// Tests for:
//   - PlayerProfile: enrollment recording, result push, stats accuracy
//   - PlayerRegistry: clone idempotency, authorization gating
//   - Deferred fee invariant: prizePool + ownerAccrued + protocolAccrued == entryFee × enrolled
//   - EL1: solo enroll → forceStart → 100% refund, owner gets 0
//   - EL2: partial enroll → timeout → claim → 100% of enrolled fees, owner gets 0
//   - Normal conclusion: owner gets 7.5%, winner gets ~90%, raffle gets ~2.5%
//   - Per-tournament raffle: winner is always an enrolled player, event emitted
//   - Profile auto-updated at conclusion (push model)

import { expect } from "chai";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Constants mirroring the contracts
// ─────────────────────────────────────────────────────────────────────────────

const PARTICIPANTS_SHARE_BPS = 9000n;
const OWNER_SHARE_BPS        = 750n;
const PROTOCOL_SHARE_BPS     = 250n;
const BASIS_POINTS           = 10000n;

// ─────────────────────────────────────────────────────────────────────────────
// Deploy helpers
// ─────────────────────────────────────────────────────────────────────────────

async function deployAll() {
    const [moduleCore, moduleMatches, modulePrizes, moduleEscalation] = await Promise.all([
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation")
            .then(f => f.deploy()).then(c => c.waitForDeployment().then(() => c)),
    ]);

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
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

function defaultTimeouts() {
    // These must match the validation in ETourFactory:
    // - enrollmentWindow: 2, 5, 10, or 30 minutes
    // - matchTimePerPlayer: 2, 5, 10, or 15 minutes
    // - timeIncrementPerMove: 15 or 30 seconds
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
        matchTimePerPlayer:    2n * 60n,    // 2 minutes (minimum allowed)
        timeIncrementPerMove:  15n,         // 15 seconds (minimum allowed)
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
    return hre.ethers.getContractAt("contracts/TicTacInstance.sol:TicTacInstance", event.args.instance);
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

        const profileAddr = await registry.getProfile(signers[0].address);
        expect(profileAddr).to.not.equal(hre.ethers.ZeroAddress);
    });

    it("returns the same profile address for repeated enrollments", async function () {
        const entryFee = hre.ethers.parseEther("0.001");
        const instance1 = await createInstance(factory, 2, entryFee, signers[0]);
        await instance1.connect(signers[1]).enrollInTournament({ value: entryFee });
        const profile1 = await registry.getProfile(signers[0].address);

        // Enroll same player in a second tournament
        const instance2 = await createInstance(factory, 2, entryFee, signers[0]);
        await instance2.connect(signers[1]).enrollInTournament({ value: entryFee });
        const profile2 = await registry.getProfile(signers[0].address);

        expect(profile1).to.equal(profile2);
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

        const profileAddr = await registry.getProfile(signers[0].address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);

        expect(await profile.getEnrollmentCount()).to.equal(1n);
    });

    it("profile enrollment record has correct fields", async function () {
        const entryFee = hre.ethers.parseEther("0.002");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);

        const profileAddr = await registry.getProfile(signers[0].address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);

        const records = await profile.getEnrollments(0, 10);
        expect(records.length).to.equal(1);
        expect(records[0].instance).to.equal(await instance.getAddress());
        expect(records[0].entryFee).to.equal(entryFee);
        expect(records[0].gameType).to.equal(0n); // TicTac = 0
        expect(records[0].concluded).to.equal(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Deferred fees invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("Deferred fees — invariant: prizePool + ownerAccrued + protocolAccrued == entryFee × enrolled", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("holds for 1 enrolled player", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);

        const t = await instance.tournament();
        expect(t.prizePool + t.ownerAccrued + t.protocolAccrued).to.equal(entryFee);
    });

    it("holds for 2 enrolled players", async function () {
        const entryFee = hre.ethers.parseEther("0.004");
        const instance = await createInstance(factory, 2, entryFee, signers[0]);
        await instance.connect(signers[1]).enrollInTournament({ value: entryFee });

        const t = await instance.tournament();
        expect(t.prizePool + t.ownerAccrued + t.protocolAccrued).to.equal(entryFee * 2n);
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
        expect(t.protocolAccrued).to.equal(entryFee * PROTOCOL_SHARE_BPS / BASIS_POINTS);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: EL1 — solo force start → 100% refund
// ─────────────────────────────────────────────────────────────────────────────

describe("EL1 — solo enroll → forceStart → 100% refund", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("solo player receives 100% of entry fee back", async function () {
        const [solo] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        // Use short enrollment window so we can force start
        const timeouts = shortTimeouts();
        const tx = await factory.connect(solo).createInstance(
            2, entryFee, timeouts.enrollmentWindow, timeouts.matchTimePerPlayer, timeouts.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        // Wait for enrollment window to expire (2 minutes + 1 second)
        await advanceTime(121);

        const balanceBefore = await hre.ethers.provider.getBalance(solo.address);
        const forceTx = await instance.connect(solo).forceStartTournament();
        const forceReceipt = await forceTx.wait();
        const gasUsed = forceReceipt.gasUsed * forceReceipt.gasPrice;
        const balanceAfter = await hre.ethers.provider.getBalance(solo.address);

        // Net change should be ~+entryFee (got full refund back, minus gas)
        const netChange = balanceAfter - balanceBefore + gasUsed;
        expect(netChange).to.equal(entryFee);
    });

    it("owner receives nothing on EL1", async function () {
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
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        await advanceTime(121); // 2 minutes + 1 second
        await instance.connect(solo).forceStartTournament();

        const ownerBalanceAfter = await factory.ownerBalance();
        expect(ownerBalanceAfter).to.equal(ownerBalanceBefore);
    });

    it("instance balance is 0 after EL1", async function () {
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
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        await advanceTime(121); // 2 minutes + 1 second
        await instance.connect(solo).forceStartTournament();

        const balance = await hre.ethers.provider.getBalance(await instance.getAddress());
        expect(balance).to.equal(0n);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: EL2 — abandoned pool claim → 100% refund
// ─────────────────────────────────────────────────────────────────────────────

describe("EL2 — partial enroll → abandoned claim → 100% of enrolled fees", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("claimer receives 100% of all enrolled entry fees", async function () {
        const [p1, p2, claimer] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

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
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
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

        // Claimer should receive 2 × entryFee (100% of both enrolled fees)
        const netGain = claimerAfter - claimerBefore + gasUsed;
        expect(netGain).to.equal(entryFee * 2n);
    });

    it("owner receives nothing on EL2", async function () {
        const [p1, , claimer] = signers;
        const entryFee = hre.ethers.parseEther("0.01");

        const ownerBefore = await factory.ownerBalance();

        const to = shortTimeouts();
        const tx = await factory.connect(p1).createInstance(
            4, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        // Wait for enrollment window + EL2 delay (2 min + 2 min = 4 min + buffer)
        await advanceTime(121 + 121);
        await instance.connect(claimer).claimAbandonedPool();

        expect(await factory.ownerBalance()).to.equal(ownerBefore);
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

    it("owner receives exactly 7.5% × 2 players at conclusion", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");

        const ownerBefore = await factory.ownerBalance();

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        // Play and win
        await playAndWin(instance, 0, 0, p1, p2);

        const ownerAfter = await factory.ownerBalance();
        const expectedOwnerCut = entryFee * 2n * OWNER_SHARE_BPS / BASIS_POINTS;
        expect(ownerAfter - ownerBefore).to.equal(expectedOwnerCut);
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

    it("winner receives ~90% of total pot", async function () {
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

        // The winner's net gain (ignoring gas) should roughly equal the prize
        // We check it's >= 90% prize (raffle may also go to winner, making it higher)
        if (isP1Winner) {
            // p1 received prize + possibly raffle; at minimum they got the prize
            expect(p1After - p1Before).to.be.gte(expectedPrize - hre.ethers.parseEther("0.002")); // gas tolerance
        } else {
            expect(p2After - p2Before).to.be.gte(expectedPrize - hre.ethers.parseEther("0.002"));
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 7: Per-tournament raffle
// ─────────────────────────────────────────────────────────────────────────────

describe("Per-tournament raffle", function () {
    let factory, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory } = await deployAll());
    });

    it("emits TournamentRaffleAwarded after a 2-player tournament", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        // Play to conclusion and watch for raffle event
        const tx = await (async () => {
            const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
            const matchData = await instance.matches(matchId);
            const first  = matchData.currentTurn === p1.address ? p1 : p2;
            const second = first === p1 ? p2 : p1;
            await instance.connect(first).makeMove(0, 0, 0);
            await instance.connect(second).makeMove(0, 0, 3);
            await instance.connect(first).makeMove(0, 0, 1);
            await instance.connect(second).makeMove(0, 0, 4);
            return instance.connect(first).makeMove(0, 0, 2); // winning move
        })();
        const receipt = await tx.wait();

        const raffleEvent = receipt.logs
            .map(log => { try { return instance.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "TournamentRaffleAwarded");

        expect(raffleEvent).to.not.be.null;
        expect(raffleEvent.args.transferred).to.equal(true);
        expect(raffleEvent.args.amount).to.be.gt(0n);
    });

    it("raffle winner is always one of the enrolled players", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");
        const enrolledAddresses = [p1.address.toLowerCase(), p2.address.toLowerCase()];

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await instance.matches(matchId);
        const first  = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;
        await instance.connect(first).makeMove(0, 0, 0);
        await instance.connect(second).makeMove(0, 0, 3);
        await instance.connect(first).makeMove(0, 0, 1);
        await instance.connect(second).makeMove(0, 0, 4);
        const tx = await instance.connect(first).makeMove(0, 0, 2);
        const receipt = await tx.wait();

        const raffleEvent = receipt.logs
            .map(log => { try { return instance.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "TournamentRaffleAwarded");

        expect(enrolledAddresses).to.include(raffleEvent.args.winner.toLowerCase());
    });

    it("raffle amount equals protocolAccrued (2.5% × enrolled)", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.004");
        const expectedRaffle = entryFee * 2n * PROTOCOL_SHARE_BPS / BASIS_POINTS;

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await instance.matches(matchId);
        const first  = matchData.currentTurn === p1.address ? p1 : p2;
        const second = first === p1 ? p2 : p1;
        await instance.connect(first).makeMove(0, 0, 0);
        await instance.connect(second).makeMove(0, 0, 3);
        await instance.connect(first).makeMove(0, 0, 1);
        await instance.connect(second).makeMove(0, 0, 4);
        const tx = await instance.connect(first).makeMove(0, 0, 2);
        const receipt = await tx.wait();

        const raffleEvent = receipt.logs
            .map(log => { try { return instance.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "TournamentRaffleAwarded");

        expect(raffleEvent.args.amount).to.equal(expectedRaffle);
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

    it("winner profile: totalWins=1, totalPlayed=1 after conclusion", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const winnerSigner = winner === p1.address ? p1 : p2;

        const profileAddr = await registry.getProfile(winnerSigner.address);
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

        const profileAddr = await registry.getProfile(loserSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const stats = await profile.getStats();

        expect(stats.totalPlayed).to.equal(1n);
        expect(stats.totalWins).to.equal(0n);
        expect(stats.totalLosses).to.equal(1n);
    });

    it("winner profile: concluded=true, won=true on enrollment record", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const winnerSigner = winner === p1.address ? p1 : p2;

        const profileAddr = await registry.getProfile(winnerSigner.address);
        const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
        const record = await profile.getEnrollmentByInstance(await instance.getAddress());

        expect(record.concluded).to.equal(true);
        expect(record.won).to.equal(true);
    });

    it("loser profile: concluded=true, won=false on enrollment record", async function () {
        const [p1, p2] = signers;
        const entryFee = hre.ethers.parseEther("0.002");

        const instance = await createInstance(factory, 2, entryFee, p1);
        await instance.connect(p2).enrollInTournament({ value: entryFee });

        const winner = await playAndWin(instance, 0, 0, p1, p2);
        const loserSigner = winner === p1.address ? p2 : p1;

        const profileAddr = await registry.getProfile(loserSigner.address);
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

        const profileAddr = await registry.getProfile(winnerSigner.address);
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

        const profileAddr = await registry.getProfile(loserSigner.address);
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
