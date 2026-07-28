# V3 deployment and verification

## Purpose and source of truth

This guide is the operator procedure for local, Arbitrum Sepolia, and Arbitrum
One deployments. The complete deployment command is
`scripts/deploy-all-factory.js`. A run is publishable only when its canonical
`deployments/<network>/manifest.json` passes the manifest validator, on-chain
smoke test, source-verification plan, ABI generation, and contract-size gate.

The canonical manifest is the source of truth for addresses and constructor
arguments. Root-level deployment JSON files exist only for V2-compatible local
frontend tooling or as network-prefixed compatibility files. New tooling must
read `deployments/<network>/` first.

## Supported targets and safety gates

| Hardhat network | Chain ID | Intended use |
| --- | ---: | --- |
| `hardhat` | `412346` | In-process tests |
| `localhost` | `412346` | Local EntryPoint and end-to-end development |
| `arbitrumSepolia` | `421614` | Public testnet acceptance |
| `arbitrum` | `42161` | Production canary and production |

Deployment scripts reject a known network name paired with the wrong chain ID.
Unknown targets require `ALLOW_UNRECOGNIZED_DEPLOYMENT_NETWORK=1` after an
explicit review. Public-network deployment from a dirty source tree is rejected
unless `ALLOW_DIRTY_DEPLOYMENT=1`; that override is for exceptional recovery,
must be recorded in the release log, and does not make an unreviewed deployment
acceptable.

Use Node 20 or 22 and the lockfile. Hardhat 2 does not support Node 23.

Before a public deployment:

1. Check out the reviewed commit and confirm `git status --short` is empty.
2. Run `npm ci`.
3. Run `npm run ci:checks`, `npm test`, and `npm run size`.
4. Confirm every deployable is below the 24,576-byte EIP-170 limit and the
   stricter reviewed V3 headroom baseline.
5. Confirm the deployment wallet is on the intended chain and has enough ETH.
6. Confirm the canonical EntryPoint v0.8 address has code.
7. Confirm both configured bundlers advertise support for that EntryPoint.
8. Record the selected paymaster owner, funding wallet, initial deposit, alert
   threshold, and incident contact.

Never place private keys or API keys in a deployment manifest, command output,
tracked `.env` file, or `logs.txt`.

## Configuration

Hardhat reads the repository-root `.env`. Public runs use:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PRIVATE_KEY` | Yes | Deployment signer; inject through the approved secret store |
| `ARBITRUM_SEPOLIA_RPC_URL` | Testnet | Arbitrum Sepolia RPC |
| `ARBITRUM_RPC_URL` | Production | Arbitrum One RPC |
| `ARBISCAN_API_KEY` | Verification | Source-verification API credential |
| `PAYMASTER_OWNER_ADDRESS` | Public | Operations multisig that receives paymaster ownership |
| `PAYMASTER_FUNDING_ADDRESS` | Public | Funding wallet recorded as non-authoritative metadata |
| `PAYMASTER_DEPOSIT_WEI` | Optional | Initial EntryPoint deposit; public default is zero |
| `PIMLICO_API_KEY` | Acceptance | Primary bundler health check |
| `ALCHEMY_API_KEY` | Acceptance | Failover bundler health check |

`PAYMASTER_OWNER_ADDRESS` and `PAYMASTER_FUNDING_ADDRESS` should be separate
from tournament escrow and ordinary player wallets. If the initial deposit is
zero, fund the paymaster after ownership and address review.

## Final deployment order

`deploy-all-factory.js` executes this order:

1. Validate network, chain ID, git commit, dirty state, and compiler metadata.
2. Confirm or deterministically deploy the canonical EntryPoint v0.8 stack and
   official reference `SimpleAccountFactory`.
3. Deploy the four shared instance modules:
   `ETourInstance_Core`, `ETourInstance_Matches`, `ETourInstance_Prizes`, and
   `ETourInstance_Escalation`.
4. Deploy `ChessRulesModule`.
5. Deploy a fresh `PlayerProfile` implementation.
6. Deploy a fresh `PlayerRegistry` pointing at that implementation.
7. Deploy `SessionKeyRegistry` pointing at the V3 `PlayerRegistry`.
8. Deploy `ETourSessionAccountFactory` pointing at EntryPoint.
9. Deploy `ETourSessionPaymaster` pointing at EntryPoint, the session registry,
   and the session-account factory; apply the initial deposit.
10. Deploy `TicTacChainFactory`, `ConnectFourFactory`, and
    `ChessOnChainFactory`. Each factory deploys and permanently pins its game
    implementation.
11. Authorize all three factories in `PlayerRegistry`.
12. Allow all three factories in the paymaster sponsorship policy.
13. Transfer paymaster ownership to `PAYMASTER_OWNER_ADDRESS`, when configured.
14. Atomically write network-scoped deployment and ABI files.
15. Atomically write the complete canonical manifest last.

The deployment deliberately creates a fresh V3 profile registry. Do not pass or
publish a V2 registry as the V3 registry.

## Constructor reference

| Contract | Constructor arguments, in order |
| --- | --- |
| `PlayerProfile` | none |
| `PlayerRegistry` | `playerProfileImplementation` |
| `SessionKeyRegistry` | `playerRegistry` |
| `ETourSessionAccountFactory` | `entryPoint` |
| `ETourSessionPaymaster` | `entryPoint`, `sessionRegistry`, `sessionAccountFactory` |
| `TicTacChainFactory` | `core`, `matches`, `prizes`, `escalation`, `playerRegistry`, `sessionRegistry` |
| `ConnectFourFactory` | `core`, `matches`, `prizes`, `escalation`, `playerRegistry`, `sessionRegistry` |
| `ChessOnChainFactory` | `core`, `matches`, `prizes`, `escalation`, `chessRules`, `playerRegistry`, `sessionRegistry` |

The three implementation contracts and four shared modules have no constructor
arguments. `ETourSessionAccount` is counterfactually created per browser
session with EntryPoint, browser owner, and factory values fixed by the account
factory; it has no singleton deployment address.

## Local deployment

Start a clean local node in one terminal:

```sh
cd v3
npx hardhat node
```

In a second terminal:

```sh
cd v3
npm run contracts:check
npm run deploy:all:force
npm run deployment:manifest:check
npm run deployment:smoke
npm run abi:generate -- --network localhost
npm run frontend:abis
```

Then run the focused EntryPoint/UserOperation and full protocol suites:

```sh
npm run test:aa
npm test
npm run ci:checks
npm run size
```

The local deployment defaults to a 0.5 ETH paymaster deposit. `FORCE=1`
redeploys modules instead of reusing a bytecode-validated local module cache.

## Arbitrum Sepolia deployment

Run from a clean reviewed commit:

```sh
cd v3
npm run contracts:check
AA_NETWORK=arbitrumSepolia npm run bundlers:check
npx hardhat run scripts/check-entrypoint.js --network arbitrumSepolia
npx hardhat run scripts/deploy-all-factory.js --network arbitrumSepolia
node scripts/check-deployment-manifest.js --network arbitrumSepolia
npx hardhat run scripts/smoke-deployment.js --network arbitrumSepolia
DRY_RUN=1 npx hardhat run scripts/verify-deployment.js --network arbitrumSepolia
npx hardhat run scripts/verify-deployment.js --network arbitrumSepolia
node scripts/regenerate-abis.js --network arbitrumSepolia
```

After verification, rerun the smoke and manifest checks. Publish only the
`deployments/arbitrumSepolia/` output from the reviewed deployment commit.
Testnet acceptance additionally requires complete create, join, direct move,
sponsored move, refresh, revoke, expiry, recovery, tournament settlement,
bundler failover, and paymaster-unavailable fallback flows for all three games.

## Arbitrum One

Arbitrum One uses the same process with network `arbitrum`, but only after
testnet acceptance, audit remediation, and canary approval. Start with a
limited paymaster deposit and controlled creation traffic. Verify and publish
the manifest before routing general frontend traffic to V3.

Rollback never upgrades or mutates active V3 tournaments. Stop new V3
creation, pause sponsorship if necessary, keep direct moves available, and
route new creation back to V2 while the incident is investigated.

## Canonical output layout

Each network is isolated:

```text
deployments/
  localhost/
    manifest.json
    account-abstraction.json
    instance-modules.json
    tictac-factory.json
    connectfour-factory.json
    chess-factory.json
    ETour-Factory-ABIs.json
    TicTacChainFactory-ABI.json
    ConnectFourFactory-ABI.json
    ChessOnChainFactory-ABI.json
    PlayerProfile-ABI.json
    PlayerRegistry-ABI.json
    SessionKeyRegistry-ABI.json
  arbitrumSepolia/
    ...
  arbitrum/
    ...
```

JSON is written to a same-directory temporary file, flushed, and renamed over
the destination. The complete `manifest.json` is written after its sibling
outputs. A failed run must not be published; retain the prior reviewed manifest
and reconcile every transaction before retrying.

The version-2 manifest schema records:

- network, chain ID, deployer, block, timestamp, git commit, and dirty state;
- actual protocol compiler version and optimizer, via-IR, EVM, and metadata
  settings;
- EntryPoint version, address, SenderCreator, SimpleAccount implementation and
  factory;
- session registry, TTL, account factory, paymaster, owner, funding address,
  and deposit;
- shared modules, Chess rules, factories, and pinned implementations;
- every constructor argument;
- source name, creation/runtime artifact hash, deployment mode, and embedded
  ABI for all 20 contract records.

`node scripts/check-deployment-manifest.js --network <network>` rejects missing,
cross-network, incomplete, malformed, or temporary output.

## Verification and post-deployment checks

`verify-deployment.js` derives the verification plan and constructor arguments
from the canonical manifest. The dry run must be reviewed before sending
verification requests. “Already verified” is accepted; all other verification
errors fail the command.

The canonical EntryPoint and official SimpleAccount reference stack are pinned
external infrastructure. V3 source verification covers the ETour modules,
rules, registries, account factory, paymaster, game implementations, and game
factories.

`smoke-deployment.js` verifies the RPC chain, bytecode at every code-bearing
manifest address, registry anchors, factory authorization, implementation
pins, and session-registry wiring. It can additionally inspect a created
instance with `INSTANCE=0x...`.

Before publication, archive these non-secret results with the release record:

- reviewed git commit;
- manifest validator output;
- smoke-test output;
- source-verification links;
- bundler health result;
- contract-size result;
- complete test and CI-gate result;
- paymaster deposit, owner, threshold, and funding approval.

