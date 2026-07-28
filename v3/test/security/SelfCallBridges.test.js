import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const MATCH_ID = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [0, 0]);

const BRIDGES = [
    { signature: "initializeRound(uint8)", args: [0] },
    {
        signature: "_createMatchGame(uint8,uint8,address,address)",
        args: (creator, attacker) => [0, 0, creator.address, attacker.address],
    },
    { signature: "_resetMatchGame(bytes32)", args: [MATCH_ID] },
    {
        signature: "_setMatchPlayer(bytes32,uint8,address)",
        args: (creator) => [MATCH_ID, 0, creator.address],
    },
    { signature: "_initializeMatchForPlay(bytes32)", args: [MATCH_ID] },
    {
        signature: "_completeMatchWithResult(bytes32,address,bool)",
        args: (creator) => [MATCH_ID, creator.address, false],
    },
];

function bridgeArgs(bridge, creator, attacker) {
    return typeof bridge.args === "function"
        ? bridge.args(creator, attacker)
        : bridge.args;
}

function normalize(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return Array.from(value, normalize);
    return value;
}

async function deployContract(name, ...args) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

function tierConfig() {
    return {
        playerCount: 2,
        entryFee: ENTRY_FEE,
        timeouts: {
            matchTimePerPlayer: 5n * 60n,
            timeIncrementPerMove: 15n,
            matchLevel2Delay: 2n * 60n,
            matchLevel3Delay: 3n * 60n,
            enrollmentWindow: 10n * 60n,
            enrollmentLevel2Delay: 2n * 60n,
        },
        totalRounds: 1,
        tierKey: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("self-call-bridge-test")),
    };
}

async function initializeBaseInstance(
    instance,
    owner,
    modules,
    moduleMatches = modules.matches
) {
    await instance.initialize(
        tierConfig(),
        owner.address,
        owner.address,
        await modules.core.getAddress(),
        await moduleMatches.getAddress(),
        await modules.prizes.getAddress(),
        await modules.escalation.getAddress(),
        await modules.sessionRegistry.getAddress()
    );
    await instance.connect(owner).enrollInTournament(hre.ethers.ZeroAddress, { value: ENTRY_FEE });
}

async function deployFixture() {
    const [owner, joiner, attacker] = await hre.ethers.getSigners();

    const [core, matches, prizes, escalation, rules, harness, sessionRegistry] = await Promise.all([
        deployContract("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"),
        deployContract("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"),
        deployContract("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"),
        deployContract("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"),
        deployContract("contracts/modules/ChessRulesModule.sol:ChessRulesModule"),
        deployContract("contracts/test-helpers/SelfCallBridgeHarness.sol:SelfCallBridgeHarness"),
        deployContract(
            "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
            owner.address
        ),
    ]);
    const modules = { core, matches, prizes, escalation, sessionRegistry };

    const [ticTac, connectFour, chess, harnessInstance] = await Promise.all([
        deployContract("contracts/TicTacInstance.sol:TicTacInstance"),
        deployContract("contracts/ConnectFourInstance.sol:ConnectFourInstance"),
        deployContract("contracts/ChessInstance.sol:ChessInstance"),
        deployContract("contracts/TicTacInstance.sol:TicTacInstance"),
    ]);

    await initializeBaseInstance(ticTac, owner, modules);
    await initializeBaseInstance(connectFour, owner, modules);
    await chess.initialize(
        tierConfig(),
        owner.address,
        owner.address,
        await core.getAddress(),
        await matches.getAddress(),
        await prizes.getAddress(),
        await escalation.getAddress(),
        await sessionRegistry.getAddress()
    );
    await chess.connect(owner).initializeChessRules(await rules.getAddress());
    await chess.connect(owner).enrollInTournament(hre.ethers.ZeroAddress, { value: ENTRY_FEE });
    await initializeBaseInstance(harnessInstance, owner, modules, harness);

    return {
        owner,
        joiner,
        attacker,
        harness,
        harnessInstance,
        instances: [
            { name: "TicTacInstance", contract: ticTac },
            { name: "ConnectFourInstance", contract: connectFour },
            { name: "ChessInstance", contract: chess },
        ],
    };
}

async function stateSnapshot(instance) {
    const address = await instance.getAddress();
    const canonicalSlots = await Promise.all(
        Array.from({ length: 45 }, (_, slot) =>
            hre.ethers.provider.getStorage(address, slot)
        )
    );

    return {
        canonicalSlots,
        balance: (await hre.ethers.provider.getBalance(address)).toString(),
        tournament: normalize(await instance.tournament()),
        players: normalize(await instance.getPlayers()),
        round: normalize(await instance.rounds(0)),
        match: normalize(await instance.matches(MATCH_ID)),
    };
}

describe("V3 protected self-call bridges", function () {
    this.timeout(60_000);

    it("rejects every bridge when called directly by an EOA on every game", async function () {
        const { owner, attacker, instances } = await loadFixture(deployFixture);

        for (const { name, contract } of instances) {
            for (const bridge of BRIDGES) {
                const call = contract.connect(attacker).getFunction(bridge.signature);
                await expect(
                    call(...bridgeArgs(bridge, owner, attacker)),
                    `${name}.${bridge.signature}`
                ).to.be.revertedWithCustomError(contract, "OnlySelfCall");
            }
        }
    });

    it("rejects every bridge when called through an unrelated contract", async function () {
        const { owner, attacker, harness, instances } = await loadFixture(deployFixture);

        for (const { name, contract } of instances) {
            for (const bridge of BRIDGES) {
                const data = contract.interface.encodeFunctionData(
                    bridge.signature,
                    bridgeArgs(bridge, owner, attacker)
                );
                await expect(
                    harness.callTarget(await contract.getAddress(), data),
                    `${name}.${bridge.signature}`
                ).to.be.revertedWithCustomError(contract, "OnlySelfCall");
            }
        }
    });

    it("leaves canonical and match state unchanged after all rejected calls", async function () {
        const { owner, attacker, harness, instances } = await loadFixture(deployFixture);
        const instance = instances[0].contract;
        const before = await stateSnapshot(instance);

        for (const bridge of BRIDGES) {
            const args = bridgeArgs(bridge, owner, attacker);
            await expect(
                instance.connect(attacker).getFunction(bridge.signature)(...args)
            ).to.be.revertedWithCustomError(instance, "OnlySelfCall");

            const data = instance.interface.encodeFunctionData(bridge.signature, args);
            await expect(
                harness.callTarget(await instance.getAddress(), data)
            ).to.be.revertedWithCustomError(instance, "OnlySelfCall");
        }

        expect(await stateSnapshot(instance)).to.deep.equal(before);
    });

    it("keeps production module-driven round creation working for every game", async function () {
        const { joiner, instances } = await loadFixture(deployFixture);

        for (const { contract } of instances) {
            await contract.connect(joiner).enrollInTournament(hre.ethers.ZeroAddress, { value: ENTRY_FEE });

            const round = await contract.rounds(0);
            const match = await contract.matches(MATCH_ID);
            expect(round.initialized).to.equal(true);
            expect(match.status).to.equal(1n);
        }
    });

    it("accepts all six bridges from a legitimate delegatecall module", async function () {
        const { owner, joiner, harnessInstance } = await loadFixture(deployFixture);

        await harnessInstance.connect(joiner).enrollInTournament(hre.ethers.ZeroAddress, { value: ENTRY_FEE });

        const match = await harnessInstance.matches(MATCH_ID);
        expect(match.player1).to.equal(owner.address);
        expect(match.player2).to.equal(joiner.address);
        expect(match.winner).to.equal(owner.address);
        expect(match.isDraw).to.equal(false);
        expect(match.status).to.equal(2n);
    });
});
