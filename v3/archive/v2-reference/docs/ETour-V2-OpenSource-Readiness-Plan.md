# ETour V2 Open-Source Readiness Plan

## Scope

This document covers **ETour V2 only**. It is a design and rollout plan for making the V2 instance/module/factory architecture easier for third-party developers to understand, extend, and safely build on.

This is **not** an implementation spec for V1, and it is **not** a migration plan for already deployed V2 instances. The focus is the next V2 development pass before sharing the system as protocol infrastructure.

## Executive Summary

The consultant feedback is directionally correct. The V2 system design is already strong in the areas that matter most for a tournament protocol:

- Instance-per-tournament isolation is clear.
- Modules are separated by responsibility.
- Factory-driven deployment and enrollment flow is coherent.
- Escalation and tournament resolution flows are already formalized.

The main gap is **developer-facing shape**, not core game logic. Right now, a developer who wants to add a new game has to infer too much from the concrete implementations and from [`ETourInstance_Base.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourInstance_Base.sol). The codebase exposes too many lifecycle functions, duplicates too much game lifecycle logic across the three shipped games, and mixes developer extension points with module-only bridge functions.

The recommended V2 direction is:

1. Introduce a new abstract game template contract that becomes the canonical extension surface.
2. Move duplicated match lifecycle and timer logic into that template.
3. Separate **internal game hooks** from **module bridge functions**.
4. Add a factory post-initialization hook so game-specific setup does not require cloning the full factory flow.
5. Keep the current `Match` storage layout for V2, but formalize which fields are infra-owned vs game-owned and remove infrastructure dependence on raw game fields.

## Current V2 Findings

### 1. The developer override surface is too wide

[`ETourInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourInstance.sol) currently implies that a game contract must implement all of the following:

- `_createMatchGame()`
- `_resetMatchGame()`
- `_getMatchResult()`
- `_initializeMatchForPlay()`
- `_completeMatchWithResult()`
- `_completeMatchGameSpecific()`
- `_getTimeIncrement()`
- `_hasCurrentPlayerTimedOut()`
- `makeMove()`

That is too much protocol knowledge for a new integrator. Most of those functions are not truly game-specific.

### 2. Match lifecycle duplication is real and high-impact

Across [`TicTacInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/TicTacInstance.sol), [`ConnectFourInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ConnectFourInstance.sol), and [`ChessInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessInstance.sol):

- `_resetMatchGame()` is structurally identical, except for chess nonce handling.
- `_getMatchResult()` is identical.
- `_completeMatchWithResult()` is identical.
- `_completeMatchGameSpecific()` is redundant and effectively identical.
- `_getTimeIncrement()` is identical.
- `_hasCurrentPlayerTimedOut()` is identical.
- The Fischer clock update at the top of each `makeMove()` is identical.
- `_createMatchGame()` and `_initializeMatchForPlay()` only differ in game-state initialization and whether player slot order is randomized or only the first mover is randomized.

This means a new game developer currently has to copy protocol glue just to reach the actual game logic.

### 3. Visibility is constrained by module delegatecall mechanics

This is the subtle part.

The matches and escalation modules call instance functions through `this.<fn>()` while running under `delegatecall`. Examples include:

- `this._createMatchGame(...)`
- `this._initializeMatchForPlay(...)`
- `this._setMatchPlayer(...)`
- `this._getMatchPlayers(...)`
- `this._completeMatchWithResult(...)`
- `this._hasCurrentPlayerTimedOut(...)`

That means some functions are public today **because modules need an externally callable bridge**, not because they are real public APIs for developers or users.

So the correct fix is not "change everything from public to internal." The correct fix is:

- keep module bridges externally reachable by `address(this)`,
- block direct outside callers,
- move actual developer extension hooks to internal functions.

### 4. Chess factory setup duplicates the full base factory flow

[`ChessOnChainFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessOnChainFactory.sol) duplicates almost the full `createInstance()` implementation from [`ETourFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourFactory.sol) only to call `initializeChess(...)` instead of `initialize(...)`.

This is a clean sign that the base factory is missing a post-init hook.

### 5. `Match` is partly infra state and partly game state

The V2 `Match` struct in [`ETourInstance_Base.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourInstance_Base.sol) currently includes:

- infra-owned fields:
  - `player1`
  - `player2`
  - `winner`
  - `currentTurn`
  - `firstPlayer`
  - `status`
  - `isDraw`
  - `startTime`
  - `lastMoveTime`
  - `player1TimeRemaining`
  - `player2TimeRemaining`
  - `completionReason`
  - `completionCategory`
- game-owned fields:
  - `packedBoard`
  - `packedState`
  - `moves`

The good news is that the modules mostly do not care about `packedBoard`, `packedState`, or `moves`. The main infra coupling is `_completeMatchInternal()`, which mixes `packedBoard` and `packedState` into entropy. That is easy to abstract.

The hard part is storage layout: because modules execute through `delegatecall`, any change to the base storage model has to preserve a compatible shared layout across the base and all modules in the same deployment set.

## Design Goals

The V2 refactor should optimize for five things:

1. A new game should be buildable by reading one abstract template plus one documentation file.
2. Game contracts should only own game logic, not tournament plumbing.
3. Internal game hooks and module bridge functions should be clearly separated.
4. Factory specialization should happen through hooks, not full method duplication.
5. Match-state flexibility should improve without destabilizing V2 storage semantics.

## Proposed Architecture

## A. Contract layering

Keep the current broad architecture, but tighten the extension surface:

- `ETourInstance_Base`
  - Owns storage, tournament lifecycle, shared events, shared read API, enrollment/prize/escalation integration, entropy, and core completion flow.
- `ETourInstance`
  - Keeps module entrypoints such as `initializeRound`, `forceEliminateStalledMatch`, and `claimMatchSlotByReplacement`.
- `ETourGame` or `ETourGameBase` (new abstract contract)
  - Becomes the developer-facing game template.
  - Implements common match lifecycle logic.
  - Exposes protected module bridge functions.
  - Defines the small set of internal hooks game authors actually override.
- Concrete game contracts
  - `TicTacInstance`
  - `ConnectFourInstance`
  - `ChessInstance`
  - Future third-party games

The new template contract is the core of this plan. Without it, documentation alone will not materially improve the developer experience.

## B. Separate bridge functions from game hooks

Introduce two categories of functions:

- **Module bridge functions**
  - Externally callable only by `address(this)`.
  - Used by delegatecall modules through `this.<fn>()`.
  - Not intended for third-party game authors to override directly.
- **Internal game hooks**
  - `internal virtual`.
  - The real extension surface for new games.
  - Called by the shared template contract.

Recommended access modifier:

```solidity
modifier onlySelfCall() {
    require(msg.sender == address(this), "Only self");
    _;
}
```

`onlyDelegateCall` should remain for module functions executed by delegatecall. It is not the right guard for self-call bridges.

## Workstream 1: Reduce Code Duplication

This is the highest-priority technical refactor because it also unlocks points 2 and 4.

### Target outcome

Game contracts should no longer implement the whole match lifecycle. They should only provide:

- initial game state setup,
- move execution,
- win/draw detection,
- optional extra game-specific cleanup,
- optional extra game-specific storage mappings.

### Proposed shared responsibilities in the new template

Move the following logic out of each game and into the new abstract template:

- player validation for new match creation,
- common match field initialization,
- common match reset logic,
- common match restart logic,
- common match completion field writes,
- time increment lookup,
- timeout detection,
- Fischer increment timer consumption,
- escalation-state clearing after a move,
- turn-switch helper,
- result/write helper for normal win/draw completion.

### Proposed internal hooks

The new template should define a narrow hook set similar to:

```solidity
enum PlayerAssignmentMode {
    RandomizeStarterOnly,
    RandomizePlayerOrder
}

function _playerAssignmentMode() internal pure virtual returns (PlayerAssignmentMode);

function _initializeGameState(bytes32 matchId) internal virtual;

function _resetGameState(bytes32 matchId) internal virtual;

function _getGameStateHash(bytes32 matchId) internal view virtual returns (bytes32);
```

Optional additional hook if needed:

```solidity
function _onMatchPlayersAssigned(bytes32 matchId) internal virtual;
```

This avoids forcing a game to reimplement all common lifecycle functions just to set an initial board.

### How the shared lifecycle should work

#### Shared `_createMatchGame` flow

The template should:

1. validate `player1` and `player2`,
2. compute `matchId`,
3. assign players using `_playerAssignmentMode()`,
4. set `currentTurn` and `firstPlayer`,
5. set `status`, `startTime`, `lastMoveTime`, and timer banks,
6. zero `winner`, `isDraw`, completion metadata, and move history,
7. call `_initializeGameState(matchId)`.

#### Shared `_initializeMatchForPlay` flow

The template should:

1. preserve the already assigned players,
2. rerandomize starter or player order according to `_playerAssignmentMode()`,
3. reset time banks and timestamps,
4. zero completion metadata,
5. clear move history,
6. call `_initializeGameState(matchId)`.

#### Shared `_resetMatchGame` flow

The template should:

1. zero all infra-owned fields,
2. zero the game-owned base fields (`packedBoard`, `packedState`, `moves`),
3. call `_resetGameState(matchId)` for auxiliary mappings,
4. set completion metadata back to neutral defaults.

### Remove `_completeMatchGameSpecific`

This function should be deleted from the developer-facing design.

Why:

- `_completeMatchInternal()` already sets `winner`, `isDraw`, `status`, `completionReason`, and `completionCategory`.
- Each concrete implementation of `_completeMatchGameSpecific()` is currently repeating those same writes.
- It adds conceptual noise without adding extension value.

Recommended action:

- remove `_completeMatchGameSpecific()` from the abstract template,
- keep only one internal completion path,
- if a game ever needs post-completion cleanup, introduce a narrowly named hook such as `_afterMatchCompleted(bytes32 matchId)` instead of duplicating result writes.

### Centralize timer helpers

All three shipped games implement the same Fischer clock logic inline in `makeMove()`. That should become a helper in the template, for example:

```solidity
function _consumeTurnClock(Match storage m) internal {
    uint256 elapsed = block.timestamp - m.lastMoveTime;
    if (m.currentTurn == m.player1) {
        m.player1TimeRemaining = (m.player1TimeRemaining > elapsed)
            ? m.player1TimeRemaining - elapsed + tierConfig.timeouts.timeIncrementPerMove
            : tierConfig.timeouts.timeIncrementPerMove;
    } else {
        m.player2TimeRemaining = (m.player2TimeRemaining > elapsed)
            ? m.player2TimeRemaining - elapsed + tierConfig.timeouts.timeIncrementPerMove
            : tierConfig.timeouts.timeIncrementPerMove;
    }
    m.lastMoveTime = block.timestamp;
}
```

Related helpers should also exist:

- `_clearMatchEscalation(bytes32 matchId)`
- `_switchTurn(Match storage m)`
- `_completeAsWin(...)`
- `_completeAsDraw(...)`

### Game-by-game impact

#### Tic-Tac

Tic-Tac should only need to own:

- 3x3 board packing helpers,
- win detection,
- draw detection,
- move recording format,
- `makeMove()`.

Its special behavior is `_playerAssignmentMode() == RandomizeStarterOnly`.

#### Connect Four

Connect Four should only need to own:

- board packing helpers,
- gravity logic,
- connect-four detection,
- move recording format,
- `makeMove()`.

Its special behavior is `_playerAssignmentMode() == RandomizePlayerOrder`.

#### Chess

Chess should only need to own:

- board/state representation,
- `CHESS_RULES` integration,
- threefold repetition bookkeeping,
- move recording format,
- `makeMove()`,
- auxiliary cleanup for `_positionCounts` and `_gameNonce`.

Its special behavior is also `_playerAssignmentMode() == RandomizePlayerOrder`.

## Workstream 2: Clear Interface and Documentation

### Target outcome

A developer should be able to answer three questions from one place:

1. What do I inherit?
2. What do I override?
3. What invariants must my `makeMove()` satisfy?

### Deliverable 1: New abstract template contract

Add a new file such as:

- `v2/contracts/ETourGame.sol`, or
- `v2/contracts/abstract/ETourGame.sol`

This contract should be the canonical extension surface. It should contain strong NatSpec on:

- which hooks are mandatory,
- which hooks are optional,
- what storage fields are safe for game logic to own,
- how modules interact with the instance,
- what the move lifecycle must do.

### Deliverable 2: Dedicated builder documentation

Add a V2 developer guide such as:

- `v2/docs/BuildingGames.md`

This guide should explain:

- the tournament lifecycle,
- module call flow,
- the difference between self-call bridges and internal hooks,
- how to store game-specific state,
- how to implement move logic safely,
- how to integrate optional external rule engines,
- how to write tests for a new game module.

### Required `makeMove()` contract

Because `makeMove()` signatures differ by game, it should not be forced into one interface signature. Instead, the template and docs should standardize the pattern.

Every `makeMove()` implementation should do the following in order:

1. resolve `matchId`,
2. verify the match is active,
3. verify `msg.sender` is a participant and equals `currentTurn`,
4. validate move-specific inputs,
5. call the shared timer helper,
6. update game state,
7. record move history if the game exposes it,
8. clear escalation state,
9. either call `_completeMatchInternal(...)` or switch turn.

### Recommended explicit developer invariants

The docs should state the following as non-negotiable:

- Only `MatchStatus.InProgress` matches may accept moves.
- A move must not mutate tournament-wide state except through approved completion paths.
- A winning or drawing move must always terminate through `_completeMatchInternal(...)`.
- A non-terminal move must always update `currentTurn`.
- If the game uses extra mappings keyed by `matchId`, reset/restart flows must handle them.
- If a game uses external rule engines, they must be configured during initialization and immutable at runtime unless there is an explicit governance model.

## Workstream 3: Factory Initialization Hooks

### Target outcome

Child factories should never need to re-copy `createInstance()` just to do one extra game-specific setup step.

### Current problem

`ChessOnChainFactory` duplicates nearly the whole `createInstance()` pipeline from `ETourFactory` to pass `CHESS_RULES` during initialization.

### Recommended base-factory hook design

Keep one canonical `createInstance()` in [`ETourFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourFactory.sol) and introduce two virtual hooks:

```solidity
function _initializeInstance(
    address instance,
    ETourInstance_Base.TierConfig memory config,
    address creator
) internal virtual {
    ETourInstance_Base(instance).initialize(
        config,
        address(this),
        creator,
        MODULE_CORE,
        MODULE_MATCHES,
        MODULE_PRIZES,
        MODULE_ESCALATION
    );
}

function _postInitializeInstance(
    address instance,
    ETourInstance_Base.TierConfig memory config,
    address creator
) internal virtual {}
```

Recommended `createInstance()` flow:

1. validate config,
2. resolve or create tier,
3. clone implementation,
4. call `_initializeInstance(...)`,
5. call `_postInitializeInstance(...)`,
6. track the instance,
7. auto-enroll creator.

### Chess-specific refactor

Refactor [`ChessInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessInstance.sol) so it no longer needs a separate `initializeChess(...)` entrypoint.

Recommended approach:

- keep the standard base `initialize(...)`,
- add a one-time post-init setter such as `setChessRules(address)` or `_configureChess(address)` exposed through a protected external initializer,
- call that setter from `ChessOnChainFactory._postInitializeInstance(...)`.

That lets `ChessOnChainFactory` override one small hook instead of duplicating the factory pipeline.

### Guardrails for post-init setters

Any post-init game configuration function should:

- be callable only by the factory,
- be callable only once,
- reject zero addresses,
- run before auto-enrollment if the game requires the dependency for round initialization or move processing.

### Optional future extension

If the protocol eventually wants truly generic third-party game setup, a later V2 enhancement could add an optional `bytes gameInitData` parameter to factory creation. That is not necessary for this pass. The hook-based design is enough for the current readiness gap.

## Workstream 4: Correct Function Visibility

### Target outcome

A developer reading the code should immediately know:

- which functions are for modules,
- which functions are public user APIs,
- which functions are game-internal hooks.

### Proposed visibility model

#### Keep as external/public user APIs

- `enrollInTournament`
- `enrollOnBehalf`
- `initializeRound`
- escalation entrypoints
- public view/read helpers such as `getMatch`, `getInstanceInfo`, `getBoard`, and prize/result views

#### Convert to protected module bridge functions

These exist so modules can call back into the instance via `this.<fn>()`:

- create-match bridge
- reset-match bridge
- get-match-result bridge
- get/set-match-player bridge
- initialize-match-for-play bridge
- completion-result bridge
- timeout-check bridge
- active-match-data bridge

These should all be guarded with `onlySelfCall`.

### Naming recommendation

For clarity, do not expose protected bridge functions with misleading developer-facing names forever.

Recommended end state:

- bridge names clearly indicate bridge usage, for example:
  - `moduleCreateMatch(...)`
  - `moduleResetMatch(...)`
  - `moduleGetMatchResult(...)`
  - `moduleInitializeMatch(...)`
- developer hooks stay internal and keep the underscore prefix.

This is cleaner than leaving public underscore-prefixed functions in the long-term API.

If a lower-risk first pass is preferred, the codebase can temporarily keep existing names and add `onlySelfCall`, then rename in a second pass.

### Why this matters beyond style

Today, a third-party developer can easily misread public underscore-prefixed functions as part of the intended extension surface. That creates three problems:

- confusion about what must be implemented,
- accidental misuse in off-protocol integrations,
- a larger externally callable surface than necessary.

Separating bridge functions from hooks solves all three.

## Workstream 5: Flexible Match Struct

This is the most sensitive change area and should be handled conservatively in V2.

### Recommendation for V2

Do **not** redesign the `Match` struct around dynamic `bytes` or remove fields from the middle of the struct in this pass.

Instead:

1. keep the current struct layout for V2 compatibility within the base/modules deployment set,
2. formally declare `packedBoard`, `packedState`, and `moves` as **game-owned fields**,
3. remove direct infrastructure dependence on those fields,
4. standardize auxiliary per-game mappings keyed by `matchId` for complex games.

### Required infra decoupling

Change `_completeMatchInternal()` so it no longer mixes `m.packedBoard` and `m.packedState` directly into entropy. Replace that with:

```solidity
function _getGameStateHash(bytes32 matchId) internal view virtual returns (bytes32);
```

Then entropy mixing can use:

- round and match coordinates,
- players,
- winner and draw flag,
- completion reason,
- `_getGameStateHash(matchId)`,
- timestamps.

For simple games:

- Tic-Tac can hash `packedBoard`.
- Connect Four can hash `packedBoard`.
- Chess can hash both `packedBoard` and `packedState`, and optionally include `_gameNonce[matchId]`.

### Custom state model for V2

The formal pattern for new games should be:

- use `packedBoard`, `packedState`, and `moves` if they are enough,
- add auxiliary mappings keyed by `matchId` if more state is needed,
- reset those mappings through `_resetGameState(matchId)`,
- include them in `_getGameStateHash(matchId)` if they materially define the live game state.

Chess already demonstrates this pattern with:

- `_positionCounts`
- `_gameNonce`

That should become documented as the supported approach, not an implicit exception.

### Why not replace the struct right now

Options like:

- replacing the three game fields with a single `bytes gameState`,
- removing all game fields and forcing parallel mappings,
- inserting a new generic game blob into `Match`,

all increase risk in V2 because:

- modules and base must preserve identical storage expectations,
- dynamic storage types increase gas and complexity,
- deployed mental models and test assumptions would all shift at once,
- the practical benefit is modest because `uint256 + uint256 + string` plus auxiliary mappings already covers a wide range of board games.

So the right V2 move is to formalize the current flexibility model, not to force a full storage redesign.

## Recommended Rollout Sequence

The priorities should be executed in this order.

### Phase 1: Create the game template and migrate duplication out of concrete games

Deliverables:

- new abstract game template contract,
- shared timer and escalation helpers,
- shared match lifecycle implementation,
- deletion of `_completeMatchGameSpecific`,
- concrete games reduced to mostly move logic and game-state initialization.

This phase creates the real protocol extension surface.

### Phase 2: Clean up visibility and bridge semantics

Deliverables:

- `onlySelfCall`,
- bridge-function guardrails,
- internalized developer hooks,
- clearer naming or at minimum clear access restrictions on bridge functions.

This phase makes the architecture legible and safer.

### Phase 3: Add factory hooks and remove chess factory duplication

Deliverables:

- `_initializeInstance(...)`,
- `_postInitializeInstance(...)`,
- chess post-init configuration,
- `ChessOnChainFactory` reduced to a small specialization.

This phase makes factory inheritance usable for third-party games.

### Phase 4: Publish developer documentation

Deliverables:

- the abstract template contract with NatSpec,
- `v2/docs/BuildingGames.md`,
- a worked example using one existing game as the reference implementation.

This phase translates the technical refactor into actual ecosystem usability.

### Phase 5: Formalize flexible game-state ownership

Deliverables:

- `_getGameStateHash(matchId)`,
- explicit docs on game-owned fields,
- explicit docs on auxiliary mappings and reset semantics.

This phase should happen after the template exists, because the template is where these rules become enforceable.

## Suggested File-Level Changes

The following file map is the most likely shape of the refactor.

### New files

- `v2/contracts/ETourGame.sol` or `v2/contracts/abstract/ETourGame.sol`
- `v2/docs/BuildingGames.md`

### Heavily changed files

- [`ETourInstance_Base.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourInstance_Base.sol)
- [`ETourInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourInstance.sol)
- [`ETourFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourFactory.sol)
- [`TicTacInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/TicTacInstance.sol)
- [`ConnectFourInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ConnectFourInstance.sol)
- [`ChessInstance.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessInstance.sol)
- [`ChessOnChainFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessOnChainFactory.sol)

### Module changes required

The modules will need coordinated updates to call the protected bridge layer rather than assuming developer hooks are public APIs:

- [`ETourInstance_Matches.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/modules/ETourInstance_Matches.sol)
- [`ETourInstance_Escalation.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/modules/ETourInstance_Escalation.sol)

This is expected because the current visibility issue is fundamentally a base-module interaction issue.

## Testing Implications

This plan is refactor-heavy, so correctness must be preserved with the existing V2 behavior suite.

### Existing tests that should remain core regression coverage

- [`TicTacInstance.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/TicTacInstance.test.js)
- [`ConnectFourInstance.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/ConnectFourInstance.test.js)
- [`ChessInstance.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/ChessInstance.test.js)
- [`PrizeRedistribution.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/PrizeRedistribution.test.js)
- [`verify-both-players-complete-flow.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/verify-both-players-complete-flow.test.js)
- [`profile-creation-both-players.test.js`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/test/factory/profile-creation-both-players.test.js)

### New tests that should be added during implementation

- bridge functions revert for direct EOA calls,
- modules can still invoke bridge functions through `this.<fn>()`,
- shared template creates the same initial match state as the current implementations,
- shared timer helper preserves current Fischer semantics,
- chess post-init hook is one-time and factory-only,
- `_getGameStateHash()` participates in entropy without changing match resolution behavior,
- game-specific auxiliary mappings are correctly reset on replay/reset flows.

## Risks and Constraints

### 1. Base and modules must be treated as one storage-bound deployment set

Any refactor touching layout assumptions or bridge semantics must be rolled out across:

- base instance contracts,
- module contracts,
- factories,
- deployment scripts,
- ABI generation scripts.

This is not a piecemeal change.

### 2. The safest V2 path is additive and consolidating, not conceptually radical

The plan should not try to reinvent the module architecture. The current delegatecall pattern is workable. The main problem is that the extension surface is not encoded cleanly.

### 3. Future instances vs past instances

This plan is naturally oriented toward:

- new implementation deployments,
- new factory deployments,
- future tournament instances.

It should not assume retroactive mutation of already deployed clones.

## Definition of Done

ETour V2 should be considered open-source ready for third-party game developers when all of the following are true:

- a new game author only overrides a small documented internal hook set plus `makeMove()`,
- game contracts no longer duplicate match lifecycle and timer plumbing,
- module-only bridges are access-controlled and clearly separated from developer hooks,
- child factories can add setup logic without copying `createInstance()`,
- the docs explain the move lifecycle and state model end-to-end,
- the V2 factory test suite still passes after the refactor,
- one existing game can serve as a minimal reference implementation for external developers.

## Recommended Final Position

For this V2 pass, the protocol should aim for a **template-first, low-risk refactor**:

- aggressively reduce duplication,
- formalize the extension surface in code,
- keep the module architecture,
- fix visibility with self-call bridges,
- add factory hooks,
- avoid a high-risk `Match` storage redesign.

That gives ETour the best chance of being understandable and adoptable by other developers without destabilizing the solid tournament logic that already exists.
