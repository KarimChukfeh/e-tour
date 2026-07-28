# V3 session authorization

This document describes the on-chain session registry and atomic enrollment
integration delivered in Phases 4 and 5. Gameplay delegation itself is added in
Phase 6. Until then, a registered executor is visible and recoverable on-chain
but cannot call `makeMove` on behalf of the primary.

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

- Generate a fresh executor per tournament by default.
- Treat refresh as the cross-device/cache-loss recovery path.
- Treat revocation as explicit key invalidation and record cleanup.
- Never store or log a browser private key in deployment manifests, analytics,
  server logs, or this registry.
- A one-hour TTL is a containment window, not a promise that every tournament
  completes before expiry.
- The primary wallet remains the fallback for recovery and, after Phase 6,
  direct gameplay.

## Tests and policy gates

The session suites cover every registration rule, exact expiry boundaries,
refresh, rotation, revocation, conclusion policy, executor uniqueness, expired
binding reclamation, randomized transition sequences, creator/joiner opt-out,
identity and fee preservation, and full rollback on registration failure.

The ABI and mutable-selector allowlists, storage-layout comparison, static
analysis, dependency audit, compiler-warning gate, EIP-170 size check, and full
V2 behavior suite remain mandatory for later session changes.
