import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const ZERO = hre.ethers.ZeroAddress;
const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const ENROLLMENT_WINDOW = 2n * 60n;
const MATCH_TIME = 2n * 60n;
const MOVE_INCREMENT = 15n;

async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function fixture() {
    const [owner, joiner, creatorExecutor, joinerExecutor] =
        await hre.ethers.getSigners();
    const [core, matches, prizes, escalation, profile] =
        await Promise.all([
            deploy("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"),
            deploy("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"),
            deploy("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"),
            deploy("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"),
            deploy("contracts/PlayerProfile.sol:PlayerProfile"),
        ]);
    const playerRegistry = await deploy(
        "contracts/PlayerRegistry.sol:PlayerRegistry",
        [await profile.getAddress()]
    );
    const sessionRegistry = await deploy(
        "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
        [await playerRegistry.getAddress()]
    );
    const moduleAddresses = await Promise.all([
        core.getAddress(),
        matches.getAddress(),
        prizes.getAddress(),
        escalation.getAddress(),
    ]);
    const factory = await deploy(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        [
            ...moduleAddresses,
            await playerRegistry.getAddress(),
            await sessionRegistry.getAddress(),
        ]
    );
    await playerRegistry.authorizeFactory(await factory.getAddress());

    return {
        owner,
        joiner,
        creatorExecutor,
        joinerExecutor,
        moduleAddresses,
        playerRegistry,
        sessionRegistry,
        factory,
    };
}

async function createInstance(factory, creator, sessionExecutor = ZERO) {
    const tx = await factory.connect(creator).createInstance(
        2,
        ENTRY_FEE,
        ENROLLMENT_WINDOW,
        MATCH_TIME,
        MOVE_INCREMENT,
        sessionExecutor,
        { value: ENTRY_FEE }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((parsed) => parsed?.name === "InstanceDeployed");
    const instance = await hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        event.args.instance
    );
    return { tx, receipt, instance };
}

async function expectAccounting(instance, enrolledCount) {
    const tournament = await instance.tournament();
    const total = ENTRY_FEE * BigInt(enrolledCount);
    expect(tournament.enrolledCount).to.equal(BigInt(enrolledCount));
    expect(tournament.totalEntryFeesAccrued).to.equal(total);
    expect(tournament.prizePool).to.equal((total * 9500n) / 10000n);
    expect(tournament.ownerAccrued).to.equal((total * 500n) / 10000n);
    expect(await hre.ethers.provider.getBalance(await instance.getAddress()))
        .to.equal(total);
}

describe("V3 session-enabled enrollment", function () {
    this.timeout(60_000);

    it("threads the registry through the factory and every initialized instance", async function () {
        const {
            owner,
            moduleAddresses,
            playerRegistry,
            sessionRegistry,
            factory,
        } = await loadFixture(fixture);
        const registryAddress = await sessionRegistry.getAddress();
        expect(await factory.SESSION_REGISTRY()).to.equal(registryAddress);
        const { instance } = await createInstance(factory, owner);
        expect(await instance.SESSION_REGISTRY()).to.equal(registryAddress);

        const Factory = await hre.ethers.getContractFactory(
            "contracts/TicTacChainFactory.sol:TicTacChainFactory"
        );
        await expect(
            Factory.deploy(
                ...moduleAddresses,
                await playerRegistry.getAddress(),
                ZERO
            )
        ).to.be.revertedWithCustomError(factory, "InvalidSessionRegistry");
        const mismatchedSessionRegistry = await deploy(
            "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
            [owner.address]
        );
        await expect(
            Factory.deploy(
                ...moduleAddresses,
                await playerRegistry.getAddress(),
                await mismatchedSessionRegistry.getAddress()
            )
        ).to.be.revertedWithCustomError(factory, "InvalidSessionRegistry");

        const implementation = await deploy(
            "contracts/TicTacInstance.sol:TicTacInstance"
        );
        const tier = {
            playerCount: 2,
            entryFee: ENTRY_FEE,
            timeouts: {
                matchTimePerPlayer: MATCH_TIME,
                timeIncrementPerMove: MOVE_INCREMENT,
                matchLevel2Delay: 2n * 60n,
                matchLevel3Delay: 3n * 60n,
                enrollmentWindow: ENROLLMENT_WINDOW,
                enrollmentLevel2Delay: 2n * 60n,
            },
            totalRounds: 1,
            tierKey: hre.ethers.keccak256(
                hre.ethers.toUtf8Bytes("zero-registry")
            ),
        };
        await expect(
            implementation.initialize(
                tier,
                await factory.getAddress(),
                owner.address,
                ...moduleAddresses,
                ZERO
            )
        ).to.be.revertedWithCustomError(
            implementation,
            "InvalidSessionRegistry"
        );
    });

    it("atomically registers the creator session without changing primary identity or fees", async function () {
        const {
            owner,
            creatorExecutor,
            playerRegistry,
            sessionRegistry,
            factory,
        } = await loadFixture(fixture);
        const { instance } = await createInstance(
            factory,
            owner,
            creatorExecutor.address
        );
        const instanceAddress = await instance.getAddress();

        expect(await instance.isEnrolled(owner.address)).to.equal(true);
        expect(await instance.isEnrolled(creatorExecutor.address))
            .to.equal(false);
        expect(await instance.getPlayers()).to.deep.equal([owner.address]);
        expect(
            await sessionRegistry.isSessionActive(
                instanceAddress,
                owner.address,
                creatorExecutor.address
            )
        ).to.equal(true);
        expect(await factory.players(creatorExecutor.address)).to.equal(ZERO);

        const profileAddress = await playerRegistry.getProfile(
            owner.address,
            0
        );
        const profile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile",
            profileAddress
        );
        expect(await profile.owner()).to.equal(owner.address);
        expect(await profile.getEnrollmentCount()).to.equal(1n);
        await expectAccounting(instance, 1);
    });

    it("supports creator opt-out without creating a session", async function () {
        const { owner, sessionRegistry, factory } =
            await loadFixture(fixture);
        const { instance } = await createInstance(factory, owner);
        expect(
            await sessionRegistry.getSession(
                await instance.getAddress(),
                owner.address
            )
        ).to.deep.equal([ZERO, 0n, 0n, 0n]);
        expect(await instance.isEnrolled(owner.address)).to.equal(true);
        await expectAccounting(instance, 1);
    });

    it("atomically registers a joiner session without enrolling the executor", async function () {
        const {
            owner,
            joiner,
            joinerExecutor,
            playerRegistry,
            sessionRegistry,
            factory,
        } = await loadFixture(fixture);
        const { instance } = await createInstance(factory, owner);
        await instance.connect(joiner).enrollInTournament(
            joinerExecutor.address,
            { value: ENTRY_FEE }
        );
        const instanceAddress = await instance.getAddress();

        expect(await instance.isEnrolled(joiner.address)).to.equal(true);
        expect(await instance.isEnrolled(joinerExecutor.address))
            .to.equal(false);
        expect(Array.from(await instance.getPlayers())).to.have.members([
            owner.address,
            joiner.address,
        ]);
        expect(
            await sessionRegistry.isSessionActive(
                instanceAddress,
                joiner.address,
                joinerExecutor.address
            )
        ).to.equal(true);
        expect(await playerRegistry.getProfile(joinerExecutor.address, 0))
            .to.equal(ZERO);
        await expectAccounting(instance, 2);
    });

    it("supports joiner opt-out without changing enrollment behavior", async function () {
        const { owner, joiner, sessionRegistry, factory } =
            await loadFixture(fixture);
        const { instance } = await createInstance(factory, owner);
        await instance.connect(joiner).enrollInTournament(
            ZERO,
            { value: ENTRY_FEE }
        );
        expect(
            await sessionRegistry.getSession(
                await instance.getAddress(),
                joiner.address
            )
        ).to.deep.equal([ZERO, 0n, 0n, 0n]);
        expect(await instance.isEnrolled(joiner.address)).to.equal(true);
        await expectAccounting(instance, 2);
    });

    it("rolls back clone tracking, tier creation, profiles, and ETH when creator registration fails", async function () {
        const {
            owner,
            playerRegistry,
            sessionRegistry,
            factory,
        } = await loadFixture(fixture);

        await expect(
            factory.connect(owner).createInstance(
                2,
                ENTRY_FEE,
                ENROLLMENT_WINDOW,
                MATCH_TIME,
                MOVE_INCREMENT,
                owner.address,
                { value: ENTRY_FEE }
            )
        ).to.be.revertedWithCustomError(
            sessionRegistry,
            "ExecutorIsPrimary"
        );

        expect(await factory.getInstanceCount()).to.equal(0n);
        expect(await factory.getActiveTournamentCount()).to.equal(0n);
        const [tierKeys] = await factory.getActiveTierConfigs();
        expect(tierKeys).to.have.length(0);
        expect(await factory.players(owner.address)).to.equal(ZERO);
        expect(await playerRegistry.getProfile(owner.address, 0))
            .to.equal(ZERO);
        expect(await hre.ethers.provider.getBalance(
            await factory.getAddress()
        )).to.equal(0n);
    });

    it("rolls back join enrollment, profile writes, tournament state, and ETH when registration fails", async function () {
        const {
            owner,
            joiner,
            playerRegistry,
            sessionRegistry,
            factory,
        } = await loadFixture(fixture);
        const { instance } = await createInstance(factory, owner);
        const instanceAddress = await instance.getAddress();
        const infoBefore = await instance.getInstanceInfo();
        const playersBefore = await instance.getPlayers();
        const balanceBefore = await hre.ethers.provider.getBalance(
            instanceAddress
        );

        await expect(
            instance.connect(joiner).enrollInTournament(
                joiner.address,
                { value: ENTRY_FEE }
            )
        ).to.be.revertedWithCustomError(
            sessionRegistry,
            "ExecutorIsPrimary"
        );

        expect(await instance.getInstanceInfo()).to.deep.equal(infoBefore);
        expect(await instance.getPlayers()).to.deep.equal(playersBefore);
        expect(await instance.isEnrolled(joiner.address)).to.equal(false);
        expect(await hre.ethers.provider.getBalance(instanceAddress))
            .to.equal(balanceBefore);
        expect(await factory.players(joiner.address)).to.equal(ZERO);
        expect(await playerRegistry.getProfile(joiner.address, 0))
            .to.equal(ZERO);
        expect(
            await sessionRegistry.getSession(instanceAddress, joiner.address)
        ).to.deep.equal([ZERO, 0n, 0n, 0n]);
    });
});
