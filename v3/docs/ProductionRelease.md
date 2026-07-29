# Arbitrum One Canary, Cutover, and Rollback

## Release states

Production advances through four machine-checked stages:

| Stage | Meaning |
|---|---|
| `local` | Internal review, release template, and audit freeze are present |
| `audit` | Independent report is checksummed and has zero unresolved critical/high findings |
| `production` | Audited contracts are deployed, verified, monitored, and the capped paymaster is funded |
| `cutover` | All-game canary is approved and an explicit approver routes new creation to V3 |

Run `npm run release:ready -- <stage>`. Later stages intentionally fail until
their real evidence exists.

## Production preparation

`npm run release:prepare` creates
`deployments/arbitrumOne-release-template.json`. It contains the canonical
EntryPoint, role/environment inputs, expected creation/runtime bytecode hashes,
ABI checksums, verification command, and post-deployment gates. Addresses and
verification flags remain empty until real transactions and explorer evidence
exist.

Before deployment:

1. use the exact audited source commit and audit freeze;
2. confirm the deployer, protocol-owner, paymaster-owner, and funding multisig;
3. revalidate both production bundlers against EntryPoint v0.8;
4. choose a deliberately capped paymaster deposit and alert threshold;
5. run the full local Arbitrum-shaped release rehearsal;
6. obtain explicit authorization for irreversible public deployment.

## Capped canary

Enable dashboards and alerts before accepting a canary player. Then run a
limited two-player tournament in each game:

- Tic-Tac-Toe: sponsored creation/join sessions and a terminal move;
- Connect Four: sponsored normal and terminal moves;
- Chess: legal sequence ending in settlement under the production gas caps.

Across those tournaments, deliberately exercise:

- primary-authorized session refresh and stale-executor rejection;
- revocation and direct-primary recovery;
- primary-to-secondary bundler failover without nonce reuse;
- temporary sponsorship unavailability and direct-primary fallback;
- profile, prize, owner-share, event attribution, and permanent-record checks.

The canary report records contract addresses, transaction/UserOperation hashes,
latency, rejections, gas, sponsorship debits, failure/recovery evidence, and
the security/release decision. A template cannot substitute for actual
on-chain evidence.

## Cutover

Cutover affects only new creation and enrollment routing:

1. record the approved canary report in `config/release-status.json`;
2. record approver and timestamp;
3. change `config/generation-routing.json` so V3 creation is enabled/default
   and V2 creation is hidden;
4. keep V2 and V3 reads enabled;
5. keep active V2 gameplay enabled until every tournament concludes;
6. publish the checksummed V3 address book, ABIs, source commit, audit, and
   migration notice;
7. update UI and indexer generation tags so combined history never conflates
   V2 and V3 contracts.

`npm run routing:check` rejects a V3 default unless the release record shows a
verified deployment, approved canary, and explicit cutover.

## Rollback

Rollback never upgrades, pauses, or mutates existing instances. It changes only
where new creation is routed:

- set the default creation generation back to the last approved generation;
- stop new paymaster sponsorship if the incident involves AA infrastructure;
- retain direct-primary access to existing V3 games;
- retain active V2 gameplay and both generations' historical reads;
- reconcile pending UserOperations, deposits, tournament accounting, profiles,
  and payouts before reopening creation.

This preserves the on-chain permanence of both generations and prevents a
frontend routing incident from becoming a protocol-state migration.
