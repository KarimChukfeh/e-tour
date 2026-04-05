import { expect } from "chai";
import hre from "hardhat";

const PAYOUT_REASON = {
    None: 0n,
    Victory: 1n,
    EvenSplit: 2n,
    WalletRejected: 3n,
    Cancelation: 4n,
};
const PARTICIPANTS_SHARE_BPS = 9500n;
const BASIS_POINTS = 10000n;

async function deployFactory() {
    const Core = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
    );
    const Matches = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
    );
    const Prizes = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"
    );
    const Escalation = await hre.ethers.getContractFactory(
        "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"
    );

    const [moduleCore, moduleMatches, modulePrizes, moduleEscalation] =
        await Promise.all([
            Core.deploy().then(c => c.waitForDeployment().then(() => c)),
            Matches.deploy().then(c => c.waitForDeployment().then(() => c)),
            Prizes.deploy().then(c => c.waitForDeployment().then(() => c)),
            Escalation.deploy().then(c => c.waitForDeployment().then(() => c)),
        ]);

    const ProfileImpl = await hre.ethers.getContractFactory("contracts/PlayerProfile.sol:PlayerProfile");
    const profileImpl = await ProfileImpl.deploy();
    await profileImpl.waitForDeployment();

    const Registry = await hre.ethers.getContractFactory("contracts/PlayerRegistry.sol:PlayerRegistry");
    const registry = await Registry.deploy(await profileImpl.getAddress());
    await registry.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory"
    );
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
        enrollmentWindow: 30n * 60n,
        matchTimePerPlayer: 15n * 60n,
        timeIncrementPerMove: 30n,
    };
}

async function createInstance(factory, playerCount, entryFee, creator) {
    const tx = await factory.connect(creator).createInstance(
        playerCount,
        entryFee,
        defaultTimeouts().enrollmentWindow,
        defaultTimeouts().matchTimePerPlayer,
        defaultTimeouts().timeIncrementPerMove,
        { value: entryFee }
    );
    const receipt = await tx.wait();

    const event = receipt.logs
        .map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
        .find(parsed => parsed && parsed.name === "InstanceDeployed");

    return hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        event.args.instance
    );
}

function signerParticipant(instance, signer) {
    return {
        address: signer.address,
        async enroll(fee) {
            await instance.connect(signer).enrollInTournament({ value: fee });
        },
        async move(roundNumber, matchNumber, cellIndex) {
            await instance.connect(signer).makeMove(roundNumber, matchNumber, cellIndex);
        },
    };
}

async function proxyParticipant(instanceAddress, controller) {
    const Proxy = await hre.ethers.getContractFactory(
        "contracts/test-helpers/RejectingTicTacPlayer.sol:RejectingTicTacPlayer"
    );
    const proxy = await Proxy.connect(controller).deploy(instanceAddress);
    await proxy.waitForDeployment();

    return {
        address: await proxy.getAddress(),
        contract: proxy,
        async enroll(fee) {
            await proxy.connect(controller).enrollInTournament({ value: fee });
        },
        async move(roundNumber, matchNumber, cellIndex) {
            await proxy.connect(controller).makeMove(roundNumber, matchNumber, cellIndex);
        },
        async setRejectPayments(reject) {
            await proxy.connect(controller).setRejectPayments(reject);
        },
    };
}

async function playWinningGame(instance, roundNumber, matchNumber, playerA, playerB, winner, beforeWinningMove) {
    const matchId = hre.ethers.solidityPackedKeccak256(
        ["uint8", "uint8"],
        [roundNumber, matchNumber]
    );
    const matchData = await instance.matches(matchId);

    const first = matchData.currentTurn === playerA.address ? playerA : playerB;
    const second = first.address === playerA.address ? playerB : playerA;

    if (winner.address === first.address) {
        await first.move(roundNumber, matchNumber, 0);
        await second.move(roundNumber, matchNumber, 3);
        await first.move(roundNumber, matchNumber, 1);
        await second.move(roundNumber, matchNumber, 4);
        if (beforeWinningMove) {
            await beforeWinningMove();
        }
        await first.move(roundNumber, matchNumber, 2);
        return first.address;
    }

    await first.move(roundNumber, matchNumber, 0);
    await second.move(roundNumber, matchNumber, 3);
    await first.move(roundNumber, matchNumber, 1);
    await second.move(roundNumber, matchNumber, 4);
    await first.move(roundNumber, matchNumber, 8);
    if (beforeWinningMove) {
        await beforeWinningMove();
    }
    await second.move(roundNumber, matchNumber, 5);
    return second.address;
}

describe("ETourInstance_Prizes redistribution on failed payouts", function () {
    this.timeout(60_000);

    it("records Victory payout metadata for a paid winner", async function () {
        const [creator, opponent] = await hre.ethers.getSigners();
        const entryFee = hre.ethers.parseEther("0.001");

        const { factory, registry } = await deployFactory();
        const instance = await createInstance(factory, 2, entryFee, creator);

        const creatorPlayer = signerParticipant(instance, creator);
        const opponentPlayer = signerParticipant(instance, opponent);

        await opponentPlayer.enroll(entryFee);
        await playWinningGame(instance, 0, 0, creatorPlayer, opponentPlayer, creatorPlayer);

        const winnersPot = (entryFee * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const winnerResult = await instance.getPlayerResult(creator.address);
        const loserResult = await instance.getPlayerResult(opponent.address);

        expect(winnerResult.payout).to.equal(winnersPot);
        expect(winnerResult.payoutReason).to.equal(PAYOUT_REASON.Victory);
        expect(loserResult.payout).to.equal(0n);
        expect(loserResult.payoutReason).to.equal(PAYOUT_REASON.None);

        const winnerProfileAddr = await registry.getProfile(creator.address, 0);
        const loserProfileAddr = await registry.getProfile(opponent.address, 0);
        const winnerProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", winnerProfileAddr);
        const loserProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", loserProfileAddr);
        const winnerRecord = await winnerProfile.getEnrollmentByInstance(await instance.getAddress());
        const loserRecord = await loserProfile.getEnrollmentByInstance(await instance.getAddress());

        expect(winnerRecord.prize).to.equal(winnersPot);
        expect(winnerRecord.payout).to.equal(winnersPot);
        expect(winnerRecord.payoutReason).to.equal(PAYOUT_REASON.Victory);
        expect(loserRecord.prize).to.equal(winnersPot);
        expect(loserRecord.payout).to.equal(0n);
        expect(loserRecord.payoutReason).to.equal(PAYOUT_REASON.None);
    });

    it("redistributes a rejecting winner's full prize across the other enrolled player", async function () {
        const [creator, proxyController] = await hre.ethers.getSigners();
        const entryFee = hre.ethers.parseEther("0.001");

        const { factory, registry } = await deployFactory();
        const instance = await createInstance(factory, 2, entryFee, creator);

        const creatorPlayer = signerParticipant(instance, creator);
        const rejectingWinner = await proxyParticipant(await instance.getAddress(), proxyController);

        await rejectingWinner.enroll(entryFee);

        await playWinningGame(
            instance,
            0,
            0,
            creatorPlayer,
            rejectingWinner,
            rejectingWinner,
            async () => {
                await rejectingWinner.setRejectPayments(true);
            }
        );

        const winnersPot = (entryFee * 2n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const winnerResult = await instance.getPlayerResult(rejectingWinner.address);
        const loserResult = await instance.getPlayerResult(creator.address);

        expect(await instance.playerPrizes(rejectingWinner.address)).to.equal(0n);
        expect(await instance.playerPrizes(creator.address)).to.equal(winnersPot);
        expect(winnerResult.payout).to.equal(0n);
        expect(winnerResult.payoutReason).to.equal(PAYOUT_REASON.WalletRejected);
        expect(loserResult.payout).to.equal(winnersPot);
        expect(loserResult.payoutReason).to.equal(PAYOUT_REASON.EvenSplit);

        const loserProfileAddr = await registry.getProfile(creator.address, 0);
        const loserProfile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", loserProfileAddr);
        const loserRecord = await loserProfile.getEnrollmentByInstance(await instance.getAddress());
        expect(loserRecord.prize).to.equal(winnersPot);
        expect(loserRecord.payout).to.equal(winnersPot);
        expect(loserRecord.payoutReason).to.equal(PAYOUT_REASON.EvenSplit);
    });

    it("keeps redistributing failed shares until only accepting enrolled players remain", async function () {
        const [creator, winnerController, loserController, fourthPlayer] = await hre.ethers.getSigners();
        const entryFee = hre.ethers.parseEther("0.001");

        const { factory } = await deployFactory();
        const instance = await createInstance(factory, 4, entryFee, creator);

        const creatorPlayer = signerParticipant(instance, creator);
        const acceptingLoser = signerParticipant(instance, fourthPlayer);
        const rejectingWinner = await proxyParticipant(await instance.getAddress(), winnerController);
        const rejectingLoser = await proxyParticipant(await instance.getAddress(), loserController);

        await rejectingWinner.enroll(entryFee);
        await rejectingLoser.enroll(entryFee);
        await acceptingLoser.enroll(entryFee);

        await playWinningGame(instance, 0, 0, creatorPlayer, rejectingWinner, rejectingWinner);
        await playWinningGame(instance, 0, 1, rejectingLoser, acceptingLoser, acceptingLoser);

        await playWinningGame(
            instance,
            1,
            0,
            rejectingWinner,
            acceptingLoser,
            rejectingWinner,
            async () => {
                await rejectingWinner.setRejectPayments(true);
                await rejectingLoser.setRejectPayments(true);
            }
        );

        const winnersPot = (entryFee * 4n * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        const firstRedistributionShare = winnersPot / 3n;
        const rejectedLoserShare = firstRedistributionShare + 1n;
        const creatorShare = rejectedLoserShare + ((rejectedLoserShare + 1n) / 2n);
        const fourthPlayerShare = (winnersPot - creatorShare);

        expect(await instance.playerPrizes(rejectingWinner.address)).to.equal(0n);
        expect(await instance.playerPrizes(rejectingLoser.address)).to.equal(0n);
        expect(await instance.playerPrizes(creator.address)).to.equal(creatorShare);
        expect(await instance.playerPrizes(fourthPlayer.address)).to.equal(fourthPlayerShare);

        const winnerResult = await instance.getPlayerResult(rejectingWinner.address);
        const loserResult = await instance.getPlayerResult(rejectingLoser.address);
        const creatorResult = await instance.getPlayerResult(creator.address);
        const fourthResult = await instance.getPlayerResult(fourthPlayer.address);

        expect(winnerResult.payoutReason).to.equal(PAYOUT_REASON.WalletRejected);
        expect(loserResult.payoutReason).to.equal(PAYOUT_REASON.WalletRejected);
        expect(creatorResult.payout).to.equal(creatorShare);
        expect(creatorResult.payoutReason).to.equal(PAYOUT_REASON.EvenSplit);
        expect(fourthResult.payout).to.equal(fourthPlayerShare);
        expect(fourthResult.payoutReason).to.equal(PAYOUT_REASON.EvenSplit);
    });
});
