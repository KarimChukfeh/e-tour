// test/factory/verify-both-players-complete-flow.test.js
// COMPREHENSIVE test to verify EVERY aspect of profile creation for BOTH players

import { expect } from "chai";
import hre from "hardhat";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TICTAC_GAME_TYPE = 0;

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

    return { factory, registry };
}

function defaultTimeouts() {
    return {
        enrollmentWindow:      2n * 60n,    // 2 minutes
        matchTimePerPlayer:    5n * 60n,    // 5 minutes
        timeIncrementPerMove:  15n,         // 15 seconds
    };
}

describe("COMPREHENSIVE: Both players get profiles with enrollment data", function () {
    let factory, registry, signers, instance, instanceAddr;
    let creator, joiner;
    const entryFee = hre.ethers.parseEther("0.001");

    before(async function () {
        signers = await hre.ethers.getSigners();
        [, creator, joiner] = signers;

        ({ factory, registry } = await deployAll());

        // Create instance (creator auto-enrolls)
        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        instanceAddr = event.args.instance;
        instance = await hre.ethers.getContractAt("contracts/TicTacToe.sol:TicTacToe", instanceAddr);

        // Joiner enrolls
        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        console.log("\n" + "=".repeat(80));
        console.log("SETUP COMPLETE");
        console.log("=".repeat(80));
        console.log("Instance:", instanceAddr);
        console.log("Creator: ", creator.address);
        console.log("Joiner:  ", joiner.address);
        console.log("=".repeat(80) + "\n");
    });

    describe("Step 1: PlayerRegistry has profiles for BOTH players", function () {
        it("registry.getProfile(creator) returns non-zero address", async function () {
            const creatorProfile = await registry.getProfile(creator.address, TICTAC_GAME_TYPE);
            console.log("registry.getProfile(creator):", creatorProfile);
            expect(creatorProfile).to.not.equal(ZERO_ADDRESS);
        });

        it("registry.getProfile(joiner) returns non-zero address", async function () {
            const joinerProfile = await registry.getProfile(joiner.address, TICTAC_GAME_TYPE);
            console.log("registry.getProfile(joiner): ", joinerProfile);
            expect(joinerProfile).to.not.equal(ZERO_ADDRESS);
        });
    });

    describe("Step 2: Factory.players() mapping has BOTH players", function () {
        it("factory.players(creator) returns non-zero address", async function () {
            const creatorProfile = await factory.players(creator.address);
            console.log("factory.players(creator):", creatorProfile);
            expect(creatorProfile).to.not.equal(ZERO_ADDRESS);
        });

        it("factory.players(joiner) returns non-zero address", async function () {
            const joinerProfile = await factory.players(joiner.address);
            console.log("factory.players(joiner): ", joinerProfile);
            expect(joinerProfile).to.not.equal(ZERO_ADDRESS);
        });
    });

    describe("Step 3: Factory.getPlayerProfile() works for BOTH players", function () {
        it("factory.getPlayerProfile(creator) returns non-zero address", async function () {
            const creatorProfile = await factory.getPlayerProfile(creator.address);
            console.log("factory.getPlayerProfile(creator):", creatorProfile);
            expect(creatorProfile).to.not.equal(ZERO_ADDRESS);
        });

        it("factory.getPlayerProfile(joiner) returns non-zero address", async function () {
            const joinerProfile = await factory.getPlayerProfile(joiner.address);
            console.log("factory.getPlayerProfile(joiner): ", joinerProfile);
            expect(joinerProfile).to.not.equal(ZERO_ADDRESS);
        });
    });

    describe("Step 4: Creator's PlayerProfile contract has enrollment data", function () {
        let creatorProfile;

        before(async function () {
            const addr = await registry.getProfile(creator.address, TICTAC_GAME_TYPE);
            creatorProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", addr);
        });

        it("creator profile: getEnrollmentCount() returns 1", async function () {
            const count = await creatorProfile.getEnrollmentCount();
            console.log("creator.getEnrollmentCount():", count.toString());
            expect(count).to.equal(1n);
        });

        it("creator profile: getEnrollments() returns 1 record", async function () {
            const enrollments = await creatorProfile.getEnrollments(0, 10);
            console.log("creator.getEnrollments() length:", enrollments.length);
            expect(enrollments.length).to.equal(1);
        });

        it("creator profile: enrollment record has correct instance address", async function () {
            const enrollments = await creatorProfile.getEnrollments(0, 10);
            console.log("creator enrollment[0].instance:", enrollments[0].instance);
            expect(enrollments[0].instance.toLowerCase()).to.equal(instanceAddr.toLowerCase());
        });

        it("creator profile: enrollment record has correct entryFee", async function () {
            const enrollments = await creatorProfile.getEnrollments(0, 10);
            console.log("creator enrollment[0].entryFee:", hre.ethers.formatEther(enrollments[0].entryFee));
            expect(enrollments[0].entryFee).to.equal(entryFee);
        });

        it("creator profile: enrollment record has correct gameType (TicTac = 0)", async function () {
            const enrollments = await creatorProfile.getEnrollments(0, 10);
            console.log("creator enrollment[0].gameType:", enrollments[0].gameType.toString());
            expect(enrollments[0].gameType).to.equal(BigInt(TICTAC_GAME_TYPE));
        });

        it("creator profile: getEnrollmentByInstance() returns correct data", async function () {
            const enrollment = await creatorProfile.getEnrollmentByInstance(instanceAddr);
            console.log("creator.getEnrollmentByInstance() instance:", enrollment.instance);
            expect(enrollment.instance.toLowerCase()).to.equal(instanceAddr.toLowerCase());
        });
    });

    describe("Step 5: Joiner's PlayerProfile contract has enrollment data", function () {
        let joinerProfile;

        before(async function () {
            const addr = await registry.getProfile(joiner.address, TICTAC_GAME_TYPE);
            joinerProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", addr);
        });

        it("joiner profile: getEnrollmentCount() returns 1", async function () {
            const count = await joinerProfile.getEnrollmentCount();
            console.log("joiner.getEnrollmentCount():", count.toString());
            expect(count).to.equal(1n);
        });

        it("joiner profile: getEnrollments() returns 1 record", async function () {
            const enrollments = await joinerProfile.getEnrollments(0, 10);
            console.log("joiner.getEnrollments() length:", enrollments.length);
            expect(enrollments.length).to.equal(1);
        });

        it("joiner profile: enrollment record has correct instance address", async function () {
            const enrollments = await joinerProfile.getEnrollments(0, 10);
            console.log("joiner enrollment[0].instance:", enrollments[0].instance);
            expect(enrollments[0].instance.toLowerCase()).to.equal(instanceAddr.toLowerCase());
        });

        it("joiner profile: enrollment record has correct entryFee", async function () {
            const enrollments = await joinerProfile.getEnrollments(0, 10);
            console.log("joiner enrollment[0].entryFee:", hre.ethers.formatEther(enrollments[0].entryFee));
            expect(enrollments[0].entryFee).to.equal(entryFee);
        });

        it("joiner profile: enrollment record has correct gameType (TicTac = 0)", async function () {
            const enrollments = await joinerProfile.getEnrollments(0, 10);
            console.log("joiner enrollment[0].gameType:", enrollments[0].gameType.toString());
            expect(enrollments[0].gameType).to.equal(BigInt(TICTAC_GAME_TYPE));
        });

        it("joiner profile: getEnrollmentByInstance() returns correct data", async function () {
            const enrollment = await joinerProfile.getEnrollmentByInstance(instanceAddr);
            console.log("joiner.getEnrollmentByInstance() instance:", enrollment.instance);
            expect(enrollment.instance.toLowerCase()).to.equal(instanceAddr.toLowerCase());
        });
    });

    describe("Step 6: Instance contract shows BOTH players enrolled", function () {
        it("instance.isEnrolled(creator) returns true", async function () {
            const enrolled = await instance.isEnrolled(creator.address);
            console.log("instance.isEnrolled(creator):", enrolled);
            expect(enrolled).to.equal(true);
        });

        it("instance.isEnrolled(joiner) returns true", async function () {
            const enrolled = await instance.isEnrolled(joiner.address);
            console.log("instance.isEnrolled(joiner): ", enrolled);
            expect(enrolled).to.equal(true);
        });

        it("instance.getPlayers() returns both creator and joiner", async function () {
            const players = await instance.getPlayers();
            console.log("instance.getPlayers():", players);
            expect(players.length).to.equal(2);
            expect(players.map(p => p.toLowerCase())).to.include(creator.address.toLowerCase());
            expect(players.map(p => p.toLowerCase())).to.include(joiner.address.toLowerCase());
        });
    });

    describe("Step 7: SIMULATING UI QUERIES - Both players should be found", function () {
        it("UI query for CREATOR works", async function () {
            console.log("\n--- SIMULATING UI QUERY FOR CREATOR ---");

            // Step 1: Get profile address (what UI does)
            let profileAddr = await factory.players(creator.address);
            console.log("1. factory.players(creator):", profileAddr);

            if (profileAddr === ZERO_ADDRESS) {
                profileAddr = await factory.getPlayerProfile(creator.address);
                console.log("   fallback: factory.getPlayerProfile(creator):", profileAddr);
            }

            expect(profileAddr).to.not.equal(ZERO_ADDRESS, "UI should find creator's profile");

            // Step 2: Get enrollment data from profile (what UI does)
            const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
            const enrollments = await profile.getEnrollments(0, 100);
            console.log("2. profile.getEnrollments() count:", enrollments.length);

            expect(enrollments.length).to.be.greaterThan(0, "Creator should have enrollment records");

            // Step 3: Verify enrollment instance exists
            console.log("3. First enrollment instance:", enrollments[0].instance);
            expect(enrollments[0].instance).to.not.equal(ZERO_ADDRESS);
        });

        it("UI query for JOINER works", async function () {
            console.log("\n--- SIMULATING UI QUERY FOR JOINER ---");

            // Step 1: Get profile address (what UI does)
            let profileAddr = await factory.players(joiner.address);
            console.log("1. factory.players(joiner):", profileAddr);

            if (profileAddr === ZERO_ADDRESS) {
                profileAddr = await factory.getPlayerProfile(joiner.address);
                console.log("   fallback: factory.getPlayerProfile(joiner):", profileAddr);
            }

            expect(profileAddr).to.not.equal(ZERO_ADDRESS, "UI should find joiner's profile");

            // Step 2: Get enrollment data from profile (what UI does)
            const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddr);
            const enrollments = await profile.getEnrollments(0, 100);
            console.log("2. profile.getEnrollments() count:", enrollments.length);

            expect(enrollments.length).to.be.greaterThan(0, "Joiner should have enrollment records");

            // Step 3: Verify enrollment instance exists
            console.log("3. First enrollment instance:", enrollments[0].instance);
            expect(enrollments[0].instance).to.not.equal(ZERO_ADDRESS);
        });
    });

    describe("Step 8: FINAL SUMMARY", function () {
        it("prints complete summary for both players", async function () {
            console.log("\n" + "=".repeat(80));
            console.log("FINAL VERIFICATION SUMMARY");
            console.log("=".repeat(80));

            const creatorProfileAddr = await factory.getPlayerProfile(creator.address);
            const joinerProfileAddr = await factory.getPlayerProfile(joiner.address);

            const creatorProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", creatorProfileAddr);
            const joinerProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", joinerProfileAddr);

            const creatorEnrollments = await creatorProfile.getEnrollments(0, 100);
            const joinerEnrollments = await joinerProfile.getEnrollments(0, 100);

            console.log("\nCREATOR (" + creator.address + "):");
            console.log("  Profile address:     ", creatorProfileAddr);
            console.log("  Enrollment count:    ", creatorEnrollments.length);
            console.log("  Instance enrolled in:", creatorEnrollments[0]?.instance || "NONE");

            console.log("\nJOINER (" + joiner.address + "):");
            console.log("  Profile address:     ", joinerProfileAddr);
            console.log("  Enrollment count:    ", joinerEnrollments.length);
            console.log("  Instance enrolled in:", joinerEnrollments[0]?.instance || "NONE");

            console.log("\n" + "=".repeat(80));
            console.log("✅ BOTH PLAYERS HAVE COMPLETE PROFILE DATA");
            console.log("=".repeat(80) + "\n");

            expect(creatorEnrollments.length).to.be.greaterThan(0);
            expect(joinerEnrollments.length).to.be.greaterThan(0);
        });
    });
});
