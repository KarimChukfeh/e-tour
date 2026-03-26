// test/factory/debug-factory-players-mapping.test.js
// Debug test to check if factory.players() mapping gets populated correctly

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

describe("Debug: factory.players() mapping population", function () {
    let factory, registry, signers;

    beforeEach(async function () {
        signers = await hre.ethers.getSigners();
        ({ factory, registry } = await deployAll());
    });

    it("factory.players() is populated for creator after createInstance", async function () {
        const [, creator] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        const to = defaultTimeouts();
        const tx = await factory.connect(creator).createInstance(
            2, entryFee, to.enrollmentWindow, to.matchTimePerPlayer, to.timeIncrementPerMove, { value: entryFee }
        );
        await tx.wait();

        // Check factory.players() mapping
        const creatorProfileFromMapping = await factory.players(creator.address);
        console.log("Creator address:", creator.address);
        console.log("factory.players(creator):", creatorProfileFromMapping);

        // Check via getPlayerProfile()
        const creatorProfileFromGetter = await factory.getPlayerProfile(creator.address);
        console.log("factory.getPlayerProfile(creator):", creatorProfileFromGetter);

        // Check registry directly
        const creatorProfileFromRegistry = await registry.getProfile(creator.address);
        console.log("registry.getProfile(creator):", creatorProfileFromRegistry);

        expect(creatorProfileFromMapping).to.not.equal(hre.ethers.ZeroAddress, "factory.players() should be set");
        expect(creatorProfileFromGetter).to.not.equal(hre.ethers.ZeroAddress, "getPlayerProfile() should work");
        expect(creatorProfileFromRegistry).to.not.equal(hre.ethers.ZeroAddress, "registry should have profile");

        // All three should return the same address
        expect(creatorProfileFromMapping).to.equal(creatorProfileFromRegistry);
        expect(creatorProfileFromGetter).to.equal(creatorProfileFromRegistry);
    });

    it("factory.players() is populated for joiner after enrollInTournament", async function () {
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

        // Check factory.players() mapping
        const joinerProfileFromMapping = await factory.players(joiner.address);
        console.log("Joiner address:", joiner.address);
        console.log("factory.players(joiner):", joinerProfileFromMapping);

        // Check via getPlayerProfile()
        const joinerProfileFromGetter = await factory.getPlayerProfile(joiner.address);
        console.log("factory.getPlayerProfile(joiner):", joinerProfileFromGetter);

        // Check registry directly
        const joinerProfileFromRegistry = await registry.getProfile(joiner.address);
        console.log("registry.getProfile(joiner):", joinerProfileFromRegistry);

        expect(joinerProfileFromMapping).to.not.equal(hre.ethers.ZeroAddress, "factory.players() should be set");
        expect(joinerProfileFromGetter).to.not.equal(hre.ethers.ZeroAddress, "getPlayerProfile() should work");
        expect(joinerProfileFromRegistry).to.not.equal(hre.ethers.ZeroAddress, "registry should have profile");

        // All three should return the same address
        expect(joinerProfileFromMapping).to.equal(joinerProfileFromRegistry);
        expect(joinerProfileFromGetter).to.equal(joinerProfileFromRegistry);
    });

    it("BOTH factory.players() entries exist after full 2-player enrollment", async function () {
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

        console.log("\n=== After both players enrolled ===");

        const creatorFromMapping = await factory.players(creator.address);
        const joinerFromMapping = await factory.players(joiner.address);

        console.log("Creator address:", creator.address);
        console.log("factory.players(creator):", creatorFromMapping);
        console.log("\nJoiner address: ", joiner.address);
        console.log("factory.players(joiner): ", joinerFromMapping);

        expect(creatorFromMapping).to.not.equal(hre.ethers.ZeroAddress, "Creator should have entry in factory.players()");
        expect(joinerFromMapping).to.not.equal(hre.ethers.ZeroAddress, "Joiner should have entry in factory.players()");
        expect(creatorFromMapping).to.not.equal(joinerFromMapping, "Each player should have unique profile");
    });
});
