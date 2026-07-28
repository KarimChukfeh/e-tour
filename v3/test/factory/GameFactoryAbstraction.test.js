import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";
import { deploySessionRegistry } from "../helpers/session-registry.js";

const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const TIMEOUTS = {
    enrollmentWindow: 2n * 60n,
    matchTimePerPlayer: 2n * 60n,
    timeIncrementPerMove: 15n,
};
const MATCH_ID = hre.ethers.solidityPackedKeccak256(
    ["uint8", "uint8"],
    [0, 0]
);

async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function deployFixture() {
    const [owner, player2, player3] = await hre.ethers.getSigners();
    const [core, matches, prizes, escalation, rules, profile] =
        await Promise.all([
            deploy("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"),
            deploy("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"),
            deploy("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"),
            deploy("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"),
            deploy("contracts/modules/ChessRulesModule.sol:ChessRulesModule"),
            deploy("contracts/PlayerProfile.sol:PlayerProfile"),
        ]);
    const registry = await deploy(
        "contracts/PlayerRegistry.sol:PlayerRegistry",
        [await profile.getAddress()]
    );
    const sessionRegistry = await deploySessionRegistry(registry);
    const commonArgs = [
        await core.getAddress(),
        await matches.getAddress(),
        await prizes.getAddress(),
        await escalation.getAddress(),
    ];
    const [ticTacFactory, connectFourFactory, chessFactory] =
        await Promise.all([
            deploy(
                "contracts/TicTacChainFactory.sol:TicTacChainFactory",
                [
                    ...commonArgs,
                    await registry.getAddress(),
                    await sessionRegistry.getAddress(),
                ]
            ),
            deploy(
                "contracts/ConnectFourFactory.sol:ConnectFourFactory",
                [
                    ...commonArgs,
                    await registry.getAddress(),
                    await sessionRegistry.getAddress(),
                ]
            ),
            deploy(
                "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
                [
                    ...commonArgs,
                    await rules.getAddress(),
                    await registry.getAddress(),
                    await sessionRegistry.getAddress(),
                ]
            ),
        ]);

    for (const factory of [
        ticTacFactory,
        connectFourFactory,
        chessFactory,
    ]) {
        await registry.authorizeFactory(await factory.getAddress());
    }

    return {
        owner,
        player2,
        player3,
        rules,
        sessionRegistry,
        modules: { core, matches, prizes, escalation },
        factories: [
            {
                name: "Tic-Tac-Toe",
                factory: ticTacFactory,
                artifact: "contracts/TicTacInstance.sol:TicTacInstance",
            },
            {
                name: "Connect Four",
                factory: connectFourFactory,
                artifact:
                    "contracts/ConnectFourInstance.sol:ConnectFourInstance",
            },
            {
                name: "Chess",
                factory: chessFactory,
                artifact: "contracts/ChessInstance.sol:ChessInstance",
            },
        ],
        chessFactory,
    };
}

async function createInstance(factory, creator) {
    const receipt = await (
        await factory.connect(creator).createInstance(
            2,
            ENTRY_FEE,
            TIMEOUTS.enrollmentWindow,
            TIMEOUTS.matchTimePerPlayer,
            TIMEOUTS.timeIncrementPerMove,
            hre.ethers.ZeroAddress, { value: ENTRY_FEE }
        )
    ).wait();
    const deployed = receipt.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === "InstanceDeployed");
    return deployed.args.instance;
}

function tierConfig() {
    return {
        playerCount: 2,
        entryFee: ENTRY_FEE,
        timeouts: {
            matchTimePerPlayer: TIMEOUTS.matchTimePerPlayer,
            timeIncrementPerMove: TIMEOUTS.timeIncrementPerMove,
            matchLevel2Delay: 2n * 60n,
            matchLevel3Delay: 3n * 60n,
            enrollmentWindow: TIMEOUTS.enrollmentWindow,
            enrollmentLevel2Delay: 2n * 60n,
        },
        totalRounds: 1,
        tierKey: hre.ethers.keccak256(
            hre.ethers.toUtf8Bytes("game-abstraction-harness")
        ),
    };
}

describe("V3 canonical game and factory abstraction", function () {
    this.timeout(60_000);

    it("creates and tracks all game instances through the canonical flow", async function () {
        const { owner, factories, modules } = await loadFixture(deployFixture);

        for (const { name, factory, artifact } of factories) {
            const instanceAddress = await createInstance(factory, owner);
            const instance = await hre.ethers.getContractAt(
                artifact,
                instanceAddress
            );

            expect(
                await factory.isInstance(instanceAddress),
                `${name} clone provenance`
            ).to.equal(true);
            expect(
                await factory.isInstance(await factory.implementation()),
                `${name} implementation is not a clone`
            ).to.equal(false);
            expect(await factory.getInstanceCount()).to.equal(1n);
            expect(await factory.getActiveTournamentCount()).to.equal(1n);
            expect(await instance.factory()).to.equal(
                await factory.getAddress()
            );
            expect(await instance.creator()).to.equal(owner.address);
            expect(await instance.isEnrolled(owner.address)).to.equal(true);
            expect(await instance.MODULE_CORE()).to.equal(
                await modules.core.getAddress()
            );
            expect(await instance.MODULE_MATCHES()).to.equal(
                await modules.matches.getAddress()
            );
            expect(await instance.MODULE_PRIZES()).to.equal(
                await modules.prizes.getAddress()
            );
            expect(await instance.MODULE_ESCALATION()).to.equal(
                await modules.escalation.getAddress()
            );
        }
    });

    it("configures Chess rules exactly once through the factory-only post hook", async function () {
        const { owner, rules, chessFactory } = await loadFixture(deployFixture);
        const instanceAddress = await createInstance(chessFactory, owner);
        const chess = await hre.ethers.getContractAt(
            "contracts/ChessInstance.sol:ChessInstance",
            instanceAddress
        );

        expect(await chess.CHESS_RULES()).to.equal(await rules.getAddress());
        await expect(
            chess.connect(owner).initializeChessRules(await rules.getAddress())
        ).to.be.revertedWith("Only factory");

        const factoryAddress = await chessFactory.getAddress();
        await hre.network.provider.send("hardhat_setBalance", [
            factoryAddress,
            "0x1000000000000000000",
        ]);
        await hre.network.provider.send("hardhat_impersonateAccount", [
            factoryAddress,
        ]);
        const factorySigner = await hre.ethers.getSigner(factoryAddress);
        await expect(
            chess
                .connect(factorySigner)
                .initializeChessRules(await rules.getAddress())
        ).to.be.revertedWith("Chess rules initialized");
        await hre.network.provider.send("hardhat_stopImpersonatingAccount", [
            factoryAddress,
        ]);
    });

    it("preserves Chess repetition nonces across shared reset and restart", async function () {
        const {
            owner,
            player2,
            player3,
            rules,
            modules,
            sessionRegistry,
        } = await loadFixture(deployFixture);
        const harness = await deploy(
            "contracts/test-helpers/ChessGameHarness.sol:ChessGameHarness"
        );

        await harness.initialize(
            tierConfig(),
            owner.address,
            owner.address,
            await modules.core.getAddress(),
            await modules.matches.getAddress(),
            await modules.prizes.getAddress(),
            await modules.escalation.getAddress(),
            await sessionRegistry.getAddress()
        );
        await harness
            .connect(owner)
            .initializeChessRules(await rules.getAddress());

        await harness.createHarnessMatch(
            0,
            0,
            player2.address,
            player3.address
        );
        expect(await harness.gameNonce(MATCH_ID)).to.equal(0n);
        expect(await harness.initialPositionCount(MATCH_ID)).to.equal(1n);

        await harness.resetAndRestartHarnessMatch(
            MATCH_ID,
            player2.address,
            player3.address
        );
        expect(await harness.gameNonce(MATCH_ID)).to.equal(2n);
        expect(await harness.initialPositionCount(MATCH_ID)).to.equal(1n);

        const matchData = await harness.matches(MATCH_ID);
        expect(matchData.status).to.equal(1n);
        expect(matchData.packedBoard).to.not.equal(0n);
        expect(matchData.packedState).to.not.equal(0n);
    });
});
