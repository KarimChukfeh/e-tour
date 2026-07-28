# Building a V3 game

V3 games inherit `ETourGame`. The abstraction is the boundary between
tournament infrastructure and rules that belong to one game.

```text
ETourStorage
  └─ ETourInstance_Base
       └─ ETourInstance
            └─ ETourGame
                 └─ ConcreteGame
```

`ETourStorage` owns the canonical delegatecall-compatible layout.
`ETourInstance_Base` owns tournament enrollment, settlement, profiles, and
views. `ETourInstance` owns escalation entry points. `ETourGame` owns the common
match lifecycle and the concrete contract owns only its rules and
representation.

## Responsibilities

| `ETourGame` owns | A concrete game owns |
| --- | --- |
| Protected module bridges | Board or game-state representation |
| Match creation, reset, restart, and result storage | Legal-move validation |
| Primary gameplay-actor and turn checks | State mutation |
| Fischer clock accounting | Win and draw detection |
| Escalation-state clearing after a valid move | Move-history encoding |
| Completion dispatch to tournament modules | Game-specific views and events |
| Common entropy envelope | Hashing game-owned state |

Concrete games must not redeclare bridge functions or duplicate common clock,
completion, reset, or escalation logic.

## Required hook surface

Every game implements three hooks:

```solidity
function _randomizesPlayerOrder() internal pure returns (bool);

function _initialGameState(bytes32 matchId)
    internal
    view
    returns (uint256 board, uint256 state);

function _gameStateHash(bytes32 matchId)
    internal
    view
    returns (bytes32);
```

`_randomizesPlayerOrder` selects between randomized side/color assignment and
stable player slots with a randomized starter. `_initialGameState` supplies the
two packed fields stored in the canonical `Match`. `_gameStateHash` commits only
game-owned state into tournament entropy; infrastructure modules do not inspect
game internals.

Two optional hooks support extra bookkeeping:

```solidity
function _afterMatchReset(bytes32 matchId) internal;

function _afterMatchInitialized(bytes32 matchId, bool isRestart) internal;
```

Chess uses these hooks to invalidate old repetition counts and record the
initial position. Its historical reset plus restart sequence increments the
repetition nonce twice, exactly as V2 did.

## Implementing a move

A concrete `makeMove` should follow this order:

1. Validate game-specific input bounds.
2. Load the canonical `Match`.
3. Resolve and validate the actor with
   `_requireCurrentGameplayPlayer(matchData)`, retaining both returned values:
   `(player, executor)`.
4. Validate the move against game state.
5. Call `_accountForMove(matchId, matchData, player)` once.
6. Mutate game state and append move history.
7. Emit the game-specific move event using both the resolved primary player
   and observed executor.
8. Call `_completeMatchInternal` for a terminal result or switch turns.

Do not use `msg.sender` as the stored player after actor resolution.
`resolveGameplayPlayer(executor)` returns an enrolled direct caller as itself,
resolves an active instance-scoped session executor through
`SessionKeyRegistry`, and returns zero for inactive executors. Only
`makeMove` uses this resolution. The executor is diagnostic event data; turn,
piece/color, winner, profile, and payout state always use the primary.

`_accountForMove` updates the correct Fischer clock, applies the configured
increment, updates `lastMoveTime`, and clears all match escalation state.

## Bridge and storage rules

The six mutable module bridges are implemented once in `ETourGame` and enforce
`onlySelfCall`. Modules reach them through `IETourInstanceSelf(address(this))`
from delegatecall context. Never weaken this modifier or add an unreviewed
mutable bridge.

Game-specific state may be declared after inherited storage. Shared
game-independent state belongs only in the append-only section of
`ETourStorage`. Never reorder canonical fields.

Run the following after any game change:

```text
npm run storage:check
npm run selectors:check
npm run abi:check
npm run size
```

Session executors have no delegated authority on enrollment, cancellation,
force-start, timeout, escalation, replacement, rescue, ownership, profile, or
settlement functions. `claimAbandonedPool` and replacement claims retain their
documented permissionless ordinary-caller semantics: a session executor may
call them only as its own address, never as its bound primary.

## Mandatory bytecode-size loop

For every Solidity change, compile and run `npm run size` before considering
the change complete. `npm run contracts:check` performs both operations.
Anything above 24,576 deployed bytes is invalid; do not capture a new baseline
to waive it. Optimize code or storage access, extract shared logic, or split the
contract into modules/libraries, then repeat the check. Run the size gate again
as part of `npm run ci:checks` before handoff.

## Factory integration

All game factories inherit the single `ETourFactory.createInstance` pipeline.
The pipeline validates configuration, creates or reuses a tier, clones the
implementation, initializes it, runs a post-initialization hook, records
`isInstance`, emits `InstanceDeployed`, and auto-enrolls the creator.

Every factory constructor receives the shared `PlayerRegistry` and
`SessionKeyRegistry`. The canonical `createInstance` API receives
`sessionExecutor` as its final argument. Concrete factories must forward the
registry addresses and must not implement a second enrollment path; this keeps
optional session registration atomic with creator enrollment.

Most games need no factory override. A game that requires one-time setup may
override only:

```solidity
function _postInitializeInstance(address instance) internal override;
```

Chess uses this hook to call `initializeChessRules`. The instance method is
factory-only, non-zero-address checked, and one-time. Do not override
`createInstance` to duplicate the pipeline.

`factory.isInstance(candidate)` is the canonical provenance check for clones
created by that factory. The shared implementation address is deliberately not
an instance.

## Required tests

A new game must prove:

- canonical factory creation and creator auto-enrollment;
- correct `isInstance` provenance;
- initial board/state and side assignment;
- normal, invalid, terminal, timeout, draw, and escalation behavior;
- reset and restart bookkeeping;
- direct EOA and unrelated-contract rejection for every bridge;
- legitimate module-driven bridge success;
- storage-prefix compatibility;
- no unexpected mutable selector;
- all deployable bytecode remains below EIP-170; and
- the complete V3 behavioral and gas suites still run.
