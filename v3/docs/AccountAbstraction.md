# V3 account abstraction and sponsorship

## Production model

V3 pins ERC-4337 EntryPoint v0.8 at
`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`. The browser generates a random
secp256k1 owner key and a random per-session salt. The
`ETourSessionAccountFactory` computes the CREATE2 account address before
deployment, allowing that address to be registered atomically during paid
tournament enrollment.

The primary wallet remains the player. The counterfactual account is only the
instance-scoped session executor. The game resolves it through
`SessionKeyRegistry`, and only `makeMove` uses that resolution. EntryPoint,
account, bundler, and paymaster code never changes prize, profile, enrollment,
or escrow identity.

## First and later operations

The first operation contains:

1. factory address plus `createAccount(browserOwner, salt)` as `initCode`;
2. game `makeMove` calldata;
3. `ETourSessionAccount.execute(instance, 0, moveData)` as account calldata;
4. EntryPoint nonce zero and bounded gas fields;
5. optional `ETourSessionPaymaster` data;
6. an EIP-712 signature bound to EntryPoint and chain ID.

EntryPoint deploys the account through `SenderCreator`, validates the browser
signature, validates sponsorship when present, and executes the move. Later
operations omit `initCode` and use the next EntryPoint nonce.

Games receive an ordinary call from the session account. They never decode a
`PackedUserOperation` and have no bundler dependency.

## Account security boundary

`ETourSessionAccount` is non-upgradeable. Its EntryPoint, browser owner, and
factory are immutable. `execute` is callable only by EntryPoint or the browser
owner. `ETourSessionAccountFactory` records accounts it created; the paymaster
rejects every sender absent from that provenance mapping.

The account should not hold user funds. Direct browser-owner execution can move
assets accidentally sent to the account, but it cannot acquire primary-wallet
authority or access tournament escrow.

## Sponsorship policy

`ETourSessionPaymaster` accepts an operation only when all of these hold:

- sponsorship is not paused and the deposit is available;
- the sender was created by the configured session-account factory;
- verification, call, pre-verification, paymaster, and maximum-cost fields are
  below hard bounds;
- account calldata is exactly the `execute(address,uint256,bytes)` wrapper;
- the wrapped value is zero;
- the inner selector is an approved three-argument or Chess five-argument
  `makeMove`;
- the target is attested by an owner-approved V3 factory;
- the target uses the configured session registry;
- the sender resolves to a currently active, unexpired session for the target.

The returned ERC-4337 validation range uses the session's on-chain
`validUntil`. Revocation, refresh, rotation, expiry, unknown accounts,
arbitrary calls, nonzero value, malformed wrappers, excessive gas, and
unapproved factories are rejected during validation.

The policy is fully on-chain. No verifier key can broaden it. An RPC provider
may decline sponsorship for budget or rate-limit reasons, but users can always
submit a direct primary-wallet move.

## Funds and operations

Paymaster deposits are held by EntryPoint and are separate from every
tournament instance. Entry fees, prize pools, refunds, and owner accounting
never fund UserOperations.

Local deployments default to a `0.5 ETH` development deposit. Public
deployments default to zero and accept an explicit `PAYMASTER_DEPOSIT_WEI`.
Production must define the funding wallet, refill and alert thresholds,
emergency pause authority, and incident runbook before launch.
`npm run paymaster:inspect` reports the current deposit/stake, pause state,
sponsored operation count and cost over a bounded block window. Configure
`PAYMASTER_ALERT_THRESHOLD_WEI`, `PAYMASTER_SPEND_ALERT_WEI`, and optionally
`PAYMASTER_LOOKBACK_BLOCKS`; the command exits nonzero for low deposits,
paused sponsorship, or abnormal spend.

## Local commands

Run artifact and contract gates:

```sh
npm run contracts:check
```

Deploy the canonical local EntryPoint reference stack:

```sh
npm run aa:deploy:localhost
```

Deploy the complete protocol, session account factory, paymaster, and approved
game factories:

```sh
npm run deploy:all
```

Run the EntryPoint and sponsorship integration suite:

```sh
npm run test:aa
```

The local bundler adapter implements the ERC-7769 methods used by the SDK for
estimation, submission, lookup, and receipt handling. Public-network phases
must repeat compatibility tests against at least two independent Arbitrum
bundlers.

The typed browser integration, encrypted key vault, nonce coordination,
recovery sequence, and frontend security requirements are documented in
[`BrowserSessionIntegration.md`](./BrowserSessionIntegration.md).
Deployment, manifest, constructor, and verification procedures are in
[`Deployment.md`](./Deployment.md). Monitoring, refill, failover, pause, and
incident procedures are in [`Operations.md`](./Operations.md).
