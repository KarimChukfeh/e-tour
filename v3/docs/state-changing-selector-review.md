# V3 instance state-changing selector review

The authoritative machine-readable review is
`config/instance-state-changing-selectors.json`. CI compares it against the
compiled ABIs of Tic-Tac-Toe, Connect Four, and Chess.

## Caller classes

| Class | Selectors |
| --- | --- |
| Instance self only | `initializeRound`, `_createMatchGame`, `_resetMatchGame`, `_setMatchPlayer`, `_initializeMatchForPlay`, `_completeMatchWithResult` |
| Atomic clone initialization | `initialize` |
| Factory-only one-time post-initialization | `initializeChessRules` |
| Factory only | `enrollOnBehalf` |
| Factory owner after conclusion | `rescueStuckFunds` |
| Primary enrollment/lifecycle | `enrollInTournament`, `forceStartTournament`, `cancelTournament`, `resetEnrollmentWindow` |
| Match participant or advanced player | `makeMove`, `claimTimeoutWin`, `forceEliminateStalledMatch` |
| Constrained permissionless escalation | `claimMatchSlotByReplacement`, `claimAbandonedPool` |

The two permissionless escalation functions remain open to ordinary addresses
only after their on-chain timing and eligibility conditions are satisfied. They
do not grant general player identity.

`enrollInTournament(address)` and the factory-only
`enrollOnBehalf(address,address)` accept an optional session executor. That
argument does not grant enrollment or lifecycle authority to the executor.
Non-zero registration is atomic with the primary's paid enrollment; zero is an
explicit opt-out.

## Initializer review

Factories create EIP-1167 clones and initialize them atomically through one
canonical `ETourFactory` flow. `initialize` retains its one-time `_initialized`
protection and receives the non-zero shared session registry. Chess then
configures its non-zero rules module through
`initializeChessRules`, which requires the stored creating factory and rejects
a second call. Both calls finish before the clone is tracked, emitted, or
auto-enrolled, so no other transaction can observe a partially initialized
instance.

## CI policy

`npm run selectors:check` fails when:

- a new state-changing selector appears;
- an allowlisted selector disappears;
- selector bytes or mutability change;
- a selector moves onto or off one of the three game instances; or
- an entry lacks its caller classification or rationale.

ABI snapshots remain a separate whole-surface check. The selector allowlist is
the explicit security review for mutable instance entry points.
