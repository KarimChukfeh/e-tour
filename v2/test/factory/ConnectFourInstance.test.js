import { expect } from "chai";
import hre from "hardhat";

const CONNECT_FOUR_GAME_TYPE = 1;
const ENTRY_FEE = hre.ethers.parseEther("0.001");
const PLAYER_COUNT = 4;
const MATCH_TIME = 2n * 60n;
const MATCH_LEVEL_3_DELAY = 3n * 60n;
const PARTICIPANTS_SHARE_BPS = 9000n;
const BASIS_POINTS = 10000n;

async function deployFactory() {
    const [moduleCore, moduleMatches, modulePrizes, moduleEscalation] = await Promise.all([
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
    ]);

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("contracts/ConnectFourFactory.sol:ConnectFourFactory");
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

function shortTimeouts() {
    return {
        enrollmentWindow: 2n * 60n,
        matchTimePerPlayer: MATCH_TIME,
        timeIncrementPerMove: 15n,
    };
}

async function createInstance(factory, signer) {
    const tx = await factory.connect(signer).createInstance(
        PLAYER_COUNT,
        ENTRY_FEE,
        shortTimeouts().enrollmentWindow,
        shortTimeouts().matchTimePerPlayer,
        shortTimeouts().timeIncrementPerMove,
        { value: ENTRY_FEE }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
        .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(parsed => parsed && parsed.name === "InstanceDeployed");

    return hre.ethers.getContractAt(
        "contracts/ConnectFourInstance.sol:ConnectFourInstance",
        event.args.instance
    );
}

async function enrollAll(instance, signers) {
    for (const signer of signers) {
        await instance.connect(signer).enrollInTournament({ value: ENTRY_FEE });
    }
}

async function advanceTime(seconds) {
    await hre.ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await hre.ethers.provider.send("evm_mine", []);
}

async function getProfile(registry, player) {
    const profileAddress = await registry.getProfile(player.address, CONNECT_FOUR_GAME_TYPE);
    return hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddress);
}

async function playMatchWithWinner(instance, roundNumber, matchNumber, desiredWinner, otherPlayer) {
    const matchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [roundNumber, matchNumber]);
    const match = await instance.matches(matchId);
    const firstPlayer = match.currentTurn === desiredWinner.address ? desiredWinner : otherPlayer;
    const secondPlayer = firstPlayer.address === desiredWinner.address ? otherPlayer : desiredWinner;

    if (firstPlayer.address === desiredWinner.address) {
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 0);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 0);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 1);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 1);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 2);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 2);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 3);
    } else {
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 6);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 0);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 6);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 1);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 6);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 2);
        await instance.connect(firstPlayer).makeMove(roundNumber, matchNumber, 5);
        await instance.connect(secondPlayer).makeMove(roundNumber, matchNumber, 3);
    }
}

describe("ConnectFourInstance — finals ML3 replacement", function () {
    this.timeout(60_000);

    let factory;
    let registry;
    let instance;
    let A;
    let B;
    let C;
    let D;

    beforeEach(async function () {
        [A, B, C, D] = await hre.ethers.getSigners();
        ({ factory, registry } = await deployFactory());
        instance = await createInstance(factory, A);
        await enrollAll(instance, [B, C, D]);
    });

    it("awards C the prize and records ML3 finals completion after replacing A and D", async function () {
        await playMatchWithWinner(instance, 0, 0, A, B);
        await playMatchWithWinner(instance, 0, 1, D, C);

        const finalsBeforeStall = await instance.getMatch(1, 0);
        const finalsMatchId = hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [1, 0]);
        const finalsMatchState = await instance.matches(finalsMatchId);
        expect([finalsBeforeStall.player1, finalsBeforeStall.player2]).to.have.members([A.address, D.address]);
        const finalsMover = finalsMatchState.currentTurn === A.address ? A : D;

        await instance.connect(finalsMover).makeMove(1, 0, 0);
        await advanceTime(MATCH_TIME + MATCH_LEVEL_3_DELAY + 5n);

        expect(await instance.isMatchEscL3Available(1, 0)).to.be.true;

        await instance.connect(C).claimMatchSlotByReplacement(1, 0);

        const tournament = await instance.tournament();
        const finalsAfterClaim = await instance.getMatch(1, 0);
        const expectedPrize = ENTRY_FEE * BigInt(PLAYER_COUNT) * PARTICIPANTS_SHARE_BPS / BASIS_POINTS;

        expect(tournament.status).to.equal(2);
        expect(tournament.winner).to.equal(C.address);
        expect(tournament.completionReason).to.equal(4);
        expect(tournament.completionCategory).to.equal(2n);

        expect(await instance.playerPrizes(C.address)).to.equal(expectedPrize);
        expect(await instance.playerPrizes(A.address)).to.equal(0n);
        expect(await instance.playerPrizes(D.address)).to.equal(0n);

        expect(finalsAfterClaim.player1).to.equal(finalsBeforeStall.player1);
        expect(finalsAfterClaim.player2).to.equal(finalsBeforeStall.player2);
        expect([finalsAfterClaim.player1, finalsAfterClaim.player2]).to.have.members([A.address, D.address]);
        expect(finalsAfterClaim.matchWinner).to.equal(C.address);
        expect(finalsAfterClaim.status).to.equal(2);
        expect(finalsAfterClaim.isDraw).to.equal(false);
        expect(finalsAfterClaim.completionReason).to.equal(4);
        expect(finalsAfterClaim.completionCategory).to.equal(2n);

        const resultA = await instance.getPlayerResult(A.address);
        const resultC = await instance.getPlayerResult(C.address);
        const resultD = await instance.getPlayerResult(D.address);

        expect(resultA.participated).to.be.true;
        expect(resultA.isWinner).to.be.false;
        expect(resultA.prizeWon).to.equal(0n);

        expect(resultD.participated).to.be.true;
        expect(resultD.isWinner).to.be.false;
        expect(resultD.prizeWon).to.equal(0n);

        expect(resultC.participated).to.be.true;
        expect(resultC.isWinner).to.be.true;
        expect(resultC.prizeWon).to.equal(expectedPrize);

        const [profileA, profileC, profileD] = await Promise.all([
            getProfile(registry, A),
            getProfile(registry, C),
            getProfile(registry, D),
        ]);

        const instanceAddress = await instance.getAddress();
        const [recordA, recordC, recordD] = await Promise.all([
            profileA.getEnrollmentByInstance(instanceAddress),
            profileC.getEnrollmentByInstance(instanceAddress),
            profileD.getEnrollmentByInstance(instanceAddress),
        ]);
        const [matchRecordA, matchRecordC, matchRecordD] = await Promise.all([
            profileA.getMatchRecordByKey(instanceAddress, 1, 0),
            profileC.getMatchRecordByKey(instanceAddress, 1, 0),
            profileD.getMatchRecordByKey(instanceAddress, 1, 0),
        ]);

        expect(recordA.concluded).to.be.true;
        expect(recordA.won).to.be.false;
        expect(recordA.prize).to.equal(0n);
        expect(recordA.tournamentResolutionReason).to.equal(4n);
        expect(recordA.tournamentResolutionCategory).to.equal(2n);

        expect(recordD.concluded).to.be.true;
        expect(recordD.won).to.be.false;
        expect(recordD.prize).to.equal(0n);
        expect(recordD.tournamentResolutionReason).to.equal(4n);
        expect(recordD.tournamentResolutionCategory).to.equal(2n);

        expect(recordC.concluded).to.be.true;
        expect(recordC.won).to.be.true;
        expect(recordC.prize).to.equal(expectedPrize);
        expect(recordC.tournamentResolutionReason).to.equal(4n);
        expect(recordC.tournamentResolutionCategory).to.equal(2n);

        expect(matchRecordA.outcome).to.equal(9n); // ReplacementDefeat
        expect(matchRecordA.category).to.equal(2n); // Defeat
        expect(matchRecordD.outcome).to.equal(9n);
        expect(matchRecordD.category).to.equal(2n);
        expect(matchRecordC.outcome).to.equal(8n); // ReplacementVictory
        expect(matchRecordC.category).to.equal(1n); // Victory
    });
});
