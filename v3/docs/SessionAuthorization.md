# V3 session authorization

This document describes the on-chain session registry, atomic enrollment, and
gameplay authorization delivered in Phases 4 through 6. An active executor can
submit legal `makeMove` calls for its primary without becoming the tournament
identity or receiving authority over any other instance entry point.

## Authority boundary

The enrolled primary wallet remains the only tournament identity. A session
executor is a temporary transaction sender, never an enrolled player, profile
owner, escrow owner, refund recipient, or prize recipient.

`SessionKeyRegistry` has no owner, administrator, pause role, or privileged
session mutation path:

- an authenticated tournament instance registers the optional initial session;
- the enrolled primary wallet refreshes or revokes its own session;
- the executor cannot extend, rotate, or revoke itself.

The registry is transport-agnostic. An executor may later be an ERC-4337 smart
account, an EIP-7702-compatible account, or another address whose transaction
authorization is enforced outside the game. Game contracts receive ordinary
calls and never decode a `UserOperation`.

## Deployment and provenance

One `SessionKeyRegistry` is deployed against one immutable `PlayerRegistry`.
The same registry address is passed to every V3 factory and copied into every
instance during clone initialization. Factory construction rejects zero,
non-registry, or differently anchored registry addresses.

Registration accepts a caller only when all of these statements are true:

1. the caller exposes a non-zero factory;
2. that factory uses the registry's immutable `PlayerRegistry`;
3. the factory and instance expose this exact `SessionKeyRegistry`;
4. `factory.isInstance(caller)` is true;
5. the `PlayerRegistry` currently authorizes the factory;
6. the primary is enrolled in the caller;
7. the instance has not concluded.

This prevents an arbitrary contract from consuming a globally unique executor
or fabricating enrollment.

## Records and uniqueness

Sessions are keyed by `(instance, primary)`:

```solidity
struct Session {
    address executor;
    uint48 issuedAt;
    uint48 validUntil;
    uint64 generation;
}
```

A reverse `executor -> (instance, primary, generation)` binding makes one
executor globally unique while its session is live. One primary may use
different executors in different instances. Expired or concluded bindings are
inactive and may be reclaimed.

Activity uses an exclusive expiry:

```text
active when block.timestamp < validUntil
expired when block.timestamp == validUntil
```

Every issue or refresh receives the fixed `SESSION_TTL` of 3,600 seconds.
There is no extension operation; refresh creates a new validity window and
increments the generation.

## Lifecycle

### Registration

`registerSession(primary, executor)` is called by the instance during paid
enrollment. It rejects zero addresses, an executor equal to the primary, an
existing active session for the pair, and an executor with another live
binding. Successful registration emits `SessionRegistered`.

### Refresh

`refreshSession(instance, newExecutor)` is called directly by the enrolled
primary. It can issue a session after enrollment opt-out or atomically replace
the current executor. The old reverse binding is removed immediately, the
generation increments, and the TTL restarts. Refresh is rejected after
tournament conclusion.

### Revocation

`revokeSession(instance)` is called directly by the enrolled primary. It clears
the executor and reverse binding and increments the generation. Revocation
remains available after conclusion so the primary can explicitly clean up the
record.

### Views

- `getSession(instance, primary)` returns the stored record, including inactive
  history and its latest generation.
- `getExecutorBinding(executor)` returns the raw reverse binding.
- `resolveSession(instance, executor)` returns a primary only for an exact live
  binding.
- `isSessionActive(instance, primary, executor)` checks the complete binding,
  expiry, generation, and conclusion policy.
- `instance.resolveGameplayPlayer(executor)` reports the direct or delegated
  primary identity that the instance would use for a move, or zero when the
  executor is inactive. Full metadata remains in the registry.

## Gameplay authorization and scope

`ETourGame` owns the only delegated identity boundary. During `makeMove`:

1. an enrolled direct caller resolves to itself;
2. a non-enrolled caller is resolved through
   `SessionKeyRegistry.resolveSession(address(this), caller)`;
3. the resolved primary must be enrolled, assigned to that match, and current;
4. game legality, clock accounting, board ownership, result attribution,
   profiles, and payouts use the primary; and
5. `MoveMade` records both the primary and the actual executor.

No other state-changing instance function uses session resolution. A registered
executor therefore receives no delegated primary authority over enrollment,
cancellation, force-start, timeout claims, escalation, replacement, rescue,
ownership, profiles, refunds, prizes, refresh, or revocation.

Some escalation resolutions intentionally remain permissionless to ordinary
addresses. In particular, an address may claim an abandoned pool after EL2 or
a replacement slot after ML3 when the public eligibility conditions are met.
If that address is also a registered executor, it acts only as itself on those
paths; it is never resolved to the primary. This ordinary permissionless
authority is separate from delegated gameplay authority.

For direct moves, `MoveMade.player == MoveMade.executor`. For delegated moves,
`MoveMade.player` is the enrolled primary and `MoveMade.executor` is the active
session address. Match and tournament completion events continue to name only
the primary result identity.

## Atomic enrollment

The public enrollment APIs are:

```solidity
factory.createInstance(..., address sessionExecutor)
instance.enrollInTournament(address sessionExecutor)
instance.enrollOnBehalf(address primary, address sessionExecutor)
```

`address(0)` is an explicit opt-out and preserves ordinary primary-wallet
enrollment. A non-zero executor is registered after the core enrollment writes
and in the same outer transaction. If registration fails, EVM rollback removes
all effects, including:

- tier creation, clone tracking, and factory events;
- instance player lists, counts, status, fee buckets, and ETH transfer;
- factory player mirrors;
- `PlayerRegistry` profile creation and enrollment records; and
- partial session or reverse-binding state.

Fee percentages and accounting are unchanged from V2.

## Recovery and operational guidance

- Follow [`BrowserSessionIntegration.md`](./BrowserSessionIntegration.md) for
  browser RNG, encrypted IndexedDB persistence, cross-tab locking, CSP,
  recovery sequencing, and direct-primary fallback requirements.
- Generate a fresh executor per tournament by default.
- Treat refresh as the cross-device/cache-loss recovery path.
- Treat revocation as explicit key invalidation and record cleanup.
- Never store or log a browser private key in deployment manifests, analytics,
  server logs, or this registry.
- A one-hour TTL is a containment window, not a promise that every tournament
  completes before expiry.
- The primary wallet always remains the fallback for direct gameplay and
  primary-authorized session refresh/revocation.

## Tests and policy gates

The session suites cover every registration rule, exact expiry boundaries,
refresh, rotation, revocation, conclusion policy, executor uniqueness, expired
binding reclamation, randomized transition sequences, creator/joiner opt-out,
identity and fee preservation, and full rollback on registration failure.
Gameplay coverage adds direct/delegated equivalence for every game, primary and
executor events, stale/missing/mismatched session rejection, refresh recovery,
win/draw profile and prize attribution, an ABI-enumerated denial check for
every non-move mutable instance function, permissionless-path identity, and
property-style active/rotated/revoked/expired transitions.

The ABI and mutable-selector allowlists, storage-layout comparison, static
analysis, dependency audit, compiler-warning gate, EIP-170 size check, and full
V2 behavior suite remain mandatory for later session changes.
