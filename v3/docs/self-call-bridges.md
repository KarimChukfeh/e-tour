# V3 self-call bridge inventory

This inventory records the state-changing instance functions that exist solely
to let delegatecall modules re-enter the instance. The canonical module host
surface is `IETourInstanceSelf`.

## Protected state-changing bridges

| Selector signature | Implementation | Legitimate caller path |
| --- | --- | --- |
| `initializeRound(uint8)` | `ETourGame` | Instance enrollment or force-start flow calls `this.initializeRound(...)` |
| `_createMatchGame(uint8,uint8,address,address)` | `ETourGame` | Matches module through `IETourInstanceSelf(address(this))` |
| `_resetMatchGame(bytes32)` | `ETourGame` | Matches module through `IETourInstanceSelf(address(this))` |
| `_setMatchPlayer(bytes32,uint8,address)` | `ETourGame` | Matches or escalation module through `IETourInstanceSelf(address(this))` |
| `_initializeMatchForPlay(bytes32)` | `ETourGame` | Matches or escalation module through `IETourInstanceSelf(address(this))` |
| `_completeMatchWithResult(bytes32,address,bool)` | `ETourGame` | Escalation module through `IETourInstanceSelf(address(this))` |

Every implementation above enforces `onlySelfCall`, which requires
`msg.sender == address(this)`.

## Read-only module bridges

The following functions do not mutate state and intentionally remain externally
readable:

- `_getMatchResult(bytes32)`
- `_getMatchPlayers(bytes32)`
- `_getTimeIncrement()`
- `_hasCurrentPlayerTimedOut(bytes32)`
- `_isMatchActive(bytes32)`
- `_getActiveMatchData(bytes32,uint8,uint8)`

## Verification command

Use:

```sh
rg -n "this\\." v3/contracts --glob '*.sol'
```

The expected production direct `this.` calls are the three round-initialization
calls in `ETourInstance_Base`. Module host calls must be spelled through
`IETourInstanceSelf(address(this))`. Additional direct self-calls exist only in
the explicitly test-only Chess lifecycle harness.

The ABI-driven adversarial suite in
`test/security/SelfCallBridges.test.js` applies the complete bridge table to all
three games. It proves that direct EOAs and unrelated contracts are rejected,
rejected calls preserve state, production module round initialization succeeds,
and all six bridges remain callable from legitimate delegatecall context.

All six mutable bridges now have one implementation in `ETourGame`; concrete
games cannot accidentally drift in bridge authorization or lifecycle behavior.

The broader mutable instance surface is frozen by
`config/instance-state-changing-selectors.json` and checked with
`npm run selectors:check`.
