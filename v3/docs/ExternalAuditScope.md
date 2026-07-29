# V3 External Audit Package

## Required scope

The independent review must include:

- canonical `ETourStorage` layout across every instance and delegatecall module;
- protected module self-call bridges and the external selector allowlist;
- factory clone provenance, initialization, and `isInstance` attestations;
- primary-player/session-executor resolution for all three games;
- enrollment atomicity, escrow, refunds, prizes, owner accounting, rescue, and
  PlayerRegistry/Profile attribution;
- session registration, TTL boundary, uniqueness, refresh, revocation, and
  lost-browser recovery;
- EntryPoint v0.8 integration, session-account counterfactual deployment,
  signature domain, nonce/replay behavior, and execution isolation;
- paymaster account/factory/target/value/selector/session/gas/cost policy;
- deployment order, immutable configuration, ownership, funding, pause,
  monitoring, verification, rollback, and generation routing.

The auditor must review all production Solidity sources, the browser/SDK
encoding boundary, deployment scripts, the internal finding register, test
evidence, compiler settings, ABI/storage/size baselines, and the audit-freeze
checksum.

## Deliverables

The release record must contain:

1. auditor and engagement reference;
2. final report file and SHA-256;
3. every finding with severity, status, owner, and rationale;
4. a regression test for every code correction;
5. explicit acceptance rationale and owner for retained medium/low risk;
6. confirmation of zero unresolved critical and high findings;
7. the remediated source commit and matching `release-freeze.json`.

Do not set `externalAudit.status` to `complete` in
`config/release-status.json` until these artifacts exist. The readiness gate
checks the report file, checksum, and critical/high counts.

## Auditor handoff commands

```bash
npm --prefix v3 ci
npm --prefix v3 run compile
npm --prefix v3 test
npm --prefix v3 run ci:checks
npm --prefix v3 run security:check
npm --prefix v3 run release:freeze:check
npm --prefix v3 run local:arbitrum:cycle:full
```

Any remediation that changes a frozen input invalidates the old freeze. After
reviewing the change, rerun all gates and capture a new freeze for the exact
remediated candidate.
