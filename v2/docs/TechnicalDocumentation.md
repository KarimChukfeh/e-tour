# ETour Protocol
## Understanding ETour's fully on-chain architecture.

This document explains:

- how each ETour V2 module works and what it does,
- how factories, instance implementations, and modules fit together,
- how tournament state is stored and mutated,
- how match progression, escalations, and payouts work,
- why the contracts are split the way they are,
- how to build new games using ETour protocol.

## Core Principles

ETour is optimized around five constraints:

1. Each tournament should be a permanent onchain record.
2. New games should reuse bracket, payout, timeout, and profile infrastructure instead of reimplementing it.
3. Game-specific logic should stay narrow and isolated.
4. Deployable contracts must remain under the EVM contract-size limit.
5. The developer-facing extension surface should be explicit and stable.

The resulting system is a hybrid of:

- EIP-1167 minimal proxies for cheap per-tournament deployments,
- shared delegatecall modules for infra logic reuse,
- thin game-specific implementation contracts for move validation and state updates.

## High-Level Architecture

```mermaid
flowchart TD
    A["Game Factory"] --> B["Game Implementation<br/>EIP-1167 clone target"]
    A --> C["PlayerRegistry"]
    A --> D["ETourInstance_Core"]
    A --> E["ETourInstance_Matches"]
    E --> F["ETourInstance_MatchesResolution"]
    A --> G["ETourInstance_Prizes"]
    A --> H["ETourInstance_Escalation"]

    I["Tournament Clone"] --> A
    I --> D
    I --> E
    I --> G
    I --> H
    I --> C
```

The important design choice is this:

- the clone owns all tournament state,
- the modules own almost no state,
- the modules execute against clone storage through `delegatecall`,
- the game contract supplies only the game-specific hooks and `makeMove(...)`.

## Key Terms

Before going deeper, it helps to define the terms ETour V2 uses repeatedly.

- factory: a contract that creates new tournament instances for one game type and tracks them over time.
- implementation: the deployed logic contract that clone instances point to.
- clone: a minimal proxy for one specific tournament; this is where the tournament's permanent state lives.
- module: a shared infrastructure contract that the clone executes through `delegatecall` so it can reuse logic without copying code.
- game contract: the concrete implementation for a specific game such as Tic-Tac-Toe, Connect Four, or Chess.
- tier: a reusable configuration bucket defined by player count, entry fee, and timeout settings.
- instance: in V2, this usually means the tournament clone itself, not the implementation contract.

## Main Contracts

### Factory Layer

The factory layer is the deployment and orchestration layer for a game family.

A factory contract does not hold match state for individual tournaments. Instead, it:

- creates new tournament clones,
- validates creation parameters,
- tracks active and past tournaments,
- stores tier metadata,
- connects tournaments to the shared player-profile system.

- [`ETourFactory.sol`](../contracts/ETourFactory.sol): common factory behavior for all V2 games.
- [`TicTacToeFactory.sol`](../contracts/TicTacToeFactory.sol): Tic-Tac-Toe factory.
- [`ConnectFourFactory.sol`](../contracts/ConnectFourFactory.sol): Connect Four factory.
- [`ChessFactory.sol`](../contracts/ChessFactory.sol): Chess factory with post-init chess rules wiring.

### Instance Layer

The instance layer is the executable tournament layer.

These contracts define the logic that tournament clones run. One implementation contract is deployed per game, and many cheap clones point to it. The clone stores the actual tournament data, while the implementation provides the code.

- [`ETourTournamentBase.sol`](../contracts/ETourTournamentBase.sol): canonical storage layout and shared lifecycle.
- [`ETourInstance.sol`](../contracts/ETourInstance.sol): instance-level delegating entrypoints.
- [`ETourGame.sol`](../contracts/ETourGame.sol): shared game template for concrete games.

### Shared Modules

The shared module layer is the reusable infrastructure layer.

Modules are not user-facing tournament contracts. They are helper contracts that hold shared logic for enrollment, bracket progression, payouts, and escalations. The clone executes them through `delegatecall`, so they operate directly on clone storage.

- [`ETourInstance_Core.sol`](../contracts/modules/ETourInstance_Core.sol): enrollment and tournament start logic.
- [`ETourInstance_Matches.sol`](../contracts/modules/ETourInstance_Matches.sol): round initialization and match completion entry logic.
- [`ETourInstance_MatchesResolution.sol`](../contracts/modules/ETourInstance_MatchesResolution.sol): heavy bracket-advancement and round-resolution logic.
- [`ETourInstance_Prizes.sol`](../contracts/modules/ETourInstance_Prizes.sol): prize distribution and redistribution.
- [`ETourInstance_Escalation.sol`](../contracts/modules/ETourInstance_Escalation.sol): timeout-based escalation logic.

### Game Contracts

Game contracts are the narrow game-specific layer developers extend.

They do not reimplement the whole tournament protocol. Their job is to define game state, validate moves, update the board or position, and decide when a match ends. Everything else is meant to be inherited or delegated to shared infrastructure.

- [`TicTacToe.sol`](../contracts/TicTacToe.sol)
- [`ConnectFour.sol`](../contracts/ConnectFour.sol)
- [`Chess.sol`](../contracts/Chess.sol)

### Supporting Contracts

Supporting contracts are adjacent services the core tournament system depends on.

They are not part of the bracket lifecycle itself, but they provide important protocol capabilities such as player profiles and chess rules validation.

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

This is the single most important architectural constraint in V2.

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

V2 uses demand-driven tiers rather than pre-registered tiers.

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

V2 explicitly treats those game-owned fields as opaque. Infra should rely on `_getGameStateHash(matchId)` when it needs a generic state fingerprint.

## Execution Boundaries

There are three important execution styles in V2.

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

This is why V2 can support:

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

The key reason it is thin is contract-size pressure. V2 requires every deployable module to remain under 24 KB.

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

This module is where V2 enforces the idea that tournaments should keep progressing even when a match stalls.

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

This is a good example of V2's extension philosophy: common behavior is shared, but the game chooses the policy.

## Entropy and Randomness

V2 uses a lightweight internal entropy accumulator rather than pretending to provide strong adversarial randomness.

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

V2 uses deferred fee accounting.

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

ETour V2 integrates profiles through the factory and registry rather than hard-coding profile behavior into each game.

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
- ML3 replacement players are explicitly registered with `entryFee = 0` when they are added to the tournament by replacement.

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
- ML3 replacement outsiders also get a tournament-level enrollment/result record for that instance because replacement now routes them through the same profile-enrollment path used by other edge-case entrants.

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

This is the clearest example of the intended ETour V2 game-author experience.

### Chess

[`Chess.sol`](../contracts/Chess.sol) is the most advanced reference game.

It demonstrates:

- packed board + packed state separation,
- external rules-module validation,
- auxiliary per-match mappings,
- replay-safe custom state invalidation,
- custom `_getGameStateHash(...)`.

The important lesson from chess is that the `Match` struct does not need to carry every possible game-state shape. Additional mappings keyed by `matchId` are a first-class pattern in V2.

## Why the `Match` Struct Is Intentionally Flexible

V2 deliberately stops short of forcing every game into the same exact board/state model.

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

## Building Games on ETour V2

This section supersedes and expands the shorter builder guide in [`BuildingGames.md`](./BuildingGames.md).

### Recommended Inheritance Path

New games should inherit [`ETourGame.sol`](../contracts/ETourGame.sol):

```solidity
import "../contracts/ETourGame.sol";

contract MyGame is ETourGame {
    // game hooks + makeMove(...)
}
```

Do not inherit `ETourTournamentBase` directly unless you are intentionally bypassing the standard game template and are prepared to own more lifecycle code.

### What `ETourGame` Already Gives You

`ETourGame` already implements:

- shared match creation,
- replay/reset lifecycle,
- starter/order randomization,
- Fischer clock consumption,
- escalation-state clearing,
- common match reset behavior,
- the narrow hook model concrete games are expected to fill in.

### Required Hooks

```solidity
function _playerAssignmentMode()
    internal
    pure
    override
    returns (PlayerAssignmentMode);

function _initializeGameState(bytes32 matchId, bool isReplay)
    internal
    override;
```

### Optional Hooks

```solidity
function _resetGameState(bytes32 matchId) internal override;

function _getGameStateHash(bytes32 matchId)
    internal
    view
    override
    returns (bytes32);
```

Override `_resetGameState(...)` if you have auxiliary mappings keyed by `matchId`.

Override `_getGameStateHash(...)` if your live game state is not fully captured by `packedBoard`, `packedState`, and `moves`.

### `makeMove(...)` Contract

Every game defines its own move signature, but the expected structure is:

1. derive `matchId`,
2. verify `MatchStatus.InProgress`,
3. verify participant and turn ownership,
4. validate game-specific move inputs,
5. call `_consumeTurnClock(m)`,
6. mutate game state,
7. append move transcript if relevant,
8. call `_clearMatchEscalation(matchId)`,
9. call `_completeMatchInternal(...)` if terminal, otherwise `_switchTurn(m)`.

### Example Shape

```solidity
function makeMove(...) external nonReentrant notConcluded {
    bytes32 matchId = _getMatchId(roundNumber, matchNumber);
    Match storage m = matches[matchId];

    require(m.status == MatchStatus.InProgress, "MA");
    require(msg.sender == m.currentTurn, "NT");

    _consumeTurnClock(m);

    // game-specific state updates

    _clearMatchEscalation(matchId);

    if (terminalWin) {
        _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, MatchCompletionReason.NormalWin);
        return;
    }

    if (terminalDraw) {
        _completeMatchInternal(roundNumber, matchNumber, address(0), true, MatchCompletionReason.Draw);
        return;
    }

    _switchTurn(m);
}
```

### Player Assignment Policy

Choose one:

- `RandomizeStarterOnly`
- `RandomizePlayerOrder`

Use `RandomizeStarterOnly` when seat order matters to the game representation but first move should still be randomized.

Use `RandomizePlayerOrder` when the game naturally models white/black, player1/player2, or first/second mover roles as seat identity.

### Factory Customization

If your game needs one-time initialization after `initialize(...)`, override:

- `_initializeInstance(...)`
- `_postInitializeInstance(...)`

Prefer `_postInitializeInstance(...)` when the extra setup depends on instance state already existing.

Chess is the model for this pattern.

### State Model Guidance

Use the `Match` struct when the game fits naturally into:

- one packed board,
- one packed state word,
- one transcript string.

Use auxiliary mappings when needed:

```solidity
mapping(bytes32 => mapping(bytes32 => uint8)) private _positionCounts;
mapping(bytes32 => uint256) private _gameNonce;
```

That is the intended pattern, not a workaround.

### What Not To Do

Do not:

- treat public `module*` functions as your primary extension surface,
- write game logic into the shared modules,
- reorder base storage,
- duplicate bracket or payout logic inside the game contract,
- bypass `_completeMatchInternal(...)` for ordinary match conclusion.

### Reference Games

Use these as the canonical V2 examples:

- [`TicTacToe.sol`](../contracts/TicTacToe.sol)
- [`ConnectFour.sol`](../contracts/ConnectFour.sol)
- [`Chess.sol`](../contracts/Chess.sol)

## Worked Example: Checkers on ETour V2

The best way to verify that the extension surface is coherent is to map a new game onto it.

Checkers is a good example because it needs more than a toy board game, but less custom machinery than chess:

- directional movement,
- captures and forced captures,
- king promotion,
- possible multi-jump continuation,
- side-wide legal-move checks.

The important architectural point is that none of this requires rewriting tournament infrastructure.

The game contract only needs to own:

- board representation,
- move validation,
- game-specific win logic,
- any auxiliary per-match state beyond the base `Match` struct.

### Example `Checkers.sol`

The contract below is written in the ETour V2 style. It shows how a real checkers implementation would plug into `ETourGame`.

It uses:

- `packedBoard` for the 8x8 board,
- `packedState` for compact remaining-piece counts,
- `_forcedCaptureSquare[matchId]` for multi-jump continuation state,
- the shared ETour lifecycle for bracket progression, time control, escalations, and settlement.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

contract Checkers is ETourGame {
    uint8 private constant EMPTY = 0;
    uint8 private constant WHITE_MAN = 1;
    uint8 private constant WHITE_KING = 2;
    uint8 private constant BLACK_MAN = 3;
    uint8 private constant BLACK_KING = 4;
    uint8 private constant NO_SQUARE = type(uint8).max;

    // matchId -> square index that must continue capturing, or NO_SQUARE
    mapping(bytes32 => uint8) private _forcedCaptureSquare;

    event MoveMade(
        bytes32 indexed matchId,
        address indexed player,
        uint8 from,
        uint8 to,
        bool wasCapture
    );

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool) internal override {
        Match storage m = matches[matchId];
        m.packedBoard = _initialBoard();
        m.packedState = _encodePieceCounts(12, 12);
        _forcedCaptureSquare[matchId] = NO_SQUARE;
    }

    function _resetGameState(bytes32 matchId) internal override {
        _forcedCaptureSquare[matchId] = NO_SQUARE;
    }

    function _getGameStateHash(bytes32 matchId) internal view override returns (bytes32) {
        Match storage m = matches[matchId];
        return keccak256(
            abi.encodePacked(
                m.packedBoard,
                m.packedState,
                _forcedCaptureSquare[matchId],
                m.moves
            )
        );
    }

    function makeMove(
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 from,
        uint8 to
    ) external nonReentrant notConcluded {
        require(from < 64 && to < 64 && from != to, "IS");
        require(_isDarkSquare(from) && _isDarkSquare(to), "SP");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.InProgress, "MA");
        require(msg.sender == m.player1 || msg.sender == m.player2, "NP");
        require(msg.sender == m.currentTurn, "NT");

        bool isWhiteTurn = msg.sender == m.player1;
        uint8 piece = _getPiece(m.packedBoard, from);

        require(_pieceBelongsToSide(piece, isWhiteTurn), "NYP");
        require(_getPiece(m.packedBoard, to) == EMPTY, "OCC");

        uint8 lockedSquare = _forcedCaptureSquare[matchId];
        if (lockedSquare != NO_SQUARE) {
            require(from == lockedSquare, "MC");
        }

        _consumeTurnClock(m);

        bool wasCapture;
        uint8 capturedSquare;

        if (_isLegalCapture(m.packedBoard, from, to, piece, isWhiteTurn)) {
            wasCapture = true;
            capturedSquare = _midSquare(from, to);
        } else {
            require(lockedSquare == NO_SQUARE, "MC");
            require(!_sideHasAnyCapture(m.packedBoard, isWhiteTurn), "FC");
            require(_isLegalStep(from, to, piece, isWhiteTurn), "IM");
        }

        uint256 newBoard = _setPiece(m.packedBoard, from, EMPTY);

        if (wasCapture) {
            uint8 capturedPiece = _getPiece(newBoard, capturedSquare);
            require(capturedPiece != EMPTY, "NC");

            newBoard = _setPiece(newBoard, capturedSquare, EMPTY);
            m.packedState = _decrementCapturedCount(m.packedState, capturedPiece);
        }

        uint8 movedPiece = _maybePromote(piece, to);
        newBoard = _setPiece(newBoard, to, movedPiece);
        m.packedBoard = newBoard;
        m.moves = _appendMove(m.moves, from, to, wasCapture);

        _clearMatchEscalation(matchId);
        emit MoveMade(matchId, msg.sender, from, to, wasCapture);

        uint8 whiteCount = _whiteCount(m.packedState);
        uint8 blackCount = _blackCount(m.packedState);

        if (wasCapture && _pieceHasCapture(newBoard, to, movedPiece, isWhiteTurn)) {
            if ((isWhiteTurn && blackCount == 0) || (!isWhiteTurn && whiteCount == 0)) {
                _forcedCaptureSquare[matchId] = NO_SQUARE;
                _completeMatchInternal(
                    roundNumber,
                    matchNumber,
                    msg.sender,
                    false,
                    MatchCompletionReason.NormalWin
                );
                return;
            }

            _forcedCaptureSquare[matchId] = to;
            return;
        }

        _forcedCaptureSquare[matchId] = NO_SQUARE;

        if ((isWhiteTurn && blackCount == 0) || (!isWhiteTurn && whiteCount == 0)) {
            _completeMatchInternal(
                roundNumber,
                matchNumber,
                msg.sender,
                false,
                MatchCompletionReason.NormalWin
            );
            return;
        }

        if (!_sideHasAnyLegalMove(newBoard, !isWhiteTurn)) {
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
        returns (uint8[64] memory board)
    {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        uint256 packed = matches[matchId].packedBoard;

        for (uint8 i = 0; i < 64; i++) {
            board[i] = _getPiece(packed, i);
        }
    }

    function getForcedCaptureSquare(uint8 roundNumber, uint8 matchNumber)
        external
        view
        returns (uint8)
    {
        return _forcedCaptureSquare[_getMatchId(roundNumber, matchNumber)];
    }

    function _initialBoard() private pure returns (uint256 board) {
        for (uint8 square = 0; square < 64; square++) {
            if (!_isDarkSquare(square)) continue;

            uint8 row = square / 8;
            if (row <= 2) {
                board = _setPiece(board, square, BLACK_MAN);
            } else if (row >= 5) {
                board = _setPiece(board, square, WHITE_MAN);
            }
        }
    }

    function _encodePieceCounts(uint8 whiteCount, uint8 blackCount) private pure returns (uint256) {
        return uint256(whiteCount) | (uint256(blackCount) << 8);
    }

    function _whiteCount(uint256 state) private pure returns (uint8) {
        return uint8(state & 0xFF);
    }

    function _blackCount(uint256 state) private pure returns (uint8) {
        return uint8((state >> 8) & 0xFF);
    }

    function _decrementCapturedCount(uint256 state, uint8 capturedPiece) private pure returns (uint256) {
        uint8 whiteCount = _whiteCount(state);
        uint8 blackCount = _blackCount(state);

        if (capturedPiece == WHITE_MAN || capturedPiece == WHITE_KING) {
            whiteCount--;
        } else {
            blackCount--;
        }

        return _encodePieceCounts(whiteCount, blackCount);
    }

    function _getPiece(uint256 board, uint8 square) private pure returns (uint8) {
        return uint8((board >> (square * 4)) & 0xF);
    }

    function _setPiece(uint256 board, uint8 square, uint8 piece) private pure returns (uint256) {
        uint256 mask = ~(uint256(0xF) << (square * 4));
        return (board & mask) | (uint256(piece) << (square * 4));
    }

    function _isDarkSquare(uint8 square) private pure returns (bool) {
        uint8 row = square / 8;
        uint8 col = square % 8;
        return ((row + col) & 1) == 1;
    }

    function _pieceBelongsToSide(uint8 piece, bool isWhite) private pure returns (bool) {
        if (isWhite) return piece == WHITE_MAN || piece == WHITE_KING;
        return piece == BLACK_MAN || piece == BLACK_KING;
    }

    function _isKing(uint8 piece) private pure returns (bool) {
        return piece == WHITE_KING || piece == BLACK_KING;
    }

    function _maybePromote(uint8 piece, uint8 to) private pure returns (uint8) {
        uint8 row = to / 8;
        if (piece == WHITE_MAN && row == 0) return WHITE_KING;
        if (piece == BLACK_MAN && row == 7) return BLACK_KING;
        return piece;
    }

    function _isLegalStep(uint8 from, uint8 to, uint8 piece, bool isWhite) private pure returns (bool) {
        int256 rowDelta = int256(uint256(to / 8)) - int256(uint256(from / 8));
        int256 colDelta = int256(uint256(to % 8)) - int256(uint256(from % 8));

        if (_abs(rowDelta) != 1 || _abs(colDelta) != 1) return false;
        if (_isKing(piece)) return true;

        return isWhite ? rowDelta == -1 : rowDelta == 1;
    }

    function _isLegalCapture(
        uint256 board,
        uint8 from,
        uint8 to,
        uint8 piece,
        bool isWhite
    ) private pure returns (bool) {
        int256 rowDelta = int256(uint256(to / 8)) - int256(uint256(from / 8));
        int256 colDelta = int256(uint256(to % 8)) - int256(uint256(from % 8));

        if (_abs(rowDelta) != 2 || _abs(colDelta) != 2) return false;
        if (!_isKing(piece) && (isWhite ? rowDelta != -2 : rowDelta != 2)) return false;

        uint8 jumpedSquare = _midSquare(from, to);
        uint8 jumpedPiece = _getPiece(board, jumpedSquare);
        return jumpedPiece != EMPTY && !_pieceBelongsToSide(jumpedPiece, isWhite);
    }

    function _pieceHasCapture(
        uint256 board,
        uint8 from,
        uint8 piece,
        bool isWhite
    ) private pure returns (bool) {
        return _canCaptureTo(board, from, piece, isWhite, -2, -2) ||
               _canCaptureTo(board, from, piece, isWhite, -2,  2) ||
               _canCaptureTo(board, from, piece, isWhite,  2, -2) ||
               _canCaptureTo(board, from, piece, isWhite,  2,  2);
    }

    function _pieceHasStep(
        uint256 board,
        uint8 from,
        uint8 piece,
        bool isWhite
    ) private pure returns (bool) {
        return _canStepTo(board, from, piece, isWhite, -1, -1) ||
               _canStepTo(board, from, piece, isWhite, -1,  1) ||
               _canStepTo(board, from, piece, isWhite,  1, -1) ||
               _canStepTo(board, from, piece, isWhite,  1,  1);
    }

    function _sideHasAnyCapture(uint256 board, bool isWhite) private pure returns (bool) {
        for (uint8 square = 0; square < 64; square++) {
            uint8 piece = _getPiece(board, square);
            if (_pieceBelongsToSide(piece, isWhite) && _pieceHasCapture(board, square, piece, isWhite)) {
                return true;
            }
        }
        return false;
    }

    function _sideHasAnyLegalMove(uint256 board, bool isWhite) private pure returns (bool) {
        for (uint8 square = 0; square < 64; square++) {
            uint8 piece = _getPiece(board, square);
            if (!_pieceBelongsToSide(piece, isWhite)) continue;

            if (_pieceHasCapture(board, square, piece, isWhite)) return true;
            if (_pieceHasStep(board, square, piece, isWhite)) return true;
        }
        return false;
    }

    function _canStepTo(
        uint256 board,
        uint8 from,
        uint8 piece,
        bool isWhite,
        int256 rowOffset,
        int256 colOffset
    ) private pure returns (bool) {
        if (!_isKing(piece) && (isWhite ? rowOffset != -1 : rowOffset != 1)) return false;

        int256 row = int256(uint256(from / 8)) + rowOffset;
        int256 col = int256(uint256(from % 8)) + colOffset;
        if (row < 0 || row >= 8 || col < 0 || col >= 8) return false;

        uint8 to = uint8(uint256(row * 8 + col));
        return _isDarkSquare(to) && _getPiece(board, to) == EMPTY;
    }

    function _canCaptureTo(
        uint256 board,
        uint8 from,
        uint8 piece,
        bool isWhite,
        int256 rowOffset,
        int256 colOffset
    ) private pure returns (bool) {
        if (!_isKing(piece) && (isWhite ? rowOffset != -2 : rowOffset != 2)) return false;

        int256 row = int256(uint256(from / 8)) + rowOffset;
        int256 col = int256(uint256(from % 8)) + colOffset;
        if (row < 0 || row >= 8 || col < 0 || col >= 8) return false;

        uint8 to = uint8(uint256(row * 8 + col));
        if (!_isDarkSquare(to) || _getPiece(board, to) != EMPTY) return false;

        uint8 jumpedPiece = _getPiece(board, _midSquare(from, to));
        return jumpedPiece != EMPTY && !_pieceBelongsToSide(jumpedPiece, isWhite);
    }

    function _midSquare(uint8 from, uint8 to) private pure returns (uint8) {
        return uint8((uint16(from) + uint16(to)) / 2);
    }

    function _appendMove(
        string memory existing,
        uint8 from,
        uint8 to,
        bool wasCapture
    ) private pure returns (string memory) {
        string memory sep = wasCapture ? "x" : "-";
        string memory moveText = string(
            abi.encodePacked(_uintToString(from), sep, _uintToString(to))
        );

        if (bytes(existing).length == 0) return moveText;
        return string(abi.encodePacked(existing, ",", moveText));
    }

    function _uintToString(uint8 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint8 tmp = value;
        uint8 digits = 0;
        while (tmp != 0) {
            digits++;
            tmp /= 10;
        }

        bytes memory out = new bytes(digits);
        while (value != 0) {
            digits--;
            out[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    function _abs(int256 value) private pure returns (int256) {
        return value >= 0 ? value : -value;
    }
}
```

### Matching `CheckersFactory.sol`

The factory follows the normal V2 pattern:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./Checkers.sol";

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

### Why This Example Fits ETour V2 Cleanly

This checkers example maps directly onto the guide:

- It inherits `ETourGame`, not `ETourTournamentBase`.
- It uses the required hooks and only the necessary optional ones.
- It keeps tournament logic, payouts, and escalations out of the game contract.
- It stores one extra piece of game-owned state in `_forcedCaptureSquare`.
- It uses `_getGameStateHash(...)` so infra does not need to understand that extra state directly.
- It concludes matches through `_completeMatchInternal(...)`, which keeps bracket and settlement behavior consistent with every other ETour V2 game.

### Production Notes for a Full Checkers Release

A production-grade checkers game would likely add:

- explicit draw rules such as repetition or move-count draws,
- richer move transcript encoding than CSV text,
- dedicated board-decoding view helpers for frontends,
- more compact packed-state flags for forced-capture continuation,
- stronger tests around multi-jump king promotion edge cases.

None of those require changing the ETour V2 infrastructure. They are purely game-layer refinements, which is exactly the separation V2 is designed to enforce.

## Practical Reading Order

For a new ETour V2 contributor, the best reading order is:

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
