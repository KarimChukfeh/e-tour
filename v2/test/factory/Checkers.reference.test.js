import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PIECE = {
    EMPTY: 0n,
    P1_MAN: 1n,
    P1_KING: 2n,
    P2_MAN: 3n,
    P2_KING: 4n,
};

function encodeBoard(entries) {
    let board = 0n;
    for (const [index, piece] of Object.entries(entries)) {
        board |= BigInt(piece) << (BigInt(index) * 4n);
    }
    return board;
}

async function deployModules() {
    const [moduleCore, moduleMatchesResolution, modulePrizes, moduleEscalation] = await Promise.all([
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

    const MatchesFactory = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
    );
    const moduleMatches = await MatchesFactory.deploy(await moduleMatchesResolution.getAddress());
    await moduleMatches.waitForDeployment();

    return {
        moduleCore,
        moduleMatches,
        moduleMatchesResolution,
        modulePrizes,
        moduleEscalation,
    };
}

async function deployRegistry() {
    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    return { profileImpl, registry };
}

async function deployCheckersFactoryFixture() {
    const signers = await hre.ethers.getSigners();
    const modules = await deployModules();
    const { registry } = await deployRegistry();

    const Factory = await hre.ethers.getContractFactory("contracts/CheckersFactory.sol:CheckersFactory");
    const factory = await Factory.deploy(
        await modules.moduleCore.getAddress(),
        await modules.moduleMatches.getAddress(),
        await modules.modulePrizes.getAddress(),
        await modules.moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await factory.waitForDeployment();
    await registry.authorizeFactory(await factory.getAddress());

    return { signers, modules, registry, factory };
}

async function deployHarnessFixture() {
    const signers = await hre.ethers.getSigners();
    const Harness = await hre.ethers.getContractFactory("contracts/test-helpers/CheckersHarness.sol:CheckersHarness");
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    return { signers, harness };
}

function getSignerByAddress(signers, address) {
    const normalized = address.toLowerCase();
    const signer = signers.find(candidate => candidate.address.toLowerCase() === normalized);
    if (!signer) {
        throw new Error(`Missing signer for ${address}`);
    }
    return signer;
}

function matchId(roundNumber, matchNumber) {
    return hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [roundNumber, matchNumber]);
}

describe("Checkers reference implementation", function () {
    this.timeout(120_000);

    it("creates a real checkers instance and enforces mandatory captures on the clone", async function () {
        const { signers, factory } = await loadFixture(deployCheckersFactoryFixture);
        const [, creator, challenger] = signers;
        const entryFee = hre.ethers.parseEther("0.001");

        await factory.connect(creator).createInstance(
            2,
            entryFee,
            10 * 60,
            5 * 60,
            0,
            { value: entryFee }
        );

        const instanceAddress = await factory.instances(0);
        const checkers = await hre.ethers.getContractAt(
            "contracts/Checkers.sol:Checkers",
            instanceAddress
        );

        await checkers.connect(challenger).enrollInTournament({ value: entryFee });

        const boardBefore = await checkers.getBoard(0, 0);
        expect(boardBefore.filter(piece => piece === 1n)).to.have.length(12);
        expect(boardBefore.filter(piece => piece === 3n)).to.have.length(12);

        const openingMatch = await checkers.matches(matchId(0, 0));
        const player1 = getSignerByAddress(signers, openingMatch.player1);
        const player2 = getSignerByAddress(signers, openingMatch.player2);

        await checkers.connect(player1).makeMove(0, 0, 20, 16);
        await checkers.connect(player2).makeMove(0, 0, 9, 13);

        await expect(
            checkers.connect(player1).makeMove(0, 0, 21, 17)
        ).to.be.revertedWithCustomError(checkers, "MandatoryCaptureAvailable");

        await checkers.connect(player1).makeMove(0, 0, 16, 9);

        const boardAfter = await checkers.getBoard(0, 0);
        expect(boardAfter[16]).to.equal(0n);
        expect(boardAfter[13]).to.equal(0n);
        expect(boardAfter[9]).to.equal(1n);
        expect(await checkers.getMatchMoves(0, 0)).to.equal("20-16,9-13,16x9");
    });

    it("keeps the turn with the capturing piece when another jump is available", async function () {
        const { signers, harness } = await loadFixture(deployHarnessFixture);
        const [player1, player2] = signers;

        await harness.harnessSetup(
            player1.address,
            player2.address,
            player1.address,
            encodeBoard({
                0: PIECE.P2_MAN,
                9: PIECE.P2_MAN,
                16: PIECE.P2_MAN,
                20: PIECE.P1_MAN,
            }),
            0
        );

        await harness.connect(player1).makeMove(0, 0, 20, 13);

        const afterFirstCapture = await harness.matches(matchId(0, 0));
        expect(afterFirstCapture.currentTurn).to.equal(player1.address);
        expect(afterFirstCapture.packedBoard).to.equal(
            encodeBoard({
                0: PIECE.P2_MAN,
                9: PIECE.P2_MAN,
                13: PIECE.P1_MAN,
            })
        );

        const pending = await harness.getPendingCapture(0, 0);
        expect(pending.active).to.equal(true);
        expect(pending.source).to.equal(13n);

        await harness.connect(player1).makeMove(0, 0, 13, 6);

        const afterSecondCapture = await harness.matches(matchId(0, 0));
        expect(afterSecondCapture.currentTurn).to.equal(player2.address);
        expect(afterSecondCapture.packedBoard).to.equal(
            encodeBoard({
                0: PIECE.P2_MAN,
                6: PIECE.P1_MAN,
            })
        );

        const cleared = await harness.getPendingCapture(0, 0);
        expect(cleared.active).to.equal(false);
        expect(await harness.getMatchMoves(0, 0)).to.equal("20x13,13x6");
    });

    it("promotes a man that reaches the back rank", async function () {
        const { signers, harness } = await loadFixture(deployHarnessFixture);
        const [player1, player2] = signers;

        await harness.harnessSetup(
            player1.address,
            player2.address,
            player1.address,
            encodeBoard({
                5: PIECE.P1_MAN,
                8: PIECE.P2_MAN,
            }),
            0
        );

        await harness.connect(player1).makeMove(0, 0, 5, 1);

        const board = await harness.getBoard(0, 0);
        expect(board[1]).to.equal(2n);
        expect(board[5]).to.equal(0n);

        const rawMatch = await harness.matches(matchId(0, 0));
        expect(rawMatch.currentTurn).to.equal(player2.address);
        expect(await harness.getMatchMoves(0, 0)).to.equal("5-1K");
    });
});
