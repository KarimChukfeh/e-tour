import { expect } from "chai";
import hre from "hardhat";

const ENTRY_FEE = hre.ethers.parseEther("0.001");
const PLAYER_COUNT = 2;

function defaultTimeouts() {
    return {
        enrollmentWindow: 2n * 60n,
        matchTimePerPlayer: 2n * 60n,
        timeIncrementPerMove: 15n,
    };
}

async function deployFactory() {
    const [moduleCore, moduleMatches, modulePrizes, moduleEscalation, chessRules] = await Promise.all([
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
        hre.ethers.getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract)),
    ]);

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("contracts/ChessOnChainFactory.sol:ChessOnChainFactory");
    const factory = await Factory.deploy(
        await moduleCore.getAddress(),
        await moduleMatches.getAddress(),
        await modulePrizes.getAddress(),
        await moduleEscalation.getAddress(),
        await chessRules.getAddress(),
        await registry.getAddress()
    );
    await factory.waitForDeployment();
    await registry.authorizeFactory(await factory.getAddress());

    return { factory, chessRules };
}

async function createInstance(factory, signer) {
    const timeouts = defaultTimeouts();
    const tx = await factory.connect(signer).createInstance(
        PLAYER_COUNT,
        ENTRY_FEE,
        timeouts.enrollmentWindow,
        timeouts.matchTimePerPlayer,
        timeouts.timeIncrementPerMove,
        { value: ENTRY_FEE }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
        .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(parsed => parsed && parsed.name === "InstanceDeployed");

    return hre.ethers.getContractAt(
        "contracts/ChessInstance.sol:ChessInstance",
        event.args.instance
    );
}

describe("ChessOnChainFactory active tournament tracking", function () {
    this.timeout(60_000);

    let factory;
    let chessRules;
    let creator;

    beforeEach(async function () {
        [creator] = await hre.ethers.getSigners();
        ({ factory, chessRules } = await deployFactory());
    });

    it("tracks newly created chess instances in activeTournaments", async function () {
        const instance = await createInstance(factory, creator);
        const instanceAddress = await instance.getAddress();

        expect(await factory.getActiveTournamentCount()).to.equal(1n);
        expect(await factory.activeTournaments(0)).to.equal(instanceAddress);
    });

    it("configures CHESS_RULES through the factory post-initialize hook", async function () {
        const instance = await createInstance(factory, creator);
        expect(await instance.CHESS_RULES()).to.equal(await chessRules.getAddress());
    });

    it("moves concluded chess instances from activeTournaments to pastTournaments", async function () {
        const instance = await createInstance(factory, creator);
        const instanceAddress = await instance.getAddress();

        await instance.connect(creator).cancelTournament();

        expect(await factory.getActiveTournamentCount()).to.equal(0n);
        expect(await factory.getPastTournamentCount()).to.equal(1n);
        expect(await factory.pastTournaments(0)).to.equal(instanceAddress);
    });
});
