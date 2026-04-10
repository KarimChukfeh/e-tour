## Introduction

This is a technical document that explains how ETour delivers on: 

- Fully on-chain tournament infrastructure
- ETH-only with no special tokens
- Self-sustaining without need for VCs
- Grief-proof with garunteed fair resolution

If you are looking to validate ETour's claims, question its assumptions, or just understand how it really works under the hood, then you're in the right place.

If you are a developer who simply wants to build on ETour rather than study its internal design, then you can safely skip ahead to the [Builder's Guide](#building-games-on-etour).

## What to Expect

In this document we'll go over:

- How ETour modules work and what they do,
- How factories, instance implementations, and modules fit together,
- How tournament state is stored and mutated,
- How match progression, escalations, and payouts work,
- Why the contracts are split the way they are,
- How to build new games using ETour protocol.

## Key Terms

Before going deeper, it helps to define the terms ETour uses repeatedly.

- Game Contract: the concrete implementation for a specific game such as Tic-Tac-Toe, Connect Four, or Chess.
- Module: a shared infrastructure contract that the clone executes through `delegatecall` so it can reuse logic without copying code.
- Tier: a reusable configuration bucket defined by player count, entry fee, and timeout settings.
- Factory: a contract that creates new tournament instances for one game type and tracks them over time.
- Implementation: the deployed logic contract that clone instances point to.
- Clone: a minimal proxy for one specific tournament; this is where the tournament's permanent state lives.
- Instance: here, this usually means the tournament clone itself, not the implementation contract.

## Core Principles

ETour is optimized around five constraints:

1. Each tournament should be a permanent onchain record.
2. New games should reuse bracket, payout, timeout, and profile infrastructure instead of reimplementing it.
3. Game-specific logic should stay narrow and isolated.
4. Deployable contracts must remain under the EVM contract-size limit.
5. The developer-facing extension surface should be explicit and stable.

The important design choice is this:

- the clone owns all tournament state,
- the modules own almost no state,
- the modules execute against clone storage through `delegatecall`,
- the game contract supplies only the game-specific hooks and `makeMove(...)`.

The resulting system is a hybrid of:

- EIP-1167 minimal proxies for cheap per-tournament deployments,
- shared delegatecall modules for infra logic reuse,
- thin game-specific implementation contracts for move validation and state updates.


## Contracts

At a high level, the ETour contract stack looks like this:

```text
ETourFactory
   ├─ deploys once → Game Implementation (ETourGame + your code)
   └─ clones many  → Tournament Clone / Instance
                       ├─ stores tournament, round, and match state
                       ├─ executes implementation code
                       └─ delegatecalls → ETour Modules (shared logic)
```

### Game Contracts

Game contracts are the developer-facing entrypoint into ETour.

If you are building a new game on ETour, this is the contract you actually write: `YourGame.sol`.

In practice, the defining step looks like `contract YourGame is ETourGame`.

That inheritance line is what turns your rules engine into an ETour tournament game. Your contract does not reimplement the whole tournament protocol. It is responsible only for the narrow game-specific surface:

- defining game-owned match state,
- validating moves,
- updating the board or position,
- deciding when a match ends,
- exposing the game's `makeMove(...)` flow.

Everything else is meant to come from ETour's shared infrastructure: enrollment, bracket progression, payouts, timeout flows, escalation flows, and player-profile integration.

- [`TicTacToe.sol`](../contracts/TicTacToe.sol)
- [`ConnectFour.sol`](../contracts/ConnectFour.sol)
- [`Chess.sol`](../contracts/Chess.sol)

### ETour Modules

Once a game inherits `ETourGame`, it gains access to ETour's shared tournament machinery through modules.

These are not user-facing game contracts. They are shared infrastructure contracts that hold reusable logic for tournament lifecycle management. The tournament clone executes them through `delegatecall`, which means they run against the clone's storage directly.

This is how a custom game gets protocol features without copying protocol code.

- [`ETourInstance_Core.sol`](../contracts/modules/ETourInstance_Core.sol): enrollment and tournament start logic.
- [`ETourInstance_Matches.sol`](../contracts/modules/ETourInstance_Matches.sol): round initialization and match completion entry logic.
- [`ETourInstance_MatchesResolution.sol`](../contracts/modules/ETourInstance_MatchesResolution.sol): heavy bracket advancement and round resolution logic.
- [`ETourInstance_Prizes.sol`](../contracts/modules/ETourInstance_Prizes.sol): prize distribution and redistribution.
- [`ETourInstance_Escalation.sol`](../contracts/modules/ETourInstance_Escalation.sol): timeout-based escalation logic.

In other words, when you write `contract YourGame is ETourGame`, you are not just inheriting a base class. You are plugging your game into this shared module-backed tournament system.

### Instance Layer

The instance layer is the executable contract stack that sits underneath `YourGame`.

These contracts define the logic that each tournament clone runs. One implementation contract is deployed per game, and many cheap clones point to it. The clone stores the actual tournament data, while the implementation provides the code.

The inheritance chain is:

- [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol): canonical storage layout and shared lifecycle invariants.
- [`ETourInstance.sol`](../contracts/ETourInstance.sol): instance-level entrypoints that bridge into modules.
- [`ETourGame.sol`](../contracts/ETourGame.sol): shared game template that concrete games extend.

This is the core contract stack behind `contract YourGame is ETourGame`.

### Factory Layer

The factory layer is the deployment and orchestration layer for a game family.

After the game contract exists, the factory is what turns it into many tournament instances.

A factory contract does not hold match state for individual tournaments. Instead, it:

- creates new tournament clones,
- validates creation parameters,
- tracks active and past tournaments,
- stores tier metadata,
- connects tournaments to the shared player-profile system.

- [`ETourFactory.sol`](../contracts/ETourFactory.sol): common factory behavior for all ETour games.
- [`TicTacToeFactory.sol`](../contracts/TicTacToeFactory.sol): Tic-Tac-Toe factory.
- [`ConnectFourFactory.sol`](../contracts/ConnectFourFactory.sol): Connect Four factory.
- [`ChessFactory.sol`](../contracts/ChessFactory.sol): Chess factory with post-init chess rules wiring.

### Supporting Contracts

Supporting contracts are adjacent services the core tournament system depends on.

They are not the core tournament execution path, but they provide important protocol capabilities such as player profiles and chess-specific rule validation.

- [`PlayerRegistry.sol`](../contracts/PlayerRegistry.sol)
- [`PlayerProfile.sol`](../contracts/PlayerProfile.sol)
- [`ChessRulesModule.sol`](../contracts/modules/ChessRulesModule.sol)

## Deployment Model

### Factory -> Implementation -> Clone

Each game type has:

- one factory,
- one implementation contract,
- many tournament clones.

The factory stores:

- the implementation address,
- the shared module addresses,
- the player registry address,
- tier metadata and instance tracking.

The implementation contract is deployed once. Every new tournament is a minimal proxy clone pointing at that implementation.

The clone then stores its own:

- tier config,
- tournament status,
- enrolled players,
- rounds,
- matches,
- timeout/escalation state,
- prize results,
- profile-related permanent record data.

This is why the clone is the permanent tournament record, while the implementation is only executable code.

### Why Modules Use `delegatecall`

The module layer exists for two reasons:

1. to reuse infrastructure logic across games,
2. to keep game implementations smaller and easier to reason about.

The modules are stateless in the practical sense. They rely on `ETourTournamentBase`'s storage layout and run inside the clone context through `delegatecall`.

That means:

- `address(this)` inside a module call is the instance clone,
- module code reads and writes clone storage directly,
- all storage layout compatibility rules are anchored in [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol).

The base contract explicitly warns about this:

```solidity
 * STORAGE LAYOUT NOTE:
 * Modules execute via delegatecall and access this storage directly.
 * The storage layout here must match what the adapted modules expect.
 * NEVER reorder or insert variables between existing ones.
```

This is the single most important architectural constraint in ETour.

## Factory Architecture

The base factory is [`ETourFactory.sol`](../contracts/ETourFactory.sol).

Its responsibilities are:

- validating game creation parameters,
- lazily registering tier configurations,
- deploying EIP-1167 clones,
- initializing clones with module addresses,
- tracking active and past tournaments,
- mirroring game-specific player profiles,
- receiving deferred owner share on conclusion.

### Tiering

ETour uses demand-driven tiers rather than pre-registered tiers.

A tier is effectively:

- `playerCount`
- `entryFee`
- timeout configuration

The tier key is computed and cached when first used. The factory then groups instance addresses by tier.

### Instance Creation Flow

The critical creation path in [`ETourFactory.sol`](../contracts/ETourFactory.sol) is:

```solidity
instance = _clone(implementation);

_initializeInstance(instance, instanceTierConfig, msg.sender);
_postInitializeInstance(instance, instanceTierConfig, msg.sender);

_trackNewInstance(instance, tierKey);

emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);

ETourTournamentBase(instance).enrollOnBehalf{value: entryFee}(msg.sender);
```

This sequence is important:

1. clone the implementation,
2. initialize clone state and module addresses,
3. run game-specific post-init hook if needed,
4. track the new tournament in the factory,
5. auto-enroll the creator.

### Why `_postInitializeInstance(...)` Exists

The post-init hook was added so games can inject custom setup without rewriting `createInstance()`.

Chess is the reference case:

- [`ChessFactory.sol`](../contracts/ChessFactory.sol) overrides `_postInitializeInstance(...)`
- [`Chess.sol`](../contracts/Chess.sol) exposes `setChessRules(...)`

That avoids copy-pasting the full factory deployment flow just to wire one extra module.

## Instance Storage Model

The canonical storage layout lives in [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol).

### Key Rule

If a module touches storage, it is really touching this contract's layout.

### Core State Domains

The storage is organized around these domains:

- instance identity: `factory`, `creator`, module addresses
- immutable tier configuration: `tierConfig`
- tournament state: `tournament`
- player enrollment: `enrolledPlayers`, `isEnrolled`
- round state: `rounds`
- match state: `matches`, `matchTimeouts`
- prizes and payout metadata: `playerPrizes`, `playerPayoutReasons`
- draw tracking: `drawParticipants`
- entropy accumulator: `_entropyState`, `_entropyNonce`

### Important Structs

#### `TierConfig`

```solidity
struct TierConfig {
    uint8 playerCount;
    uint256 entryFee;
    TimeoutConfig timeouts;
    uint8 totalRounds;
    bytes32 tierKey;
}
```

This is immutable for a clone after `initialize(...)`.

#### `TournamentState`

This is the tournament's top-level lifecycle record. It tracks:

- status,
- round position,
- fee buckets,
- timing,
- winner,
- draw/escalation resolution flags,
- completion metadata,
- payout metadata.

#### `Round`

```solidity
struct Round {
    uint8 totalMatches;
    uint8 completedMatches;
    bool initialized;
    uint8 drawCount;
    uint8 playerCount;
}
```

This is the bracket layer's compact summary for each round.

#### `Match`

```solidity
struct Match {
    address player1;
    address player2;
    address winner;
    address currentTurn;
    address firstPlayer;
    MatchStatus status;
    bool isDraw;
    uint256 packedBoard;
    uint256 packedState;
    uint256 startTime;
    uint256 lastMoveTime;
    uint256 player1TimeRemaining;
    uint256 player2TimeRemaining;
    string moves;
    MatchCompletionReason completionReason;
    MatchCompletionCategory completionCategory;
}
```

This is intentionally mixed:

- some fields are infra-owned,
- some are game-owned.

Infra-owned fields:

- players,
- current turn,
- winner,
- status,
- timing,
- completion metadata.

Game-owned fields:

- `packedBoard`
- `packedState`
- `moves`

ETour explicitly treats those game-owned fields as opaque. Infra should rely on `_getGameStateHash(matchId)` when it needs a generic state fingerprint.

## Execution Boundaries

There are three important execution styles in ETour.

At a glance, the execution boundary looks like this:

```text
EOA / frontend
       ↓ direct call
┌──────────────────────────────────┐
│ Tournament Clone / Instance      │  ← indexers read state here
│ - tournament / round / match data│
├──────────────────────────────────┤
│ ETour Modules                    │  ← shared logic via delegatecall
├──────────────────────────────────┤
│ Game Implementation              │  ← your rules + makeMove(...)
└──────────────────────────────────┘
```

The important correction is that ETour does **not** deploy one contract per match. Match data lives inside the tournament clone's storage.

### 1. Direct Calls Into the Clone

Example:

- `enrollInTournament()`
- `makeMove(...)`
- `claimTimeoutWin(...)`

These are the user-facing entrypoints.

### 2. Clone -> Module `delegatecall`

Example:

```solidity
(bool success, ) = MODULE_CORE.delegatecall(
    abi.encodeWithSignature("coreEnroll()")
);
```

Used when the clone wants shared infrastructure behavior while preserving clone storage context.

### 3. Module -> Clone Self-Calls

Some module operations need to call back into clone-owned hooks such as game-specific match creation/reset/start.

Those functions remain public, but are protected with `onlySelfCall`.

Example bridge functions:

- `moduleCreateMatch(...)`
- `moduleResetMatch(...)`
- `moduleInitializeMatchForPlay(...)`
- `moduleSetMatchPlayer(...)`
- `moduleGetMatchResult(...)`

Why this shape exists:

- modules need an externally callable ABI surface,
- but EOAs should not be able to call those helpers directly,
- `msg.sender == address(this)` is the gate that separates module orchestration from external usage.

This is why the real game extension surface is not those public `module*` functions. It is the internal hook surface in [`ETourGame.sol`](../contracts/ETourGame.sol).

## Tournament Lifecycle

The full lifecycle is easiest to reason about as a single flow:

```text
Clone created → Players enroll → Tournament starts → Matches initialized
→ Moves submitted → Timeout / escalation if needed → Winners advance
→ Tournament concludes → Payouts + profile updates
```

### 1. Initialization

The factory calls:

```solidity
ETourTournamentBase(instance).initialize(
    config,
    address(this),
    creator_,
    MODULE_CORE,
    MODULE_MATCHES,
    MODULE_PRIZES,
    MODULE_ESCALATION
);
```

The clone stores:

- parent factory,
- creator,
- module addresses,
- immutable tier config,
- initial `TournamentStatus.Enrolling`.

### 2. Enrollment

Public enrollment flows live in [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol):

- `enrollInTournament()`
- `enrollOnBehalf(address player)`

Each flow:

1. performs best-effort player registration on the factory,
2. delegatecalls into `MODULE_CORE`,
3. mixes enrollment entropy,
4. auto-starts round 0 if the tournament becomes full.

### 3. Tournament Start

The core module computes `actualTotalRounds` from the actual enrolled count, not just the nominal tier maximum.

This is why ETour can support:

- full power-of-two brackets,
- odd participant flows after force-start,
- walkovers and odd-round progression.

### 4. Match Play

Concrete game contracts implement `makeMove(...)`.

The shared pattern is:

1. load match,
2. validate status and turn ownership,
3. consume Fischer clock,
4. mutate game state,
5. record move transcript,
6. clear escalation state,
7. either conclude the match or switch turns.

### 5. Match Completion

All game contracts eventually flow through `_completeMatchInternal(...)`.

That function:

- marks the match completed,
- clears timeout/escalation state,
- mixes match-result entropy,
- delegatecalls into the matches module,
- records player match outcomes,
- emits `MatchCompleted`,
- checks for tournament conclusion.

### 6. Tournament Conclusion

Conclusion is centralized in `_handleTournamentConclusion()`.

The settlement sequence is:

1. distribute winner/draw prizes through `MODULE_PRIZES`,
2. emit `TournamentConcluded`,
3. push result data into player profiles,
4. send deferred owner share to the factory.

This ordering is deliberate.

Profile updates happen before the owner-share callback so ordinary user actions still estimate enough gas to complete permanent-record writes.

## Module Responsibilities

### `ETourInstance_Core`

[`ETourInstance_Core.sol`](../contracts/modules/ETourInstance_Core.sol) handles:

- `coreEnroll()`
- `coreEnrollOnBehalf(address)`
- `coreCancelTournament()`
- `coreResetEnrollmentWindow()`
- `coreForceStart()`
- `coreClaimAbandonedPool()`

Its concerns are:

- enrollment validation,
- fee-bucket accounting,
- enrollment escalation windows,
- transition from `Enrolling` to `InProgress` or `Concluded`.

It does not create matches directly. It only determines when the tournament is ready for round initialization.

### `ETourInstance_Matches`

[`ETourInstance_Matches.sol`](../contracts/modules/ETourInstance_Matches.sol) is intentionally thin.

It handles:

- round initialization,
- first-round pairing,
- first-round walkover handling,
- match-completion counting,
- delegation into the heavy resolution module.

The key reason it is thin is contract-size pressure. ETour requires every deployable module to remain under 24 KB.

### `ETourInstance_MatchesResolution`

[`ETourInstance_MatchesResolution.sol`](../contracts/modules/ETourInstance_MatchesResolution.sol) now owns the heavier bracket logic:

- advancing winners to the next round,
- initializing next rounds on demand,
- consolidating scattered players,
- detecting finals and uncontested finals,
- handling all-draw rounds,
- processing orphaned winners,
- completing tournaments when only one player remains.

This split exists because the original single matches module exceeded the EVM size limit.

Architecturally, that split is a good fit:

- `ETourInstance_Matches` is now the bracket entrypoint,
- `ETourInstance_MatchesResolution` is the bracket resolver.

### `ETourInstance_Escalation`

[`ETourInstance_Escalation.sol`](../contracts/modules/ETourInstance_Escalation.sol) handles timeout-driven fallback resolution.

It covers:

- marking matches stalled,
- ML2 advanced-player force elimination,
- ML3 external-player replacement,
- escalation completion metadata,
- some escalation-specific round-completion logic.

This module is where ETour enforces the idea that tournaments should keep progressing even when a match stalls.

### `ETourInstance_Prizes`

[`ETourInstance_Prizes.sol`](../contracts/modules/ETourInstance_Prizes.sol) handles:

- winner-takes-all distribution,
- equal split distribution for draw resolutions,
- failed payout redistribution across remaining enrolled players,
- persistent payout reason tracking.

The important design choice here is that failed winner payments do not bounce to the factory. They are redistributed inside the tournament context, preserving tournament-local accounting.

## Match Architecture

### Match Identity

Every match ID is:

```solidity
keccak256(abi.encodePacked(roundNumber, matchNumber))
```

There is no tier ID and no instance ID in the key because the clone itself is the tournament namespace.

### Shared Match Lifecycle

The shared game template in [`ETourGame.sol`](../contracts/ETourGame.sol) provides:

- `moduleCreateMatch(...)`
- `moduleResetMatch(...)`
- `moduleInitializeMatchForPlay(...)`
- `_startFreshMatch(...)`
- `_assignPlayersForMatch(...)`
- `_consumeTurnClock(...)`
- `_clearMatchEscalation(...)`
- `_switchTurn(...)`

This removed a large amount of duplication from the concrete games.

### Player Assignment Modes

`ETourGame` supports two assignment modes:

```solidity
enum PlayerAssignmentMode {
    RandomizeStarterOnly,
    RandomizePlayerOrder
}
```

Used today as follows:

- Tic-Tac-Toe: randomize starter only
- Connect Four: randomize full player order
- Chess: randomize full player order

This is a good example of ETour's extension philosophy: common behavior is shared, but the game chooses the policy.

## Entropy and Randomness

ETour uses a lightweight internal entropy accumulator rather than pretending to provide strong adversarial randomness.

The accumulator mixes:

- prior entropy state,
- domain-separated salts,
- nonce,
- instance address,
- creator,
- `block.prevrandao`,
- previous block hash,
- current tournament state.

Example:

```solidity
mixed = keccak256(abi.encodePacked(
    _entropyState,
    domain,
    salt,
    _entropyNonce,
    address(this),
    creator,
    block.prevrandao,
    _previousBlockHash(),
    tournament.status,
    tournament.currentRound,
    tournament.enrolledCount,
    tournament.totalEntryFeesAccrued
));
```

This entropy is used for:

- random starters,
- randomized seat order,
- walkover selection,
- match-result entropy mixing.

It is suitable for lightweight protocol decisions inside this design, but it should not be described as cryptographically secure randomness.

## Time Control and Escalations

### Fischer Clock

Shared turn-clock handling is in `ETourGame._consumeTurnClock(...)`.

It subtracts elapsed time from the current player and adds the configured increment:

```solidity
if (m.currentTurn == m.player1) {
    m.player1TimeRemaining = (m.player1TimeRemaining > elapsed)
        ? m.player1TimeRemaining - elapsed + increment
        : increment;
}
```

This keeps the timing model uniform across all games.

### Timeout Claim

Normal timeout resolution begins in [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol) through `claimTimeoutWin(...)`.

That path:

1. confirms the caller is the waiting player,
2. confirms the active player exceeded their remaining time,
3. delegatecalls into `MODULE_ESCALATION` to mark the match stalled,
4. immediately completes the match as `Timeout`.

### ML2 and ML3

If a timeout situation lingers, the escalation module exposes:

- `forceEliminateStalledMatch(...)`
- `claimMatchSlotByReplacement(...)`

These provide tournament liveness beyond ordinary timeout claims:

- ML2 lets an advanced player force-eliminate a stalled earlier match.
- ML3 lets an outside player replace both stalled players.

## Fee Model and Settlement

ETour uses deferred fee accounting.

For every enrollment:

- 95% accrues to `tournament.prizePool`
- 5% accrues to `tournament.ownerAccrued`

Nothing is forwarded to the factory immediately.

This matters because:

- EL0 and EL2 need full or special-case recovery behavior,
- instance-local accounting stays coherent until conclusion,
- conclusion can distribute based on the final tournament outcome.

### Conclusion Settlement

At conclusion, `_handleTournamentConclusion()`:

1. resolves prize distribution locally,
2. records permanent profile results,
3. sends owner share to `factory.receiveOwnerShare()`.

The factory then:

- forwards owner ETH immediately if possible,
- otherwise records fallback `ownerBalance`,
- moves the instance from `activeTournaments` to `pastTournaments`.

## Player Profiles

ETour integrates profiles through the factory and registry rather than hard-coding profile behavior into each game.

### Enrollment-Time Registration

When a player enrolls, the instance first calls:

```solidity
factory.call(
    abi.encodeWithSignature("registerPlayer(address,uint256)", player, tierConfig.entryFee)
);
```

The factory then forwards that to `PlayerRegistry.recordEnrollment(...)` on a best-effort basis.

There is one important extension to that rule:

- normal enrollees are registered through the factory with their real `entryFee`,
- EL2 abandoned-pool claimants are explicitly registered with `entryFee = 0` before conclusion,
- ML3 replacement players are match-level replacements, so they can receive profile match records without automatically receiving a tournament enrollment record.

### Conclusion-Time Result Push

At tournament conclusion, the instance pushes final result data through `_recordPlayerProfileResult(...)`.

This includes:

- won/lost,
- prize basis,
- actual payout,
- payout reason,
- tournament completion reason.

That means:

- enrolled players get both match-level and tournament-level profile data,
- EL2 claimants also get a tournament-level profile record because the contract explicitly registers them before conclusion,
- ML3 replacement outsiders can still get match records through `recordMatchOutcome(...)`, but if they were never enrolled into the tournament profile path, they do not get a normal enrollment/result record for that instance.

The profile system is therefore a permanent-record sink, not the source of truth for tournament state.

The clone remains the source of truth.

## Concrete Game Implementations

### Tic-Tac-Toe

[`TicTacToe.sol`](../contracts/TicTacToe.sol) is the simplest reference game.

Its game-specific responsibilities are:

- 2-bit packed board manipulation,
- win-line checks,
- draw detection,
- move transcript as comma-separated cell indices.

Its hook surface is minimal:

```solidity
function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
    return PlayerAssignmentMode.RandomizeStarterOnly;
}

function _initializeGameState(bytes32 matchId, bool) internal override {
    matches[matchId].packedBoard = 0;
}
```

This is the clearest example of the intended ETour game-author experience.

### Chess

[`Chess.sol`](../contracts/Chess.sol) is the most advanced reference game.

It demonstrates:

- packed board + packed state separation,
- external rules-module validation,
- auxiliary per-match mappings,
- replay-safe custom state invalidation,
- custom `_getGameStateHash(...)`.

The important lesson from chess is that the `Match` struct does not need to carry every possible game-state shape. Additional mappings keyed by `matchId` are a first-class pattern in ETour.

## Why the `Match` Struct Is Intentionally Flexible

ETour deliberately stops short of forcing every game into the same exact board/state model.

The protocol owns:

- lifecycle,
- bracket movement,
- timing,
- escalations,
- settlement.

The game owns:

- how game state is represented,
- how moves are validated,
- how much extra storage is required,
- what constitutes a draw or win.

The generic state contract is:

- `packedBoard`, `packedState`, and `moves` are convenient default fields,
- extra mappings are allowed,
- `_getGameStateHash(matchId)` is the abstraction layer infra uses when it needs an opaque state fingerprint.

That is why chess can maintain `_positionCounts` and `_gameNonce` without forcing those concepts into every other game.

## Building Games on ETour

This guide walks you through the A-Z of deploying a game with ETour integration

## What You Need

At the authoring level, building on ETour is intentionally narrow. You mainly write two contracts:

```solidity
import "./ETourGame.sol";

contract MyGame is ETourGame {
    function _playerAssignmentMode()
        internal
        pure
        override
        returns (PlayerAssignmentMode)
    {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool isReplay)
        internal
        override
    {
        matchId;
        isReplay;
        // initialize game-owned state here
    }

    function makeMove(...) external nonReentrant notConcluded {
        // derive matchId
        // validate active match + caller turn
        // validate game-specific move
        // _consumeTurnClock(m)
        // mutate game state
        // _clearMatchEscalation(matchId)
        // _completeMatchInternal(...) or _switchTurn(m)
    }
}
```

and:

```solidity
import "./ETourFactory.sol";
import "./MyGame.sol";

contract MyGameFactory is ETourFactory {
    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry
    ) ETourFactory(
        address(new MyGame()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 0;
    }
}
```

For `MyGame is ETourGame`, the required implementation surface is:

- `_playerAssignmentMode()`
- `_initializeGameState(bytes32 matchId, bool isReplay)`
- your public `makeMove(...)`

Optional hooks are:

- `_resetGameState(bytes32 matchId)` if you store extra mappings keyed by `matchId`
- `_getGameStateHash(bytes32 matchId)` if your live state is not fully captured by `packedBoard`, `packedState`, and `moves`

The core move-flow pattern is always the same:

1. derive `matchId`
2. fetch `Match storage m = matches[matchId]`
3. require `m.status == MatchStatus.InProgress`
4. require the caller is a participant
5. require the caller owns `m.currentTurn`
6. validate your game-specific move inputs
7. call `_consumeTurnClock(m)`
8. mutate game-owned state
9. record move transcript if useful
10. call `_clearMatchEscalation(matchId)`
11. call `_completeMatchInternal(...)` if terminal, otherwise `_switchTurn(m)`

That is all you are supposed to own. ETour continues to own:

- clone deployment
- enrollment
- bracket progression
- time banking
- escalations
- payouts
- permanent tournament record storage

## Dependencies

### Requirements

These are the **must-have** Solidity dependencies.

If `MyGame is ETourGame`, then your project must include:

- [`ETourGame.sol`](../contracts/ETourGame.sol)
- [`ETourInstance.sol`](../contracts/ETourInstance.sol)
- [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol)

If `MyGameFactory is ETourFactory`, then your project must include:

- [`ETourFactory.sol`](../contracts/ETourFactory.sol)

If you want profile-aware enrollment and results, which the ETour factory path expects, then your project must also include:

- [`PlayerRegistry.sol`](../contracts/PlayerRegistry.sol)
- [`PlayerProfile.sol`](../contracts/PlayerProfile.sol)

And because the ETour instance/factory architecture delegates lifecycle logic into shared modules, your project also needs the ETour module contracts:

- [`ETourInstance_Core.sol`](../contracts/modules/ETourInstance_Core.sol)
- [`ETourInstance_Matches.sol`](../contracts/modules/ETourInstance_Matches.sol)
- [`ETourInstance_MatchesResolution.sol`](../contracts/modules/ETourInstance_MatchesResolution.sol)
- [`ETourInstance_Prizes.sol`](../contracts/modules/ETourInstance_Prizes.sol)
- [`ETourInstance_Escalation.sol`](../contracts/modules/ETourInstance_Escalation.sol)

Those contracts are not optional. They are the actual protocol inheritance and execution surface.

### Helpers

These are **not** part of the ETour protocol itself. They are just a practical way to compile, deploy, test, and integrate.

Typical examples are:

- `package.json`
- `hardhat.config.js`
- `.env`
- deployment scripts
- ABI sync scripts
- tests
- deployment manifests

You do **not** need to use the exact same helper scripts or config files as this repo. You can replace those with your own preferred tooling. Hardhat is just the practical reference path used here.

The distinction is important:

- the protocol contracts are mandatory
- the surrounding JS/config/devops layer is replaceable

## Project Structure

### Minimal

Conceptually, the smallest contract-only project is:

```text
contracts/
├── ETourGame.sol
├── ETourFactory.sol
├── PlayerRegistry.sol
├── PlayerProfile.sol
├── MyGame.sol
└── MyGameFactory.sol
```

That is the smallest **conceptual** tree, because those are the top-level contracts you directly think about.

In practice, if you are copying files manually, the ETour inheritance/import chain means you also need:

- `ETourInstance.sol`
- `ETourTournamentBase.sol`
- `contracts/modules/*`
- any referenced interfaces

So the minimal compileable tree is larger than the six filenames above. The six-contract view is useful for understanding responsibility, not for pretending the transitive imports do not exist.

### Practical

A realistic project usually looks more like this:

```text
my-etour-game/
├── .env
├── package.json
├── package-lock.json
├── hardhat.config.js
├── contracts/
│   ├── ETourFactory.sol
│   ├── ETourGame.sol
│   ├── ETourInstance.sol
│   ├── ETourTournamentBase.sol
│   ├── PlayerRegistry.sol
│   ├── PlayerProfile.sol
│   ├── MyGame.sol
│   ├── MyGameFactory.sol
│   ├── interfaces/
│   ├── modules/
│   └── test-helpers/
├── deployments/
├── scripts/
└── test/
```

That practical tree is what most teams will actually want:

- Node-based dependency management
- Hardhat config
- deployment scripts
- deployment outputs
- tests
- helper contracts

## Example: Checkers

The checkers reference below is the concrete end-to-end example of the ETour pattern.

### Dependencies

If you want a practical local setup from a fresh machine, the easiest path is to start from this repo or a future starter kit.

Placeholder starter download slot:

- [ETour V2 Checkers Starter Kit (placeholder)](https://example.com/etour-v2-checkers-starter.zip)

If you are setting up manually, the sequence is:

1. Create a local repo and project folder:

```bash
mkdir my-etour-checkers
cd my-etour-checkers
```

2. Create a root `package.json`.

Minimal example:

```json
{
  "name": "my-etour-checkers",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "compile": "hardhat compile --config hardhat.config.js",
    "test": "hardhat test --config hardhat.config.js",
    "deploy:modules": "hardhat run scripts/deploy-instance-modules.js --config hardhat.config.js --network localhost",
    "deploy:checkers": "hardhat run scripts/deploy-checkers-factory.js --config hardhat.config.js --network localhost"
  }
}
```

Why this file is needed:

- it defines your Node project
- it gives you reproducible dependency installs
- it gives you stable script entrypoints for compile, test, and deploy

This file should live at project root:

```text
my-etour-checkers/
└── package.json
```

3. Install the packages:

```bash
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
npm install @openzeppelin/contracts dotenv
```

4. Create your Hardhat config at `hardhat.config.js`.

Minimal example:

```js
import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

export default {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {
      chainId: 412346,
      accounts: {
        count: 250,
        accountsBalance: "10000000000000000000000"
      },
      allowUnlimitedContractSize: true,
      blockGasLimit: 300000000
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 412346
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161
    }
  },
  etherscan: {
    apiKey: process.env.ARBISCAN_API_KEY || ""
  }
};
```

Why this file is needed:

- it tells Hardhat where contracts, tests, and artifacts live
- it defines the Solidity compiler settings ETour V2 expects
- it defines local and Arbitrum deployment targets

This file should live here:

```text
my-etour-checkers/
└── hardhat.config.js
```

5. Create a root `.env` file:

```bash
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
PRIVATE_KEY=0x...
ARBISCAN_API_KEY=...
```

This file belongs at project root:

```text
my-etour-checkers/
├── .env
└── hardhat.config.js
```

6. Add the required ETour contract dependencies into `contracts/`.

At minimum, copy in:

- [`ETourGame.sol`](../contracts/ETourGame.sol)
- [`ETourFactory.sol`](../contracts/ETourFactory.sol)
- [`ETourInstance.sol`](../contracts/ETourInstance.sol)
- [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol)
- [`PlayerRegistry.sol`](../contracts/PlayerRegistry.sol)
- [`PlayerProfile.sol`](../contracts/PlayerProfile.sol)
- [`contracts/interfaces`](../contracts/interfaces)
- [`contracts/modules`](../contracts/modules)

Those are the required contract dependencies. The rest of the checkers example will sit on top of them.

### Checkers.sol

The checked-in source file remains the source of truth:

- [`Checkers.sol`](../contracts/Checkers.sol)

Full example:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

/**
 * @title Checkers
 * @dev Reference American-checkers implementation for the ETour V2 game surface.
 *
 * Board model:
 * - 32 playable dark squares only (4 bits per square in packedBoard)
 * - 0 = empty
 * - 1 = player1 man
 * - 2 = player1 king
 * - 3 = player2 man
 * - 4 = player2 king
 *
 * packedState model:
 * - bit 0: capture continuation active
 * - bits 1-5: source square that must continue capturing
 *
 * Design notes:
 * - The contract stores only the 32 playable dark squares, not all 64 board
 *   coordinates. That keeps the board compact while still giving deterministic
 *   square indices for frontends and offchain tooling.
 * - ETour owns tournament lifecycle, brackets, clocks, escalations, and prize
 *   settlement. This contract owns only rules, board state, and move flow.
 * - Multi-jump continuation is encoded in packedState so the whole live game
 *   state remains inside the base Match struct.
 */
contract Checkers is ETourGame {

    error InvalidSquare();
    error MatchNotActive();
    error NotParticipant();
    error NotYourTurn();
    error NoPieceOwned();
    error DestinationOccupied();
    error MandatoryCaptureAvailable();
    error CaptureContinuationRequired();
    error InvalidMove();

    uint8 private constant BOARD_SQUARES = 32;

    uint8 private constant EMPTY = 0;
    uint8 private constant PLAYER1_MAN = 1;
    uint8 private constant PLAYER1_KING = 2;
    uint8 private constant PLAYER2_MAN = 3;
    uint8 private constant PLAYER2_KING = 4;

    uint256 private constant PENDING_CAPTURE_FLAG = 1;
    uint256 private constant PENDING_CAPTURE_SOURCE_SHIFT = 1;

    event MoveMade(
        bytes32 indexed matchId,
        address indexed player,
        uint8 from,
        uint8 to,
        bool capture,
        bool crowned
    );

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool) internal override {
        Match storage m = matches[matchId];
        // Fresh matches always begin from the canonical opening position and
        // with no forced-capture continuation pending.
        m.packedBoard = _initialBoard();
        m.packedState = 0;
    }

    function makeMove(
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 from,
        uint8 to
    ) external nonReentrant notConcluded {
        if (from >= BOARD_SQUARES || to >= BOARD_SQUARES || from == to) revert InvalidSquare();

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        if (m.status != MatchStatus.InProgress) revert MatchNotActive();
        if (msg.sender != m.player1 && msg.sender != m.player2) revert NotParticipant();
        if (msg.sender != m.currentTurn) revert NotYourTurn();

        bool isPlayer1 = msg.sender == m.player1;
        uint256 board = m.packedBoard;
        uint8 piece = _getSquare(board, from);

        if (!_isOwnPiece(piece, isPlayer1)) revert NoPieceOwned();
        if (_getSquare(board, to) != EMPTY) revert DestinationOccupied();

        bool pendingCapture = _pendingCaptureActive(m.packedState);
        if (pendingCapture && from != _pendingCaptureSource(m.packedState)) {
            revert CaptureContinuationRequired();
        }

        // Convert from the compact 0-31 playable-square index into real board
        // row/column coordinates so diagonal movement math is straightforward.
        (uint8 fromRow, uint8 fromCol) = _indexToCoords(from);
        (uint8 toRow, uint8 toCol) = _indexToCoords(to);

        int8 rowDiff = int8(toRow) - int8(fromRow);
        int8 colDiff = int8(toCol) - int8(fromCol);

        bool isCapture;
        uint8 capturedIndex;

        if (_isSimpleStep(rowDiff, colDiff, piece, isPlayer1)) {
            if (pendingCapture || _playerHasAnyCapture(board, isPlayer1)) {
                revert MandatoryCaptureAvailable();
            }
        } else if (_isCaptureStep(rowDiff, colDiff, piece, isPlayer1)) {
            isCapture = true;
            capturedIndex = _capturedIndex(fromRow, fromCol, toRow, toCol);
            if (!_isOpponentPiece(_getSquare(board, capturedIndex), isPlayer1)) {
                revert InvalidMove();
            }
        } else {
            revert InvalidMove();
        }

        // Once the move is known to be structurally valid we charge the active
        // player's clock before mutating game state.
        _consumeTurnClock(m);

        // Clear the source square first, then optionally remove the captured
        // piece, then place the moved piece at the destination.
        board = _setSquare(board, from, EMPTY);
        if (isCapture) {
            board = _setSquare(board, capturedIndex, EMPTY);
        }

        bool crowned;
        uint8 movedPiece = piece;
        if (!_isKing(piece) && _isPromotionRow(isPlayer1, toRow)) {
            // In American checkers the move ends immediately when a man reaches
            // the back rank and becomes a king, so we track that explicitly.
            movedPiece = isPlayer1 ? PLAYER1_KING : PLAYER2_KING;
            crowned = true;
        }

        board = _setSquare(board, to, movedPiece);

        m.packedBoard = board;
        m.moves = _appendMoveNotation(m.moves, from, to, isCapture, crowned);

        _clearMatchEscalation(matchId);

        emit MoveMade(matchId, msg.sender, from, to, isCapture, crowned);

        // A capture that can legally continue must keep the same player on move.
        // Promotion intentionally stops continuation in this reference version.
        if (isCapture && !crowned && _pieceHasCapture(board, to, movedPiece, isPlayer1)) {
            m.packedState = _encodePendingCapture(to);
            return;
        }

        m.packedState = 0;

        // ETour only needs to know the terminal result. The game contract is
        // responsible for deciding when a side has no remaining pieces or no
        // legal moves left and then routing through _completeMatchInternal(...).
        if (_countPiecesForPlayer(board, !isPlayer1) == 0 || !_playerHasAnyLegalMove(board, !isPlayer1)) {
            _completeMatchInternal(
                roundNumber,
                matchNumber,
                msg.sender,
                false,
                MatchCompletionReason.NormalWin
            );
            return;
        }

        _switchTurn(m);
    }

    function getBoard(uint8 roundNumber, uint8 matchNumber)
        external
        view
        returns (uint8[32] memory board)
    {
        // Expose the compact playable-square representation directly. Frontends
        // can map each 0-31 index to an 8x8 board with the same helper math
        // used inside _indexToCoords(...).
        uint256 packed = matches[_getMatchId(roundNumber, matchNumber)].packedBoard;
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            board[i] = _getSquare(packed, i);
        }
    }

    function getPendingCapture(uint8 roundNumber, uint8 matchNumber)
        external
        view
        returns (bool active, uint8 source)
    {
        uint256 state = matches[_getMatchId(roundNumber, matchNumber)].packedState;
        active = _pendingCaptureActive(state);
        source = active ? _pendingCaptureSource(state) : 0;
    }

    function _initialBoard() private pure returns (uint256 board) {
        // Playable-square indexing runs top-to-bottom, left-to-right over only
        // the dark squares. Indices 0-11 are player2's opening men and 20-31
        // are player1's opening men.
        for (uint8 i = 0; i < 12; i++) {
            board = _setSquare(board, i, PLAYER2_MAN);
        }
        for (uint8 i = 20; i < BOARD_SQUARES; i++) {
            board = _setSquare(board, i, PLAYER1_MAN);
        }
    }

    function _getSquare(uint256 board, uint8 index) private pure returns (uint8) {
        return uint8((board >> (index * 4)) & 0xF);
    }

    function _setSquare(uint256 board, uint8 index, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(0xF) << (index * 4));
        return (board & mask) | (uint256(value) << (index * 4));
    }

    function _indexToCoords(uint8 index) private pure returns (uint8 row, uint8 col) {
        // Even rows use dark squares in columns 1,3,5,7.
        // Odd rows use dark squares in columns 0,2,4,6.
        row = index / 4;
        col = uint8((index % 4) * 2 + ((row + 1) % 2));
    }

    function _coordsToIndex(uint8 row, uint8 col) private pure returns (uint8) {
        return row * 4 + (col / 2);
    }

    function _validCoords(int8 row, int8 col) private pure returns (bool) {
        return row >= 0 && row < 8 && col >= 0 && col < 8;
    }

    function _isOwnPiece(uint8 piece, bool isPlayer1) private pure returns (bool) {
        if (isPlayer1) {
            return piece == PLAYER1_MAN || piece == PLAYER1_KING;
        }
        return piece == PLAYER2_MAN || piece == PLAYER2_KING;
    }

    function _isOpponentPiece(uint8 piece, bool isPlayer1) private pure returns (bool) {
        if (piece == EMPTY) return false;
        return !_isOwnPiece(piece, isPlayer1);
    }

    function _isKing(uint8 piece) private pure returns (bool) {
        return piece == PLAYER1_KING || piece == PLAYER2_KING;
    }

    function _isPromotionRow(bool isPlayer1, uint8 row) private pure returns (bool) {
        return isPlayer1 ? row == 0 : row == 7;
    }

    function _isSimpleStep(int8 rowDiff, int8 colDiff, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        if (!_isOne(colDiff)) return false;
        if (_isKing(piece)) return rowDiff == -1 || rowDiff == 1;
        return isPlayer1 ? rowDiff == -1 : rowDiff == 1;
    }

    function _isCaptureStep(int8 rowDiff, int8 colDiff, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        if (!_isTwo(colDiff)) return false;
        if (_isKing(piece)) return rowDiff == -2 || rowDiff == 2;
        return isPlayer1 ? rowDiff == -2 : rowDiff == 2;
    }

    function _capturedIndex(
        uint8 fromRow,
        uint8 fromCol,
        uint8 toRow,
        uint8 toCol
    ) private pure returns (uint8) {
        return _coordsToIndex((fromRow + toRow) / 2, (fromCol + toCol) / 2);
    }

    function _playerHasAnyCapture(uint256 board, bool isPlayer1) private pure returns (bool) {
        // Forced capture is a side-wide rule, so we must scan every piece for
        // at least one available jump before allowing any non-capturing move.
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            uint8 piece = _getSquare(board, i);
            if (_isOwnPiece(piece, isPlayer1) && _pieceHasCapture(board, i, piece, isPlayer1)) {
                return true;
            }
        }
        return false;
    }

    function _playerHasAnyLegalMove(uint256 board, bool isPlayer1) private pure returns (bool) {
        // Used for terminal detection after a move resolves. If the opponent
        // has pieces but no legal move, the current player wins immediately.
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            uint8 piece = _getSquare(board, i);
            if (!_isOwnPiece(piece, isPlayer1)) continue;

            if (_pieceHasCapture(board, i, piece, isPlayer1)) return true;
            if (_pieceHasSimpleMove(board, i, piece, isPlayer1)) return true;
        }
        return false;
    }

    function _pieceHasCapture(uint256 board, uint8 from, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        (uint8 row, uint8 col) = _indexToCoords(from);

        if (_isKing(piece) || isPlayer1) {
            if (_hasCaptureInDirection(board, row, col, -1, -1, isPlayer1)) return true;
            if (_hasCaptureInDirection(board, row, col, -1, 1, isPlayer1)) return true;
        }

        if (_isKing(piece) || !isPlayer1) {
            if (_hasCaptureInDirection(board, row, col, 1, -1, isPlayer1)) return true;
            if (_hasCaptureInDirection(board, row, col, 1, 1, isPlayer1)) return true;
        }

        return false;
    }

    function _pieceHasSimpleMove(uint256 board, uint8 from, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        (uint8 row, uint8 col) = _indexToCoords(from);

        if (_isKing(piece) || isPlayer1) {
            if (_hasSimpleMoveInDirection(board, row, col, -1, -1)) return true;
            if (_hasSimpleMoveInDirection(board, row, col, -1, 1)) return true;
        }

        if (_isKing(piece) || !isPlayer1) {
            if (_hasSimpleMoveInDirection(board, row, col, 1, -1)) return true;
            if (_hasSimpleMoveInDirection(board, row, col, 1, 1)) return true;
        }

        return false;
    }

    function _hasCaptureInDirection(
        uint256 board,
        uint8 row,
        uint8 col,
        int8 rowStep,
        int8 colStep,
        bool isPlayer1
    ) private pure returns (bool) {
        // Check the adjacent diagonal square for an opponent piece and the
        // landing square beyond it for emptiness.
        int8 middleRow = int8(row) + rowStep;
        int8 middleCol = int8(col) + colStep;
        int8 landingRow = int8(row) + (rowStep * 2);
        int8 landingCol = int8(col) + (colStep * 2);

        if (!_validCoords(middleRow, middleCol) || !_validCoords(landingRow, landingCol)) {
            return false;
        }

        uint8 middleIndex = _coordsToIndex(uint8(middleRow), uint8(middleCol));
        uint8 landingIndex = _coordsToIndex(uint8(landingRow), uint8(landingCol));

        return _isOpponentPiece(_getSquare(board, middleIndex), isPlayer1)
            && _getSquare(board, landingIndex) == EMPTY;
    }

    function _hasSimpleMoveInDirection(
        uint256 board,
        uint8 row,
        uint8 col,
        int8 rowStep,
        int8 colStep
    ) private pure returns (bool) {
        int8 landingRow = int8(row) + rowStep;
        int8 landingCol = int8(col) + colStep;

        if (!_validCoords(landingRow, landingCol)) return false;

        uint8 landingIndex = _coordsToIndex(uint8(landingRow), uint8(landingCol));
        return _getSquare(board, landingIndex) == EMPTY;
    }

    function _countPiecesForPlayer(uint256 board, bool isPlayer1) private pure returns (uint8 count) {
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            if (_isOwnPiece(_getSquare(board, i), isPlayer1)) {
                unchecked {
                    ++count;
                }
            }
        }
    }

    function _pendingCaptureActive(uint256 state) private pure returns (bool) {
        return (state & PENDING_CAPTURE_FLAG) != 0;
    }

    function _pendingCaptureSource(uint256 state) private pure returns (uint8) {
        return uint8((state >> PENDING_CAPTURE_SOURCE_SHIFT) & 0x1F);
    }

    function _encodePendingCapture(uint8 source) private pure returns (uint256) {
        return PENDING_CAPTURE_FLAG | (uint256(source) << PENDING_CAPTURE_SOURCE_SHIFT);
    }

    function _appendMoveNotation(
        string memory existing,
        uint8 from,
        uint8 to,
        bool isCapture,
        bool crowned
    ) private pure returns (string memory) {
        // Transcript format is intentionally human-readable for the docs:
        // "20-16" for a normal move, "16x9" for a capture, and a trailing "K"
        // when the move crowns a king.
        string memory separator = isCapture ? "x" : "-";
        bytes memory moveText = abi.encodePacked(
            _uint8ToString(from),
            separator,
            _uint8ToString(to),
            crowned ? "K" : ""
        );

        if (bytes(existing).length == 0) {
            return string(moveText);
        }

        return string(abi.encodePacked(existing, ",", moveText));
    }

    function _uint8ToString(uint8 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint8 tmp = value;
        uint8 digits = 0;
        while (tmp != 0) {
            unchecked {
                ++digits;
            }
            tmp /= 10;
        }

        bytes memory out = new bytes(digits);
        while (value != 0) {
            unchecked {
                --digits;
            }
            out[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    function _isOne(int8 value) private pure returns (bool) {
        return value == -1 || value == 1;
    }

    function _isTwo(int8 value) private pure returns (bool) {
        return value == -2 || value == 2;
    }
}
```

### CheckersFactory.sol

The checked-in source file remains the source of truth:

- [`CheckersFactory.sol`](../contracts/CheckersFactory.sol)

Full example:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./Checkers.sol";

/**
 * @title CheckersFactory
 * @dev Reference ETour factory for the Checkers game implementation.
 */
contract CheckersFactory is ETourFactory {

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry
    ) ETourFactory(
        address(new Checkers()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 3;
    }
}
```

### Project Structure

After adding the game-specific contracts, a practical checkers project should look roughly like this:

```text
my-etour-checkers/
├── .env
├── package.json
├── hardhat.config.js
├── contracts/
│   ├── ETourFactory.sol
│   ├── ETourGame.sol
│   ├── ETourInstance.sol
│   ├── ETourTournamentBase.sol
│   ├── PlayerRegistry.sol
│   ├── PlayerProfile.sol
│   ├── Checkers.sol
│   ├── CheckersFactory.sol
│   ├── interfaces/
│   ├── modules/
│   └── test-helpers/
├── deployments/
├── scripts/
│   ├── deploy-instance-modules.js
│   └── deploy-checkers-factory.js
└── test/
    └── factory/
        └── Checkers.reference.test.js
```

### Deployment

At this point deployment is straightforward:

- deploy or resolve the shared ETour modules
- deploy `PlayerProfile`
- deploy `PlayerRegistry`
- deploy `CheckersFactory`
- read the `Checkers` implementation address from the factory
- save deployment metadata and ABI output for your UI and scripts

The reference utility script is:

- [`deploy-checkers-factory.js`](../scripts/deploy-checkers-factory.js)

That script now does two things in one run:

1. deploys the checkers reference stack
2. generates a combined ABI bundle in `deployments/CheckersFactory-ABI.json`

#### Local

1. Start a local chain:

```bash
npx hardhat node --config hardhat.config.js
```

2. In a second terminal, deploy the shared ETour modules:

```bash
npx hardhat run scripts/deploy-instance-modules.js --config hardhat.config.js --network localhost
```

3. Deploy the checkers stack:

```bash
npx hardhat run scripts/deploy-checkers-factory.js --config hardhat.config.js --network localhost
```

Outputs you should expect:

- `deployments/localhost-checkers-factory.json`
- `deployments/CheckersFactory-ABI.json`

#### Arbitrum

For Arbitrum, fund the wallet in `.env` with ETH on Arbitrum One and then run:

```bash
npx hardhat run scripts/deploy-checkers-factory.js --config hardhat.config.js --network arbitrum
```

By default, that script reuses the live ETour module addresses from [`arbitrum-factory.json`](../deployments/arbitrum-factory.json). If you want to override them manually, set:

```bash
MODULE_CORE=0x...
MODULE_MATCHES=0x...
MODULE_PRIZES=0x...
MODULE_ESCALATION=0x...
```

The script writes:

- `deployments/arbitrum-checkers-factory.json`
- `deployments/CheckersFactory-ABI.json`

The ABI bundle contains:

- factory ABI
- implementation ABI
- player registry ABI
- player profile ABI
- module addresses used for deployment

That is usually enough for the frontend to treat the ABI bundle as the source of truth.

### Integration

Once deployment is done and you have the ABI bundle, you are mostly finished with the protocol side.

What comes next is building a UI that:

- reads the factory ABI
- reads the game instance ABI
- creates tournaments through the factory
- reads tournaments and matches from clone instances
- sends `makeMove(...)` calls against the game ABI

At that point, the ABI bundle and deployment manifest should be treated as your source of truth. A UI integration guide is coming separately.

### Testing

The reference test file is:

- [`Checkers.reference.test.js`](../test/factory/Checkers.reference.test.js)

Run it locally with:

```bash
npx hardhat test --config hardhat.config.js test/factory/Checkers.reference.test.js
```

That test currently proves:

- real factory deployment
- real clone creation
- mandatory capture enforcement
- multi-jump continuation
- promotion behavior

A broader testing guide is still to come, but the current reference test is already the right starting point for local validation.

## Live Examples

The live V2 examples on Arbitrum One are:

- [TicTacToeFactory](https://arbiscan.io/address/0x9b370782C5BE175CA3DC57606E32c56b9653A62a)
- [ConnectFourFactory](https://arbiscan.io/address/0x35e7b5eFadcc752a3b55c43BFe430c04Aec31b4d)
- [ChessFactory](https://arbiscan.io/address/0x0C48382605fd65f15518782F5b69E936c4461313)

And the corresponding implementation contracts are:

- [TicTacToe](https://arbiscan.io/address/0x8C7272980dE407CA791b7C718394a6e215d44dd4)
- [ConnectFour](https://arbiscan.io/address/0x567A20A586073d9ADc1832074Ffc0c8b127b464c)
- [Chess](https://arbiscan.io/address/0xe7957e1663f4959689f495a73A45D4dC2cf0bD83)

Architecturally, those are nothing more exotic than:

- `GameA is ETourGame`
- `GameAFactory is ETourFactory`

That is the point. The live deployments prove the pattern is the real pattern, not a documentation abstraction.

## Practical Reading Order

For a new ETour contributor, the best reading order is:

1. [`ETourFactory.sol`](../contracts/ETourFactory.sol)
2. [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol)
3. [`ETourGame.sol`](../contracts/ETourGame.sol)
4. [`ETourInstance_Core.sol`](../contracts/modules/ETourInstance_Core.sol)
5. [`ETourInstance_Matches.sol`](../contracts/modules/ETourInstance_Matches.sol)
6. [`ETourInstance_MatchesResolution.sol`](../contracts/modules/ETourInstance_MatchesResolution.sol)
7. [`ETourInstance_Prizes.sol`](../contracts/modules/ETourInstance_Prizes.sol)
8. [`ETourInstance_Escalation.sol`](../contracts/modules/ETourInstance_Escalation.sol)
9. one simple game such as [`TicTacToe.sol`](../contracts/TicTacToe.sol)
10. one complex game such as [`Chess.sol`](../contracts/Chess.sol)

That sequence mirrors the real architectural dependency chain.
