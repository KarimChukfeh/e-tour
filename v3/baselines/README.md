# V3 Copied-Baseline Evidence

Captured on 2026-07-27 from V2 source commit
`3bf167f2600141826d16a6ceaf4a17b357cff205`.

## Toolchain

- Node.js: `22.21.0`
- npm: `10.9.4`
- Hardhat: `2.27.0`
- `@nomicfoundation/hardhat-ethers`: `3.1.2`
- `@nomicfoundation/edr`: `0.12.0-next.16`
- Solidity: `0.8.20`
- OpenZeppelin Contracts: `5.4.0`
- optimizer: enabled, 1 run
- via IR: enabled

`@nomicfoundation/edr` is a direct pin because Hardhat 2.27's allowed semver
range currently resolves EDR 0.12.1, which is incompatible with Hardhat 2.27's
network-provider schema. The known-good V2 lock used `0.12.0-next.16`.

## Reproduction results

- Clean compile: 21 Solidity files compiled successfully.
- Full copied suite: 251 passing.
- Focused-test command: verified with 2 passing active-tournament tests.
- Storage-layout check: 10 targets passed with 20 canonical base entries.
- Contract-size check: all deployable contracts remain under 24,576 bytes.
- Compiler warnings: 42 baseline warnings; see
  [`compiler-warnings.md`](./compiler-warnings.md).

## Critical size baseline

| Contract | Deployed bytes | EIP-170 usage |
|---|---:|---:|
| `ETourInstance_Matches` | 23,841 | 97.0% |
| `ConnectFourInstance` | 21,023 | 85.5% |
| `ChessInstance` | 20,654 | 84.0% |
| `TicTacInstance` | 20,333 | 82.7% |

The complete machine-readable result is in
[`contract-sizes.json`](./contract-sizes.json).

## Lifecycle gas baseline

The deterministic gas scenario uses a four-player Tic-Tac-Toe tournament so a
normal move, a terminal non-settling semifinal move, and the final settling move
can be distinguished.

| Operation | Gas used |
|---|---:|
| Create instance plus creator enrollment | 1,413,302 |
| Ordinary enrollment without tournament start | 381,559 |
| Final enrollment plus tournament start | 840,297 |
| Normal move | 122,919 |
| Terminal match move without tournament settlement | 443,887 |
| Terminal move with tournament settlement | 1,106,249 |

V2 settlement is atomic inside the terminal gameplay transaction, so there is no
separate normal-settlement transaction to measure. The complete deterministic
result is in [`gas-lifecycle.json`](./gas-lifecycle.json); the aggregate suite
report is in [`gas-report.txt`](./gas-report.txt).

## Storage baseline

[`storage-layout.json`](./storage-layout.json) captures:

- `ETourInstance_Base`
- `ETourInstance`
- all three game instance implementations
- all four delegatecall lifecycle modules
- the stateless Chess rules module

The checker requires every stateful instance/module layout to retain the
`ETourInstance_Base` layout as an exact prefix and requires the Chess rules module
to remain stateless.

## Commands

Run these from `v3/` after activating the Node version in `.nvmrc`:

```text
npm ci --ignore-scripts
npm run compile
npm test
npm run test:focused -- --grep "<pattern>"
npm run abi:generate -- --network <network>
npm run abi:sync
npm run frontend:abis
npm run size
npm run size:capture
npm run storage:check
npm run storage:capture
npm run gas
npm run gas:capture
npm run gas:baseline
```

ABI generation requires fresh V3 deployment manifests. Both `abi:sync` and
`frontend:abis` run the complete localhost workflow: compile V3, regenerate ABI
bundles, verify the live Anvil bytecode, convert V3 contract names to the legacy
frontend aliases, discover every JSON imported by `tic-tac-react/src/v2`, and
atomically replace all ten required files under `src/v2/ABIs/`.
