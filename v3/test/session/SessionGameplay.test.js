import { expect } from "chai";
import {
    loadFixture,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const ZERO = hre.ethers.ZeroAddress;
const ZERO_HASH = hre.ethers.ZeroHash;
const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const ENROLLMENT_WINDOW = 2n * 60n;
const MATCH_TIME = 2n * 60n;
const MOVE_INCREMENT = 15n;
const MATCH_ID = hre.ethers.solidityPackedKeccak256(
    ["uint8", "uint8"],
    [0, 0]
);

const GAMES = [
    {
        key: "tictac",
        factory: "tictacFactory",
        artifact: "contracts/TicTacInstance.sol:TicTacInstance",
        move: [0, 0, 0],
        invalidMove: [0, 0, 9],
    },
    {
        key: "connectfour",
        factory: "connectFourFactory",
        artifact:
            "contracts/ConnectFourInstance.sol:ConnectFourInstance",
        move: [0, 0, 0],
        invalidMove: [0, 0, 7],
    },
    {
        key: "chess",
        factory: "chessFactory",
        artifact: "contracts/ChessInstance.sol:ChessInstance",
        move: [0, 0, 12, 28, 0],
        invalidMove: [0, 0, 64, 0, 0],
    },
];

async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function protocolFixture() {
    const [
        owner,
        joiner,
        ownerExecutor,
        joinerExecutor,
        replacementExecutor,
        outsider,
    ] = await hre.ethers.getSigners();
    const [core, matches, prizes, escalation, chessRules, profile] =
        await Promise.all([
            deploy(
                "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
            ),
            deploy(
                "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
            ),
            deploy(
                "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"
            ),
            deploy(
                "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"
            ),
            deploy(
                "contracts/modules/ChessRulesModule.sol:ChessRulesModule"
            ),
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
    const commonFactoryArgs = [
        ...moduleAddresses,
        await playerRegistry.getAddress(),
        await sessionRegistry.getAddress(),
    ];
    const [tictacFactory, connectFourFactory, chessFactory] =
        await Promise.all([
            deploy(
                "contracts/TicTacChainFactory.sol:TicTacChainFactory",
                commonFactoryArgs
            ),
            deploy(
                "contracts/ConnectFourFactory.sol:ConnectFourFactory",
                commonFactoryArgs
            ),
            deploy(
                "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
                [
                    ...moduleAddresses,
                    await chessRules.getAddress(),
                    await playerRegistry.getAddress(),
                    await sessionRegistry.getAddress(),
                ]
            ),
        ]);
    for (const factory of [
        tictacFactory,
        connectFourFactory,
        chessFactory,
    ]) {
        await playerRegistry.authorizeFactory(await factory.getAddress());
    }

    return {
        owner,
        joiner,
        ownerExecutor,
        joinerExecutor,
        replacementExecutor,
        outsider,
        playerRegistry,
        sessionRegistry,
        moduleAddresses,
        tictacFactory,
        connectFourFactory,
        chessFactory,
    };
}

async function createGame(
    env,
    game,
    creatorSession = env.ownerExecutor.address,
    joinerSession = env.joinerExecutor.address
) {
    const factory = env[game.factory];
    const tx = await factory.connect(env.owner).createInstance(
        2,
        ENTRY_FEE,
        ENROLLMENT_WINDOW,
        MATCH_TIME,
        MOVE_INCREMENT,
        creatorSession,
        { value: ENTRY_FEE }
    );
    const receipt = await tx.wait();
    const deployed = receipt.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === "InstanceDeployed");
    const instance = await hre.ethers.getContractAt(
        game.artifact,
        deployed.args.instance
    );
    if (joinerSession !== null) {
        await instance.connect(env.joiner).enrollInTournament(
            joinerSession,
            { value: ENTRY_FEE }
        );
    }
    return instance;
}

function normalize(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return Array.from(value, normalize);
    return value;
}

async function captureGameplayState(instance) {
    const [match, board, tournament, balance] = await Promise.all([
        instance.matches(MATCH_ID),
        instance.getBoard(0, 0),
        instance.tournament(),
        hre.ethers.provider.getBalance(await instance.getAddress()),
    ]);
    return normalize([match, board, tournament, balance]);
}

function signerFor(env, address) {
    return [env.owner, env.joiner].find(
        (signer) => signer.address === address
    );
}

function executorFor(env, address) {
    return address === env.owner.address
        ? env.ownerExecutor
        : env.joinerExecutor;
}

function parseEvent(receipt, instance, name) {
    return receipt.logs
        .map((log) => {
            try {
                return instance.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === name);
}

describe("V3 session-authorized gameplay", function () {
    this.timeout(120_000);

    for (const game of GAMES) {
        it(`${game.key}: direct and delegated moves produce identical state with explicit executor attribution`, async function () {
            const env = await loadFixture(protocolFixture);
            const instance = await createGame(env, game);
            const match = await instance.matches(MATCH_ID);
            const primary = signerFor(env, match.currentTurn);
            const executor = executorFor(env, match.currentTurn);

            expect(
                await instance.resolveGameplayPlayer(primary.address)
            ).to.equal(primary.address);
            expect(
                await instance.resolveGameplayPlayer(executor.address)
            ).to.equal(primary.address);
            expect(
                await instance.resolveGameplayPlayer(env.outsider.address)
            ).to.equal(ZERO);

            const snapshot = await hre.ethers.provider.send(
                "evm_snapshot",
                []
            );
            const moveTimestamp = BigInt(await time.latest()) + 10n;
            await time.setNextBlockTimestamp(moveTimestamp);
            await instance.connect(primary).makeMove(...game.move);
            const directState = await captureGameplayState(instance);
            await hre.ethers.provider.send("evm_revert", [snapshot]);

            await time.setNextBlockTimestamp(moveTimestamp);
            const delegatedTx = await instance
                .connect(executor)
                .makeMove(...game.move);
            const delegatedReceipt = await delegatedTx.wait();
            const delegatedState = await captureGameplayState(instance);
            expect(delegatedState).to.deep.equal(directState);

            const move = parseEvent(
                delegatedReceipt,
                instance,
                "MoveMade"
            );
            expect(move.args.matchId).to.equal(MATCH_ID);
            expect(move.args.player).to.equal(primary.address);
            expect(move.args.executor).to.equal(executor.address);
        });

        it(`${game.key}: rotation resumes play while stale, revoked, wrong-turn, and missing executors cannot mutate state`, async function () {
            const env = await loadFixture(protocolFixture);
            const instance = await createGame(env, game);
            const match = await instance.matches(MATCH_ID);
            const currentPrimary = signerFor(env, match.currentTurn);
            const currentExecutor = executorFor(
                env,
                currentPrimary.address
            );
            const otherExecutor =
                currentExecutor.address === env.ownerExecutor.address
                    ? env.joinerExecutor
                    : env.ownerExecutor;

            const initialState = await captureGameplayState(instance);
            await expect(
                instance.connect(env.outsider).makeMove(...game.move)
            ).to.be.revertedWith("NP");
            await expect(
                instance.connect(otherExecutor).makeMove(...game.move)
            ).to.be.revertedWith("NT");
            expect(await captureGameplayState(instance)).to.deep.equal(
                initialState
            );

            if (game.key === "connectfour") {
                await expect(
                    instance
                        .connect(currentExecutor)
                        .makeMove(...game.invalidMove)
                ).to.be.revertedWithCustomError(
                    instance,
                    "InvalidColumn"
                );
            } else {
                await expect(
                    instance
                        .connect(currentExecutor)
                        .makeMove(...game.invalidMove)
                ).to.be.revertedWith(
                    game.key === "tictac" ? "IC" : "IS"
                );
            }

            await env.sessionRegistry
                .connect(currentPrimary)
                .refreshSession(
                    await instance.getAddress(),
                    env.replacementExecutor.address
                );
            expect(
                await instance.resolveGameplayPlayer(
                    currentExecutor.address
                )
            ).to.equal(ZERO);
            expect(
                await instance.resolveGameplayPlayer(
                    env.replacementExecutor.address
                )
            ).to.equal(currentPrimary.address);

            const preStaleState = await captureGameplayState(instance);
            await expect(
                instance
                    .connect(currentExecutor)
                    .makeMove(...game.move)
            ).to.be.revertedWith("NP");
            expect(await captureGameplayState(instance)).to.deep.equal(
                preStaleState
            );
            await instance
                .connect(env.replacementExecutor)
                .makeMove(...game.move);

            const nextMatch = await instance.matches(MATCH_ID);
            const nextPrimary = signerFor(env, nextMatch.currentTurn);
            const nextExecutor = executorFor(
                env,
                nextPrimary.address
            );
            await env.sessionRegistry
                .connect(nextPrimary)
                .revokeSession(await instance.getAddress());
            const preRevokedState =
                await captureGameplayState(instance);
            await expect(
                instance.connect(nextExecutor).makeMove(...game.move)
            ).to.be.revertedWith("NP");
            expect(await captureGameplayState(instance)).to.deep.equal(
                preRevokedState
            );
        });

        it(`${game.key}: the exclusive TTL boundary disables delegation without disabling the primary wallet`, async function () {
            const env = await loadFixture(protocolFixture);
            const instance = await createGame(env, game);
            const match = await instance.matches(MATCH_ID);
            const primary = signerFor(env, match.currentTurn);
            const executor = executorFor(env, primary.address);
            const session = await env.sessionRegistry.getSession(
                await instance.getAddress(),
                primary.address
            );
            await time.setNextBlockTimestamp(session.validUntil);

            const before = await captureGameplayState(instance);
            await expect(
                instance.connect(executor).makeMove(...game.move)
            ).to.be.revertedWith("NP");
            expect(await captureGameplayState(instance)).to.deep.equal(
                before
            );
            expect(
                await instance.resolveGameplayPlayer(executor.address)
            ).to.equal(ZERO);
            await instance.connect(primary).makeMove(...game.move);
        });
    }

    it("attributes a fully delegated win, prize, and profile outcomes only to primary wallets", async function () {
        const env = await loadFixture(protocolFixture);
        const game = GAMES[0];
        const instance = await createGame(env, game);
        const executors = new Map([
            [env.owner.address, env.ownerExecutor],
            [env.joiner.address, env.joinerExecutor],
        ]);

        let terminalReceipt;
        for (const cell of [0, 3, 1, 4, 2]) {
            const match = await instance.matches(MATCH_ID);
            const primary = match.currentTurn;
            const executor = executors.get(primary);
            const receipt = await (
                await instance
                    .connect(executor)
                    .makeMove(0, 0, cell)
            ).wait();
            const event = parseEvent(receipt, instance, "MoveMade");
            expect(event.args.player).to.equal(primary);
            expect(event.args.executor).to.equal(executor.address);
            terminalReceipt = receipt;
        }

        const match = await instance.matches(MATCH_ID);
        const tournament = await instance.tournament();
        const winner = match.winner;
        const loser =
            winner === env.owner.address
                ? env.joiner.address
                : env.owner.address;
        const completedState = await captureGameplayState(instance);
        await expect(
            instance.connect(env.ownerExecutor).makeMove(0, 0, 5)
        ).to.be.revertedWith("Instance concluded");
        expect(await captureGameplayState(instance)).to.deep.equal(
            completedState
        );
        expect(tournament.winner).to.equal(winner);
        expect(tournament.prizeRecipient).to.equal(winner);
        expect(
            parseEvent(terminalReceipt, instance, "MatchCompleted")
                .args.winner
        ).to.equal(winner);
        expect(
            parseEvent(
                terminalReceipt,
                instance,
                "TournamentConcluded"
            ).args.winner
        ).to.equal(winner);
        expect(await instance.playerPrizes(winner)).to.be.greaterThan(0n);
        expect(
            await instance.playerPrizes(env.ownerExecutor.address)
        ).to.equal(0n);
        expect(
            await instance.playerPrizes(env.joinerExecutor.address)
        ).to.equal(0n);

        const winnerProfile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile",
            await env.playerRegistry.getProfile(winner, 0)
        );
        const loserProfile = await hre.ethers.getContractAt(
            "contracts/PlayerProfile.sol:PlayerProfile",
            await env.playerRegistry.getProfile(loser, 0)
        );
        const [winnerStats, loserStats, winnerMatches, loserMatches] =
            await Promise.all([
                winnerProfile.getStats(),
                loserProfile.getStats(),
                winnerProfile.getMatchRecords(0, 0),
                loserProfile.getMatchRecords(0, 0),
            ]);
        expect(winnerStats.totalWins).to.equal(1n);
        expect(winnerStats.totalLosses).to.equal(0n);
        expect(loserStats.totalWins).to.equal(0n);
        expect(loserStats.totalLosses).to.equal(1n);
        expect(winnerMatches[0].category).to.equal(1n);
        expect(loserMatches[0].category).to.equal(2n);
        expect(
            await env.playerRegistry.getProfile(
                env.ownerExecutor.address,
                0
            )
        ).to.equal(ZERO);
        expect(
            await env.playerRegistry.getProfile(
                env.joinerExecutor.address,
                0
            )
        ).to.equal(ZERO);
    });

    it("attributes a fully delegated draw record and even split only to primary wallets", async function () {
        const env = await loadFixture(protocolFixture);
        const instance = await createGame(env, GAMES[0]);
        const executors = new Map([
            [env.owner.address, env.ownerExecutor],
            [env.joiner.address, env.joinerExecutor],
        ]);
        for (const cell of [0, 1, 2, 4, 3, 5, 7, 6, 8]) {
            const match = await instance.matches(MATCH_ID);
            await instance
                .connect(executors.get(match.currentTurn))
                .makeMove(0, 0, cell);
        }

        const tournament = await instance.tournament();
        expect(tournament.winner).to.equal(ZERO);
        for (const [primary, executor] of [
            [env.owner, env.ownerExecutor],
            [env.joiner, env.joinerExecutor],
        ]) {
            expect(
                await instance.playerPrizes(primary.address)
            ).to.be.greaterThan(0n);
            expect(
                await instance.playerPrizes(executor.address)
            ).to.equal(0n);
            const profile = await hre.ethers.getContractAt(
                "contracts/PlayerProfile.sol:PlayerProfile",
                await env.playerRegistry.getProfile(primary.address, 0)
            );
            const records = await profile.getMatchRecords(0, 0);
            expect(records[0].category).to.equal(3n);
            expect(
                await env.playerRegistry.getProfile(executor.address, 0)
            ).to.equal(ZERO);
        }
    });

    it("rejects session executors from every non-move state-changing instance entry point", async function () {
        const env = await loadFixture(protocolFixture);
        const instance = await createGame(env, GAMES[0]);
        const executor = env.ownerExecutor;
        const instanceAddress = await instance.getAddress();
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
            tierKey: ZERO_HASH,
        };
        const calls = new Map([
            [
                "_completeMatchWithResult(bytes32,address,bool)",
                () =>
                    instance
                        .connect(executor)
                        ._completeMatchWithResult(
                            MATCH_ID,
                            env.owner.address,
                            false
                        ),
            ],
            [
                "_createMatchGame(uint8,uint8,address,address)",
                () =>
                    instance
                        .connect(executor)
                        ._createMatchGame(
                            0,
                            0,
                            env.owner.address,
                            env.joiner.address
                        ),
            ],
            [
                "_initializeMatchForPlay(bytes32)",
                () =>
                    instance
                        .connect(executor)
                        ._initializeMatchForPlay(MATCH_ID),
            ],
            [
                "_resetMatchGame(bytes32)",
                () =>
                    instance
                        .connect(executor)
                        ._resetMatchGame(MATCH_ID),
            ],
            [
                "_setMatchPlayer(bytes32,uint8,address)",
                () =>
                    instance
                        .connect(executor)
                        ._setMatchPlayer(
                            MATCH_ID,
                            0,
                            executor.address
                        ),
            ],
            [
                "cancelTournament()",
                () => instance.connect(executor).cancelTournament(),
            ],
            [
                "claimAbandonedPool()",
                () => instance.connect(executor).claimAbandonedPool(),
            ],
            [
                "claimMatchSlotByReplacement(uint8,uint8)",
                () =>
                    instance
                        .connect(executor)
                        .claimMatchSlotByReplacement(0, 0),
            ],
            [
                "claimTimeoutWin(uint8,uint8)",
                () =>
                    instance
                        .connect(executor)
                        .claimTimeoutWin(0, 0),
            ],
            [
                "enrollInTournament(address)",
                () =>
                    instance
                        .connect(executor)
                        .enrollInTournament(ZERO),
            ],
            [
                "enrollOnBehalf(address,address)",
                () =>
                    instance
                        .connect(executor)
                        .enrollOnBehalf(executor.address, ZERO),
            ],
            [
                "forceEliminateStalledMatch(uint8,uint8)",
                () =>
                    instance
                        .connect(executor)
                        .forceEliminateStalledMatch(0, 0),
            ],
            [
                "forceStartTournament()",
                () => instance.connect(executor).forceStartTournament(),
            ],
            [
                "initialize((uint8,uint256,(uint256,uint256,uint256,uint256,uint256,uint256),uint8,bytes32),address,address,address,address,address,address,address)",
                () =>
                    instance.connect(executor).initialize(
                        tier,
                        ZERO,
                        ZERO,
                        ZERO,
                        ZERO,
                        ZERO,
                        ZERO,
                        ZERO
                    ),
            ],
            [
                "initializeRound(uint8)",
                () => instance.connect(executor).initializeRound(0),
            ],
            [
                "rescueStuckFunds(address)",
                () =>
                    instance
                        .connect(executor)
                        .rescueStuckFunds(executor.address),
            ],
            [
                "resetEnrollmentWindow()",
                () =>
                    instance
                        .connect(executor)
                        .resetEnrollmentWindow(),
            ],
        ]);
        const mutableSignatures = new Set(
            instance.interface.fragments
                .filter(
                    (fragment) =>
                        fragment.type === "function" &&
                        ["payable", "nonpayable"].includes(
                            fragment.stateMutability
                        ) &&
                        fragment.name !== "makeMove"
                )
                .map((fragment) => fragment.format("sighash"))
        );
        expect(new Set(calls.keys())).to.deep.equal(mutableSignatures);

        const before = await captureGameplayState(instance);
        for (const [signature, call] of calls) {
            await expect(call(), signature).to.be.reverted;
        }
        expect(await captureGameplayState(instance)).to.deep.equal(
            before
        );
        expect(
            await env.sessionRegistry.isSessionActive(
                instanceAddress,
                env.owner.address,
                executor.address
            )
        ).to.equal(true);

        const chess = await createGame(env, GAMES[2], ZERO, ZERO);
        await expect(
            chess
                .connect(executor)
                .initializeChessRules(executor.address)
        ).to.be.revertedWith("Only factory");
    });

    it("caps an exhausted player-two clock at the configured move increment", async function () {
        const env = await loadFixture(protocolFixture);
        const instance = await createGame(env, GAMES[0]);
        let match = await instance.matches(MATCH_ID);

        if (match.currentTurn !== match.player2) {
            await instance
                .connect(executorFor(env, match.currentTurn))
                .makeMove(0, 0, 0);
            match = await instance.matches(MATCH_ID);
        }

        expect(match.currentTurn).to.equal(match.player2);
        await time.setNextBlockTimestamp(
            match.lastMoveTime + MATCH_TIME + 1n
        );
        await instance
            .connect(executorFor(env, match.player2))
            .makeMove(0, 0, 1);

        const updated = await instance.matches(MATCH_ID);
        expect(updated.player2TimeRemaining).to.equal(MOVE_INCREMENT);
    });

    it("keeps permissionless abandonment identity separate from delegated primary identity", async function () {
        const env = await loadFixture(protocolFixture);
        const instance = await createGame(
            env,
            GAMES[0],
            env.ownerExecutor.address,
            null
        );
        await time.increase(ENROLLMENT_WINDOW + 2n * 60n + 1n);
        await instance
            .connect(env.ownerExecutor)
            .claimAbandonedPool();
        const tournament = await instance.tournament();

        expect(tournament.winner).to.equal(env.ownerExecutor.address);
        expect(tournament.winner).not.to.equal(env.owner.address);
        expect(
            await instance.playerPrizes(env.owner.address)
        ).to.equal(0n);
        expect(
            await instance.playerPrizes(env.ownerExecutor.address)
        ).to.be.greaterThan(0n);
    });

    it("rejects an executor whose live binding belongs to a different instance", async function () {
        const env = await loadFixture(protocolFixture);
        await createGame(env, GAMES[0]);
        const otherInstance = await createGame(
            env,
            GAMES[2],
            ZERO,
            ZERO
        );
        const before = await captureGameplayState(otherInstance);

        await expect(
            otherInstance
                .connect(env.ownerExecutor)
                .makeMove(...GAMES[2].move)
        ).to.be.revertedWith("NP");
        expect(
            await otherInstance.resolveGameplayPlayer(
                env.ownerExecutor.address
            )
        ).to.equal(ZERO);
        expect(await captureGameplayState(otherInstance)).to.deep.equal(
            before
        );
    });

    it("property-checks active, rotated, revoked, and expired session transitions without unauthorized state changes", async function () {
        const env = await loadFixture(protocolFixture);
        const instance = await createGame(env, GAMES[0]);
        const match = await instance.matches(MATCH_ID);
        const primary = signerFor(env, match.currentTurn);
        const executor = executorFor(env, primary.address);
        const instanceAddress = await instance.getAddress();

        for (let iteration = 0; iteration < 16; iteration++) {
            const snapshot = await hre.ethers.provider.send(
                "evm_snapshot",
                []
            );
            const mode = iteration % 4;
            if (mode === 0) {
                const before = await captureGameplayState(instance);
                await instance.connect(executor).makeMove(0, 0, 0);
                expect(await captureGameplayState(instance)).not.to.deep
                    .equal(before);
            } else if (mode === 1) {
                await env.sessionRegistry
                    .connect(primary)
                    .refreshSession(
                        instanceAddress,
                        env.replacementExecutor.address
                    );
                const before = await captureGameplayState(instance);
                await expect(
                    instance.connect(executor).makeMove(0, 0, 0)
                ).to.be.revertedWith("NP");
                expect(await captureGameplayState(instance)).to.deep
                    .equal(before);
                await instance
                    .connect(env.replacementExecutor)
                    .makeMove(0, 0, 0);
            } else if (mode === 2) {
                await env.sessionRegistry
                    .connect(primary)
                    .revokeSession(instanceAddress);
                const before = await captureGameplayState(instance);
                await expect(
                    instance.connect(executor).makeMove(0, 0, 0)
                ).to.be.revertedWith("NP");
                expect(await captureGameplayState(instance)).to.deep
                    .equal(before);
            } else {
                const session = await env.sessionRegistry.getSession(
                    instanceAddress,
                    primary.address
                );
                await time.setNextBlockTimestamp(session.validUntil);
                const before = await captureGameplayState(instance);
                await expect(
                    instance.connect(executor).makeMove(0, 0, 0)
                ).to.be.revertedWith("NP");
                expect(await captureGameplayState(instance)).to.deep
                    .equal(before);
            }
            await hre.ethers.provider.send("evm_revert", [snapshot]);
        }
    });
});
