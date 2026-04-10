# Building Games on ETour V2

This is the short builder guide.

For the full V2 architecture, module, storage, lifecycle, and extension-surface documentation, start with [`TechnicalDocumentation.md`](./TechnicalDocumentation.md).

## Purpose

ETour V2 is designed so a new game contract can inherit the shared tournament, factory, prize, and escalation infrastructure without reimplementing bracket or payout plumbing.

The canonical extension surface is [`ETourGame.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ETourGame.sol).

## What to inherit

New games should inherit:

```solidity
import "../contracts/ETourGame.sol";

contract MyGame is ETourGame {
    // game hooks + makeMove(...)
}
```

`ETourGame` already provides:

- shared match creation and replay lifecycle,
- shared Fischer clock handling,
- shared escalation-state clearing,
- shared player-order/random-starter assignment,
- shared reset behavior for infra-owned match fields.

## Hooks you implement

### Required

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

### Optional

```solidity
function _resetGameState(bytes32 matchId) internal override;

function _getGameStateHash(bytes32 matchId)
    internal
    view
    override
    returns (bytes32);
```

Use `_resetGameState` when your game stores auxiliary mappings keyed by `matchId`.

Override `_getGameStateHash` when your live game state is not fully represented by the default `packedBoard`, `packedState`, and `moves` fields.

## Player assignment modes

Use:

- `PlayerAssignmentMode.RandomizeStarterOnly`
  - preserves `player1` / `player2`, randomizes only who moves first.
  - current example: Tic-Tac-Toe.
- `PlayerAssignmentMode.RandomizePlayerOrder`
  - randomizes seat order and starts with `player1`.
  - current examples: Connect Four and Chess.

## `makeMove()` contract

Each game defines its own move signature, but every move function should follow the same pattern:

1. Resolve `matchId`.
2. Check `m.status == MatchStatus.InProgress`.
3. Check the caller is a participant and equals `m.currentTurn`.
4. Validate move-specific inputs.
5. Call `_consumeTurnClock(m)`.
6. Apply game-state changes.
7. Append move history if the game exposes it.
8. Call `_clearMatchEscalation(matchId)`.
9. If the move ends the game, call `_completeMatchInternal(...)`; otherwise call `_switchTurn(m)`.

## Match storage model

Infra-owned `Match` fields include:

- players,
- current turn,
- status,
- time banks,
- completion metadata,
- timestamps.

Game-owned `Match` fields include:

- `packedBoard`,
- `packedState`,
- `moves`.

If those fields are not enough, store extra state in your own mappings keyed by `matchId`.

Current example:

- [`Chess.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/Chess.sol) uses `_positionCounts` and `_gameNonce` alongside the base `Match` fields.

## Module bridge functions

Functions like `moduleCreateMatch`, `moduleResetMatch`, and `moduleInitializeMatchForPlay` remain public because ETour modules call them via `this.<fn>()` from delegatecall context.

They are protected with `onlySelfCall`, which means:

- modules can call them through the instance,
- EOAs and external integrations cannot use them directly,
- game authors should not treat them as the primary extension surface.

The real extension surface is the internal hook set in `ETourGame`.

## Factory customization

If a game needs one-time instance setup after `initialize(...)`, customize the factory through:

- `_initializeInstance(...)`
- `_postInitializeInstance(...)`

Current example:

- [`ChessFactory.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ChessFactory.sol) calls `setChessRules(...)` from `_postInitializeInstance(...)` instead of duplicating the full `createInstance()` flow.

## Current reference games

Use these as working examples:

- [`TicTacToe.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/TicTacToe.sol)
- [`ConnectFour.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/ConnectFour.sol)
- [`Chess.sol`](/Users/karim/Documents/workspace/zero-trust/e-tour/v2/contracts/Chess.sol)
