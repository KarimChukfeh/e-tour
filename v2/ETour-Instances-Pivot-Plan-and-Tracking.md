# ETour Instances Pivot — Plan & Tracking

**Created:** March 22, 2026
**Status:** Planning
**Ref:** ETour-pivot.md

---

## Overview

Migrate ETour from hardcoded tiers with pre-allocated instance slots to a factory pattern where each tournament instance is a lightweight child contract deployed on demand. Tier configs become demand-driven (created at runtime if they don't already exist). Product flow shifts from "browse and join" to "create → invite → play → permanent record."

---

## Core Design Principle: Instances as Permanent On-Chain Records

Every tournament instance contract is a **permanent, immutable record** once it concludes (win, cancel, EL1, EL2). The contract stays deployed forever and all of its data stays readable on-chain:

- **Tournament metadata:** tier config, player count, entry fee, creator, timestamps (created, started, completed)
- **Full player roster:** every address that enrolled, in enrollment order
- **Complete bracket:** every round, every match pairing
- **Every match result:** winner, completion reason (normal win, timeout, draw, forfeit, escalation), timestamps
- **Full move history:** every move made in every match, in order (board states, move data, who moved when)
- **Prize distribution:** who won what, fee breakdown

**Nothing gets deleted or garbage-collected.** A completed instance contract is a self-contained, verifiable proof of everything that happened in that tournament. Anyone can read it at any time by calling view functions on the instance address.

### Player History

Player history is **not** a centralized leaderboard on the factory. Instead:

- The factory maintains a simple mapping: `mapping(address => address[]) public playerInstances` — for each player, an array of instance addresses they participated in.
- When a player enrolls in an instance, the instance calls back to the factory to register: `factory.registerPlayer(player, address(this))`
- To build a player's full history, the UI fetches their `playerInstances[]` array from the factory, then reads each instance contract for the details (result, earnings, match data, etc.)
- This keeps the factory lightweight — it stores references, not data. The data lives on the instances.

**Why this matters:**
- No redundant storage — match data exists once, on the instance
- Fully verifiable — anyone can audit any tournament by reading the instance contract directly
- Scales infinitely — the factory never accumulates historical bulk
- Composable — third parties can build their own leaderboards, stats, or UIs by reading instance contracts

### Instance Lifecycle States

```
Created → Enrolling → InProgress → Concluded (permanent)
                ↓                       ↑
           EL1/EL2 (abandoned) ────────┘
```

Once an instance reaches any terminal state (Completed, Cancelled, EL1, EL2), it **locks permanently**. All write functions revert. Only view functions remain callable.

### Dead Code to Remove

Because instances are single-use and never reset, the following existing logic becomes unnecessary and must be removed:

- **`resetTournamentAfterCompletion()`** in `ETour_Core.sol` — currently wipes tournament state so the slot can be reused. No longer needed; the instance IS the record.
- **`resetEnrollmentWindow()`** logic that re-initializes enrollment state for a fresh cycle — instances don't cycle.
- **Any state zeroing** after prize distribution (clearing `enrolledPlayers`, resetting `enrolledCount`, wiping `prizePool`, etc.) — this data must persist as part of the permanent record.
- **Instance ID recycling / reuse logic** — there are no instance IDs to recycle; each instance is a unique contract address.
- **Match state cleanup** between rounds or after completion — match data (board state, move history, results) must remain readable forever.
- **`TournamentStatus.Enrolling` re-entry** — a concluded instance never goes back to Enrolling. The status enum only moves forward.

In short: every function that currently "cleans up" state to prepare a slot for the next tournament is dead code in the new architecture. Remove it entirely rather than leaving it unused.

---

## Phase 1: New Contract Architecture

### 1.1 — Create `ETourInstance.sol` (Child Contract)

**File:** `contracts/ETourInstance.sol`

A minimal child contract that holds the state for a single tournament instance. This replaces what is currently one slot in `tournaments[tierId][instanceId]`.

**What it holds:**
- Its own `TournamentInstance` storage (status, enrolled players, prize pool, rounds, matches)
- Its own `Match[]` array for all rounds
- Reference back to the parent (factory) for module addresses and fee config
- Tier parameters (playerCount, entryFee, timeouts) — set once at deploy

**What it does NOT hold:**
- Tier registry (parent's job)
- Raffle state (stays on parent)
- Leaderboard / player earnings (stays on parent)
- Protocol share accumulator (stays on parent)

**Key decisions:**
- Deploy via EIP-1167 minimal proxy (clone) to keep gas ~$0.10 instead of ~$1+ per instance creation
- The "implementation" contract is deployed once; clones are cheap proxies pointing to it
- Each clone is initialized via an `initialize()` function (not constructor) since proxies can't use constructors
- Instance is immutable after conclusion — no `selfdestruct`, address stays on-chain as permanent history

**Checklist:**
- [x] Define `ETourInstance` storage layout (subset of current `ETour_Base`) → `ETourInstance_Base.sol`
- [x] Implement `initialize(tierConfig, parentAddress, moduleAddresses)`
- [x] Port enrollment logic (currently in `ETour_Core.enrollInTournament`) → `ETourInstance_Core.coreEnroll()`
- [x] On enrollment, call `factory.registerPlayer(player)` to record participation
- [x] Port match/round logic (currently in `ETour_Matches`) → `ETourInstance_Matches.sol`
- [x] Port prize distribution (currently in `ETour_Prizes`) → `ETourInstance_Prizes.sol`
- [x] Port escalation logic (currently in `ETour_Escalation`) → `ETourInstance_Escalation.sol`
- [x] Ensure fee splits route back to parent (owner share + protocol share) via `factory.receiveOwnerShare()` / `factory.receiveProtocolShare()`
- [x] Implement permanent lock: all write functions revert once instance is concluded (`notConcluded` modifier)
- [x] Emit events: `PlayerEnrolled`, `TournamentStarted`, `TournamentConcluded`, `MatchCompleted`
- [x] **View functions for permanent record reads:**
  - [x] `getInstanceInfo()` — tier config, creator, timestamps, status, player count
  - [x] `getPlayers()` — full enrolled player list
  - [x] `getBracket()` — all rounds and match pairings
  - [x] `getMatch(roundId, matchId)` — full match detail (players, result, reason, timestamps)
  - [x] `getMatchMoves(roundId, matchId)` — complete move history for a match
  - [x] `getPrizeDistribution()` — who received what
  - [x] `getPlayerResult(address)` — a specific player's outcome (round eliminated, earnings)

---

### 1.2 — Create `ETourFactory.sol` (Parent / Factory Contract)

**File:** `contracts/ETourFactory.sol`

Replaces the current game contracts (TicTacChain, ChessOnChain, ConnectFourOnChain) as the entry point. Each game type gets its own factory deployment.

**Responsibilities:**
- Stores the EIP-1167 implementation address for `ETourInstance`
- Maintains the tier registry: `mapping(bytes32 => TierConfig)` keyed by `keccak256(abi.encodePacked(playerCount, entryFee))`
- Deploys new instance clones via `createInstance(playerCount, entryFee, timeoutConfig)`
- Tracks all instance addresses: `address[] public instances`
- Holds global state: raffle accumulator, player earnings leaderboard, protocol share
- Routes raffle execution across instances
- Owns the module addresses (passed to children at creation)

**Tier system — on-demand, deduplicated:**

A "tier" is simply a unique combination of `(playerCount, entryFee)`. There is no predefined list of tiers — they are created lazily when the first instance requests a config that doesn't exist yet.

**Allowed player counts:** 2, 4, 8, 16, 32, 64 (powers of 2 only — required for bracket structure)

**Allowed entry fees:** Increments of 0.001 ETH (e.g., 0.001, 0.002, ... 0.01, 0.011, ... 1.0, etc.). Enforced on-chain: `require(entryFee % 0.001 ether == 0)`.

**Deduplication logic:**
```
tierKey = keccak256(abi.encodePacked(playerCount, entryFee))
if tierRegistry[tierKey] exists → reuse that TierConfig
else → create new TierConfig, store it, emit TierCreated(tierKey, playerCount, entryFee)
```

When a user calls `createInstance(playerCount, entryFee, timeoutConfig)`:
1. Validate playerCount is a power of 2 in [2, 64]
2. Validate entryFee is a multiple of 0.001 ETH and within bounds
3. Compute `tierKey` — if tier exists, reuse it; if not, register it
4. Deploy a new instance clone configured with that tier
5. The tierKey is stored on the instance so future queries can group instances by tier

This means the first person to create a "4 players, 0.005 ETH" instance also creates that tier config. Every subsequent "4 players, 0.005 ETH" instance reuses the same tier config automatically.

**Storage:**
```solidity
mapping(bytes32 => TierConfig) public tierRegistry;  // tierKey → config
bytes32[] public tierKeys;                            // all known tier keys (for enumeration)
mapping(bytes32 => address[]) public tierInstances;   // tierKey → instance addresses (optional, for browsing)
```

**Guardrails on instance creation:**
- Player count: must be power of 2, minimum 2, maximum 64
- Entry fee: must be multiple of 0.001 ETH, minimum 0.001 ETH, maximum configurable (e.g., 10 ETH)
- Timeout bounds: min/max for enrollment window, match timeout, increment

**Checklist:**
- [x] Define factory storage layout
- [x] Implement `createInstance()` with EIP-1167 clone deployment
- [x] Implement tier deduplication (hash-based lookup via `keccak256(playerCount, entryFee)`)
- [x] Add guardrail checks (min/max player count, fee bounds, power-of-2 enforcement)
- [x] Maintain `instances[]` array + `getInstanceCount()`
- [x] Implement `getInstances(offset, limit)` pagination view
- [ ] Implement `getInstancesByCreator(address)` view ← next
- [x] Implement `getActiveTierConfigs()` view
- [x] Keep raffle state + `executeProtocolRaffle()` on factory
- [x] Keep fee accumulation (`receiveOwnerShare()` + `receiveProtocolShare()`)
- [x] Implement `playerInstances` mapping + `registerPlayer()` + `getPlayerInstances()`
- [x] No centralized leaderboard — player stats derived by UI reading each instance
- [x] Emit events: `InstanceDeployed`, `TierCreated`, `PlayerRegistered`
- [x] Add `owner` / access control (`onlyOwner` modifier, `transferOwnership`)

---

### 1.3 — Create Game-Specific Factory Subcontracts

**Files:**
- `contracts/TicTacChainFactory.sol`
- `contracts/ChessOnChainFactory.sol`
- `contracts/ConnectFourOnChainFactory.sol`

Each inherits from `ETourFactory` and adds:
- Game-specific move validation logic (or reference to game rules module)
- Game-specific `ETourInstance` implementation address
- Game-specific raffle thresholds
- Any game-specific views (e.g., Chess elite match history)

**Checklist:**
- [x] `TicTacChainFactory` — inherits ETourFactory, deploys TicTacInstance implementation, raffle thresholds
- [x] `ChessOnChainFactory` — overrides createInstance(), passes CHESS_RULES to each clone via initializeChess()
- [x] `ConnectFourFactory` — inherits ETourFactory, deploys ConnectFourInstance implementation, raffle thresholds
- [x] Each deploys its own `ETourInstance` implementation in constructor

---

### 1.4 — Create Game-Specific Instance Implementations

**Files:**
- `contracts/TicTacInstance.sol`
- `contracts/ChessInstance.sol`
- `contracts/ConnectFourInstance.sol`

Each inherits from `ETourInstance` and adds:
- Game-specific board state and move validation
- Game-specific win detection
- `makeMove()` function with game rules applied

This keeps the instance contract small (game logic + tournament state only).

**Checklist:**
- [x] `TicTacInstance` — 2-bit packed board, 3x3 win detection (14.6KB, 61% of limit)
- [x] `ChessInstance` — 4-bit piece encoding, IChessRules delegatecall, threefold repetition (15.3KB, 62%)
- [x] `ConnectFourInstance` — 6×7 board, gravity moves, 4-in-a-row detection (14.3KB, 58%)
- [x] Each must fit well under 24KB (target: <8KB with proxy pattern) — TicTacInstance fine; Chess/C4 pending

---

### 1.5 — Adapt Existing Modules

The five existing modules (Core, Matches, Prizes, Escalation, Raffle) currently execute via delegatecall from the game contract. They need to work in the new context where the caller is an `ETourInstance` child contract.

**Key change:** Modules currently read/write to the game contract's storage layout (`ETour_Base`). In the new architecture, they read/write to `ETourInstance`'s storage layout. The storage layout of `ETourInstance` must be compatible with what the modules expect.

**Approach:**
- `ETourInstance` inherits the same storage layout variables the modules expect
- Modules continue to work via delegatecall from the instance (not the factory)
- The only difference: fee routing sends owner/protocol shares to the factory address instead of `address(this)`

**Checklist:**
- [x] Audit `ETour_Core.sol` → `ETourInstance_Core.sol` — single-instance storage, no tierId/instanceId
- [x] Audit `ETour_Matches.sol` → `ETourInstance_Matches.sol` — single-instance, no indexing
- [x] Audit `ETour_Prizes.sol` → `ETourInstance_Prizes.sol` — routes fees to factory
- [x] Audit `ETour_Escalation.sol` → `ETourInstance_Escalation.sol` — single-instance storage
- [x] Audit `ETour_Raffle.sol` — raffle stays on factory (`ETourFactory.executeProtocolRaffle()`)
- [x] Simplify module code: remove tier/instance indexing — direct `tournament.status` etc.
- [x] Each instance IS the tournament: access is direct

---

## Phase 2: Migration & Deployment

### 2.1 — Update Deployment Scripts

**Files:**
- `scripts/deploy-modules.js` (update)
- `scripts/deploy-factory.js` (new)
- `scripts/deploy-instance-impl.js` (new)

**Deployment order:**
1. Deploy shared modules (Core, Matches, Prizes, Escalation) — may need updates
2. Deploy game-specific modules (ChessRulesModule) — unchanged
3. Deploy instance implementation contracts (TicTacInstance, ChessInstance, ConnectFourInstance)
4. Deploy factory contracts with implementation + module addresses

**Checklist:**
- [x] `deploy-instance-modules.js` — deploys/reuses Core, Matches, Prizes, Escalation
- [x] `deploy-tictacchain-factory.js` — TicTacChainFactory + ABI (reuses modules)
- [x] `deploy-connectfour-factory.js` — ConnectFourFactory + ABI (reuses modules)
- [x] `deploy-chessonchain-factory.js` — ChessOnChainFactory + ChessRulesModule + ABI (reuses modules)
- [x] `deploy-factories.js` — deploys all three factories at once
- [x] `deploy-all-factory.js` — one-shot: modules + all factories
- [x] `deployments/` artifacts updated per run
- [ ] Verify deployment gas costs are reasonable

---

### 2.2 — Archive Old Contracts

Move the old monolithic game contracts to `contracts/archived/`:
- `TicTacChain.sol` → `contracts/archived/`
- `ChessOnChain.sol` → `contracts/archived/`
- `ConnectFourOnChain.sol` → `contracts/archived/`

**Checklist:**
- [ ] Move old contracts to archived
- [ ] Keep old ABIs in `deployments/` for any historical reads

---

## Phase 3: Testing

### 3.1 — Unit Tests for Factory

**File:** `test/factory/ETourFactory.test.js`

- [ ] Factory deploys instance clones correctly
- [ ] Tier deduplication works (same config → same tierKey)
- [ ] New tier creation works (unknown config → new entry)
- [ ] Guardrails reject invalid parameters
- [ ] Instance array tracking is correct
- [ ] Events emitted correctly

### 3.2 — Unit Tests for Instance Lifecycle

**File:** `test/factory/ETourInstance.test.js`

- [ ] Instance initializes correctly from factory
- [ ] Enrollment works (single player, full enrollment)
- [ ] Tournament starts when full
- [ ] Match progression works through all rounds
- [ ] Prize distribution works
- [ ] Fee routing sends shares back to factory
- [ ] Instance status transitions correctly
- [ ] Completed instance rejects further enrollment

### 3.3 — Game-Specific Tests

**Files:**
- `test/factory/TicTacInstance.test.js`
- `test/factory/ChessInstance.test.js`
- `test/factory/ConnectFourInstance.test.js`

- [ ] Game moves validate correctly within instance context
- [ ] Win detection works
- [ ] Full game lifecycle (create → enroll → play → win → prizes)

### 3.4 — Escalation Tests in New Architecture

**File:** `test/factory/InstanceEscalation.test.js`

- [ ] EL1: Solo enrollment force-start works in instance
- [ ] EL2: Abandoned pool claim works in instance
- [ ] ML1-ML3: Match timeout escalation works in instance

### 3.5 — Raffle Tests

**File:** `test/factory/FactoryRaffle.test.js`

- [ ] Protocol share accumulates on factory from instance fee routing
- [ ] Raffle executes from factory context
- [ ] Raffle eligibility checks work across instances

### 3.6 — Gas Benchmarks

- [ ] Measure instance clone deployment gas
- [ ] Measure enrollment gas (compare old vs new)
- [ ] Measure full tournament lifecycle gas
- [ ] Confirm instance implementation < 8KB bytecode
- [ ] Confirm factory < 24KB bytecode

---

## Phase 4: Frontend Updates

> **Note:** Frontend lives at `/Users/karim/Documents/workspace/zero-trust/tic-tac-react/`

### 4.1 — New "Create Instance" Flow

Replace tier/instance browser with a creation form:

**UI Flow:**
1. User picks game (TicTacToe / Chess / ConnectFour)
2. User sets parameters: player count, entry fee (dropdown or custom)
3. User clicks "Create Instance" → calls `factory.createInstance()`
4. Instance deploys → user gets a shareable invite link with the instance address
5. User shares link → friends join directly

**Checklist:**
- [ ] New `CreateInstance` component with parameter picker
- [ ] Connect to factory contract's `createInstance()`
- [ ] Generate shareable invite link: `/{game}?instance={address}`
- [ ] Show confirmation with instance address after creation

### 4.2 — Update Instance Joining Flow

- [ ] Invite link lands user directly on the instance page
- [ ] Instance page reads state from child contract (not parent)
- [ ] Enrollment calls go to instance contract directly
- [ ] Remove old tier/instanceId selection UI

### 4.3 — Instance Browser (Secondary)

Open/public instances can still be browsed, but it's no longer the primary flow.

- [ ] Query factory's `getInstances()` with pagination
- [ ] Filter by status (Enrolling / InProgress / Completed)
- [ ] Filter by game parameters (player count, fee range)
- [ ] Show instance cards with: creator, player count, entry fee, spots remaining

### 4.4 — Update ABIs and Contract References

- [ ] Replace game contract ABIs with factory + instance ABIs
- [ ] Update contract address references in frontend config
- [ ] Remove hardcoded `TIER_CONFIG` objects
- [ ] Query tier configs dynamically from factory

### 4.5 — Player History & Instance Detail Pages

The UI is now responsible for building player profiles and tournament history by reading directly from instance contracts.

**Player Profile flow:**
1. Call `factory.getPlayerInstances(address)` → get list of instance addresses
2. For each instance address, call the instance's view functions (`getInstanceInfo()`, `getPlayerResult(address)`)
3. Aggregate locally: total matches, win rate, earnings, recent activity
4. Use multicall / batching to keep RPC calls manageable

**Instance Detail page:**
1. Given an instance address (from URL, player history, or browser)
2. Call `getInstanceInfo()`, `getPlayers()`, `getBracket()`, `getPrizeDistribution()`
3. For each match, lazy-load `getMatch()` and `getMatchMoves()` on expand
4. Completed instances show as a permanent, shareable record page

**Checklist:**
- [ ] `TicTacChain.jsx` — refactor to work with instance addresses
- [ ] `Chess.jsx` — refactor to work with instance addresses
- [ ] `ConnectFour.jsx` — refactor to work with instance addresses
- [ ] `Landing.jsx` — update CTAs from "Join" to "Create & Invite"
- [ ] `InviteModal.jsx` — update to use instance address links
- [ ] `usePlayerActivity.jsx` — fetch `playerInstances[]` from factory, read each instance for details
- [ ] New `InstanceDetail` component — permanent record view for concluded tournaments
- [ ] New `PlayerProfile` component — aggregated stats from instance reads
- [ ] Multicall batching for player history (could be many instances)

---

## Phase 5: Documentation & Positioning

### 5.1 — Update Whitepaper (README.md)

- [ ] Reframe from "find a tournament" to "create and invite"
- [ ] Document factory pattern architecture
- [ ] Document on-demand tier creation
- [ ] Update fee distribution section (unchanged logic, new routing)
- [ ] Update deployment section

### 5.2 — Update Landing Page Copy

- [ ] Primary CTA: "Challenge Someone" / "Create a Match"
- [ ] Secondary: "Browse Open Lobbies"
- [ ] Messaging: "Prove it on-chain" / "Settle the score"

---

## Execution Order & Dependencies

```
Phase 1.5 (Adapt Modules)          ← do first, smallest blast radius
    ↓
Phase 1.1 (ETourInstance)          ← needs adapted module interfaces
    ↓
Phase 1.4 (Game Instances)         ← inherits from ETourInstance
    ↓
Phase 1.2 (ETourFactory)           ← deploys instances, needs impl address
    ↓
Phase 1.3 (Game Factories)         ← inherits from ETourFactory
    ↓
Phase 2.1 (Deploy Scripts)         ← needs all contracts finalized
Phase 3.x (Tests)                  ← run continuously, formalize here
    ↓
Phase 2.2 (Archive Old)            ← only after new contracts pass tests
    ↓
Phase 4.x (Frontend)               ← needs deployed factory + instance ABIs
    ↓
Phase 5.x (Docs)                   ← last, reflects final state
```

---

## Risk Checklist

- [ ] **Storage layout compatibility:** Modules via delegatecall MUST match instance storage layout exactly. Audit carefully.
- [ ] **Reentrancy:** Instance sends ETH to factory for fee routing — guard with checks-effects-interactions or reentrancy lock.
- [ ] **Clone initialization:** EIP-1167 clones can only be initialized once. Ensure `initialize()` has an `initializer` modifier.
- [ ] **Gas limits:** If factory's `instances[]` array grows very large, iteration becomes expensive. Use pagination for reads, never iterate on-chain.
- [ ] **Proxy upgrade path:** Clones point to a fixed implementation. If bugs are found post-deploy, new instances use the new implementation, but old instances are stuck. Consider whether this is acceptable or if UUPS is needed.
- [ ] **Cross-contract raffle:** Raffle eligibility must check across all active instances. This may require the factory to track which players are enrolled where.

---

## Progress Log

| Date | Phase | Description | Status |
|------|-------|-------------|--------|
| 2026-03-22 | — | Plan created | Done |
| 2026-03-22 | 1.5 | Audit & adapt modules — new files: `ETourInstance_Base.sol`, `modules/ETourInstance_Core.sol`, `modules/ETourInstance_Matches.sol`, `modules/ETourInstance_Prizes.sol`, `modules/ETourInstance_Escalation.sol` | Done |
| 2026-03-22 | 1.1 | Created `ETourInstance.sol` + `ETourInstance_Base.sol` — permanent single-instance child contract with initialize(), view functions, permanent lock | Done |
| 2026-03-22 | 1.4 | Created `TicTacInstance.sol` — TicTac game logic ported to single-instance pattern (14.6KB, 61% of 24KB limit) | Done |
| 2026-03-22 | 1.2 | Created `ETourFactory.sol` — EIP-1167 clone factory, demand-driven tiers, player history, raffle (10.7KB) | Done |
| 2026-03-22 | 1.3 | Created `TicTacChainFactory.sol` — inherits ETourFactory, deploys TicTacInstance implementation, raffle thresholds | Done |
| 2026-03-22 | 1.4 | Created `ConnectFourInstance.sol` — 6×7 gravity board, 4-in-a-row detection, time bank, escalation clearing (14.3KB, 58%) | Done |
| 2026-03-22 | 1.4 | Created `ChessInstance.sol` — 4-bit piece encoding, IChessRules delegatecall, threefold repetition tracking, `initializeChess()` (15.3KB, 62%) | Done |
| 2026-03-22 | 1.3 | Created `ConnectFourFactory.sol` — inherits ETourFactory, deploys ConnectFourInstance implementation (10.7KB) | Done |
| 2026-03-22 | 1.3 | Created `ChessOnChainFactory.sol` — inherits ETourFactory, overrides createInstance() to pass CHESS_RULES to each clone (11.1KB) | Done |
| 2026-03-22 | — | All 26 contracts compile successfully (0 errors, evm: paris) | Done |
| 2026-03-22 | 2.1 | Deploy scripts complete: `deploy-instance-modules.js`, `deploy-tictacchain-factory.js`, `deploy-connectfour-factory.js`, `deploy-chessonchain-factory.js`, `deploy-factories.js`, `deploy-all-factory.js` | Done |
| | | | |
