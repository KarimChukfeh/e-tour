import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

export const PARTICIPANTS_SHARE_BPS = 9500n;
export const OWNER_SHARE_BPS = 500n;
export const BASIS_POINTS = 10000n;

export const STATUS = {
    Tournament: {
        Enrolling: 0n,
        InProgress: 1n,
        Concluded: 2n,
    },
    Match: {
        NotStarted: 0n,
        InProgress: 1n,
        Completed: 2n,
    },
};

export const MATCH_CATEGORY = {
    None: 0n,
    MatchResult: 1n,
    Escalation: 2n,
};

export const MATCH_REASON = {
    R0: 0n,
    ML1: 1n,
    R1: 2n,
    ML2: 3n,
    ML3: 4n,
};

export const TOURNAMENT_CATEGORY = {
    None: 0n,
    MatchResult: 1n,
    Escalation: 2n,
    DrawResolution: 3n,
    EnrollmentResolution: 4n,
};

export const TOURNAMENT_REASON = {
    R0: 0n,
    ML1: 1n,
    R1: 2n,
    ML2: 3n,
    ML3: 4n,
    EL0: 5n,
    EL2: 6n,
    R2: 7n,
};

export const PAYOUT_REASON = {
    None: 0n,
    Victory: 1n,
    EvenSplit: 2n,
    WalletRejected: 3n,
    Cancelation: 4n,
};

export const PLAYER_MATCH_OUTCOME = {
    None: 0n,
    NormalVictory: 1n,
    NormalDefeat: 2n,
    TimeoutVictory: 3n,
    TimeoutDefeat: 4n,
    Draw: 5n,
    ForceEliminationVictory: 6n,
    ForceEliminationDefeat: 7n,
    ReplacementVictory: 8n,
    ReplacementDefeat: 9n,
};

export const PLAYER_MATCH_CATEGORY = {
    None: 0n,
    Victory: 1n,
    Defeat: 2n,
    Draw: 3n,
};

const DEFAULT_ENTRY_FEE = hre.ethers.parseEther("0.001");
const CONNECT_FOUR_DRAW_COLUMNS = [
    0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1,
    4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 5,
    2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3,
    6, 6, 6, 6, 6, 6,
    5,
];

/**
 * @typedef {{
 *   key: string,
 *   name: string,
 *   gameType: number,
 *   factoryArtifact: string,
 *   factoryLabel: string,
 *   gameArtifact: string,
 *   gameLabel: string,
 *   rejectingArtifact: string,
 *   supportsDraw: boolean,
 *   supportsRoundDraw: boolean,
 *   supportsR2: boolean,
 *   timeouts: { enrollmentWindow: bigint, matchTimePerPlayer: bigint, timeIncrementPerMove: bigint },
 *   deployFactory: () => Promise<any>,
 *   playWin: (instance: any, roundNumber: number, matchNumber: number, desiredWinner: any, otherPlayer: any) => Promise<string>,
 *   playDraw?: (instance: any, roundNumber: number, matchNumber: number, playerA: any, playerB: any) => Promise<void>,
 *   startAndStall: (instance: any, roundNumber: number, matchNumber: number, playerA: any, playerB: any) => Promise<any>,
 * }} GameAdapter
 */

/**
 * @typedef {{
 *   adapter: GameAdapter,
 *   factory: any,
 *   registry: any,
 *   instance: any,
 *   signers: any[],
 *   creator: any,
 *   entryFee: bigint,
 *   configuredPlayers: any[],
 *   outsider: any,
 *   timeouts: { enrollmentWindow: bigint, matchTimePerPlayer: bigint, timeIncrementPerMove: bigint },
 * }} ScenarioContext
 */

/**
 * @typedef {{
 *   address: string,
 *   result?: { participated?: boolean, prizeWon?: bigint, isWinner?: boolean, payout?: bigint, payoutReason?: bigint },
 *   factoryProfile?: boolean,
 *   profile?: {
 *     instance?: string,
 *     gameType?: bigint,
 *     entryFee?: bigint,
 *     concluded?: boolean,
 *     won?: boolean,
 *     prize?: bigint,
 *     payout?: bigint,
 *     payoutReason?: bigint,
 *     tournamentResolutionReason?: bigint,
 *     stats?: { totalPlayed?: number, totalWins?: number, totalLosses?: number },
 *     matchRecords?: Record<string, {
 *       instance?: string,
 *       gameType?: bigint,
 *       roundNumber?: bigint,
 *       matchNumber?: bigint,
 *       outcome?: bigint,
 *       category?: bigint,
 *       resolutionReason?: bigint
 *     }>
 *   }
 * }} ExpectedPlayerState
 */

const scenarioApplicability = {
    tictactoe: {
        draws: "required",
        roundDraws: "required",
        uncontestedFinalist: "required",
    },
    connectfour: {
        draws: "required",
        roundDraws: "required",
        uncontestedFinalist: "required",
    },
    chess: {
        draws: "not_applicable",
        roundDraws: "not_applicable",
        uncontestedFinalist: "not_applicable",
    },
};

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

    const moduleMatches = await hre.ethers
        .getContractFactory("contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches")
        .then(async factory => factory.deploy(await moduleMatchesResolution.getAddress()));
    await moduleMatches.waitForDeployment();

    return { moduleCore, moduleMatchesResolution, moduleMatches, modulePrizes, moduleEscalation };
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

function currentTimeouts(base) {
    return {
        enrollmentWindow: base.enrollmentWindow,
        matchTimePerPlayer: base.matchTimePerPlayer,
        timeIncrementPerMove: base.timeIncrementPerMove,
    };
}

async function createFactoryFixture(adapter) {
    const modules = await deployModules();
    const { registry } = await deployRegistry();

    if (adapter.key === "chess") {
        const chessRules = await hre.ethers
            .getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule")
            .then(factory => factory.deploy())
            .then(contract => contract.waitForDeployment().then(() => contract));

        const Factory = await hre.ethers.getContractFactory(adapter.factoryArtifact);
        const factory = await Factory.deploy(
            await modules.moduleCore.getAddress(),
            await modules.moduleMatches.getAddress(),
            await modules.modulePrizes.getAddress(),
            await modules.moduleEscalation.getAddress(),
            await chessRules.getAddress(),
            await registry.getAddress()
        );
        await factory.waitForDeployment();
        await registry.authorizeFactory(await factory.getAddress());
        return { ...modules, registry, factory, chessRules };
    }

    const Factory = await hre.ethers.getContractFactory(adapter.factoryArtifact);
    const factory = await Factory.deploy(
        await modules.moduleCore.getAddress(),
        await modules.moduleMatches.getAddress(),
        await modules.modulePrizes.getAddress(),
        await modules.moduleEscalation.getAddress(),
        await registry.getAddress()
    );
    await factory.waitForDeployment();
    await registry.authorizeFactory(await factory.getAddress());
    return { ...modules, registry, factory };
}

async function createTournamentFixture(adapter, {
    playerCount,
    enrolledPlayers = playerCount,
    entryFee = DEFAULT_ENTRY_FEE,
    timeouts = currentTimeouts(adapter.timeouts),
} = {}) {
    const [creator, ...rest] = await hre.ethers.getSigners();
    const system = await createFactoryFixture(adapter);
    const tx = await system.factory.connect(creator).createInstance(
        playerCount,
        entryFee,
        timeouts.enrollmentWindow,
        timeouts.matchTimePerPlayer,
        timeouts.timeIncrementPerMove,
        { value: entryFee }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
        .map(log => { try { return system.factory.interface.parseLog(log); } catch { return null; } })
        .find(parsed => parsed && parsed.name === "InstanceDeployed");

    const instance = await hre.ethers.getContractAt(adapter.gameArtifact, event.args.instance);
    const configuredPlayers = [creator];
    const needed = enrolledPlayers - 1;
    for (const signer of rest.slice(0, needed)) {
        configuredPlayers.push(signer);
        await instance.connect(signer).enrollInTournament({ value: entryFee });
    }

    return {
        ...system,
        adapter,
        signers: [creator, ...rest],
        creator,
        entryFee,
        instance,
        configuredPlayers,
        outsider: rest[needed],
        timeouts,
    };
}

async function loadTournamentFixture(adapter, options) {
    async function namedTournamentFixture() {
        return createTournamentFixture(adapter, options);
    }

    return loadFixture(namedTournamentFixture);
}

function participantFromSigner(adapter, instance, signer) {
    return {
        address: signer.address,
        signer,
        async enroll(entryFee) {
            await instance.connect(signer).enrollInTournament({ value: entryFee });
        },
        async move(...args) {
            await instance.connect(signer).makeMove(...args);
        },
    };
}

async function createRejectingParticipant(adapter, instance, controller) {
    const Helper = await hre.ethers.getContractFactory(adapter.rejectingArtifact);
    const contract = await Helper.connect(controller).deploy(await instance.getAddress());
    await contract.waitForDeployment();

    return {
        address: await contract.getAddress(),
        controller,
        contract,
        async enroll(entryFee) {
            await contract.connect(controller).enrollInTournament({ value: entryFee });
        },
        async move(...args) {
            await contract.connect(controller).makeMove(...args);
        },
        async setRejectPayments(reject) {
            await contract.connect(controller).setRejectPayments(reject);
        },
    };
}

function prizePoolFor(entryFee, enrolledCount) {
    return (entryFee * BigInt(enrolledCount) * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
}

function ownerAccruedFor(entryFee, enrolledCount) {
    return (entryFee * BigInt(enrolledCount) * OWNER_SHARE_BPS) / BASIS_POINTS;
}

function matchKey(roundNumber, matchNumber) {
    return `${roundNumber}-${matchNumber}`;
}

function matchId(roundNumber, matchNumber) {
    return hre.ethers.solidityPackedKeccak256(["uint8", "uint8"], [roundNumber, matchNumber]);
}

async function readMatchRaw(instance, roundNumber, matchNumber) {
    return instance.matches(matchId(roundNumber, matchNumber));
}

async function advanceTo(timestamp) {
    await time.increaseTo(timestamp);
}

async function advanceBy(seconds) {
    await time.increase(Number(seconds));
}

async function advancePastEnrollmentDeadline(instance, extraSeconds = 1n) {
    const tournament = await instance.tournament();
    await advanceTo(BigInt(tournament.enrollmentTimeout.escalation1Start) + extraSeconds);
}

async function advancePastEnrollmentClaim(instance, extraSeconds = 1n) {
    const tournament = await instance.tournament();
    await advanceTo(BigInt(tournament.enrollmentTimeout.escalation2Start) + extraSeconds);
}

async function advancePastMatchTimeout(instance, roundNumber, matchNumber, extraSeconds = 5n) {
    const raw = await readMatchRaw(instance, roundNumber, matchNumber);
    const tournament = await instance.tierConfig();
    const timeoutAt = BigInt(raw.lastMoveTime) + BigInt(tournament.timeouts.matchTimePerPlayer);
    await advanceTo(timeoutAt + extraSeconds);
}

async function advancePastMl2(instance, roundNumber, matchNumber, extraSeconds = 5n) {
    const raw = await readMatchRaw(instance, roundNumber, matchNumber);
    const tier = await instance.tierConfig();
    const timeoutAt = BigInt(raw.lastMoveTime) + BigInt(tier.timeouts.matchTimePerPlayer) + BigInt(tier.timeouts.matchLevel2Delay);
    await advanceTo(timeoutAt + extraSeconds);
}

async function advancePastMl3(instance, roundNumber, matchNumber, extraSeconds = 5n) {
    const raw = await readMatchRaw(instance, roundNumber, matchNumber);
    const tier = await instance.tierConfig();
    const timeoutAt = BigInt(raw.lastMoveTime) + BigInt(tier.timeouts.matchTimePerPlayer) + BigInt(tier.timeouts.matchLevel2Delay) + BigInt(tier.timeouts.matchLevel3Delay);
    await advanceTo(timeoutAt + extraSeconds);
}

async function getMatchPlayers(instance, roundNumber, matchNumber, participantsByAddress) {
    const detail = await instance.getMatch(roundNumber, matchNumber);
    return {
        detail,
        player1: participantsByAddress[detail.player1],
        player2: participantsByAddress[detail.player2],
    };
}

async function getProfile(registry, address, gameType) {
    const profileAddress = await registry.getProfile(address, gameType);
    if (profileAddress === hre.ethers.ZeroAddress) {
        return { address: profileAddress, contract: null };
    }
    return {
        address: profileAddress,
        contract: await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", profileAddress),
    };
}

async function collectSnapshot(ctx, {
    trackedPlayers = [],
    trackedMatches = [],
    trackedProfileMatches = [],
    trackedRecipients = [],
} = {}) {
    const instanceAddress = await ctx.instance.getAddress();
    const factoryAddress = await ctx.factory.getAddress();
    const [tournament, info, players, bracket, prizeDistribution, factoryOwnerBalance, factoryActiveCount, factoryPastCount, instanceBalance, factoryBalance] = await Promise.all([
        ctx.instance.tournament(),
        ctx.instance.getInstanceInfo(),
        ctx.instance.getPlayers(),
        ctx.instance.getBracket(),
        ctx.instance.getPrizeDistribution(),
        ctx.factory.ownerBalance(),
        ctx.factory.getActiveTournamentCount(),
        ctx.factory.getPastTournamentCount(),
        hre.ethers.provider.getBalance(instanceAddress),
        hre.ethers.provider.getBalance(factoryAddress),
    ]);

    const matches = {};
    for (const [roundNumber, matchNumber] of trackedMatches) {
        matches[matchKey(roundNumber, matchNumber)] = {
            detail: await ctx.instance.getMatch(roundNumber, matchNumber),
            raw: await readMatchRaw(ctx.instance, roundNumber, matchNumber),
            moves: await ctx.instance.getMatchMoves(roundNumber, matchNumber),
        };
    }

    const playerState = {};
    for (const player of trackedPlayers) {
        const profile = await getProfile(ctx.registry, player.address, ctx.adapter.gameType);
        const state = {
            factoryProfile: await ctx.factory.players(player.address),
            registryProfile: profile.address,
            result: await ctx.instance.getPlayerResult(player.address),
            prize: await ctx.instance.playerPrizes(player.address),
            enrollment: null,
            stats: null,
            matchRecords: {},
        };

        if (profile.contract) {
            state.enrollment = await profile.contract.getEnrollmentByInstance(instanceAddress);
            state.stats = await profile.contract.getStats();
            for (const [roundNumber, matchNumber] of trackedProfileMatches) {
                state.matchRecords[matchKey(roundNumber, matchNumber)] = await profile.contract.getMatchRecordByKey(
                    instanceAddress,
                    roundNumber,
                    matchNumber
                );
            }
        }

        playerState[player.address] = state;
    }

    const recipientState = {};
    for (const recipient of trackedRecipients) {
        if (!recipient?.contract) continue;
        recipientState[recipient.address] = {
            receivedAmount: await recipient.contract.receivedAmount(),
            rejectionCount: await recipient.contract.rejectionCount(),
        };
    }

    return {
        adapter: ctx.adapter.key,
        instanceAddress,
        factoryAddress,
        tournament,
        info,
        players,
        bracket,
        prizeDistribution,
        matches,
        playerState,
        recipientState,
        balances: {
            instanceBalance,
            factoryBalance,
            factoryOwnerBalance,
        },
        factoryState: {
            activeCount: factoryActiveCount,
            pastCount: factoryPastCount,
            active: await Promise.all(Array.from({ length: Number(factoryActiveCount) }, (_, index) => ctx.factory.activeTournaments(index))),
            past: await Promise.all(Array.from({ length: Number(factoryPastCount) }, (_, index) => ctx.factory.pastTournaments(index))),
        },
    };
}

function amountMap(prizeDistribution) {
    const out = {};
    for (let i = 0; i < prizeDistribution.players.length; i++) {
        out[prizeDistribution.players[i]] = prizeDistribution.amounts[i];
    }
    return out;
}

function expectProfilePresent(state, address) {
    expect(state.factoryProfile, `factory profile missing for ${address}`).to.not.equal(hre.ethers.ZeroAddress);
    expect(state.registryProfile, `registry profile missing for ${address}`).to.not.equal(hre.ethers.ZeroAddress);
}

function assertPlayerSnapshot(snapshot, address, expected) {
    const state = snapshot.playerState[address];
    expect(state, `missing player snapshot for ${address}`).to.exist;

    if (expected.factoryProfile) {
        if (expected.factoryProfile === "registry") {
            expect(state.registryProfile, `registry profile missing for ${address}`).to.not.equal(hre.ethers.ZeroAddress);
        } else {
            expectProfilePresent(state, address);
        }
    }

    if (expected.result) {
        if (expected.result.participated !== undefined) expect(state.result.participated).to.equal(expected.result.participated);
        if (expected.result.prizeWon !== undefined) expect(state.result.prizeWon).to.equal(expected.result.prizeWon);
        if (expected.result.isWinner !== undefined) expect(state.result.isWinner).to.equal(expected.result.isWinner);
        if (expected.result.payout !== undefined) expect(state.result.payout).to.equal(expected.result.payout);
        if (expected.result.payoutReason !== undefined) expect(state.result.payoutReason).to.equal(expected.result.payoutReason);
    }

    if (expected.profile) {
        expect(state.enrollment, `missing enrollment record for ${address}`).to.exist;
        if (expected.profile.instance !== undefined) expect(state.enrollment.instance).to.equal(expected.profile.instance);
        if (expected.profile.gameType !== undefined) expect(state.enrollment.gameType).to.equal(expected.profile.gameType);
        if (expected.profile.entryFee !== undefined) expect(state.enrollment.entryFee).to.equal(expected.profile.entryFee);
        if (expected.profile.concluded !== undefined) expect(state.enrollment.concluded).to.equal(expected.profile.concluded);
        if (expected.profile.won !== undefined) expect(state.enrollment.won).to.equal(expected.profile.won);
        if (expected.profile.prize !== undefined) expect(state.enrollment.prize).to.equal(expected.profile.prize);
        if (expected.profile.payout !== undefined) expect(state.enrollment.payout).to.equal(expected.profile.payout);
        if (expected.profile.payoutReason !== undefined) expect(state.enrollment.payoutReason).to.equal(expected.profile.payoutReason);
        if (expected.profile.tournamentResolutionReason !== undefined) {
            expect(state.enrollment.tournamentResolutionReason).to.equal(expected.profile.tournamentResolutionReason);
        }
        if (expected.profile.stats) {
            if (expected.profile.stats.totalPlayed !== undefined) expect(state.stats.totalPlayed).to.equal(expected.profile.stats.totalPlayed);
            if (expected.profile.stats.totalWins !== undefined) expect(state.stats.totalWins).to.equal(expected.profile.stats.totalWins);
            if (expected.profile.stats.totalLosses !== undefined) expect(state.stats.totalLosses).to.equal(expected.profile.stats.totalLosses);
        }
        if (expected.profile.matchRecords) {
            for (const [key, recordExpectation] of Object.entries(expected.profile.matchRecords)) {
                const record = state.matchRecords[key];
                expect(record, `missing match record ${key} for ${address}`).to.exist;
                if (recordExpectation.instance !== undefined) expect(record.instance).to.equal(recordExpectation.instance);
                if (recordExpectation.gameType !== undefined) expect(record.gameType).to.equal(recordExpectation.gameType);
                if (recordExpectation.roundNumber !== undefined) expect(record.roundNumber).to.equal(recordExpectation.roundNumber);
                if (recordExpectation.matchNumber !== undefined) expect(record.matchNumber).to.equal(recordExpectation.matchNumber);
                if (recordExpectation.outcome !== undefined) expect(record.outcome).to.equal(recordExpectation.outcome);
                if (recordExpectation.category !== undefined) expect(record.category).to.equal(recordExpectation.category);
                if (recordExpectation.resolutionReason !== undefined) expect(record.resolutionReason).to.equal(recordExpectation.resolutionReason);
            }
        }
    }
}

function assertSnapshot(snapshot, expected) {
    const expectedTournamentReason = expected.tournament?.completionReason;

    if (expected.tournament) {
        if (expected.tournament.status !== undefined) expect(snapshot.tournament.status).to.equal(expected.tournament.status);
        if (expected.tournament.winner !== undefined) expect(snapshot.tournament.winner).to.equal(expected.tournament.winner);
        if (expected.tournament.completionReason !== undefined) expect(snapshot.tournament.completionReason).to.equal(expected.tournament.completionReason);
        if (expected.tournament.completionCategory !== undefined) expect(snapshot.tournament.completionCategory).to.equal(expected.tournament.completionCategory);
        if (expected.tournament.enrolledCount !== undefined) expect(snapshot.tournament.enrolledCount).to.equal(expected.tournament.enrolledCount);
        if (expected.tournament.totalEntryFeesAccrued !== undefined) expect(snapshot.tournament.totalEntryFeesAccrued).to.equal(expected.tournament.totalEntryFeesAccrued);
        if (expected.tournament.prizePool !== undefined) expect(snapshot.tournament.prizePool).to.equal(expected.tournament.prizePool);
        if (expected.tournament.ownerAccrued !== undefined) expect(snapshot.tournament.ownerAccrued).to.equal(expected.tournament.ownerAccrued);
        if (expected.tournament.prizeRecipient !== undefined) expect(snapshot.tournament.prizeRecipient).to.equal(expected.tournament.prizeRecipient);
        if (expected.tournament.prizeAwarded !== undefined) expect(snapshot.tournament.prizeAwarded).to.equal(expected.tournament.prizeAwarded);
        if (expected.tournament.allDrawResolution !== undefined) expect(snapshot.tournament.allDrawResolution).to.equal(expected.tournament.allDrawResolution);
        if (expected.tournament.finalsWasDraw !== undefined) expect(snapshot.tournament.finalsWasDraw).to.equal(expected.tournament.finalsWasDraw);
        if (expected.tournament.currentRound !== undefined) expect(snapshot.tournament.currentRound).to.equal(expected.tournament.currentRound);
        if (expected.tournament.actualTotalRounds !== undefined) expect(snapshot.tournament.actualTotalRounds).to.equal(expected.tournament.actualTotalRounds);
    }

    if (expected.instanceInfo) {
        if (expected.instanceInfo.status !== undefined) expect(snapshot.info.status).to.equal(expected.instanceInfo.status);
        if (expected.instanceInfo.winner !== undefined) expect(snapshot.info.winner).to.equal(expected.instanceInfo.winner);
        if (expected.instanceInfo.completionReason !== undefined) expect(snapshot.info.completionReason).to.equal(expected.instanceInfo.completionReason);
        if (expected.instanceInfo.completionCategory !== undefined) expect(snapshot.info.completionCategory).to.equal(expected.instanceInfo.completionCategory);
        if (expected.instanceInfo.playerCount !== undefined) expect(snapshot.info.playerCount).to.equal(expected.instanceInfo.playerCount);
        if (expected.instanceInfo.entryFee !== undefined) expect(snapshot.info.entryFee).to.equal(expected.instanceInfo.entryFee);
        if (expected.instanceInfo.prizeAwarded !== undefined) expect(snapshot.info.prizeAwarded).to.equal(expected.instanceInfo.prizeAwarded);
        if (expected.instanceInfo.prizeRecipient !== undefined) expect(snapshot.info.prizeRecipient).to.equal(expected.instanceInfo.prizeRecipient);
    }

    if (expected.players) {
        expect(Array.from(snapshot.players)).to.have.members(expected.players);
    }

    if (expected.bracket) {
        expect(snapshot.bracket.totalRounds).to.equal(expected.bracket.totalRounds);
        expect([...snapshot.bracket.matchCounts].map(value => BigInt(value))).to.deep.equal(expected.bracket.matchCounts.map(value => BigInt(value)));
        expect([...snapshot.bracket.completedCounts].map(value => BigInt(value))).to.deep.equal(expected.bracket.completedCounts.map(value => BigInt(value)));
    }

    if (expected.factoryState) {
        if (expected.factoryState.activeCount !== undefined) expect(snapshot.factoryState.activeCount).to.equal(expected.factoryState.activeCount);
        if (expected.factoryState.pastCount !== undefined) expect(snapshot.factoryState.pastCount).to.equal(expected.factoryState.pastCount);
        if (expected.factoryState.activeIncludes) {
            expect(snapshot.factoryState.active).to.include.members(expected.factoryState.activeIncludes);
        }
        if (expected.factoryState.pastIncludes) {
            expect(snapshot.factoryState.past).to.include.members(expected.factoryState.pastIncludes);
        }
    }

    if (expected.prizeDistribution) {
        const actual = amountMap(snapshot.prizeDistribution);
        for (const [address, amount] of Object.entries(expected.prizeDistribution.amounts)) {
            expect(actual[address] ?? 0n).to.equal(amount);
        }
        if (expected.prizeDistribution.total !== undefined) {
            expect(snapshot.prizeDistribution.amounts.reduce((sum, amount) => sum + amount, 0n)).to.equal(expected.prizeDistribution.total);
        }
    }

    if (expected.matches) {
        for (const [key, matchExpectation] of Object.entries(expected.matches)) {
            const actual = snapshot.matches[key];
            expect(actual, `missing match snapshot ${key}`).to.exist;
            if (matchExpectation.players) {
                expect([actual.detail.player1, actual.detail.player2]).to.have.members(matchExpectation.players);
            }
            if (matchExpectation.winner !== undefined) expect(actual.detail.matchWinner).to.equal(matchExpectation.winner);
            if (matchExpectation.status !== undefined) expect(actual.detail.status).to.equal(matchExpectation.status);
            if (matchExpectation.isDraw !== undefined) expect(actual.detail.isDraw).to.equal(matchExpectation.isDraw);
            if (matchExpectation.completionReason !== undefined) expect(actual.detail.completionReason).to.equal(matchExpectation.completionReason);
            if (matchExpectation.completionCategory !== undefined) expect(actual.detail.completionCategory).to.equal(matchExpectation.completionCategory);
            if (matchExpectation.movesNonEmpty !== undefined) {
                expect(actual.moves.length > 0).to.equal(matchExpectation.movesNonEmpty);
            }
            if (matchExpectation.currentTurn !== undefined) expect(actual.raw.currentTurn).to.equal(matchExpectation.currentTurn);
        }
    }

    if (expected.playersState) {
        for (const [address, playerExpectation] of Object.entries(expected.playersState)) {
            const normalizedExpectation = {
                ...playerExpectation,
                profile: playerExpectation.profile ? {
                    ...playerExpectation.profile,
                    tournamentResolutionReason:
                        playerExpectation.profile.tournamentResolutionReason !== undefined
                            ? playerExpectation.profile.tournamentResolutionReason
                            : (playerExpectation.profile.concluded === true && expectedTournamentReason !== undefined
                                ? expectedTournamentReason
                                : playerExpectation.profile.tournamentResolutionReason),
                    matchRecords: playerExpectation.profile.matchRecords
                        ? Object.fromEntries(
                            Object.entries(playerExpectation.profile.matchRecords).map(([key, recordExpectation]) => {
                                const expectedMatchReason = expected.matches?.[key]?.completionReason;
                                const resolvedReason = recordExpectation.resolutionReason !== undefined
                                    ? recordExpectation.resolutionReason
                                    : (recordExpectation.instance === hre.ethers.ZeroAddress
                                        ? 0n
                                        : (expectedMatchReason !== undefined ? expectedMatchReason : undefined));
                                return [key, {
                                    ...recordExpectation,
                                    ...(resolvedReason !== undefined ? { resolutionReason: resolvedReason } : {}),
                                }];
                            })
                        )
                        : playerExpectation.profile.matchRecords,
                } : playerExpectation.profile,
            };
            assertPlayerSnapshot(snapshot, address, normalizedExpectation);
        }
    }

    if (expected.recipientState) {
        for (const [address, recipientExpectation] of Object.entries(expected.recipientState)) {
            const actual = snapshot.recipientState[address];
            expect(actual, `missing recipient state for ${address}`).to.exist;
            if (recipientExpectation.receivedAmount !== undefined) expect(actual.receivedAmount).to.equal(recipientExpectation.receivedAmount);
            if (recipientExpectation.rejectionCount !== undefined) expect(actual.rejectionCount).to.equal(recipientExpectation.rejectionCount);
        }
    }

    if (expected.balances) {
        if (expected.balances.instanceBalance !== undefined) expect(snapshot.balances.instanceBalance).to.equal(expected.balances.instanceBalance);
        if (expected.balances.factoryOwnerBalance !== undefined) expect(snapshot.balances.factoryOwnerBalance).to.equal(expected.balances.factoryOwnerBalance);
    }
}

function participantsMap(adapter, instance, signers) {
    const map = {};
    for (const signer of signers) {
        const participant = participantFromSigner(adapter, instance, signer);
        map[participant.address] = participant;
    }
    return map;
}

function makeTicTacToeAdapter() {
    return {
        key: "tictactoe",
        name: "TicTacToe",
        gameType: 0,
        factoryArtifact: "contracts/TicTacToeFactory.sol:TicTacToeFactory",
        factoryLabel: "TicTacToeFactory",
        gameArtifact: "contracts/TicTacToe.sol:TicTacToe",
        gameLabel: "TicTacToe",
        rejectingArtifact: "contracts/test-helpers/RejectingTicTacPlayer.sol:RejectingTicTacPlayer",
        supportsDraw: true,
        supportsRoundDraw: true,
        supportsR2: true,
        timeouts: {
            enrollmentWindow: 2n * 60n,
            matchTimePerPlayer: 2n * 60n,
            timeIncrementPerMove: 15n,
        },
        deployFactory: () => createFactoryFixture(adapters.tictactoe),
        async playWin(instance, roundNumber, matchNumber, desiredWinner, otherPlayer) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const first = raw.currentTurn === desiredWinner.address ? desiredWinner : otherPlayer;
            const second = first.address === desiredWinner.address ? otherPlayer : desiredWinner;

            await first.move(roundNumber, matchNumber, 0);
            await second.move(roundNumber, matchNumber, 3);
            await first.move(roundNumber, matchNumber, 1);
            await second.move(roundNumber, matchNumber, 4);

            if (first.address === desiredWinner.address) {
                await first.move(roundNumber, matchNumber, 2);
                return first.address;
            }

            await first.move(roundNumber, matchNumber, 8);
            await second.move(roundNumber, matchNumber, 5);
            return second.address;
        },
        async playDraw(instance, roundNumber, matchNumber, playerA, playerB) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const first = raw.currentTurn === playerA.address ? playerA : playerB;
            const second = first.address === playerA.address ? playerB : playerA;

            await first.move(roundNumber, matchNumber, 0);
            await second.move(roundNumber, matchNumber, 1);
            await first.move(roundNumber, matchNumber, 2);
            await second.move(roundNumber, matchNumber, 4);
            await first.move(roundNumber, matchNumber, 3);
            await second.move(roundNumber, matchNumber, 5);
            await first.move(roundNumber, matchNumber, 7);
            await second.move(roundNumber, matchNumber, 6);
            await first.move(roundNumber, matchNumber, 8);
        },
        async startAndStall(instance, roundNumber, matchNumber, playerA, playerB) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const first = raw.currentTurn === playerA.address ? playerA : playerB;
            await first.move(roundNumber, matchNumber, 0);
            return {
                mover: first.address,
                claimer: first,
            };
        },
    };
}

function makeConnectFourAdapter() {
    return {
        key: "connectfour",
        name: "ConnectFour",
        gameType: 1,
        factoryArtifact: "contracts/ConnectFourFactory.sol:ConnectFourFactory",
        factoryLabel: "ConnectFourFactory",
        gameArtifact: "contracts/ConnectFour.sol:ConnectFour",
        gameLabel: "ConnectFour",
        rejectingArtifact: "contracts/test-helpers/RejectingConnectFourPlayer.sol:RejectingConnectFourPlayer",
        supportsDraw: true,
        supportsRoundDraw: true,
        supportsR2: true,
        timeouts: {
            enrollmentWindow: 2n * 60n,
            matchTimePerPlayer: 2n * 60n,
            timeIncrementPerMove: 15n,
        },
        deployFactory: () => createFactoryFixture(adapters.connectfour),
        async playWin(instance, roundNumber, matchNumber, desiredWinner, otherPlayer) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const first = raw.currentTurn === desiredWinner.address ? desiredWinner : otherPlayer;
            const second = first.address === desiredWinner.address ? otherPlayer : desiredWinner;

            if (first.address === desiredWinner.address) {
                await first.move(roundNumber, matchNumber, 0);
                await second.move(roundNumber, matchNumber, 0);
                await first.move(roundNumber, matchNumber, 1);
                await second.move(roundNumber, matchNumber, 1);
                await first.move(roundNumber, matchNumber, 2);
                await second.move(roundNumber, matchNumber, 2);
                await first.move(roundNumber, matchNumber, 3);
                return first.address;
            }

            await first.move(roundNumber, matchNumber, 6);
            await second.move(roundNumber, matchNumber, 0);
            await first.move(roundNumber, matchNumber, 6);
            await second.move(roundNumber, matchNumber, 1);
            await first.move(roundNumber, matchNumber, 6);
            await second.move(roundNumber, matchNumber, 2);
            await first.move(roundNumber, matchNumber, 5);
            await second.move(roundNumber, matchNumber, 3);
            return second.address;
        },
        async playDraw(instance, roundNumber, matchNumber, playerA, playerB) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const firstAddress = raw.currentTurn;
            const first = firstAddress === playerA.address ? playerA : playerB;
            const second = first.address === playerA.address ? playerB : playerA;
            for (let index = 0; index < CONNECT_FOUR_DRAW_COLUMNS.length; index++) {
                const participant = index % 2 === 0 ? first : second;
                await participant.move(roundNumber, matchNumber, CONNECT_FOUR_DRAW_COLUMNS[index]);
            }
        },
        async startAndStall(instance, roundNumber, matchNumber, playerA, playerB) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const first = raw.currentTurn === playerA.address ? playerA : playerB;
            await first.move(roundNumber, matchNumber, 0);
            return {
                mover: first.address,
                claimer: first,
            };
        },
    };
}

function makeChessAdapter() {
    return {
        key: "chess",
        name: "Chess",
        gameType: 2,
        factoryArtifact: "contracts/ChessFactory.sol:ChessFactory",
        factoryLabel: "ChessFactory",
        gameArtifact: "contracts/Chess.sol:Chess",
        gameLabel: "Chess",
        rejectingArtifact: "contracts/test-helpers/RejectingChessPlayer.sol:RejectingChessPlayer",
        supportsDraw: false,
        supportsRoundDraw: false,
        supportsR2: false,
        timeouts: {
            enrollmentWindow: 2n * 60n,
            matchTimePerPlayer: 2n * 60n,
            timeIncrementPerMove: 15n,
        },
        deployFactory: () => createFactoryFixture(adapters.chess),
        async playWin(instance, roundNumber, matchNumber, desiredWinner, otherPlayer) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const white = raw.player1 === desiredWinner.address ? desiredWinner : otherPlayer;
            const black = white.address === desiredWinner.address ? otherPlayer : desiredWinner;

            if (desiredWinner.address === raw.player1) {
                const moves = [
                    [12, 28, 0], // e2-e4
                    [52, 36, 0], // e7-e5
                    [3, 39, 0],  // Qd1-h5
                    [57, 42, 0], // Nb8-c6
                    [5, 26, 0],  // Bf1-c4
                    [62, 45, 0], // Ng8-f6
                    [39, 53, 0], // Qh5xf7#
                ];
                for (const [from, to, promotion] of moves) {
                    const turn = await readMatchRaw(instance, roundNumber, matchNumber);
                    const mover = turn.currentTurn === white.address ? white : black;
                    await mover.move(roundNumber, matchNumber, from, to, promotion);
                }
                return desiredWinner.address;
            }

            const moves = [
                [13, 21, 0], // f2-f3
                [52, 36, 0], // e7-e5
                [14, 30, 0], // g2-g4
                [59, 31, 0], // Qd8-h4#
            ];
            for (const [from, to, promotion] of moves) {
                const turn = await readMatchRaw(instance, roundNumber, matchNumber);
                const mover = turn.currentTurn === raw.player1 ? white : black;
                await mover.move(roundNumber, matchNumber, from, to, promotion);
            }
            return desiredWinner.address;
        },
        async startAndStall(instance, roundNumber, matchNumber, playerA, playerB) {
            const raw = await readMatchRaw(instance, roundNumber, matchNumber);
            const white = raw.player1 === playerA.address ? playerA : playerB;
            await white.move(roundNumber, matchNumber, 12, 28, 0); // e2-e4
            return {
                mover: white.address,
                claimer: white,
            };
        },
    };
}

export const adapters = {
    tictactoe: makeTicTacToeAdapter(),
    connectfour: makeConnectFourAdapter(),
    chess: makeChessAdapter(),
};

async function concludeSingleMatchTournament(ctx, winnerParticipant, loserParticipant, reason = TOURNAMENT_REASON.R0) {
    await ctx.adapter.playWin(ctx.instance, 0, 0, winnerParticipant, loserParticipant);
    const expectedPot = prizePoolFor(ctx.entryFee, 2);
    const snapshot = await collectSnapshot(ctx, {
        trackedPlayers: [winnerParticipant, loserParticipant],
        trackedMatches: [[0, 0]],
        trackedProfileMatches: [[0, 0]],
    });

    assertSnapshot(snapshot, {
        tournament: {
            status: STATUS.Tournament.Concluded,
            winner: winnerParticipant.address,
            completionReason: reason,
            completionCategory: TOURNAMENT_CATEGORY.MatchResult,
            enrolledCount: 2n,
            totalEntryFeesAccrued: ctx.entryFee * 2n,
            prizePool: expectedPot,
            ownerAccrued: ownerAccruedFor(ctx.entryFee, 2),
            prizeAwarded: expectedPot,
            prizeRecipient: winnerParticipant.address,
        },
        instanceInfo: {
            status: STATUS.Tournament.Concluded,
            winner: winnerParticipant.address,
            completionReason: reason,
            completionCategory: TOURNAMENT_CATEGORY.MatchResult,
            playerCount: 2n,
            entryFee: ctx.entryFee,
            prizeAwarded: expectedPot,
            prizeRecipient: winnerParticipant.address,
        },
        bracket: {
            totalRounds: 1n,
            matchCounts: [1],
            completedCounts: [1],
        },
        players: [winnerParticipant.address, loserParticipant.address],
        factoryState: {
            activeCount: 0n,
            pastCount: 1n,
            pastIncludes: [snapshot.instanceAddress],
        },
        matches: {
            "0-0": {
                players: [winnerParticipant.address, loserParticipant.address],
                winner: winnerParticipant.address,
                status: STATUS.Match.Completed,
                isDraw: false,
                completionReason: MATCH_REASON.R0,
                completionCategory: MATCH_CATEGORY.MatchResult,
                movesNonEmpty: true,
            },
        },
        prizeDistribution: {
            total: expectedPot,
            amounts: {
                [winnerParticipant.address]: expectedPot,
                [loserParticipant.address]: 0n,
            },
        },
        playersState: {
            [winnerParticipant.address]: {
                factoryProfile: true,
                result: {
                    participated: true,
                    prizeWon: expectedPot,
                    isWinner: true,
                    payout: expectedPot,
                    payoutReason: PAYOUT_REASON.Victory,
                },
                profile: {
                    concluded: true,
                    won: true,
                    prize: expectedPot,
                    payout: expectedPot,
                    payoutReason: PAYOUT_REASON.Victory,
                    tournamentResolutionReason: reason,
                    stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                    matchRecords: {
                        "0-0": {
                            outcome: PLAYER_MATCH_OUTCOME.NormalVictory,
                            category: PLAYER_MATCH_CATEGORY.Victory,
                        },
                    },
                },
            },
            [loserParticipant.address]: {
                factoryProfile: true,
                result: {
                    participated: true,
                    prizeWon: 0n,
                    isWinner: false,
                    payout: 0n,
                    payoutReason: PAYOUT_REASON.None,
                },
                profile: {
                    concluded: true,
                    won: false,
                    prize: expectedPot,
                    payout: 0n,
                    payoutReason: PAYOUT_REASON.None,
                    tournamentResolutionReason: reason,
                    stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                    matchRecords: {
                        "0-0": {
                            outcome: PLAYER_MATCH_OUTCOME.NormalDefeat,
                            category: PLAYER_MATCH_CATEGORY.Defeat,
                        },
                    },
                },
            },
        },
        balances: {
            instanceBalance: 0n,
            factoryOwnerBalance: 0n,
        },
    });
}

async function setupParticipants(ctx, count) {
    return ctx.configuredPlayers.slice(0, count).map(signer => participantFromSigner(ctx.adapter, ctx.instance, signer));
}

function nonParticipant(ctx, offset = 0) {
    const signer = ctx.signers[ctx.configuredPlayers.length + offset] || ctx.signers[offset + 5];
    return participantFromSigner(ctx.adapter, ctx.instance, signer);
}

export function installCreationLifecycleSection(adapter) {
    describe("P0 Creation & Lifecycle", function () {
        it("P0.1 creates, auto-enrolls, auto-starts, and moves the instance from active to past", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 1 });
            const [creator, joiner] = [participantFromSigner(adapter, ctx.instance, ctx.creator), participantFromSigner(adapter, ctx.instance, ctx.signers[1])];

            if (adapter.key === "chess") {
                expect(await ctx.instance.CHESS_RULES()).to.equal(await ctx.chessRules.getAddress());
            }

            const before = await collectSnapshot(ctx, {
                trackedPlayers: [creator],
                trackedMatches: [],
                trackedProfileMatches: [],
            });
            assertSnapshot(before, {
                tournament: {
                    status: STATUS.Tournament.Enrolling,
                    enrolledCount: 1n,
                    totalEntryFeesAccrued: ctx.entryFee,
                    prizePool: prizePoolFor(ctx.entryFee, 1),
                    ownerAccrued: ownerAccruedFor(ctx.entryFee, 1),
                },
                instanceInfo: {
                    status: STATUS.Tournament.Enrolling,
                    playerCount: 2n,
                    entryFee: ctx.entryFee,
                },
                players: [creator.address],
                factoryState: {
                    activeCount: 1n,
                    pastCount: 0n,
                },
                playersState: {
                    [creator.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: 0n, isWinner: false, payout: 0n, payoutReason: PAYOUT_REASON.None },
                        profile: { concluded: false, won: false, prize: 0n, payout: 0n, payoutReason: PAYOUT_REASON.None },
                    },
                },
            });

            await joiner.enroll(ctx.entryFee);
            await concludeSingleMatchTournament(ctx, creator, joiner);
        });
    });
}

export function installNormalResolutionSection(adapter) {
    describe("P1 R0 Normal Resolution", function () {
        it("P1.1 concludes a 2-player direct final with R0", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 2 });
            const [first, second] = await setupParticipants(ctx, 2);
            await concludeSingleMatchTournament(ctx, first, second);
        });

        it("P1.2 concludes a 4-player bracket with R0 and validates every touched match", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const match0 = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const match1 = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, match0.player1, match0.player2);
            await adapter.playWin(ctx.instance, 0, 1, match1.player1, match1.player2);

            const final = await getMatchPlayers(ctx.instance, 1, 0, byAddress);
            const champion = final.player1;
            const finalist = final.player2;
            await adapter.playWin(ctx.instance, 1, 0, champion, finalist);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const outsider = nonParticipant(ctx);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress), outsider],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.R0,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    enrolledCount: 4n,
                    totalEntryFeesAccrued: ctx.entryFee * 4n,
                    prizePool: expectedPot,
                    ownerAccrued: ownerAccruedFor(ctx.entryFee, 4),
                    prizeAwarded: expectedPot,
                    prizeRecipient: champion.address,
                },
                instanceInfo: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.R0,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    playerCount: 4n,
                    entryFee: ctx.entryFee,
                    prizeAwarded: expectedPot,
                    prizeRecipient: champion.address,
                },
                bracket: {
                    totalRounds: 2n,
                    matchCounts: [2, 1],
                    completedCounts: [2, 1],
                },
                players: Object.keys(byAddress),
                factoryState: {
                    activeCount: 0n,
                    pastCount: 1n,
                    pastIncludes: [snapshot.instanceAddress],
                },
                matches: {
                    "0-0": {
                        players: [match0.player1.address, match0.player2.address],
                        winner: match0.player1.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                    "0-1": {
                        players: [match1.player1.address, match1.player2.address],
                        winner: match1.player1.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                    "1-0": {
                        players: [champion.address, finalist.address],
                        winner: champion.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                prizeDistribution: {
                    total: expectedPot,
                    amounts: {
                        [champion.address]: expectedPot,
                        [match0.player2.address]: 0n,
                        [match1.player2.address]: 0n,
                        [finalist.address]: 0n,
                    },
                },
                playersState: {
                    [champion.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                            stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                        },
                    },
                    [finalist.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                            stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                        },
                    },
                    [match0.player2.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: 0n, isWinner: false, payout: 0n, payoutReason: PAYOUT_REASON.None },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                            stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                        },
                    },
                    [match1.player2.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: 0n, isWinner: false, payout: 0n, payoutReason: PAYOUT_REASON.None },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                            stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                        },
                    },
                    [outsider.address]: {
                        result: {
                            participated: false,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installTimeoutSection(adapter) {
    describe("P2 ML1 Timeout", function () {
        it("P2.1 concludes a 2-player tournament by direct timeout claim", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 2 });
            const [playerA, playerB] = await setupParticipants(ctx, 2);
            const { claimer } = await adapter.startAndStall(ctx.instance, 0, 0, playerA, playerB);
            await advancePastMatchTimeout(ctx.instance, 0, 0);
            const claimerParticipant = claimer;
            const loserParticipant = claimer.address === playerA.address ? playerB : playerA;
            await ctx.instance.connect(claimerParticipant.signer ?? claimerParticipant.controller).claimTimeoutWin(0, 0);

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [playerA, playerB],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: claimerParticipant.address,
                    completionReason: TOURNAMENT_REASON.ML1,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: claimerParticipant.address,
                },
                matches: {
                    "0-0": {
                        players: [playerA.address, playerB.address],
                        winner: claimerParticipant.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [claimerParticipant.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML1,
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.TimeoutVictory, category: PLAYER_MATCH_CATEGORY.Victory },
                            },
                        },
                    },
                    [loserParticipant.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML1,
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.TimeoutDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P2.2 advances a 4-player bracket through a semifinal timeout and still validates the final state", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            const stalled = await adapter.startAndStall(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);
            await advancePastMatchTimeout(ctx.instance, 0, 1);
            const semifinalWinner = stalled.claimer;
            const semifinalLoser = stalled.claimer.address === secondSemi.player1.address ? secondSemi.player2 : secondSemi.player1;
            await ctx.instance.connect(semifinalWinner.signer ?? semifinalWinner.controller).claimTimeoutWin(0, 1);

            const final = await getMatchPlayers(ctx.instance, 1, 0, byAddress);
            await adapter.playWin(ctx.instance, 1, 0, final.player1, final.player2);

            const champion = final.player1;
            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.R0,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: champion.address,
                },
                matches: {
                    "0-1": {
                        players: [secondSemi.player1.address, secondSemi.player2.address],
                        winner: semifinalWinner.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                    "1-0": {
                        players: [final.player1.address, final.player2.address],
                        winner: champion.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [semifinalWinner.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-1": { outcome: PLAYER_MATCH_OUTCOME.TimeoutVictory, category: PLAYER_MATCH_CATEGORY.Victory },
                            },
                        },
                    },
                    [semifinalLoser.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-1": { outcome: PLAYER_MATCH_OUTCOME.TimeoutDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                    [champion.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installForceEliminationSection(adapter) {
    describe("P3 ML2 Force Elimination", function () {
        it("P3.1 force-eliminates a stalled semifinal, then concludes the bracket normally", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 8, enrolledPlayers: 8 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const match0 = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const match1 = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 1, match1.player1, match1.player2);
            await adapter.startAndStall(ctx.instance, 0, 0, match0.player1, match0.player2);
            await advancePastMl2(ctx.instance, 0, 0);
            await ctx.instance.connect(match1.player1.signer ?? match1.player1.controller).forceEliminateStalledMatch(0, 0);

            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1]],
                trackedProfileMatches: [[0, 0], [0, 1]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.InProgress,
                    currentRound: 0n,
                    actualTotalRounds: 3n,
                    enrolledCount: 8n,
                    totalEntryFeesAccrued: ctx.entryFee * 8n,
                },
                bracket: {
                    totalRounds: 3n,
                    matchCounts: [4, 2, 0],
                    completedCounts: [2, 0, 0],
                },
                matches: {
                    "0-0": {
                        players: [match0.player1.address, match0.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML2,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                    "0-1": {
                        players: [match1.player1.address, match1.player2.address],
                        winner: match1.player1.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [match0.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.ForceEliminationDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                    [match0.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.ForceEliminationDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                    [match1.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-1": { outcome: PLAYER_MATCH_OUTCOME.NormalVictory, category: PLAYER_MATCH_CATEGORY.Victory },
                            },
                        },
                    },
                },
            });
        });

        it("P3.2 lets the finalist force-eliminate the other semifinal and win the tournament by ML2", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.startAndStall(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);
            await advancePastMl2(ctx.instance, 0, 1);
            await ctx.instance.connect(firstSemi.player1.signer ?? firstSemi.player1.controller).forceEliminateStalledMatch(0, 1);

            const champion = firstSemi.player1;
            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.ML2,
                    completionCategory: TOURNAMENT_CATEGORY.Escalation,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: champion.address,
                },
                matches: {
                    "0-1": {
                        players: [secondSemi.player1.address, secondSemi.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML2,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                    "1-0": {
                        winner: champion.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML2,
                        completionCategory: MATCH_CATEGORY.Escalation,
                    },
                },
                playersState: {
                    [champion.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML2,
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.NormalVictory, category: PLAYER_MATCH_CATEGORY.Victory },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installReplacementSection(adapter) {
    describe("P4 ML3 Replacement", function () {
        it("P4.1 replaces both players in a semifinal, then continues the bracket", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 8, enrolledPlayers: 8 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);
            const targetMatch = await getMatchPlayers(ctx.instance, 0, 0, byAddress);

            await adapter.startAndStall(ctx.instance, 0, 0, targetMatch.player1, targetMatch.player2);
            await advancePastMl3(ctx.instance, 0, 0);
            await ctx.instance.connect(outsider.signer ?? outsider.controller).claimMatchSlotByReplacement(0, 0);

            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress), outsider],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.InProgress,
                    currentRound: 0n,
                    actualTotalRounds: 3n,
                    enrolledCount: 9n,
                    totalEntryFeesAccrued: ctx.entryFee * 8n,
                },
                matches: {
                    "0-0": {
                        players: [targetMatch.player1.address, targetMatch.player2.address],
                        winner: outsider.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML3,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [targetMatch.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                    [targetMatch.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat, category: PLAYER_MATCH_CATEGORY.Defeat },
                            },
                        },
                    },
                    [outsider.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: 0n,
                            concluded: false,
                            won: false,
                            prize: 0n,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: 0n,
                            stats: { totalPlayed: 0, totalWins: 0, totalLosses: 0 },
                            matchRecords: {
                                "0-0": { outcome: PLAYER_MATCH_OUTCOME.ReplacementVictory, category: PLAYER_MATCH_CATEGORY.Victory },
                            },
                        },
                    },
                },
            });
        });

        it("P4.2 replaces both finalists and ends the tournament by ML3", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.playWin(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);

            const final = await getMatchPlayers(ctx.instance, 1, 0, byAddress);
            await adapter.startAndStall(ctx.instance, 1, 0, final.player1, final.player2);
            await advancePastMl3(ctx.instance, 1, 0);
            await ctx.instance.connect(outsider.signer ?? outsider.controller).claimMatchSlotByReplacement(1, 0);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress), outsider],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: outsider.address,
                    completionReason: TOURNAMENT_REASON.ML3,
                    completionCategory: TOURNAMENT_CATEGORY.Escalation,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: outsider.address,
                },
                matches: {
                    "1-0": {
                        players: [final.player1.address, final.player2.address],
                        winner: outsider.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML3,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installEnrollmentSection(adapter) {
    describe("P5 Enrollment Escalations", function () {
        it("P5.1 supports EL0 solo cancel with full refund and consistent terminal records", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 1 });
            const creator = participantFromSigner(adapter, ctx.instance, ctx.creator);

            await ctx.instance.connect(ctx.creator).cancelTournament();

            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [creator],
                trackedMatches: [],
                trackedProfileMatches: [],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: creator.address,
                    completionReason: TOURNAMENT_REASON.EL0,
                    completionCategory: TOURNAMENT_CATEGORY.EnrollmentResolution,
                    enrolledCount: 1n,
                    totalEntryFeesAccrued: ctx.entryFee,
                    prizePool: 0n,
                    ownerAccrued: 0n,
                },
                instanceInfo: {
                    status: STATUS.Tournament.Concluded,
                    winner: creator.address,
                    completionReason: TOURNAMENT_REASON.EL0,
                    completionCategory: TOURNAMENT_CATEGORY.EnrollmentResolution,
                    playerCount: 2n,
                    entryFee: ctx.entryFee,
                },
                players: [creator.address],
                factoryState: {
                    activeCount: 0n,
                    pastCount: 1n,
                },
                prizeDistribution: {
                    total: ctx.entryFee,
                    amounts: {
                        [creator.address]: ctx.entryFee,
                    },
                },
                playersState: {
                    [creator.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: ctx.entryFee,
                            isWinner: true,
                            payout: ctx.entryFee,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: 0n,
                            payout: ctx.entryFee,
                            payoutReason: PAYOUT_REASON.Cancelation,
                            tournamentResolutionReason: TOURNAMENT_REASON.EL0,
                            stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P5.2 exercises EL1 mechanics: reset window, force-start gating, and bye materialization", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 1 });
            const creator = participantFromSigner(adapter, ctx.instance, ctx.creator);
            const joiner = participantFromSigner(adapter, ctx.instance, ctx.signers[1]);

            await expect(ctx.instance.connect(ctx.creator).forceStartTournament()).to.be.reverted;
            await advanceBy(30n);
            await ctx.instance.connect(ctx.creator).resetEnrollmentWindow();
            await joiner.enroll(ctx.entryFee);
            await advanceBy(ctx.timeouts.enrollmentWindow - 10n);
            await expect(ctx.instance.connect(ctx.creator).forceStartTournament()).to.be.reverted;
            await advanceBy(15n);
            await ctx.instance.connect(ctx.creator).forceStartTournament();

            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [creator, joiner],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.InProgress,
                    currentRound: 0n,
                    actualTotalRounds: 1n,
                    enrolledCount: 2n,
                    totalEntryFeesAccrued: ctx.entryFee * 2n,
                    prizePool: prizePoolFor(ctx.entryFee, 2),
                },
                bracket: {
                    totalRounds: 1n,
                    matchCounts: [1],
                    completedCounts: [0],
                },
                factoryState: {
                    activeCount: 1n,
                    pastCount: 0n,
                },
                matches: {
                    "0-0": {
                        players: [creator.address, joiner.address],
                        status: STATUS.Match.InProgress,
                        isDraw: false,
                    },
                },
            });
        });

        it("P5.3 supports EL2 abandoned-claim resolution by an outsider", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 2 });
            const creator = participantFromSigner(adapter, ctx.instance, ctx.creator);
            const joiner = participantFromSigner(adapter, ctx.instance, ctx.signers[1]);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);

            await advancePastEnrollmentClaim(ctx.instance);
            await ctx.instance.connect(ctx.outsider).claimAbandonedPool();

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [creator, joiner, outsider],
                trackedMatches: [],
                trackedProfileMatches: [],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: outsider.address,
                    completionReason: TOURNAMENT_REASON.EL2,
                    completionCategory: TOURNAMENT_CATEGORY.EnrollmentResolution,
                    enrolledCount: 2n,
                    totalEntryFeesAccrued: ctx.entryFee * 2n,
                    prizePool: expectedPot,
                    ownerAccrued: ownerAccruedFor(ctx.entryFee, 2),
                },
                prizeDistribution: {
                    amounts: {
                        [creator.address]: 0n,
                        [joiner.address]: 0n,
                    },
                },
                playersState: {
                    [outsider.address]: {
                        factoryProfile: "registry",
                        result: {
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.EL2,
                            stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installDrawSection(adapter) {
    describe("P6 Draw Resolution", function () {
        if (!adapter.supportsDraw) {
            it("P6.NA marks finals draw, round draw, and R2 as not applicable for this game", async function () {
                expect(scenarioApplicability[adapter.key].draws).to.equal("not_applicable");
                expect(scenarioApplicability[adapter.key].roundDraws).to.equal("not_applicable");
                expect(scenarioApplicability[adapter.key].uncontestedFinalist).to.equal("not_applicable");
            });
            return;
        }

        it("P6.1 resolves a 2-player finals draw with R1 and equal payout", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 2 });
            const [playerA, playerB] = await setupParticipants(ctx, 2);
            await adapter.playDraw(ctx.instance, 0, 0, playerA, playerB);

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const split = expectedPot / 2n;
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [playerA, playerB],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: hre.ethers.ZeroAddress,
                    completionReason: TOURNAMENT_REASON.R1,
                    completionCategory: TOURNAMENT_CATEGORY.DrawResolution,
                    prizePool: expectedPot,
                    finalsWasDraw: true,
                },
                matches: {
                    "0-0": {
                        players: [playerA.address, playerB.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: true,
                        completionReason: MATCH_REASON.R1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                prizeDistribution: {
                    total: expectedPot,
                    amounts: {
                        [playerA.address]: split,
                        [playerB.address]: split,
                    },
                },
                playersState: {
                    [playerA.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: { "0-0": { outcome: PLAYER_MATCH_OUTCOME.Draw, category: PLAYER_MATCH_CATEGORY.Draw } },
                        },
                    },
                    [playerB.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: { "0-0": { outcome: PLAYER_MATCH_OUTCOME.Draw, category: PLAYER_MATCH_CATEGORY.Draw } },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P6.2 resolves an all-draw semifinal round with R1 and even split for every player", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playDraw(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.playDraw(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const split = expectedPot / 4n;
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1]],
                trackedProfileMatches: [[0, 0], [0, 1]],
            });

            const expectedPlayersState = {};
            for (const participant of Object.values(byAddress)) {
                expectedPlayersState[participant.address] = {
                    factoryProfile: true,
                    result: {
                        participated: true,
                        prizeWon: split,
                        isWinner: false,
                        payout: split,
                        payoutReason: PAYOUT_REASON.EvenSplit,
                    },
                    profile: {
                        concluded: true,
                        won: false,
                        prize: expectedPot,
                        payout: split,
                        payoutReason: PAYOUT_REASON.EvenSplit,
                        tournamentResolutionReason: TOURNAMENT_REASON.R1,
                    },
                };
            }

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: hre.ethers.ZeroAddress,
                    completionReason: TOURNAMENT_REASON.R1,
                    completionCategory: TOURNAMENT_CATEGORY.DrawResolution,
                    prizePool: expectedPot,
                    allDrawResolution: true,
                },
                bracket: {
                    totalRounds: 2n,
                    matchCounts: [2, 0],
                    completedCounts: [2, 0],
                },
                prizeDistribution: {
                    total: expectedPot,
                    amounts: Object.fromEntries(Object.values(byAddress).map(participant => [participant.address, split])),
                },
                playersState: expectedPlayersState,
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P6.3 awards the uncontested finalist with R2 when the other semifinal ends in a draw", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.playDraw(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const champion = firstSemi.player1;
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.R2,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    prizePool: expectedPot,
                },
                matches: {
                    "0-1": {
                        players: [secondSemi.player1.address, secondSemi.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: true,
                        completionReason: MATCH_REASON.R1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [champion.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.R2,
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installPrizeRedistributionSection(adapter) {
    describe("P7 Prize Redistribution", function () {
        it("P7.1 redistributes a rejecting winner's payout to the remaining enrolled player", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 1 });
            const creator = participantFromSigner(adapter, ctx.instance, ctx.creator);
            const rejectingWinner = await createRejectingParticipant(adapter, ctx.instance, ctx.signers[1]);
            await rejectingWinner.enroll(ctx.entryFee);
            await rejectingWinner.setRejectPayments(true);

            await adapter.playWin(ctx.instance, 0, 0, rejectingWinner, creator);

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [creator, rejectingWinner],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0]],
                trackedRecipients: [rejectingWinner],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: rejectingWinner.address,
                    completionReason: TOURNAMENT_REASON.R0,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    prizePool: expectedPot,
                },
                prizeDistribution: {
                    total: expectedPot,
                    amounts: {
                        [rejectingWinner.address]: 0n,
                        [creator.address]: expectedPot,
                    },
                },
                playersState: {
                    [rejectingWinner.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: true,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.WalletRejected,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.WalletRejected,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                        },
                    },
                    [creator.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: false,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                        },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R0,
                        },
                    },
                },
                recipientState: {
                    [rejectingWinner.address]: {
                        receivedAmount: 0n,
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}

export function installPlayerRecordEdgeCasesSection(adapter) {
    describe("P8 Player Records & Resolution Edge Cases", function () {
        it("P8.1 records original finalists' tournament outcome and the outsider's replacement match win in a direct ML3 final", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 2, enrolledPlayers: 2 });
            const [playerA, playerB] = await setupParticipants(ctx, 2);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);

            await adapter.startAndStall(ctx.instance, 0, 0, playerA, playerB);
            await advancePastMl3(ctx.instance, 0, 0);
            await ctx.instance.connect(outsider.signer ?? outsider.controller).claimMatchSlotByReplacement(0, 0);

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [playerA, playerB, outsider],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: outsider.address,
                    completionReason: TOURNAMENT_REASON.ML3,
                    completionCategory: TOURNAMENT_CATEGORY.Escalation,
                    enrolledCount: 3n,
                    totalEntryFeesAccrued: ctx.entryFee * 2n,
                    prizePool: expectedPot,
                    ownerAccrued: ownerAccruedFor(ctx.entryFee, 2),
                    prizeAwarded: expectedPot,
                    prizeRecipient: outsider.address,
                },
                players: [playerA.address, playerB.address, outsider.address],
                matches: {
                    "0-0": {
                        players: [playerA.address, playerB.address],
                        winner: outsider.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML3,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                },
                prizeDistribution: {
                    total: expectedPot,
                    amounts: {
                        [playerA.address]: 0n,
                        [playerB.address]: 0n,
                        [outsider.address]: expectedPot,
                    },
                },
                playersState: {
                    [playerA.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: ctx.entryFee,
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    gameType: BigInt(adapter.gameType),
                                    roundNumber: 0n,
                                    matchNumber: 0n,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                            },
                        },
                    },
                    [playerB.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: ctx.entryFee,
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            stats: { totalPlayed: 1, totalWins: 0, totalLosses: 1 },
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    gameType: BigInt(adapter.gameType),
                                    roundNumber: 0n,
                                    matchNumber: 0n,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                            },
                        },
                    },
                    [outsider.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: 0n,
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    gameType: BigInt(adapter.gameType),
                                    roundNumber: 0n,
                                    matchNumber: 0n,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementVictory,
                                    category: PLAYER_MATCH_CATEGORY.Victory,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P8.2 records EL2 terminal tournament results without creating any player match records", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 2 });
            const creator = participantFromSigner(adapter, ctx.instance, ctx.creator);
            const joiner = participantFromSigner(adapter, ctx.instance, ctx.signers[1]);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);

            await advancePastEnrollmentClaim(ctx.instance);
            await ctx.instance.connect(ctx.outsider).claimAbandonedPool();

            const expectedPot = prizePoolFor(ctx.entryFee, 2);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [creator, joiner, outsider],
                trackedProfileMatches: [[0, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: outsider.address,
                    completionReason: TOURNAMENT_REASON.EL2,
                    completionCategory: TOURNAMENT_CATEGORY.EnrollmentResolution,
                    enrolledCount: 2n,
                    totalEntryFeesAccrued: ctx.entryFee * 2n,
                    prizePool: expectedPot,
                    ownerAccrued: ownerAccruedFor(ctx.entryFee, 2),
                    prizeAwarded: expectedPot,
                    prizeRecipient: outsider.address,
                },
                players: [creator.address, joiner.address],
                prizeDistribution: {
                    amounts: {
                        [creator.address]: 0n,
                        [joiner.address]: 0n,
                    },
                },
                playersState: {
                    [creator.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: ctx.entryFee,
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.EL2,
                            matchRecords: {
                                "0-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [joiner.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: 0n,
                            isWinner: false,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: ctx.entryFee,
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.EL2,
                            matchRecords: {
                                "0-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [outsider.address]: {
                        factoryProfile: "registry",
                        result: {
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: 0n,
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.EL2,
                            matchRecords: {
                                "0-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P8.3 preserves per-player records when ML2 awards the tournament without a played final", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playWin(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.startAndStall(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);
            await advancePastMl2(ctx.instance, 0, 1);
            await ctx.instance.connect(firstSemi.player1.signer ?? firstSemi.player1.controller).forceEliminateStalledMatch(0, 1);

            const champion = firstSemi.player1;
            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: champion.address,
                    completionReason: TOURNAMENT_REASON.ML2,
                    completionCategory: TOURNAMENT_CATEGORY.Escalation,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: champion.address,
                },
                matches: {
                    "0-0": {
                        players: [firstSemi.player1.address, firstSemi.player2.address],
                        winner: champion.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.R0,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                    "0-1": {
                        players: [secondSemi.player1.address, secondSemi.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML2,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                    "1-0": {
                        winner: champion.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML2,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: false,
                    },
                },
                playersState: {
                    [champion.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML2,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.NormalVictory,
                                    category: PLAYER_MATCH_CATEGORY.Victory,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [firstSemi.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML2,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.NormalDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML2,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.ForceEliminationDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML2,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.ForceEliminationDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        if (!adapter.supportsDraw) {
            it("P8.NA marks draw-driven record edge cases as not applicable for this game", async function () {
                expect(scenarioApplicability[adapter.key].draws).to.equal("not_applicable");
                expect(scenarioApplicability[adapter.key].roundDraws).to.equal("not_applicable");
                expect(scenarioApplicability[adapter.key].uncontestedFinalist).to.equal("not_applicable");
            });
            return;
        }

        it("P8.4 keeps draw and ML3 record semantics distinct when an outsider wins from the non-drawn side", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const outsider = participantFromSigner(adapter, ctx.instance, ctx.outsider);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playDraw(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.startAndStall(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);
            await advancePastMl3(ctx.instance, 0, 1);
            await ctx.instance.connect(outsider.signer ?? outsider.controller).claimMatchSlotByReplacement(0, 1);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress), outsider],
                trackedMatches: [[0, 0], [0, 1], [1, 0]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: outsider.address,
                    completionReason: TOURNAMENT_REASON.ML3,
                    completionCategory: TOURNAMENT_CATEGORY.Escalation,
                    enrolledCount: 5n,
                    totalEntryFeesAccrued: ctx.entryFee * 4n,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: outsider.address,
                },
                matches: {
                    "0-0": {
                        players: [firstSemi.player1.address, firstSemi.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: true,
                        completionReason: MATCH_REASON.R1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                    "0-1": {
                        players: [secondSemi.player1.address, secondSemi.player2.address],
                        winner: outsider.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML3,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: true,
                    },
                    "1-0": {
                        winner: outsider.address,
                        status: STATUS.Match.Completed,
                        isDraw: false,
                        completionReason: MATCH_REASON.ML3,
                        completionCategory: MATCH_CATEGORY.Escalation,
                        movesNonEmpty: false,
                    },
                },
                playersState: {
                    [firstSemi.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [firstSemi.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementDefeat,
                                    category: PLAYER_MATCH_CATEGORY.Defeat,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [outsider.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: 0n,
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.ML3,
                            stats: { totalPlayed: 1, totalWins: 1, totalLosses: 0 },
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.ReplacementVictory,
                                    category: PLAYER_MATCH_CATEGORY.Victory,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P8.5 records R2 correctly when a bye finalist wins without ever playing a match", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 3 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);

            await advancePastEnrollmentDeadline(ctx.instance);
            await ctx.instance.connect(ctx.creator).forceStartTournament();

            const semifinal = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const byeFinalist = Object.values(byAddress).find(
                participant => participant.address !== semifinal.player1.address && participant.address !== semifinal.player2.address
            );

            await adapter.playDraw(ctx.instance, 0, 0, semifinal.player1, semifinal.player2);

            const expectedPot = prizePoolFor(ctx.entryFee, 3);
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0]],
                trackedProfileMatches: [[0, 0], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: byeFinalist.address,
                    completionReason: TOURNAMENT_REASON.R2,
                    completionCategory: TOURNAMENT_CATEGORY.MatchResult,
                    enrolledCount: 3n,
                    totalEntryFeesAccrued: ctx.entryFee * 3n,
                    prizePool: expectedPot,
                    prizeAwarded: expectedPot,
                    prizeRecipient: byeFinalist.address,
                },
                matches: {
                    "0-0": {
                        players: [semifinal.player1.address, semifinal.player2.address],
                        winner: hre.ethers.ZeroAddress,
                        status: STATUS.Match.Completed,
                        isDraw: true,
                        completionReason: MATCH_REASON.R1,
                        completionCategory: MATCH_CATEGORY.MatchResult,
                        movesNonEmpty: true,
                    },
                },
                playersState: {
                    [semifinal.player1.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.R2,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [semifinal.player2.address]: {
                        factoryProfile: true,
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: 0n,
                            payoutReason: PAYOUT_REASON.None,
                            tournamentResolutionReason: TOURNAMENT_REASON.R2,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [byeFinalist.address]: {
                        factoryProfile: true,
                        result: {
                            participated: true,
                            prizeWon: expectedPot,
                            isWinner: true,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                        },
                        profile: {
                            instance: snapshot.instanceAddress,
                            gameType: BigInt(adapter.gameType),
                            entryFee: ctx.entryFee,
                            concluded: true,
                            won: true,
                            prize: expectedPot,
                            payout: expectedPot,
                            payoutReason: PAYOUT_REASON.Victory,
                            tournamentResolutionReason: TOURNAMENT_REASON.R2,
                            matchRecords: {
                                "0-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });

        it("P8.6 leaves every player without a finals match record when an entire semifinal round draws", async function () {
            const ctx = await loadTournamentFixture(adapter, { playerCount: 4, enrolledPlayers: 4 });
            const byAddress = participantsMap(adapter, ctx.instance, ctx.configuredPlayers);
            const firstSemi = await getMatchPlayers(ctx.instance, 0, 0, byAddress);
            const secondSemi = await getMatchPlayers(ctx.instance, 0, 1, byAddress);

            await adapter.playDraw(ctx.instance, 0, 0, firstSemi.player1, firstSemi.player2);
            await adapter.playDraw(ctx.instance, 0, 1, secondSemi.player1, secondSemi.player2);

            const expectedPot = prizePoolFor(ctx.entryFee, 4);
            const split = expectedPot / 4n;
            const snapshot = await collectSnapshot(ctx, {
                trackedPlayers: [...Object.values(byAddress)],
                trackedMatches: [[0, 0], [0, 1]],
                trackedProfileMatches: [[0, 0], [0, 1], [1, 0]],
            });

            assertSnapshot(snapshot, {
                tournament: {
                    status: STATUS.Tournament.Concluded,
                    winner: hre.ethers.ZeroAddress,
                    completionReason: TOURNAMENT_REASON.R1,
                    completionCategory: TOURNAMENT_CATEGORY.DrawResolution,
                    prizePool: expectedPot,
                },
                playersState: {
                    [firstSemi.player1.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [firstSemi.player2.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: {
                                "0-0": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player1.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                    [secondSemi.player2.address]: {
                        factoryProfile: true,
                        result: { participated: true, prizeWon: split, isWinner: false, payout: split, payoutReason: PAYOUT_REASON.EvenSplit },
                        profile: {
                            concluded: true,
                            won: false,
                            prize: expectedPot,
                            payout: split,
                            payoutReason: PAYOUT_REASON.EvenSplit,
                            tournamentResolutionReason: TOURNAMENT_REASON.R1,
                            matchRecords: {
                                "0-1": {
                                    instance: snapshot.instanceAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.Draw,
                                    category: PLAYER_MATCH_CATEGORY.Draw,
                                },
                                "1-0": {
                                    instance: hre.ethers.ZeroAddress,
                                    outcome: PLAYER_MATCH_OUTCOME.None,
                                    category: PLAYER_MATCH_CATEGORY.None,
                                },
                            },
                        },
                    },
                },
                balances: {
                    instanceBalance: 0n,
                    factoryOwnerBalance: 0n,
                },
            });
        });
    });
}
