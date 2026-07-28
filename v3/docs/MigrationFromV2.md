# Migrating from V2 to V3

## Migration model

V3 is a new source and deployment generation, not an upgrade to V2. Existing
V2 factories, clones, profiles, tournaments, balances, results, and events stay
where they are. Active V2 tournaments finish on V2. V3 becomes the creation
target for new tournaments only after its testnet, audit, canary, and
operational gates pass.

No migration transaction moves player funds or rewrites historical state.

## Source transition

V3 began as an identical copy of the authoritative V2 directory, including
contracts, modules, tests, scripts, configuration, and ABI tooling. It then
added:

- canonical append-only delegatecall storage and protected self-call bridges;
- shared `ETourGame` and `ETourFactory` extension boundaries;
- fresh V3 profile and session registries;
- optional atomic session registration on creation and joining;
- primary/session identity resolution only for `makeMove`;
- EntryPoint v0.8, counterfactual session accounts, bundler SDK, and paymaster;
- network-scoped manifests, ABI generation, safety checks, and operations docs.

V2 remains unchanged unless a separate V2 hotfix is explicitly requested. Do
not backport V3 storage, constructor, ABI, or session assumptions into V2
deployment tooling.

## On-chain generations

| Concern | V2 | V3 |
| --- | --- | --- |
| Existing tournaments | Continue and settle on V2 | Unaffected |
| New tournaments after cutover | Creation hidden/disabled in clients | Created through V3 factories |
| Player profiles | Existing V2 registry/profile history | Fresh V3 registry/profile history |
| Session authorization | None | Instance-scoped fixed-TTL registry |
| Transaction path | Primary wallet | Primary or ERC-4337 session move |
| Deployment metadata | Legacy root JSON | Canonical network-scoped complete manifest |
| Upgrade strategy | Immutable historical generation | Immutable new generation |

The client and indexer aggregate V2 and V3 profile/tournament history for
display. They must never pretend a V2 profile address is the V3 profile or
authorize a V3 factory on the V2 registry.

## API and ABI changes

Creation and enrollment add an optional executor:

```solidity
factory.createInstance(..., address sessionExecutor)
instance.enrollInTournament(address sessionExecutor)
instance.enrollOnBehalf(address primary, address sessionExecutor)
```

Pass `address(0)` for direct-wallet-only behavior. A nonzero executor registers
atomically; the paid transaction either completes enrollment and session
registration together or reverts everything.

`makeMove` signatures remain game-specific and compatible at the contract
surface. V3 may observe either the primary wallet or active session account as
`msg.sender`; stored actor identity remains the primary. `MoveMade` exposes
both primary player and executor, so indexers must update event decoding.

V3 additionally exposes session inspection, resolution, refresh, and revoke
APIs; factory `isInstance`; the session-account factory/paymaster surfaces; and
new custom errors. Consumers must use V3 ABI bundles for V3 addresses rather
than mixing generations.

The compatibility frontend generator writes the currently imported names under
`tic-tac-react/src/v2/ABIs/`, including legacy game naming aliases. The directory
name is a frontend compatibility constraint, not evidence that V3 addresses
are V2 contracts. Each JSON's network, chain, and addresses must be validated
before use.

## Frontend migration

The application should model deployment generation explicitly:

```text
{ generation, chainId, factory, instance, profileRegistry, sessionRegistry }
```

Do not infer generation from a game name or ABI filename.

Before cutover:

1. Load reviewed V2 and V3 manifests independently.
2. Route each instance read/write through its own generation's ABI and address
   set.
3. Aggregate history without merging profile contract identities.
4. Add the V3 one-confirmation enrollment, session status, recovery, revoke,
   and direct fallback UX.
5. Confirm V2 creation remains available behind a reversible feature flag.
6. Run browser tests for IndexedDB loss, private mode, account/chain changes,
   bundler failures, paymaster refusal, ambiguous nonce, and direct fallback.

At cutover, switch only new creation routing to V3. Existing V2 tournament
links, reads, moves, escalation, claims, and settlement remain routed to V2.

## Indexer and analytics migration

Index all generations with `(chainId, generation, contractAddress)` as part of
identity. For V3:

- ingest session registration, refresh, revoke, generation, and expiry events;
- distinguish `MoveMade.player` from `MoveMade.executor`;
- attribute matches, profiles, prizes, refunds, and settlement to the primary;
- record direct versus delegated transport without treating the executor as a
  player;
- index counterfactual account deployment and UserOperation outcomes as
  delivery metadata, separate from game results;
- monitor V3 factory provenance and implementation pins.

Backfill V2 history before V3 cutover and verify combined user totals against
generation-specific source records. Never rewrite historical V2 events into V3
event shapes.

## Testnet acceptance

Arbitrum Sepolia acceptance requires:

- every V3 source and constructor verified;
- canonical manifest and ABIs published from the reviewed commit;
- both selected bundlers supporting EntryPoint v0.8;
- creator and joiner one-confirmation registration;
- direct and sponsored moves for Tic-Tac-Toe, Connect Four, and Chess;
- first-use account deployment and later operations;
- expiry, refresh, revoke, lost-browser recovery, and direct fallback;
- complete tournament settlement and profile attribution for all games;
- bundler failover and paymaster-unavailable behavior;
- measured gas, calldata, account-deployment, and sponsorship costs;
- long-duration flow crossing the one-hour TTL.

Production migration cannot begin while any acceptance item is incomplete or
while critical/high-confidence security findings remain unresolved.

## Production cutover

1. Deploy from the audited clean commit using the approved deployment wallet.
2. Validate chain, canonical manifest, bytecode, wiring, source verification,
   ownership, allowlists, paymaster deposit, thresholds, and both bundlers.
3. Publish addresses and ABIs before enabling clients.
4. Enable V3 for an internal/allowlisted canary cohort.
5. Complete real canary tournaments for all games and validate settlement,
   session, fallback, monitoring, and support procedures.
6. Expand creation traffic gradually while monitoring UserOperations,
   sponsorship, sessions, payouts, and profiles.
7. Hide V2 creation only after launch approval; retain V2 reads and active
   tournament actions indefinitely.

The decision and evidence must be recorded in `logs.txt` and the release
record. Never use `tracking.md` completion alone as production approval.

## Rollback

Rollback is routing, not state mutation:

1. stop or limit new V3 creation;
2. pause sponsorship only when the incident requires it;
3. preserve direct-primary moves and recovery where safe;
4. route new creation back to V2;
5. keep all existing V3 instances readable and support them through settlement;
6. fix forward with a new reviewed deployment generation if contracts change.

Do not revoke user sessions in bulk, alter match state, drain instances, replace
manifests to disguise chain state, or attempt to upgrade EIP-1167 clones.

## Final replacement criteria

V3 replaces V2 for new activity only when:

- V2 parity and complete V3 tests pass;
- storage, ABI, selector, static, dependency, secret, gas, and size gates pass;
- session/account/paymaster code has completed required external review;
- Arbitrum Sepolia and production canary acceptance are complete;
- source, manifests, ABIs, and user documentation are published;
- monitoring, funding, refill, failover, incident, and support ownership are
  operational;
- direct-primary fallback is proven;
- the UI/indexer retains correct dual-generation history and routing.

V2 contracts are never deleted. “V3 replaces V2” means V3 is the default for
new creation while V2 remains an immutable historical and active-instance
generation.

