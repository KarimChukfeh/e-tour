# V3 pre-implementation architecture decisions

Date accepted: 2026-07-27

These decisions freeze the starting point for implementation. They may be
changed when testing or audit evidence warrants it, but a change must update
this document, `config/account-abstraction.json`, `plan.md`, `tracking.md`, and
`logs.txt` together.

## PlayerRegistry

V3 deploys a fresh `PlayerRegistry` and fresh `PlayerProfile` implementation.
V2 contracts and profiles remain immutable historical records. The client and
indexer aggregate V2 and V3 history for display instead of granting V3 factories
authority over a V2 registry.

This keeps the deployment, ownership, factory allowlist, incident response, and
audit boundaries generation-specific. No V2 address may be silently reused in a
V3 deployment manifest.

## Session TTL and tournament-duration comparison

The V3 session TTL is fixed at 3,600 seconds (`1 hours`) in contract code. It is
measured from registration or refresh and is not admin-configurable.

The TTL deliberately does not cover the maximum tournament duration:

- enrollment alone can last 30 minutes;
- a match can start each player with 20 minutes;
- the Fischer increment can add 60 seconds per move;
- Connect Four permits up to 42 moves, so one match can consume up to 82 minutes
  of aggregate player clock before escalation time;
- a 32-player tournament has five rounds, making the champion's Connect Four
  path up to 410 minutes of aggregate match clock;
- Chess's fifty-move counter resets on pawn moves and captures, so it does not
  provide a practical one-hour tournament ceiling.

Therefore, no short-lived browser credential can honestly be described as
lasting for every legal tournament. One hour is the security containment window
for a stolen browser key. Refresh is a normal primary-wallet recovery action,
and the primary wallet retains a direct-move fallback after expiry.

## ERC-4337 EntryPoint

V3 pins `@account-abstraction/contracts@0.8.0`, the v0.8 UserOperation schema,
and EntryPoint address
`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` on:

- local chain 412346;
- Arbitrum Sepolia 421614;
- Arbitrum One 42161.

The local environment must deploy the official EntryPoint bytecode
deterministically at the same address; tests must not substitute an arbitrary
address. The [official v0.8 release](https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.8.0)
publishes this address. The
[official v0.9 release](https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.9.0)
is newer, but states that bundlers must explicitly support its mempool. V3 stays
on v0.8 until both selected Arbitrum providers and the complete V3 integration
suite validate a later version.

The pinned v0.8 EntryPoint, account, and factory sources require Solidity
`^0.8.28`. The later local EntryPoint integration step must add a separately
pinned 0.8.28 compiler for those vendor contracts while retaining Solidity
0.8.20 for ETour contracts and re-running every compiler, storage, ABI, and size
baseline.

## Session account and counterfactual deployment

V3 pins the official v0.8 `SimpleAccount` and `SimpleAccountFactory` from
`@account-abstraction/contracts@0.8.0`. ETour deploys the factory
deterministically on each supported network and records its address in
`config/account-abstraction.json`.

The factory's
[`getAddress(owner, salt)`](https://github.com/eth-infinitism/account-abstraction/blob/v0.8.0/contracts/accounts/SimpleAccountFactory.sol)
computes the ERC-1967 proxy CREATE2 address before deployment. Its
`createAccount(owner, salt)` is designed for factory data on the first
UserOperation and is restricted to the EntryPoint `SenderCreator`. Thus V3 can
register the counterfactual executor during enrollment and deploy it atomically
with the first move.

The account-abstraction repository includes OpenZeppelin and Spearbit audit
reports, but its own documentation calls `SimpleAccount` a sample/reference
account. V3 accepts that limited implementation only because the session account
must never hold stake or prize authority and the game registry independently
limits it to one instance, one primary player, `makeMove`, and one TTL. The
pinned v0.8 account/factory and ETour integration remain in the V3 external
audit scope; an adverse review reopens this decision.

## Bundlers

The first two providers are:

1. Pimlico, primary.
2. Alchemy, failover.

Pimlico's current chain reference lists Arbitrum One and Arbitrum Sepolia with
EntryPoint v0.8 and `SimpleAccount` support. Alchemy's
[supported-chain table](https://www.alchemy.com/docs/wallets/supported-chains)
lists Bundler support for both Arbitrum networks, and its
[Bundler FAQ](https://www.alchemy.com/docs/wallets/reference/bundler-faqs)
lists EntryPoint v0.8 and the canonical address.

This is provider selection, not final operational acceptance. Later integration
steps must call `eth_supportedEntryPoints`, estimate, submit, and obtain receipts
through both providers on Arbitrum Sepolia before production.

## Paymaster

The production design uses both:

- an on-chain policy that independently enforces approved V3 factories,
  instances, account wrapper, registered executor, active TTL, `makeMove`
  selector, zero value, gas bounds, chain ID, and EntryPoint; and
- a verifying signature for budget allocation, rate limiting, expiry, and abuse
  response.

The verifier may narrow or decline sponsorship but can never broaden what the
on-chain policy accepts. Paymaster outage or refusal does not alter game
authorization and never blocks a direct primary-wallet transaction.

## EIP-7702

EIP-7702 is deferred until the ERC-4337 V3 MVP passes local and Arbitrum Sepolia
integration tests. The on-chain session model remains executor-agnostic so a
later 7702 transport can reuse the same instance scope, primary identity, TTL,
rotation, and recovery rules.

## Frozen non-negotiable invariants

1. The primary wallet is the enrolled player, stake owner, profile identity,
   tournament actor in stored state/events, and only prize recipient.
2. A session executor is never enrolled and never becomes an escrow,
   withdrawal, rescue, refund, payout, profile, enrollment, timeout,
   escalation, factory, or registry-administration authority.
3. Session authorization is exactly one registry, one V3 instance, one enrolled
   primary, one current executor, one generation, one fixed validity window, and
   the game-specific `makeMove` selector.
4. One executor has at most one live registry binding. Rotation/revocation
   invalidates the old reverse binding and increments generation.
5. Registration is atomic with paid enrollment when a non-zero executor is
   supplied; partial enrollment/session success is forbidden.
6. Only the primary can refresh or revoke. The executor cannot extend, rotate,
   or recover itself.
7. Expiry is enforced by ETour contracts regardless of account, bundler,
   paymaster, or off-chain service behavior.
8. Game state and tournament outcomes for a legal primary move and the
   equivalent legal session move are identical.
9. Game contracts receive normal calls and never decode `UserOperation`.
10. Bundlers and paymasters affect delivery or sponsorship only, never
    consensus validity, escrow, settlement, or recovery.
11. Sponsored gas is separately funded and cannot debit entry fees or prize
    pools.
12. The primary can always use the ordinary direct-wallet path when the session,
    bundler, or paymaster is unavailable.

## Storage and module trust boundary

ADR-012 is accepted and implemented:

- `ETourStorage` is the canonical game-independent storage declaration for
  instances and delegatecall modules.
- `ReentrancyGuard` is inherited first through `ETourStorage`, preserving its
  slot position in every storage consumer.
- All 20 V2 storage entries retain their semantic label, slot, offset, and type
  shape. `SESSION_REGISTRY` is appended at slot 44.
- Modules no longer inherit `ETourInstance_Base` or expose reverting abstract
  stubs. The storage-free `ETourModuleGuard` retains direct-call protection.
- Module-to-instance re-entry is explicit through `IETourInstanceSelf`.
- All six state-changing host bridges enforce `onlySelfCall`; read-only bridges
  remain externally readable.

## Reviewed state-changing instance surface

ADR-017 is accepted and implemented. The complete mutable external surface of
`TicTacInstance`, `ConnectFourInstance`, and `ChessInstance` is recorded in
`config/instance-state-changing-selectors.json`. Each entry records its exact
signature, selector, mutability, applicable contracts, caller classification,
and security rationale.

The allowlist is exact rather than additive: CI fails if a mutable function is
added, removed, changes selector or mutability, or appears on an unreviewed game
instance. This turns every future state-changing entry point into an explicit
security-boundary decision. The corresponding human-readable review is in
`docs/state-changing-selector-review.md`.

Every state-changing module bridge is tested against direct EOA calls and calls
forwarded by an unrelated contract. Rejected calls are required to preserve
canonical storage and observable tournament state. Separate tests prove the
same bridges remain usable through legitimate instance-context delegatecalls.

## Canonical game and factory extension boundary

ADR-018 is accepted and implemented. `ETourGame` is the single owner of common
match creation, reset, restart, result state, Fischer clocks, gameplay-actor
validation, escalation clearing, completion dispatch, protected bridges, and
the internal game-state hash boundary.

Concrete games supply only side-assignment policy, initial packed state,
game-state hashing, optional reset/initialization bookkeeping, legal-move
validation, mutation, terminal detection, history encoding, and views. The
effective-player hook deliberately sits above game rules so session resolution
can be added later without teaching each game about executors.

`ETourFactory.createInstance` is the only creation pipeline. Internal
initialization and post-initialization hooks cover game-specific setup.
Chess no longer duplicates creation and instead configures its rules module
through a factory-only, one-time post hook. Every created clone is recorded in
`isInstance`; implementation contracts are not instances.

## Session registry authority and lifecycle

ADRs 019–021 are accepted and implemented.

The registry authenticates a registration caller through the full deployed
provenance chain: the instance's factory, the factory's `isInstance` mapping,
the `PlayerRegistry.authorizedFactories` allowlist, matching immutable player
and session registry addresses, instance enrollment, and non-conclusion. The
registry deliberately has no owner or privileged session mutation API.

The one-hour TTL is strict and exclusive at `validUntil`. An executor has only
one globally live reverse binding, while a primary may use distinct executors
in distinct instances. Expired and concluded bindings may be reclaimed.
Refresh is rejected after conclusion; explicit primary revocation remains
available for cleanup.

Creator and joiner APIs accept an optional executor. Zero is an explicit
opt-out. A non-zero registration is part of the paid enrollment transaction,
so a registry rejection also rolls back the clone/tier, player/profile,
tournament, accounting, ETH, and event effects.

The implemented registry and enrollment boundaries are documented in
`docs/SessionAuthorization.md`. Session-to-primary gameplay resolution remains
the separate Phase 6 change.
