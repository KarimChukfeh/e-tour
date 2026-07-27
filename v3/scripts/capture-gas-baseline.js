import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import hre from "hardhat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.resolve(__dirname, "..", "baselines", "gas-lifecycle.json");

async function deploy(contractName, args = []) {
    const factory = await hre.ethers.getContractFactory(contractName);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function deployFactory() {
    const [core, matches, prizes, escalation] = await Promise.all([
        deploy("contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"),
        deploy("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"),
        deploy("contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"),
        deploy("contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"),
    ]);

    const profile = await deploy("contracts/PlayerProfile.sol:PlayerProfile");
    const registry = await deploy(
        "contracts/PlayerRegistry.sol:PlayerRegistry",
        [await profile.getAddress()]
    );
    const factory = await deploy(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        [
            await core.getAddress(),
            await matches.getAddress(),
            await prizes.getAddress(),
            await escalation.getAddress(),
            await registry.getAddress(),
        ]
    );
    await (await registry.authorizeFactory(await factory.getAddress())).wait();
    return factory;
}

function parseInstanceAddress(factory, receipt) {
    for (const log of receipt.logs) {
        try {
            const event = factory.interface.parseLog(log);
            if (event?.name === "InstanceDeployed") {
                return event.args.instance;
            }
        } catch {
            // Ignore logs emitted by other contracts in the creation transaction.
        }
    }
    throw new Error("InstanceDeployed event not found");
}

async function signerFor(address, signers) {
    const normalized = address.toLowerCase();
    const signer = signers.find((candidate) => candidate.address.toLowerCase() === normalized);
    if (!signer) {
        throw new Error(`No local signer found for match player ${address}`);
    }
    return signer;
}

async function playWin(instance, roundNumber, matchNumber, signers) {
    const matchId = hre.ethers.solidityPackedKeccak256(
        ["uint8", "uint8"],
        [roundNumber, matchNumber]
    );
    const matchData = await instance.matches(matchId);
    const first = await signerFor(matchData.currentTurn, signers);
    const secondAddress =
        matchData.player1.toLowerCase() === first.address.toLowerCase()
            ? matchData.player2
            : matchData.player1;
    const second = await signerFor(secondAddress, signers);

    const gas = [];
    for (const [signer, cell] of [
        [first, 0],
        [second, 3],
        [first, 1],
        [second, 4],
        [first, 2],
    ]) {
        const receipt = await (
            await instance.connect(signer).makeMove(roundNumber, matchNumber, cell)
        ).wait();
        gas.push(receipt.gasUsed);
    }

    return {
        winner: first.address,
        normalMove: gas[0],
        terminalMove: gas[4],
    };
}

async function main() {
    const signers = await hre.ethers.getSigners();
    const [creator, player2, player3, player4] = signers;
    const factory = await deployFactory();
    const entryFee = hre.ethers.parseEther("0.001");

    const creationReceipt = await (
        await factory.connect(creator).createInstance(
            4,
            entryFee,
            30n * 60n,
            15n * 60n,
            30n,
            { value: entryFee }
        )
    ).wait();
    const instanceAddress = parseInstanceAddress(factory, creationReceipt);
    const instance = await hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        instanceAddress
    );

    const enrollmentReceipt = await (
        await instance.connect(player2).enrollInTournament({ value: entryFee })
    ).wait();
    await (await instance.connect(player3).enrollInTournament({ value: entryFee })).wait();
    const startingEnrollmentReceipt = await (
        await instance.connect(player4).enrollInTournament({ value: entryFee })
    ).wait();

    const semifinal0 = await playWin(instance, 0, 0, signers);
    await playWin(instance, 0, 1, signers);
    const final = await playWin(instance, 1, 0, signers);

    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        compiler: {
            version: "0.8.20",
            optimizerEnabled: true,
            optimizerRuns: 1,
            viaIR: true,
        },
        scenario: {
            game: "TicTac",
            playerCount: 4,
            entryFeeWei: entryFee.toString(),
            note:
                "The terminal settlement is atomic inside the final makeMove transaction; " +
                "V2 has no separately callable normal-settlement transaction.",
        },
        gasUsed: {
            createInstanceAndCreatorEnrollment: creationReceipt.gasUsed.toString(),
            enrollmentWithoutTournamentStart: enrollmentReceipt.gasUsed.toString(),
            enrollmentWithTournamentStart: startingEnrollmentReceipt.gasUsed.toString(),
            normalMove: semifinal0.normalMove.toString(),
            terminalMatchMoveWithoutTournamentSettlement: semifinal0.terminalMove.toString(),
            terminalMoveWithTournamentSettlement: final.terminalMove.toString(),
            standaloneSettlement: null,
        },
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote lifecycle gas baseline: ${OUTPUT_PATH}`);
    console.log(JSON.stringify(report.gasUsed, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
