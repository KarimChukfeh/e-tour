# Browser session integration

This document is the frontend security and recovery contract for the V3
TypeScript SDK in `sdk/`. The SDK turns a browser-generated key into a
counterfactual ERC-4337 executor, persists it locally, submits gameplay
`UserOperation`s, and keeps the primary wallet available for recovery and
direct moves.

## Key lifecycle

The browser must generate every session key with Web Crypto
`crypto.getRandomValues`. Never derive a session private key from a primary
wallet signature, password, device identifier, account address, or predictable
PRNG. A wallet signature may approve an on-chain `refreshSession`, but it is
not entropy for the replacement key.

`BrowserSessionKey` exposes only its address and typed-data signing. It does
not expose `signMessage`, a private-key getter, or a JSON-serializable secret.
The vault asks the key object to encrypt its scalar directly and the temporary
byte copy is overwritten immediately.

Create a fresh owner and salt for each `(chainId, instance, primary)` tuple.
Do not reuse one executor across tournaments. This agrees with the registry's
global active-executor uniqueness rule and limits correlation and compromise
scope.

## Local persistence

`SessionKeyVault` stores:

- one non-extractable AES-256-GCM `CryptoKey` in IndexedDB;
- public chain, instance, primary, account, owner, salt, and timestamps; and
- an AES-GCM ciphertext and random 96-bit IV for the session scalar.

The normalized session identity is authenticated as AES-GCM additional data,
so moving ciphertext between instance records fails authentication. The vault
rejects malformed versions, tampered ciphertext, and decrypted keys whose
address differs from the stored public owner.

This design protects against accidental storage inspection, diagnostics,
backups, analytics collection, and opportunistic local-file disclosure. It
does not make same-origin JavaScript trusted: an XSS payload running in the
application origin can ask the non-extractable key to decrypt. XSS prevention
is therefore part of key security.

Never place key material in localStorage, cookies, query strings, Redux/state
debuggers, error objects, console output, telemetry, session replay, server
requests, deployment manifests, crash reports, or source maps. Do not build a
raw-key export or cloud-sync feature without a separate reviewed encryption
and recovery design.

## Browser and device behavior

- Clearing site data removes the wrapping key and ciphertext. The primary
  wallet must authorize a replacement with `refreshSession`.
- Private-browsing storage can disappear when the last private window closes
  and may have lower quotas. Treat it as an ephemeral session.
- A different browser profile, device, origin, or subdomain cannot open the
  original IndexedDB vault. Refresh a newly generated executor from the
  primary wallet.
- Mobile browsers may evict origin storage. Request persistent storage where
  supported, but never represent it as guaranteed.
- Do not restore an orphaned ciphertext without its original non-extractable
  wrapping key. Generate and refresh instead.
- On logout, account change, or chain change, close monitors and coordinators.
  Do not silently apply one identity's key to another identity.

## Cross-tab behavior

`SessionCoordinator` sends only public lifecycle and nonce state through
`BroadcastChannel`. It serializes nonce-sensitive work with Web Locks when
available, then a renewable public localStorage lease, then an in-process
lock. The private key and signature never cross the channel.

Hold the nonce lock across nonce read, operation construction, signing,
submission, and the receipt-or-timeout decision. A submission timeout is
ambiguous: do not reuse the nonce or automatically send the same logical move
through another bundler until receipt and EntryPoint nonce have been
reconciled.

## Enrollment and routine moves

1. Call `createSession(identity)` before creating or joining an instance.
2. Pass `metadata.account` to the V3 factory or enrollment API in the same
   paid wallet transaction.
3. After confirmation, inspect the on-chain session before accepting
   zero-friction moves.
4. Call `submitMove`. The SDK checks the exact stored account is active,
   supplies factory init code only on first use, reads the EntryPoint nonce,
   wraps the game move in account `execute`, signs the chain/EntryPoint-bound
   payload, estimates, submits, and waits for an ERC-7769 receipt.
5. A reverted game move is a completed operation and must not trigger an
   automatic direct-wallet retry.

The browser may monitor `inspect()` or `SessionLifecycleMonitor` for:
`missing`, `active`, `expired`, `revoked`, `rotated`, or `inactive`. Rotation
means the local account no longer matches the registry even if the local key
still decrypts correctly.

## Recovery and revocation

For cache loss, another device, expiration, or suspected compromise:

1. generate a new random owner and salt in the current browser;
2. compute its counterfactual executor;
3. ask the enrolled primary wallet to call
   `SessionKeyRegistry.refreshSession(instance, newExecutor)`;
4. wait for transaction confirmation;
5. only then replace the local encrypted record; and
6. discard the old local record and notify other tabs.

The old executor becomes invalid atomically on-chain. If the wallet rejects or
the refresh transaction fails, discard the staged replacement, keep the
existing local record, and do not claim that recovery succeeded. The SDK
encrypts and stages the replacement before opening the wallet, then promotes it
after confirmation. If confirmation succeeds but final IndexedDB promotion is
interrupted, call `recoverPendingRefresh(identity)` on startup; it promotes the
staged key only when its account exactly matches the registry and otherwise
discards it.

For explicit invalidation, the primary calls `revokeSession(instance)`. Remove
the local record only after confirmation. Revocation is available after
tournament conclusion for cleanup.

## Direct-primary fallback

Direct gameplay remains a first-class safety path. Recommend it for missing,
expired, revoked, rotated, or inactive sessions and for bundler/paymaster/RPC
availability failures. Do not automatically fall back for an illegal game
move, user rejection, or a UserOperation that reached execution and reverted;
that could duplicate intent or hide a deterministic failure.

The direct call is the ordinary game `makeMove` from the enrolled primary.
It bypasses the account, bundler, and paymaster but not game rules.

## User-visible behavior and copy

The product should describe the session as a convenience key for this game,
not as a second wallet or a transfer of custody.

| State | Expected experience | Required action/copy |
| --- | --- | --- |
| Creating or joining with a session | One primary-wallet confirmation pays the entry fee, enrolls the player, and authorizes this tournament's browser session atomically | “Confirm once to join and enable prompt-free moves for this game.” |
| Active session | Legal moves submit without primary-wallet popups; show pending/included state from the UserOperation receipt | “Move submitted securely from this browser session.” |
| Expired | Tournament state is unchanged and the primary can still play | “Your one-hour play session expired. Reconnect your wallet to refresh it, or make this move directly.” |
| Browser storage lost or new device | No local key exists, but the on-chain tournament and funds are safe | “This browser no longer has the game key. Connect the enrolled wallet to authorize a new one.” |
| Rotated or revoked | The local key is no longer authorized | “This browser session was replaced or revoked. Refresh with the enrolled wallet.” |
| Bundler or paymaster unavailable | Do not imply the game or funds are unavailable | “Prompt-free submission is temporarily unavailable. Make the move directly with your wallet.” |
| Illegal/reverted move | Do not retry automatically through the primary wallet | Show the decoded game reason and let the user correct the move |

Never say that the session controls funds, lasts for the whole tournament, or
can recover without the enrolled wallet. A tournament can legally last longer
than one hour; refresh is a normal flow rather than an exceptional failure.

During refresh, distinguish wallet approval from completion. Show success only
after the transaction confirms and the new executor matches the registry. If
the wallet rejects, keep the old local record and say that nothing changed. If
the transaction confirmed but local promotion was interrupted, startup
recovery should reconcile the staged key before asking the user to approve
another refresh.

## Content security and dependencies

Production frontend requirements:

- deliver `Content-Security-Policy` as an HTTP header with
  `default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`, a narrow `connect-src`
  allowlist, and no `unsafe-inline` or `unsafe-eval`;
- use nonces or hashes only for reviewed unavoidable inline resources;
- enable Trusted Types where supported and avoid unsafe DOM sinks;
- disable third-party session replay on all game and wallet views;
- pin exact dependency versions and lockfiles, review lockfile changes, run
  the repository dependency gate, and remove unused browser dependencies;
- serve immutable production assets with integrity metadata where the hosting
  stack supports it; and
- keep RPC/bundler URLs out of arbitrary user-controlled configuration.

The SDK source and focused tests are checked by `npm run sdk:check` and
`npm run test:sdk`. Frontends should add browser integration tests using their
actual IndexedDB and CSP environment before production.
