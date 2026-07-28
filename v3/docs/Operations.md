# V3 account-abstraction operations

## Scope and invariants

This runbook covers bundlers, EntryPoint, session accounts, and the move
paymaster. It never authorizes operators to alter tournament state, player
identity, session bindings, match results, or escrow. A primary wallet alone
registers, refreshes, or revokes its session; contracts settle funds according
to game state.

Sponsored gameplay is an availability feature, not a custody dependency.
When sponsorship or bundlers fail, the required safe degradation is a direct
primary-wallet `makeMove`.

## Operational roles

- The paymaster owner is an operations multisig. It controls factory allowlisting,
  pause state, EntryPoint deposit/stake withdrawal, and ownership transfer.
- The paymaster funding wallet replenishes the EntryPoint deposit. It is
  independent from tournament escrow.
- Release operators deploy and verify only reviewed commits and publish signed
  deployment records.
- Responders can disable sponsorship and frontend routing. They cannot rotate a
  player's session key or modify an active match.

All administrative actions require a ticket or incident identifier, simulated
calldata, multisig review, transaction hash, and post-action validation.

## Normal monitoring

Monitor at least:

- primary and failover bundler health, latency, supported EntryPoint, simulation
  failures, submission errors, inclusion latency, and receipt timeouts;
- UserOperation submission, inclusion, revert, duplicate, replacement, and
  dropped-operation rates;
- paymaster EntryPoint deposit, stake state, sponsored operation count, spend
  per window, average cost, and forecast depletion time;
- session registration, rotation, revocation, expiry, failed resolution, and
  direct-wallet fallback counts;
- account deployment failures and nonce conflicts;
- factory authorization, paymaster allowlist, implementation pins, registry
  anchors, and manifest/RPC chain agreement;
- tournament creation, enrollment, completion, payout, and profile-write
  failures.

Run the built-in checks:

```sh
AA_NETWORK=arbitrumSepolia npm run bundlers:check
PAYMASTER_ALERT_THRESHOLD_WEI=50000000000000000 \
PAYMASTER_SPEND_ALERT_WEI=<reviewed-window-limit> \
PAYMASTER_LOOKBACK_BLOCKS=50000 \
npx hardhat run scripts/inspect-paymaster.js --network arbitrumSepolia
node scripts/check-deployment-manifest.js --network arbitrumSepolia
npx hardhat run scripts/smoke-deployment.js --network arbitrumSepolia
```

`inspect-paymaster.js` exits with status 2 when sponsorship is paused, the
deposit is below threshold, or spend exceeds the configured window limit.
Alerting should treat missing metrics and command failures as unhealthy, not as
zero usage.

Recommended alert classes:

| Severity | Condition |
| --- | --- |
| Page | Both bundlers unhealthy; manifest/wiring mismatch; unexpected owner or allowlist; payout anomaly |
| Urgent | Paymaster below refill threshold; abnormal spend; sustained UserOperation rejection or revert spike |
| Warning | Primary bundler unhealthy but failover healthy; rising inclusion latency; unusual session refresh failures |
| Informational | Planned paymaster refill, owner action, release deployment, or expected traffic change |

## Bundler failover

The SDK uses ordered providers from `config/account-abstraction.json`: Pimlico
first and Alchemy second. Failover must preserve the same signed
`PackedUserOperation`; never silently rebuild it with a different nonce or fee.

For a transport error or timeout:

1. Query the original provider for the UserOperation hash and receipt.
2. Query EntryPoint/account nonce and the fallback provider.
3. If inclusion is unknown, resubmit the exact signed operation to the fallback.
4. If the nonce is consumed, locate and present the receipt; do not submit a
   different move.
5. If both providers are unavailable, present direct-primary fallback.

Do not fire the same logical move concurrently with different nonces or fee
fields. The browser SDK's per-account nonce lock must remain held until
inclusion, definitive rejection, or explicit reconciliation.

After failover, record provider, failure class, operation hash, sender, nonce,
target instance, timing, and receipt. Never record signatures or browser-key
material.

## Paymaster refill

The refill threshold must cover the measured peak spend rate through the
longest approved response window plus safety margin. Recalculate it from actual
Arbitrum costs after testnet and canary measurement.

To refill:

1. Validate the paymaster, EntryPoint, network, current owner, deposit, and
   manifest against independent RPCs.
2. Obtain the approved refill amount and funding-wallet authorization.
3. Send native ETH to the paymaster address with empty calldata. Its `receive`
   function immediately deposits the value into EntryPoint.
4. Wait for finality and confirm `getDeposit()` and EntryPoint `balanceOf`.
5. Rerun `inspect-paymaster.js`; record transaction and before/after balances.

Never send refill funds to a session account, game instance, factory, registry,
or tournament escrow. A native balance sitting on the paymaster is not the same
as its EntryPoint deposit; investigate any nonzero native balance.

The current on-chain policy does not require stake for its deterministic
validation logic. If a bundler or production policy requires stake, the owner
must call `addStake(unstakeDelaySec)` under a separately reviewed stake and
withdrawal policy. Stake unlock and withdrawal are delayed and must not be used
as emergency refill mechanisms.

## Emergency sponsorship pause

Pause sponsorship when there is credible paymaster abuse, an allowlist or
factory-provenance discrepancy, an EntryPoint incident, abnormal spend that
cannot be explained, or an unresolved policy bypass.

1. Confirm the target chain and paymaster from the published manifest.
2. Prepare multisig calldata for `setPaused(true)`.
3. Simulate, approve, and execute it.
4. Confirm the `SponsorshipPauseSet(true)` event and `paused()` state.
5. Switch the UI to direct-primary fallback and communicate the availability
   impact.
6. Preserve logs and investigate without rotating user sessions.

Unpause only after the cause is fixed or disproved, tests and simulations pass,
balances and allowlists are reconciled, and release/security owners approve
`setPaused(false)`.

## Incident playbooks

### Primary bundler outage

Keep the failover provider enabled, increase monitoring, reconcile pending
hashes, and verify inclusion/receipt behavior. Do not pause the paymaster solely
because one transport provider is down. Restore primary routing only after a
sustained healthy window.

### All bundlers unavailable

Disable session-submit UI actions that would appear pending indefinitely,
retain session state locally, offer direct-primary moves, and continue read-only
RPC polling. Do not ask players to refresh healthy sessions. Re-enable session
submission only after nonce and pending-operation reconciliation.

### Paymaster low balance

Fail new sponsorship before depletion if the application can do so cleanly,
refill through the approved wallet, and retain direct fallback. Investigate
spend-rate changes before raising limits.

### Paymaster abuse or policy anomaly

Pause immediately, preserve UserOperations and receipts, compare calldata to
the allowed factory/instance/session policy, inspect allowlist changes, and
quantify spend. A contract-policy defect requires a new reviewed deployment;
operators cannot hot-patch the immutable paymaster.

### EntryPoint or canonical infrastructure incident

Pause sponsorship and new V3 creation, keep already-safe direct contract calls
available only after security review, and compare deployed bytecode/address
against the pinned release. EntryPoint is immutable infrastructure; migration
requires a new V3 deployment generation and explicit frontend cutover.

### Lost browser key

The user connects the primary wallet, generates and durably stages a new
encrypted browser key, calls `refreshSession`, waits for confirmation, verifies
the on-chain executor, and only then deletes the old local key. Operators cannot
perform this action for the user.

### Suspected session-key compromise

Prompt the primary wallet to revoke or refresh immediately and offer direct
play. A stolen key can call only in-scope moves until revocation/rotation/TTL;
it cannot withdraw escrow, claim prizes as the primary wallet, refresh itself,
or authorize other selectors.

### Nonce ambiguity or unknown receipt

Stop new session submissions for that account. Query both bundlers and
EntryPoint, compare account nonce, search receipts/logs, and reconcile the exact
operation hash. Never "fix" ambiguity by generating a second logical move.

### Factory, registry, or manifest mismatch

Stop new creation and sponsorship, run the manifest validator and smoke test
against independent RPCs, and compare source-verification metadata. Do not edit
the published manifest to fit unexpected chain state. Publish a corrected
manifest only if the original publication—not on-chain state—was demonstrably
wrong, with an auditable correction notice.

### Settlement or escrow anomaly

Disable new tournament creation and escalate to protocol security. Do not use
paymaster ownership or session controls as a settlement workaround. Preserve
chain data and keep affected users informed.

## Recovery and return to service

Before resolving an incident:

1. Identify root cause and affected networks, contracts, operations, and users.
2. Reconcile every pending UserOperation and administrative transaction.
3. Confirm direct-primary gameplay and escrow invariants.
4. Run focused regression, account-abstraction, smoke, manifest, static, secret,
   and size checks.
5. Validate both bundlers and paymaster simulations.
6. Obtain security/release approval and execute the smallest required change.
7. Monitor a controlled canary before restoring general traffic.
8. Write a post-incident record with no secrets or session-key material.

## Routine change checklist

For bundler endpoints, thresholds, allowlists, ownership, funding, or a new
deployment:

- link the reviewed code/config commit;
- state network, chain ID, canonical manifest hash, and affected address;
- document before/after values and rollback;
- simulate each on-chain action;
- use multisig approval where required;
- run post-change health, smoke, and manifest checks;
- update `logs.txt`, `tracking.md`, and documentation when assumptions change.

