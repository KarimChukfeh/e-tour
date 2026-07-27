# V2-to-V3 Baseline File Inventory

Baseline commit: `3bf167f2600141826d16a6ceaf4a17b357cff205`

This inventory classifies all 120 regular files and the one dependency symlink
copied from `v2/`. Paths below are relative to `v2/`; their V3 disposition is
stated by section. The copy was made before any V3 namespace or cleanup changes.

## Port — contracts (20)

- `contracts/ChessInstance.sol`
- `contracts/ChessOnChainFactory.sol`
- `contracts/ConnectFourFactory.sol`
- `contracts/ConnectFourInstance.sol`
- `contracts/ETourFactory.sol`
- `contracts/ETourInstance.sol`
- `contracts/ETourInstance_Base.sol`
- `contracts/PlayerProfile.sol`
- `contracts/PlayerRegistry.sol`
- `contracts/TicTacChainFactory.sol`
- `contracts/TicTacInstance.sol`
- `contracts/interfaces/IPlayerProfile.sol`
- `contracts/interfaces/IPlayerRegistry.sol`
- `contracts/interfaces/ITournamentInstance.sol`
- `contracts/modules/ChessRulesModule.sol`
- `contracts/modules/ETourInstance_Core.sol`
- `contracts/modules/ETourInstance_Escalation.sol`
- `contracts/modules/ETourInstance_Matches.sol`
- `contracts/modules/ETourInstance_Prizes.sol`
- `contracts/test-helpers/RejectingTicTacPlayer.sol`

## Port — configuration and package definition (2)

- `hardhat.config.js`
- `package.json`

These files are ported and then changed to use the V3 package identity, pinned
toolchain, V3-relative paths, storage-layout compiler output, and V3 commands.

## Port — tests (9)

- `test/factory/.gitkeep`
- `test/factory/ChessInstance.test.js`
- `test/factory/ConnectFourInstance.test.js`
- `test/factory/PlayerProfile.test.js`
- `test/factory/PrizeRedistribution.test.js`
- `test/factory/TicTacInstance.test.js`
- `test/factory/debug-factory-players-mapping.test.js`
- `test/factory/profile-creation-both-players.test.js`
- `test/factory/verify-both-players-complete-flow.test.js`

## Port — operational scripts (9)

- `scripts/check-contract-sizes.js`
- `scripts/deploy-all-factory.js`
- `scripts/deploy-chessonchain-factory.js`
- `scripts/deploy-connectfour-factory.js`
- `scripts/deploy-factories.js`
- `scripts/deploy-instance-modules.js`
- `scripts/deploy-tictacchain-factory.js`
- `scripts/regenerate-abis.js`
- `scripts/sync-abis.js`

These scripts are ported with V3-relative deployment, artifact, configuration,
and frontend ABI paths. They must not consume or emit files under `v2/`.

## Archive as V2 reference material — documents (4)

- `ETour-Instances-Pivot-Plan-and-Tracking.md`
- `ETour-PlayerProfile-Plan.md`
- `ETour-V2-OpenSource-Readiness-Plan.md`
- `ETour-pivot.md`

The copies live under `v3/archive/v2-reference/docs/`. They are historical input,
not authoritative V3 documentation.

## Archive as V2 reference material — diagnostics and dated verification (6)

- `scripts/check-instance.js`
- `scripts/debug-create.js`
- `scripts/diagnose-profile-issue.js`
- `scripts/test-enrollment.js`
- `scripts/verify-arbitrum-2026-04-02.sh`
- `verify-arbitrum-2026-04-05.js`

The copies live under `v3/archive/v2-reference/scripts/`. They contain local V2
frontend paths and/or dated V2 deployment addresses, so they cannot be exposed as
V3 operational scripts. Any needed diagnostic or verification behavior must be
rebuilt against fresh V3 manifests.

## Regenerate — Hardhat artifacts (49)

- `artifacts/@openzeppelin/contracts/utils/ReentrancyGuard.sol/ReentrancyGuard.dbg.json`
- `artifacts/@openzeppelin/contracts/utils/ReentrancyGuard.sol/ReentrancyGuard.json`
- `artifacts/build-info/1c3e9a746088fea1e515a153714cd5d9.json`
- `artifacts/build-info/5ab12c2a67c2c96ea8b8a5349d7061be.json`
- `artifacts/build-info/b683d522f416635733ad44aee5320c03.json`
- `artifacts/contracts/ChessInstance.sol/ChessInstance.dbg.json`
- `artifacts/contracts/ChessInstance.sol/ChessInstance.json`
- `artifacts/contracts/ChessInstance.sol/IChessRules.dbg.json`
- `artifacts/contracts/ChessInstance.sol/IChessRules.json`
- `artifacts/contracts/ChessOnChainFactory.sol/ChessOnChainFactory.dbg.json`
- `artifacts/contracts/ChessOnChainFactory.sol/ChessOnChainFactory.json`
- `artifacts/contracts/ConnectFourFactory.sol/ConnectFourFactory.dbg.json`
- `artifacts/contracts/ConnectFourFactory.sol/ConnectFourFactory.json`
- `artifacts/contracts/ConnectFourInstance.sol/ConnectFourInstance.dbg.json`
- `artifacts/contracts/ConnectFourInstance.sol/ConnectFourInstance.json`
- `artifacts/contracts/ETourFactory.sol/ETourFactory.dbg.json`
- `artifacts/contracts/ETourFactory.sol/ETourFactory.json`
- `artifacts/contracts/ETourInstance.sol/ETourInstance.dbg.json`
- `artifacts/contracts/ETourInstance.sol/ETourInstance.json`
- `artifacts/contracts/ETourInstance_Base.sol/ETourInstance_Base.dbg.json`
- `artifacts/contracts/ETourInstance_Base.sol/ETourInstance_Base.json`
- `artifacts/contracts/PlayerProfile.sol/PlayerProfile.dbg.json`
- `artifacts/contracts/PlayerProfile.sol/PlayerProfile.json`
- `artifacts/contracts/PlayerRegistry.sol/PlayerRegistry.dbg.json`
- `artifacts/contracts/PlayerRegistry.sol/PlayerRegistry.json`
- `artifacts/contracts/TicTacChainFactory.sol/TicTacChainFactory.dbg.json`
- `artifacts/contracts/TicTacChainFactory.sol/TicTacChainFactory.json`
- `artifacts/contracts/TicTacInstance.sol/TicTacInstance.dbg.json`
- `artifacts/contracts/TicTacInstance.sol/TicTacInstance.json`
- `artifacts/contracts/interfaces/IPlayerProfile.sol/IPlayerProfile.dbg.json`
- `artifacts/contracts/interfaces/IPlayerProfile.sol/IPlayerProfile.json`
- `artifacts/contracts/interfaces/IPlayerRegistry.sol/IPlayerRegistry.dbg.json`
- `artifacts/contracts/interfaces/IPlayerRegistry.sol/IPlayerRegistry.json`
- `artifacts/contracts/interfaces/ITournamentInstance.sol/ITournamentInstance.dbg.json`
- `artifacts/contracts/interfaces/ITournamentInstance.sol/ITournamentInstance.json`
- `artifacts/contracts/modules/ChessRulesModule.sol/ChessRulesModule.dbg.json`
- `artifacts/contracts/modules/ChessRulesModule.sol/ChessRulesModule.json`
- `artifacts/contracts/modules/ETourInstance_Core.sol/ETourInstance_Core.dbg.json`
- `artifacts/contracts/modules/ETourInstance_Core.sol/ETourInstance_Core.json`
- `artifacts/contracts/modules/ETourInstance_Escalation.sol/ETourInstance_Escalation.dbg.json`
- `artifacts/contracts/modules/ETourInstance_Escalation.sol/ETourInstance_Escalation.json`
- `artifacts/contracts/modules/ETourInstance_Matches.sol/ETourInstance_Matches.dbg.json`
- `artifacts/contracts/modules/ETourInstance_Matches.sol/ETourInstance_Matches.json`
- `artifacts/contracts/modules/ETourInstance_Prizes.sol/ETourInstance_Prizes.dbg.json`
- `artifacts/contracts/modules/ETourInstance_Prizes.sol/ETourInstance_Prizes.json`
- `artifacts/contracts/test-helpers/RejectingTicTacPlayer.sol/ITicTacInstanceLike.dbg.json`
- `artifacts/contracts/test-helpers/RejectingTicTacPlayer.sol/ITicTacInstanceLike.json`
- `artifacts/contracts/test-helpers/RejectingTicTacPlayer.sol/RejectingTicTacPlayer.dbg.json`
- `artifacts/contracts/test-helpers/RejectingTicTacPlayer.sol/RejectingTicTacPlayer.json`

The copied directory was deleted. V3 compilation regenerates it.

## Regenerate — Hardhat cache (1)

- `cache/solidity-files-cache.json`

The copied directory was deleted. V3 compilation regenerates it.

## Regenerate — dependency symlink (1)

- `node_modules -> ../node_modules`

The copied V2 symlink was removed. V3 uses an isolated `node_modules/` generated
strictly from `v3/package-lock.json`; it must never resolve through the root or V2
dependency tree.

## Regenerate — deployment and ABI manifests (18)

- `deployments/ChessOnChainFactory-ABI.json`
- `deployments/ConnectFourFactory-ABI.json`
- `deployments/ETour-Factory-ABIs.json`
- `deployments/PlayerProfile-ABI.json`
- `deployments/PlayerRegistry-ABI.json`
- `deployments/TicTacChainFactory-ABI.json`
- `deployments/arbitrum-chess-factory.json`
- `deployments/arbitrum-connectfour-factory.json`
- `deployments/arbitrum-tictac-factory.json`
- `deployments/hardhat-factory.json`
- `deployments/instance-modules.json`
- `deployments/localhost-chess-factory.json`
- `deployments/localhost-connectfour-factory.json`
- `deployments/localhost-factory.json`
- `deployments/localhost-tictac-factory.json`
- `v2/deployments/TicTacChainFactory-ABI.json`
- `v2/deployments/instance-modules.json`
- `v2/deployments/localhost-tictac-factory.json`

All copied manifests and the accidental nested `v2/` tree were deleted. The
authoritative V3 `deployments/` directory starts empty except for `.gitkeep`.
Fresh V3 deployments and ABI generation are the only valid sources for new files.

## Deliberately omit — operating-system metadata (2)

- `.DS_Store`
- `test/.DS_Store`

Both files were deleted and are already excluded by the repository `.gitignore`.

## Reconciliation

| Classification | Count |
|---|---:|
| Port | 40 |
| Archive | 10 |
| Regenerate | 69 |
| Deliberately omit | 2 |
| **Total copied V2 filesystem entries** | **121** |

Of the 121 entries, 120 were regular files and one was a symbolic link.
