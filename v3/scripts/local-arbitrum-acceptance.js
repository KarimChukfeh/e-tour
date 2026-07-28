import { createRequire } from "module";
import hre from "hardhat";
import {
    FailoverBundler,
} from "../sdk/bundler-client.js";
import {
    BundlerSimulationError,
    LocalBundler,
} from "../sdk/local-bundler.js";
import {
    buildInitCode,
    buildPackedUserOperation,
    buildPaymasterAndData,
    encodeAccountExecute,
    estimateUserOperationGas,
    getUserOperationNonce,
    signUserOperation,
    submitUserOperation,
    toRpcUserOperation,
} from "../sdk/user-operation.js";
import {
    generateBrowserSessionKey,
    generateSessionSalt,
} from "../sdk/dist/index.js";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";
import {
    isLocalDevelopmentNetwork,
} from "./lib/deployment-output.js";

if (!isLocalDevelopmentNetwork(hre.network.name)) {
    throw new Error(
        "local Arbitrum acceptance requires a local Hardhat network"
    );
}

const require = createRequire(import.meta.url);
const entryPointArtifact = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const MATCH_ID = hre.ethers.solidityPackedKeccak256(
    ["uint8", "uint8"],
    [0, 0]
);
const GAMES = [
    {
        key: "tictactoe",
        gameType: 0,
        factoryKey: "TicTacChainFactory",
        factoryArtifact:
            "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        instanceArtifact:
            "contracts/TicTacInstance.sol:TicTacInstance",
        moves: [
            [0, 0, 0],
            [0, 0, 3],
            [0, 0, 1],
            [0, 0, 4],
            [0, 0, 2],
        ],
    },
    {
        key: "connectfour",
        gameType: 1,
        factoryKey: "ConnectFourFactory",
        factoryArtifact:
            "contracts/ConnectFourFactory.sol:ConnectFourFactory",
        instanceArtifact:
            "contracts/ConnectFourInstance.sol:ConnectFourInstance",
        moves: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 0, 0],
            [0, 0, 1],
            [0, 0, 0],
            [0, 0, 1],
            [0, 0, 0],
        ],
    },
    {
        key: "chess",
        gameType: 2,
        factoryKey: "ChessOnChainFactory",
        factoryArtifact:
            "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
        instanceArtifact:
            "contracts/ChessInstance.sol:ChessInstance",
        // Fool's mate: f2-f3, e7-e5, g2-g4, d8-h4#.
        moves: [
            [0, 0, 13, 21, 0],
            [0, 0, 52, 36, 0],
            [0, 0, 14, 30, 0],
            [0, 0, 59, 31, 0],
        ],
    },
];

const { file: manifestFile, manifest } =
    loadDeploymentManifest(hre.network.name);
const entryPointAddress = requiredAddress(
    manifest.accountAbstraction?.entryPoint,
    "manifest accountAbstraction.entryPoint"
);
const accountFactoryAddress = requiredAddress(
    manifest.accountAbstraction?.sessionAccountFactory,
    "manifest accountAbstraction.sessionAccountFactory"
);
const paymasterAddress = requiredAddress(
    manifest.accountAbstraction?.sessionPaymaster,
    "manifest accountAbstraction.sessionPaymaster"
);
const sessionRegistryAddress = requiredAddress(
    manifest.sessionAuthorization?.SessionKeyRegistry,
    "manifest sessionAuthorization.SessionKeyRegistry"
);
const playerRegistryAddress = requiredAddress(
    manifest.playerProfile?.PlayerRegistry,
    "manifest playerProfile.PlayerRegistry"
);
const [
    deployer,
    creator,
    joiner,
    bundlerSignerA,
    bundlerSignerB,
] = await hre.ethers.getSigners();
const network = await hre.ethers.provider.getNetwork();
const requiredSigners = [
    deployer,
    creator,
    joiner,
    bundlerSignerA,
    bundlerSignerB,
];
for (const signer of requiredSigners) {
    const balance = await hre.ethers.provider.getBalance(
        signer.address
    );
    assert(
        balance >= hre.ethers.parseEther("100"),
        `funded Hardhat wallet ${signer.address} has insufficient balance`
    );
}

const entryPoint = new hre.ethers.Contract(
    entryPointAddress,
    entryPointArtifact.abi,
    deployer
);
const accountFactory = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
    accountFactoryAddress
);
const sessionRegistry = await hre.ethers.getContractAt(
    "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
    sessionRegistryAddress
);
const playerRegistry = await hre.ethers.getContractAt(
    "contracts/PlayerRegistry.sol:PlayerRegistry",
    playerRegistryAddress
);
const paymaster = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster",
    paymasterAddress,
    deployer
);

const localA = new LocalBundler({
    entryPoint,
    bundlerSigner: bundlerSignerA,
});
const localB = new LocalBundler({
    entryPoint,
    bundlerSigner: bundlerSignerB,
});
const availability = { A: true, B: true };
const providers = [
    localAdapter("HardhatBundlerA", localA, () => availability.A),
    localAdapter("HardhatBundlerB", localB, () => availability.B),
];
const bundlerMetrics = [];
const bundler = new FailoverBundler({
    providers,
    entryPoint: entryPointAddress,
    receiptPollMs: 1,
    onMetric: (metric) => bundlerMetrics.push(metric),
});
const initialHealth = await bundler.healthCheck();
assert(
    initialHealth.every((item) => item.healthy),
    "both local bundlers must begin healthy"
);

const keys = new Set();
const results = [];
let sponsoredMoveCount = 0;
let rotatedOldExecutorRejected = false;
let revokedExecutorRejected = false;
const depositBefore = await paymaster.getDeposit();

try {
    for (const game of GAMES) {
        const tournament = await createTournament(game);

        for (
            let moveIndex = 0;
            moveIndex < game.moves.length;
            moveIndex += 1
        ) {
            const match = await tournament.instance.matches(
                MATCH_ID
            );
            const primary = signerFor(match.currentTurn);
            let descriptor = tournament.descriptors.get(
                primary.address.toLowerCase()
            );

            if (game.key === "tictactoe" && moveIndex === 0) {
                availability.A = false;
            }
            if (game.key === "tictactoe" && moveIndex === 1) {
                availability.A = true;
                const old = descriptor;
                descriptor = await replaceDescriptor(
                    tournament,
                    primary
                );
                rotatedOldExecutorRejected =
                    await operationIsRejected(
                        tournament.instance,
                        old,
                        game.moves[moveIndex]
                    );
            }
            if (game.key === "tictactoe" && moveIndex === 2) {
                const old = descriptor;
                await (
                    await sessionRegistry
                        .connect(primary)
                        .revokeSession(
                            await tournament.instance.getAddress()
                        )
                ).wait();
                revokedExecutorRejected =
                    await operationIsRejected(
                        tournament.instance,
                        old,
                        game.moves[moveIndex]
                    );
                descriptor = await replaceDescriptor(
                    tournament,
                    primary
                );
            }

            let moveContext =
                `${game.key} move ${moveIndex + 1}/${game.moves.length}`;
            if (
                game.key === "chess" &&
                moveIndex === game.moves.length - 1
            ) {
                const directGas = await tournament.instance
                    .connect(primary)
                    .makeMove.estimateGas(...game.moves[moveIndex]);
                moveContext += ` (direct gas estimate ${directGas})`;
            }
            const sent = await sendMove(
                tournament.instance,
                descriptor,
                game.moves[moveIndex],
                moveContext
            );
            sponsoredMoveCount += 1;
            const moveEvent = parseEvent(
                sent.receipt.receipt,
                tournament.instance,
                "MoveMade"
            );
            assert(moveEvent, `${game.key} MoveMade event missing`);
            assert(
                moveEvent.args.player === primary.address,
                `${game.key} move lost primary attribution`
            );
            assert(
                moveEvent.args.executor === descriptor.account,
                `${game.key} move lost executor attribution`
            );
        }

        const state = await tournament.instance.tournament();
        assert(
            state.winner !== hre.ethers.ZeroAddress,
            `${game.key} did not conclude with a winner`
        );
        assert(
            (await tournament.instance.playerPrizes(state.winner)) >
                0n,
            `${game.key} winner prize was not attributed`
        );
        assert(
            (await hre.ethers.provider.getBalance(
                await tournament.instance.getAddress()
            )) === 0n,
            `${game.key} escrow did not settle`
        );
        for (const primary of [creator, joiner]) {
            assert(
                (await playerRegistry.getProfile(
                    primary.address,
                    game.gameType
                )) !==
                    hre.ethers.ZeroAddress,
                `${game.key} primary profile is missing`
            );
        }
        results.push({
            game: game.key,
            instance: await tournament.instance.getAddress(),
            winner: state.winner,
            moves: game.moves.length,
            settlement: "complete",
        });
        destroyTournamentKeys(tournament);
    }

    const outage = await runOutageFallback();
    const depositAfter = await paymaster.getDeposit();
    assert(
        depositAfter < depositBefore,
        "sponsored operations did not debit the paymaster deposit"
    );
    assert(
        rotatedOldExecutorRejected,
        "rotated executor remained sponsorable"
    );
    assert(
        revokedExecutorRejected,
        "revoked executor remained sponsorable"
    );
    assert(
        bundlerMetrics.some(
            (metric) =>
                metric.provider === "HardhatBundlerB" &&
                metric.method === "eth_sendUserOperation" &&
                metric.outcome === "submitted"
        ),
        "secondary local bundler never handled failover traffic"
    );

    console.log(
        JSON.stringify(
            {
                status: "healthy",
                mode: "fully-local-arbitrum-simulation",
                network: hre.network.name,
                chainId: network.chainId.toString(),
                manifest: manifestFile,
                fundedWallets: requiredSigners.map(
                    (signer, index) => ({
                        role: [
                            "deployer",
                            "creator",
                            "joiner",
                            "bundlerA",
                            "bundlerB",
                        ][index],
                        address: signer.address,
                    })
                ),
                entryPoint: entryPointAddress,
                paymaster: {
                    address: paymasterAddress,
                    depositBeforeWei: depositBefore.toString(),
                    depositAfterWei: depositAfter.toString(),
                    sponsoredMoveCount,
                },
                bundlers: {
                    initialHealth,
                    failoverObserved: true,
                    allUnavailableFallbackObserved:
                        outage.bundlerFallback,
                },
                recovery: {
                    rotatedOldExecutorRejected,
                    revokedExecutorRejected,
                },
                tournaments: results,
                outageFallback: outage,
            },
            null,
            2
        )
    );
} finally {
    for (const key of keys) key.destroy();
    if (await paymaster.paused()) {
        await (await paymaster.setPaused(false)).wait();
    }
}

async function createTournament(game) {
    const factoryAddress = requiredAddress(
        manifest.factories?.[game.factoryKey],
        `manifest factories.${game.factoryKey}`
    );
    const factory = await hre.ethers.getContractAt(
        game.factoryArtifact,
        factoryAddress
    );
    const descriptors = new Map();
    for (const primary of [creator, joiner]) {
        const descriptor = await newDescriptor(primary);
        descriptors.set(
            primary.address.toLowerCase(),
            descriptor
        );
    }
    const creatorDescriptor = descriptors.get(
        creator.address.toLowerCase()
    );
    const create = await factory.connect(creator).createInstance(
        2,
        ENTRY_FEE,
        120,
        1200,
        15,
        creatorDescriptor.account,
        { value: ENTRY_FEE }
    );
    const receipt = await create.wait();
    const deployed = parseEvent(
        receipt,
        factory,
        "InstanceDeployed"
    );
    assert(deployed, `${game.key} InstanceDeployed event missing`);
    const instance = await hre.ethers.getContractAt(
        game.instanceArtifact,
        deployed.args.instance
    );
    await (
        await instance.connect(joiner).enrollInTournament(
            descriptors.get(joiner.address.toLowerCase()).account,
            { value: ENTRY_FEE }
        )
    ).wait();
    return { game, factory, instance, descriptors };
}

async function newDescriptor(primary) {
    const key = generateBrowserSessionKey();
    keys.add(key);
    const salt = generateSessionSalt();
    const account =
        await accountFactory["getAddress(address,uint256)"](
            key.address,
            salt
        );
    return { primary, key, salt, account };
}

async function replaceDescriptor(tournament, primary) {
    const descriptor = await newDescriptor(primary);
    await (
        await sessionRegistry
            .connect(primary)
            .refreshSession(
                await tournament.instance.getAddress(),
                descriptor.account
            )
    ).wait();
    tournament.descriptors.set(
        primary.address.toLowerCase(),
        descriptor
    );
    return descriptor;
}

async function buildMove(instance, descriptor, move) {
    const code = await hre.ethers.provider.getCode(
        descriptor.account
    );
    const initCode =
        code === "0x"
            ? buildInitCode(
                  accountFactoryAddress,
                  descriptor.key.address,
                  descriptor.salt
              )
            : "0x";
    const gameCall =
        instance.interface.encodeFunctionData(
            "makeMove",
            move
        );
    const callData = encodeAccountExecute(
        await instance.getAddress(),
        gameCall
    );
    const nonce = await getUserOperationNonce(
        entryPoint,
        descriptor.account
    );
    const unsigned = buildPackedUserOperation({
        sender: descriptor.account,
        nonce,
        initCode,
        callData,
        verificationGasLimit: 2_000_000n,
        // Chess checkmate validation scans the opponent's legal responses and
        // is the most expensive deterministic gameplay path.
        callGasLimit: 4_000_000n,
        preVerificationGas: 100_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 1_000_000_000n,
        paymasterAndData:
            buildPaymasterAndData(paymasterAddress),
    });
    const signed = await signUserOperation(
        unsigned,
        descriptor.key,
        entryPointAddress,
        network.chainId
    );
    return toRpcUserOperation(signed);
}

async function sendMove(
    instance,
    descriptor,
    move,
    context = "session move"
) {
    const operation = await buildMove(
        instance,
        descriptor,
        move
    );
    await estimateUserOperationGas(
        bundler,
        operation,
        entryPointAddress
    );
    const hash = await submitUserOperation(
        bundler,
        operation,
        entryPointAddress
    );
    const receipt = await bundler.waitForReceipt(hash, {
        timeoutMs: 10_000,
    });
    assert(
        receipt.success,
        `${context} UserOperation reverted: ` +
            `${receipt.revertReason ?? "unknown"}`
    );
    return { hash, receipt };
}

async function operationIsRejected(
    instance,
    descriptor,
    move
) {
    const operation = await buildMove(
        instance,
        descriptor,
        move
    );
    try {
        await estimateUserOperationGas(
            bundler,
            operation,
            entryPointAddress
        );
        return false;
    } catch (error) {
        return (
            error instanceof BundlerSimulationError ||
            /validation|session|revert/iu.test(
                String(error?.message ?? error)
            )
        );
    }
}

async function runOutageFallback() {
    const tournament = await createTournament(GAMES[0]);
    const fallbackMoves = GAMES[0].moves;
    let match = await tournament.instance.matches(MATCH_ID);
    let primary = signerFor(match.currentTurn);
    let descriptor = tournament.descriptors.get(
        primary.address.toLowerCase()
    );
    availability.A = false;
    availability.B = false;
    const operation = await buildMove(
        tournament.instance,
        descriptor,
        fallbackMoves[0]
    );
    let bundlerFallback = false;
    try {
        await estimateUserOperationGas(
            bundler,
            operation,
            entryPointAddress
        );
    } catch {
        bundlerFallback = true;
    }
    assert(bundlerFallback, "all-bundler outage was not observed");
    await (
        await tournament.instance
            .connect(primary)
            .makeMove(...fallbackMoves[0])
    ).wait();

    availability.A = true;
    availability.B = true;
    await (await paymaster.setPaused(true)).wait();
    match = await tournament.instance.matches(MATCH_ID);
    primary = signerFor(match.currentTurn);
    descriptor = tournament.descriptors.get(
        primary.address.toLowerCase()
    );
    const paymasterRejected = await operationIsRejected(
        tournament.instance,
        descriptor,
        fallbackMoves[1]
    );
    assert(
        paymasterRejected,
        "paused paymaster accepted sponsorship"
    );
    await (
        await tournament.instance
            .connect(primary)
            .makeMove(...fallbackMoves[1])
    ).wait();
    await (await paymaster.setPaused(false)).wait();

    for (const [offset, move] of fallbackMoves.slice(2).entries()) {
        match = await tournament.instance.matches(MATCH_ID);
        primary = signerFor(match.currentTurn);
        descriptor = tournament.descriptors.get(
            primary.address.toLowerCase()
        );
        await sendMove(
            tournament.instance,
            descriptor,
            move,
            `outage recovery move ${offset + 3}/${fallbackMoves.length}`
        );
        sponsoredMoveCount += 1;
    }
    const state = await tournament.instance.tournament();
    assert(
        state.winner !== hre.ethers.ZeroAddress,
        "fallback tournament did not conclude"
    );
    const result = {
        instance: await tournament.instance.getAddress(),
        bundlerFallback,
        paymasterFallback: paymasterRejected,
        directPrimaryMoves: 2,
        sponsoredRecoveryMoves: 3,
        settlement: "complete",
    };
    destroyTournamentKeys(tournament);
    return result;
}

function signerFor(address) {
    if (address === creator.address) return creator;
    if (address === joiner.address) return joiner;
    throw new Error(`unknown tournament primary ${address}`);
}

function localAdapter(name, target, online) {
    return {
        name,
        async request(request) {
            if (!online()) {
                throw new Error(`${name} is intentionally unavailable`);
            }
            return target.request(request);
        },
    };
}

function parseEvent(receipt, contract, eventName) {
    return receipt.logs
        .map((log) => {
            try {
                return contract.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === eventName);
}

function destroyTournamentKeys(tournament) {
    for (const descriptor of tournament.descriptors.values()) {
        if (keys.delete(descriptor.key)) {
            descriptor.key.destroy();
        }
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
