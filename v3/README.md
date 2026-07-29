# ETour V3

ETour V3 is the complete successor to V2 for new tournaments. It preserves the
three fully on-chain games and tournament behavior while adding one-hour,
instance-scoped browser sessions delivered through ERC-4337. A player confirms
creation or enrollment once with the primary wallet, then a temporary encrypted
browser key can submit legal moves without repeated wallet prompts.

V3 is locally complete. Public-testnet infrastructure is intentionally not part
of the development cycle: an isolated Hardhat chain uses Arbitrum One chain ID
42161, deterministic funded player wallets, two independently funded local
bundlers, the canonical EntryPoint, and a locally funded paymaster. External
review, the Arbitrum One production canary, and cutover are still required.
Existing V2 contracts and tournaments remain immutable.

## Security model

- The primary wallet remains the enrolled player, profile identity, escrow
  owner, refund recipient, and prize recipient.
- A session executor is authorized only for `makeMove` in one tournament
  instance and only until its fixed one-hour expiry.
- Registration is atomic with the paid creation/join transaction.
- Only the primary wallet can refresh or revoke a session.
- Games receive ordinary calls and never decode a `UserOperation`.
- The paymaster can sponsor only attested game-instance moves from active
  factory-created session accounts.
- Bundler and paymaster failure never removes direct primary-wallet gameplay.
- Every deployable contract must remain below 24,576 runtime bytes; the stricter
  reviewed size baseline is enforced by CI.

The complete invariants and trust boundaries are in
[`docs/Architecture.md`](./docs/Architecture.md).

## Repository layout

```text
contracts/      V3 factories, instances, modules, registries, and ERC-4337 code
sdk/            Browser session, vault, UserOperation, and bundler TypeScript
test/           V2-parity, session, security, SDK, and account-abstraction tests
scripts/        Deployment, manifests, ABI sync, diagnostics, and policy gates
config/         Pinned EntryPoint/bundler policy and selector allowlists
baselines/      Reviewed ABI, storage, size, static, audit, and gas evidence
deployments/    Canonical network-scoped manifests and ABI bundles
docs/           Architecture, integration, deployment, operations, and migration
archive/        Deliberately retained obsolete V2-era one-off material
plan.md         General implementation guide; intentionally revisable
tracking.md     Ordered execution checklist; intentionally revisable
logs.txt        Current handoff and validation history
```

## Requirements

- Node.js 20 or 22
- npm 10
- A local JSON-RPC node for deployment/integration commands

Install and validate:

```sh
cd v3
npm ci
npm run contracts:check
npm test
npm run ci:checks
```

`npm run contracts:check` compiles the contracts and runs the mandatory
contract-size policy. `npm run ci:checks` runs TypeScript, secret-output,
official ERC-4337 artifact, compiler-warning, size, storage, ABI, V2
compatibility, selector, static-analysis, and dependency gates.

## Local deployment

The preferred complete cycle is one command:

```sh
cd v3
npm run local:arbitrum:cycle
```

It starts and later stops an isolated node on `127.0.0.1:8546`, builds the SDK,
compiles, deploys the complete stack, validates EntryPoint/manifest/wiring,
checks both funded local bundlers, concludes all three games through session
UserOperations, exercises recovery and infrastructure outages, regenerates
network ABIs, checks secret-safe output, and enforces contract sizes. It can
run alongside the ordinary V2/V3 node on port 8545.

Use the full release-grade local cycle when changing protocol behavior:

```sh
npm run local:arbitrum:cycle:full
```

That adds the complete test suite and every CI policy gate. Set
`ARBITRUM_LOCAL_PORT` only when the isolated default port must change.

The ordinary chain-ID-412346 workflow remains available for frontend
compatibility work:

Start the local chain:

```sh
cd v3
npx hardhat node
```

Then deploy and validate in another terminal:

```sh
cd v3
npm run deploy:all:force
npm run deployment:manifest:check
npm run deployment:smoke
npm run frontend:abis
```

The complete manifest is
`deployments/localhost/manifest.json`. The frontend ABI command regenerates the
V3 ABIs, validates deployed bytecode and every imported frontend JSON, and
atomically copies the ten required compatibility payloads to the existing
`tic-tac-react/src/v2/ABIs/` integration directory.

See [`docs/Deployment.md`](./docs/Deployment.md) before a production canary. Do
not deploy public contracts from a dirty tree or publish output before
manifest, smoke, verification, bundler, test, and size checks pass.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile protocol contracts |
| `npm test` | Build the SDK and run the complete suite |
| `npm run test:aa` | Run EntryPoint, UserOperation, paymaster, and failover tests |
| `npm run test:sdk` | Run browser session SDK tests |
| `npm run test:fuzz` | Run the extended session/game/provenance invariant campaign |
| `npm run coverage:session` | Produce and enforce the session-authorization coverage report |
| `npm run natspec:check` | Require complete NatSpec on every public/external production API |
| `npm run size` | Reject EIP-170 or reviewed-baseline violations |
| `npm run storage:check` | Verify canonical delegatecall storage |
| `npm run selectors:check` | Verify the complete mutable instance surface |
| `npm run deployment:manifest:check` | Validate the canonical localhost manifest |
| `npm run deployment:smoke` | Verify deployed code and protocol wiring |
| `npm run local:arbitrum:cycle` | Run the isolated local Arbitrum-shaped acceptance cycle |
| `npm run local:arbitrum:cycle:full` | Add full tests and CI gates to that cycle |
| `npm run frontend:abis` | Generate, validate, and sync frontend ABI JSON |
| `npm run paymaster:inspect` | Report deposit, stake, pause, and sponsored spend |
| `npm run release:prepare` | Generate the checksum-bearing Arbitrum One release template |
| `npm run release:freeze:check` | Verify the exact audit-candidate source/tooling/test freeze |
| `npm run release:ready -- local` | Validate the current staged release evidence |
| `npm run routing:check` | Reject unsafe V2/V3 creation and rollback routing |

Capture commands such as `size:capture`, `storage:capture`, and `abi:capture`
change reviewed baselines. Use them only after inspecting and approving the
underlying change; never capture a baseline to hide an invalid regression.

## Documentation

- [`docs/Architecture.md`](./docs/Architecture.md): contracts, storage,
  delegatecall, identity, and trust boundaries
- [`docs/SessionAuthorization.md`](./docs/SessionAuthorization.md): registry,
  TTL, scope, events, refresh, revoke, and threat containment
- [`docs/AccountAbstraction.md`](./docs/AccountAbstraction.md): EntryPoint,
  account, UserOperation, bundlers, and sponsorship
- [`docs/BrowserSessionIntegration.md`](./docs/BrowserSessionIntegration.md):
  key vault, frontend lifecycle, UX states, recovery, and fallback
- [`docs/BuildingGames.md`](./docs/BuildingGames.md): canonical game/factory
  extension surface and required tests
- [`docs/Deployment.md`](./docs/Deployment.md): order, configuration,
  manifests, verification, and publication
- [`docs/Operations.md`](./docs/Operations.md): monitoring, failover, refill,
  pause, incidents, and recovery
- [`docs/MigrationFromV2.md`](./docs/MigrationFromV2.md): dual-generation
  rollout, history, cutover, and rollback
- [`docs/SecurityReview.md`](./docs/SecurityReview.md): internal privilege,
  call-graph, identity, escrow, payout, and finding review
- [`docs/ExternalAuditScope.md`](./docs/ExternalAuditScope.md): independent
  audit boundary, evidence, and remediation requirements
- [`docs/ProductionRelease.md`](./docs/ProductionRelease.md): staged readiness,
  Arbitrum One canary, cutover, generation routing, and rollback

`plan.md`, `tracking.md`, and `logs.txt` are living coordination documents.
They should be corrected when implementation evidence changes the route, while
preserving the core identity, escrow, session-scope, and recovery invariants.
