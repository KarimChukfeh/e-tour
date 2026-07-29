# V3 Internal Security Review

Date: 2026-07-28  
Status: Internal review complete; independent external audit still required

## Review boundary

This review covers the production Solidity sources, canonical storage layout,
delegatecall module boundaries, protected self-call bridges, factory/instance
provenance, primary/session identity resolution, escrow and payout paths,
PlayerRegistry/Profile writes, ERC-4337 validation, paymaster policy, and
deployment-role configuration.

It does not claim independent-auditor assurance. The release gate intentionally
fails at `audit`, `production`, and `cutover` stages until real evidence is
entered in `config/release-status.json`.

## Privilege and call graph

| Actor | Authorized calls | Explicitly excluded |
|---|---|---|
| Primary player | Create/join with stake, direct moves, refresh/revoke session, player-owned lifecycle actions and withdrawals | Protocol administration |
| Session executor | `makeMove` on its one active instance before `validUntil` | Enrollment, escrow, refunds, prizes, cancellation, timeout claims, rescue, ownership, refresh/revoke, arbitrary calls |
| Instance clone | Protected factory profile-registration and owner-share callbacks; registry result/match writes for itself | Writing another instance's records |
| Factory | Deploy and initialize its pinned clone; attest `isInstance`; enrollment profile write | Gameplay and session rotation |
| PlayerRegistry owner | Authorize/deauthorize game factories and transfer ownership | Direct profile result fabrication, session assignment, escrow |
| Session registry | Resolve active instance/player/executor bindings | Tournament funds and gameplay mutation |
| Session-account owner key | Ask its immutable account to call one game target | Primary-wallet authority or tournament funds |
| EntryPoint | Validate and execute correctly signed UserOperations | Changing game rules |
| Paymaster owner | Pause sponsorship, manage isolated EntryPoint deposit/stake and factory allowlist | Broaden on-chain selector/value/session checks; tournament escrow |
| Protocol/factory owner | Deployment configuration, owner-share withdrawal fallback, post-conclusion rescue path | Active pot redirection through session authorization |

The security-sensitive write path is:

```text
browser key
  -> EntryPoint validates UserOperation
  -> immutable ETourSessionAccount validates owner signature and nonce
  -> ETourSessionPaymaster validates account provenance, factory provenance,
     zero value, makeMove selector, live session binding, and gas/cost caps
  -> game instance resolves executor -> primary in SessionKeyRegistry
  -> game mutates the primary player's active match
  -> instance conclusion writes profile/result for address(this)
  -> PlayerRegistry verifies caller == supplied instance
  -> authorized factory verifies isInstance(instance)
  -> PlayerProfile records primary identity and payout metadata
```

## Storage and delegatecall

- `ETourStorage` is the canonical shared layout inherited by instances and
  modules in the same order.
- Automated layout comparison fails on incompatible instance/module layouts.
- State-changing module bridges require `msg.sender == address(this)`.
- The selector allowlist fails when an unreviewed external state-changing
  selector enters an instance ABI.
- Game modules cannot resolve a session into escrow or ownership authority.

## Identity, escrow, and payout conclusions

- Enrollment and the ETH entry fee originate from the primary wallet or the
  factory's primary-preserving creator path.
- Brackets, turns, clocks, results, profiles, refunds, and prizes store or pay
  the primary address.
- Move events retain both primary and observed executor for diagnosis.
- A session account holds no primary-wallet authority and does not become an
  enrolled player.
- Sponsorship deposits are separate from tournament balances and owner shares.
- Direct primary gameplay remains valid during bundler/paymaster failure.

## Internal findings

The authoritative machine-readable register is
`baselines/internal-security-review.json`.

### V3-INT-001 — High — fixed

`PlayerRegistry` previously trusted any contract that returned an authorized
factory from `factory()`. A malicious contract could pass a genuine instance
address and attempt to finalize profile/result data before the real instance.

The registry now requires:

1. the caller equals the supplied instance;
2. the reported factory is authorized;
3. that factory returns `true` from `isInstance(instance)`; and
4. the game type comes from that attesting factory.

Regression coverage proves forged tournament results and match outcomes leave
the real profile unchanged.

### V3-INT-002 — High — fixed

`ETourFactory.registerPlayer` and `receiveOwnerShare` previously accepted calls
from arbitrary addresses. Direct calls could pollute factory-local profile
mirrors and emit false lifecycle events. Both callbacks now require
`isInstance[msg.sender]`. Registry enrollment also independently verifies the
factory's instance attestation and declared game type.

### V3-INT-003 — Medium — accepted

A valid live session can submit a policy-compliant but illegal move that
reverts and consumes sponsored gas. This cannot mutate gameplay, identity, or
escrow. The availability/economic risk is controlled by a capped isolated
deposit, emergency pause, refill/spend alerts, provider rate limits, and direct
primary fallback.

### V3-INT-004 — Low — accepted

Production administration retains explicit factory authorization, paymaster,
deployment, and post-conclusion recovery roles. These are documented trust
assumptions. Production must assign them to recorded multisigs, monitor their
events, and include them in the independent audit.

## Static and dynamic evidence

- Solhint runs over every contract and fails on any new or increased finding.
  The inherited V2 style baseline remains visible rather than silently hidden.
- ABI, state-changing selector, compiler warning, storage layout, dependency,
  secret-output, official ERC-4337 artifact, and EIP-170 gates run in CI.
- Focused adversarial tests cover every corrected internal finding.
- Session tests cover random registration, expiry, rotation, revocation, stale
  executors, cross-instance binding, and state preservation.
- The full local Arbitrum-shaped rehearsal exercises two bundlers, full
  bundler outage, paymaster outage, recovery, settlement, and all three games.

## Release conclusion

There are no unresolved critical or high findings in the internal register.
That is necessary but not sufficient for production. The external audit,
finding remediation, real Arbitrum One verification, capped canary, and
explicit cutover approval remain hard gates.
