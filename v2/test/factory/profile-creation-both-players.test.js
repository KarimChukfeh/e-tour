// test/factory/profile-creation-both-players.test.js
// Tests to verify BOTH players get profiles created:
//   - Player 1 (instance creator via createInstance + enrollOnBehalf)
//   - Player 2 (normal enrollment via enrollInTournament)

import { expect } from "chai";
import hre from "hardhat";

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

    // CRITICAL: Authorize factory
    await registry.authorizeFactory(await factory.getAddress());

    return { factory, registry, profileImpl };
}

function defaultTimeouts() {
    return {
        enrollmentWindow:      2n * 60n,    // 2 minutes
        matchTimePerPlayer:    5n * 60n,    // 5 minutes
        timeIncrementPerMove:  15n,         // 15 seconds
    };
}

describe("Profile creation — both players (creator + joiner)", function () {
    let factory, registry, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("BOTH players get profiles: creator via enrollOnBehalf, joiner via enrollInTournament", async function () {
        const [, creator, joiner] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        // Creator creates instance (auto-enrolls via enrollOnBehalf)
        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        // Joiner enrolls normally
        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        // Check creator's profile
        const creatorProfile = await registry.getProfile(creator.address);
        console.log("Creator address:", creator.address);
        console.log("Creator profile:", creatorProfile);
        expect(creatorProfile).to.not.equal(hre.ethers.ZeroAddress, "Creator should have a profile");

        // Check joiner's profile
        const joinerProfile = await registry.getProfile(joiner.address);
        console.log("Joiner address: ", joiner.address);
        console.log("Joiner profile: ", joinerProfile);
        expect(joinerProfile).to.not.equal(hre.ethers.ZeroAddress, "Joiner should have a profile");

        // Verify both profiles are different (unique per player)
        expect(creatorProfile).to.not.equal(joinerProfile);
    });

    it("creator profile has enrollment record after createInstance", async function () {
        const [, creator] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");

        const creatorProfileAddr = await registry.getProfile(creator.address);
        expect(creatorProfileAddr).to.not.equal(hre.ethers.ZeroAddress);

        const profile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile", creatorProfileAddr
        );

        const enrollmentCount = await profile.getEnrollmentCount();
        console.log("Creator enrollment count:", enrollmentCount.toString());
        expect(enrollmentCount).to.equal(1n, "Creator should have 1 enrollment");

        const enrollments = await profile.getEnrollments(0, 10);
        expect(enrollments.length).to.equal(1);
        expect(enrollments[0].instance).to.equal(event.args.instance);
        expect(enrollments[0].entryFee).to.equal(entryFee);
    });

    it("joiner profile has enrollment record after enrollInTournament", async function () {
        const [, creator, joiner] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        const joinerProfileAddr = await registry.getProfile(joiner.address);
        expect(joinerProfileAddr).to.not.equal(hre.ethers.ZeroAddress);

        const profile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile", joinerProfileAddr
        );

        const enrollmentCount = await profile.getEnrollmentCount();
        console.log("Joiner enrollment count:", enrollmentCount.toString());
        expect(enrollmentCount).to.equal(1n, "Joiner should have 1 enrollment");

        const enrollments = await profile.getEnrollments(0, 10);
        expect(enrollments.length).to.equal(1);
        expect(enrollments[0].instance).to.equal(await instance.getAddress());
        expect(enrollments[0].entryFee).to.equal(entryFee);
    });

    it("BOTH profiles show enrollment records for the SAME instance", async function () {
        const [, creator, joiner] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instanceAddr = event.args.instance;
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", instanceAddr
        );

        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        // Check creator's enrollment record
        const creatorProfileAddr = await registry.getProfile(creator.address);
        const creatorProfile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile", creatorProfileAddr
        );
        const creatorEnrollments = await creatorProfile.getEnrollments(0, 10);
        expect(creatorEnrollments[0].instance).to.equal(instanceAddr);

        // Check joiner's enrollment record
        const joinerProfileAddr = await registry.getProfile(joiner.address);
        const joinerProfile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile", joinerProfileAddr
        );
        const joinerEnrollments = await joinerProfile.getEnrollments(0, 10);
        expect(joinerEnrollments[0].instance).to.equal(instanceAddr);

        console.log("Both players enrolled in same instance:", instanceAddr);
    });

    it("creator profile shows stats AFTER tournament completes", async function () {
        const [, creator, joiner] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        // Play the match to completion
        const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);
        const matchData = await instance.matches(matchId);
        const first = matchData.currentTurn === creator.address ? creator : joiner;
        const second = first === creator ? joiner : creator;

        await instance.connect(first).makeMove(0, 0, 0);
        await instance.connect(second).makeMove(0, 0, 3);
        await instance.connect(first).makeMove(0, 0, 1);
        await instance.connect(second).makeMove(0, 0, 4);
        await instance.connect(first).makeMove(0, 0, 2); // winning move

        // Check creator's stats
        const creatorProfileAddr = await registry.getProfile(creator.address);
        const creatorProfile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile", creatorProfileAddr
        );
        const creatorStats = await creatorProfile.getStats();

        console.log("Creator stats after tournament:");
        console.log("  totalPlayed:", creatorStats.totalPlayed.toString());
        console.log("  totalWins:  ", creatorStats.totalWins.toString());
        console.log("  totalLosses:", creatorStats.totalLosses.toString());

        expect(creatorStats.totalPlayed).to.equal(1n);
        expect(creatorStats.totalWins + creatorStats.totalLosses).to.equal(1n);
    });

    it("BUG CHECK: without factory authorization, NO profiles are created", async function () {
        const [deployer, creator, joiner] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        // Deploy WITHOUT authorizing factory
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
        const unauthorizedRegistry = await Registry.deploy(await profileImpl.getAddress());
        await unauthorizedRegistry.waitForDeployment();

        const Factory = await hre.ethers.getContractFactory("contracts/TicTacChainFactory.sol:TicTacChainFactory");
        const unauthorizedFactory = await Factory.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleEscalation.getAddress(),
            await unauthorizedRegistry.getAddress()
        );
        await unauthorizedFactory.waitForDeployment();

        // NOTE: NOT calling registry.authorizeFactory() here!
        console.log("Factory NOT authorized - testing failure scenario");

        // Try to create instance and enroll
        const to = defaultTimeouts();
        const tx = await unauthorizedFactory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => { try { return unauthorizedFactory.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "InstanceDeployed");
        const instance = await hre.ethers.getContractAt(
            "contracts/TicTacInstance.sol:TicTacInstance", event.args.instance
        );

        await instance.connect(joiner).enrollInTournament({ value: entryFee });

        // Check that NEITHER player has a profile
        const creatorProfile = await unauthorizedRegistry.getProfile(creator.address);
        const joinerProfile = await unauthorizedRegistry.getProfile(joiner.address);

        console.log("Creator profile (should be zero):", creatorProfile);
        console.log("Joiner profile (should be zero): ", joinerProfile);

        expect(creatorProfile).to.equal(hre.ethers.ZeroAddress, "Creator should NOT have profile without authorization");
        expect(joinerProfile).to.equal(hre.ethers.ZeroAddress, "Joiner should NOT have profile without authorization");
    });
});
