# ETour Player Profile Contract + Raffle Redesign — Plan

**Created:** 2026-03-24
**Updated:** 2026-03-25
**Status:** Ready to Execute
**Scope:** Phase 4 — PlayerProfile factory pattern + Community Raffle replacement

---

## 1. The Problem This Solves

Currently `ETourFactory` holds a flat `mapping(address => address[]) playerInstances` — just an array of instance addresses per player. This means:

- Any richer player data (stats summary, cross-game record) has nowhere to live on-chain except bloating the factory.
- Each factory (TicTac, ConnectFour, Chess) holds its own siloed `playerInstances` — no unified cross-game player identity.
- The factory's per-player storage grows unboundedly as players join more tournaments.

**Goal:** Give every player a dedicated contract that owns their data, while keeping each game factory lightweight (it only stores `address → playerProfileAddress` via the registry).

---

## 2. Core Idea

When a player enrolls in their **first ever** tournament (across any factory), a `PlayerProfile` contract is deployed for them — once, globally. All subsequent enrollments across all game types record to that same profile.

A **`PlayerRegistry`** contract acts as the single source of truth:
- `mapping(address => address) public profiles` — wallet → profile contract address
- Deployed once, address known by all game factories
- Factories call it on enrollment to get-or-create a profile

```
PlayerRegistry (singleton)
├── profiles[0xAlice] → PlayerProfile_Alice
├── profiles[0xBob]   → PlayerProfile_Bob
└── ...

PlayerProfile_Alice
├── owner: 0xAlice
├── enrollments[]: [TicTacInstance_1, ChessInstance_5, ...]
└── stats: { wins, losses, draws, totalEarnings, tournamentsPlayed, perGameType }
```

---

## 3. Resolved Design Decisions

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Registry authorization | Only the protocol deployer (owner) can `authorizeFactory()`. Factories self-register via `ETourFactory` constructor calling `registry.authorizeFactory(address(this))` — **not** open to arbitrary callers. |
| 2 | Profile metadata | No display name or avatar for now. Profile stores only enrollment history and stats. |
| 3 | Result sync trigger | **Push model**: when a tournament concludes, the instance calls back to each player's profile directly as part of `_handleTournamentConclusion()`. No manual `syncResult` function. |
| 4 | `playerInstances` removal | Removed immediately once the new implementation is working. No deprecation period. |
| 5 | Raffle | Raffle mechanic is being redesigned soon — skip raffle changes entirely. The existing raffle logic can temporarily be a no-op or use a stub. |
| 6 | Max player count | **Capped at 32** (down from 64) to bound worst-case conclusion gas. |
| 7 | Conclusion gas cost | Profile update callbacks are best-effort (low-level calls, failures ignored). Gas cost absorbed by the **2.5% protocol share** already collected — no new fee tier. |

---

## 4. Contract Architecture

### 4.1 `PlayerRegistry.sol` (new singleton)

Responsibilities:
- Deploy `PlayerProfile` clones via EIP-1167
- Map `wallet → profile address`
- Gate `recordEnrollment` and `recordResult` to authorized factories only

```solidity
contract PlayerRegistry {
    address public immutable profileImplementation;
    address public owner;
    mapping(address => address) public profiles;
    mapping(address => bool) public authorizedFactories;

    // Called by factory constructor at deploy time
    function authorizeFactory(address factory) external onlyOwner;

    // Called by factory.registerPlayer() on enrollment
    // Creates profile clone if first enrollment
    function recordEnrollment(address player, address instance, uint8 gameType) external onlyAuthorized;

    // Called by instance._handleTournamentConclusion() for each enrolled player
    // Routes to the correct profile and records outcome
    function recordResult(address player, address instance, bool won, uint256 prize) external onlyAuthorized;

    function getProfile(address player) external view returns (address);
}
```

**Authorization model:** `onlyAuthorized` checks `authorizedFactories[msg.sender]`. The owner must call `authorizeFactory(factory)` for each deployed factory before it can write to profiles. This is done in the deploy script immediately after factory deployment.

### 4.2 `PlayerProfile.sol` (new clonable)

Deployed once per player by the registry. Initialized with the player's wallet address.

```solidity
struct EnrollmentRecord {
    address instance;    // tournament instance address
    uint8   gameType;    // 0=TicTac, 1=ConnectFour, 2=Chess
    uint64  enrolledAt;  // timestamp
    bool    concluded;   // result has been pushed
    bool    won;         // did this player win?
    uint256 prize;       // prize amount received (0 if lost)
}

struct GameStats {
    uint32 played;
    uint32 wins;
    uint32 losses;
    uint32 draws;
    int256 netEarnings;
}

struct PlayerStats {
    uint32 totalPlayed;
    uint32 totalWins;
    uint32 totalLosses;
    uint32 totalDraws;
    int256 totalNetEarnings;
    mapping(uint8 => GameStats) byGameType;  // 0/1/2
}
```

Key functions:
- `initialize(address _owner, address _registry)` — called once by registry
- `recordEnrollment(address instance, uint8 gameType, uint256 entryFee)` — only registry
- `recordResult(address instance, bool won, uint256 prize)` — only registry; finds matching enrollment by instance address, marks concluded, updates stats
- `getEnrollments(uint256 offset, uint256 limit)` — paginated
- `getStats()` — returns flat stats (no mapping in return — return arrays for byGameType)
- `getEnrollmentCount()` — total enrollment count

### 4.3 `ETourFactory.sol` changes

**Remove:**
```solidity
mapping(address => address[]) public playerInstances;
// and all references
```

**Add:**
```solidity
address public immutable PLAYER_REGISTRY;

constructor(..., address _playerRegistry) {
    PLAYER_REGISTRY = _playerRegistry;
}

function registerPlayer(address player) external {
    // msg.sender is the calling instance (trust model unchanged)
    (bool ok, ) = PLAYER_REGISTRY.call(
        abi.encodeWithSignature(
            "recordEnrollment(address,address,uint8)",
            player, msg.sender, GAME_TYPE
        )
    );
    ok; // best-effort, intentionally ignored
}

function getPlayerProfile(address player) external view returns (address) {
    (bool ok, bytes memory ret) = PLAYER_REGISTRY.staticcall(
        abi.encodeWithSignature("getProfile(address)", player)
    );
    if (!ok || ret.length == 0) return address(0);
    return abi.decode(ret, (address));
}
```

`GAME_TYPE` is an abstract `uint8` constant defined by each child factory.

**Remove from factory:**
- `mapping(address => address[]) public playerInstances`
- `getPlayerInstances(address player)` view
- `_isCallerEnrolledInAnyActive` — raffle skip for now
- `_getActivePlayersWithWeights` — raffle skip for now

### 4.4 `ETourInstance_Base.sol` — conclusion callback

In `_handleTournamentConclusion()`, after prizes are distributed, add a best-effort callback loop:

```solidity
// After prize distribution loop:
address reg = ETourFactory(factory).PLAYER_REGISTRY;
for (uint256 i = 0; i < enrolledPlayers.length; i++) {
    address p = enrolledPlayers[i];
    bool won = (tournament.winner == p);
    uint256 prize = playerPrizes[p];
    // best-effort: failure must not revert conclusion
    reg.call{gas: 50_000}(
        abi.encodeWithSignature(
            "recordResult(address,address,bool,uint256)",
            p, address(this), won, prize
        )
    );
}
```

Gas budget: 50k gas per player × 32 max players = 1.6M gas max for callbacks. Absorbed by protocol share already collected.

---

## 5. Data Flow

### On Enrollment
```
enrollInTournament() / enrollOnBehalf()
  └─► ETourInstance_Base.enrollInTournament()
        └─► MODULE_CORE.delegatecall(coreEnroll)
        └─► factory.registerPlayer(player)              ← existing call
              └─► registry.recordEnrollment(player, instance, gameType)
                    ├─► if no profile: clone PlayerProfile, initialize
                    └─► profile.recordEnrollment(instance, gameType, entryFee)
```

### On Conclusion
```
_handleTournamentConclusion()
  ├─► MODULE_PRIZES.delegatecall(distributePrizes)
  ├─► emit TournamentConcluded
  └─► for each enrolledPlayer:
        registry.recordResult(player, instance, won, prize)  ← best-effort
          └─► profile.recordResult(instance, won, prize)
```

---

## 6. New Files

| File | Type |
|------|------|
| `contracts/PlayerRegistry.sol` | Singleton registry + clone factory |
| `contracts/PlayerProfile.sol` | Per-player clonable profile |
| `contracts/interfaces/IPlayerRegistry.sol` | Used by factories + instances |
| `contracts/interfaces/IPlayerProfile.sol` | Used by registry |

---

## 7. Changed Files

| File | Changes |
|------|---------|
| `ETourFactory.sol` | Add `PLAYER_REGISTRY` immutable; replace `playerInstances` + `registerPlayer`; add `getPlayerProfile`; remove raffle player-iteration helpers (stub/skip) |
| `TicTacChainFactory.sol` | Add `GAME_TYPE = 0`; pass registry to super constructor |
| `ConnectFourFactory.sol` | Add `GAME_TYPE = 1`; pass registry |
| `ChessOnChainFactory.sol` | Add `GAME_TYPE = 2`; pass registry |
| `ETourInstance_Base.sol` | Add profile callback loop in `_handleTournamentConclusion()`; cap playerCount validation at 32 |
| `ETourFactory.sol` | Cap `_validatePlayerCount` at 32 |
| Deploy scripts | Deploy `PlayerProfile` impl → `PlayerRegistry` → factories (pass registry); call `authorizeFactory` for each |

---

## 8. Execution Plan

### Phase A — New contracts
- [ ] `IPlayerRegistry.sol`
- [ ] `IPlayerProfile.sol`
- [ ] `PlayerProfile.sol`
- [ ] `PlayerRegistry.sol`
- [ ] Compile, 0 errors

### Phase B — Factory + Instance integration
- [ ] `ETourFactory.sol`: add registry, replace `playerInstances`, remove entire raffle system (`accumulatedProtocolShare`, `raffleResults`, `receiveProtocolShare`, all helpers)
- [ ] `ETourInstance_Core.sol`: deferred fees — remove immediate owner + protocol transfers; accumulate all three buckets in storage; update `forfeitPool` to full entry fee; update EL1 solo refund to 100%
- [ ] `ETourInstance_Base.sol`: add `ownerAccrued` + `protocolAccrued` to `TournamentState`; add deferred owner send + profile callbacks + raffle in `_handleTournamentConclusion()`; add `rescueStuckFunds()`; add `TournamentRaffleAwarded` event; cap playerCount at 32
- [ ] Child factories: add `GAME_TYPE`, pass registry
- [ ] Compile, 0 errors

### Phase C — Deploy scripts
- [ ] Update all deploy scripts: registry first, `authorizeFactory` after each factory
- [ ] Smoke test on localhost

### Phase D — Tests
- [ ] PlayerProfile unit: enrollment, result recording, stats accuracy
- [ ] PlayerRegistry: clone idempotency, authorization gating
- [ ] Integration: full enrollment → conclusion → profile updated
- [ ] Raffle: winner is always one of the enrolled players; raffle skipped when balance is 0
- [ ] Raffle: `TournamentRaffleAwarded` event emitted correctly
- [ ] Deferred fees: assert `prizePool + ownerAccrued + protocolAccrued == entryFee × enrolledCount` invariant at all stages
- [ ] EL1: solo enroll → forceStart → assert 100% refund to solo player, owner gets 0
- [ ] EL2: partial enroll → timeout → claim → assert 100% of enrolled fees to claimer, owner gets 0
- [ ] Normal conclusion: assert owner gets 7.5%, winner gets 90%, raffle gets 2.5%
- [ ] Gas benchmark: 32-player conclusion with deferred owner send + callbacks + raffle

---

---

## 10. Raffle Redesign — Community Raffle Removed, Per-Tournament Raffle Added

### 10.1 What's Being Removed

The existing community raffle mechanism on `ETourFactory` is eliminated entirely:

**Removed from `ETourFactory`:**
- `accumulatedProtocolShare` storage
- `raffleThresholds[]` storage
- `raffleResults[]` storage + `RaffleResult` struct
- `executeProtocolRaffle()` external function
- `getRaffleInfo()`, `getRaffleCount()`, `getRaffleResult()` views
- `receiveProtocolShare()` payable receiver
- `_isCallerEnrolledInAnyActive()` internal
- `_getActivePlayersWithWeights()` internal
- `_selectWeightedWinner()` internal
- `RAFFLE_OWNER_BPS`, `RAFFLE_WINNER_BPS`, `RAFFLE_RESERVE_BPS` constants
- `RaffleExecuted` event

**Removed from `ETourInstance_Core` (module):**
- `receiveProtocolShare()` call forwarding protocol fees to factory — protocol share now stays on the instance

### 10.2 New Model: Per-Tournament Instant Raffle

**Concept:** The 2.5% protocol share collected from each player's entry fee stays on the instance. When the tournament concludes, after prize distribution and profile callbacks, whatever protocol balance remains is immediately raffled among the enrolled players of that tournament. The factory never accumulates protocol funds.

**Fee flow change:**

```
Current enrollment fee split:
  90%   → prize pool (held on instance)
  7.5%  → owner share → forwarded to factory immediately
  2.5%  → protocol share → forwarded to factory immediately

New enrollment fee split (ALL deferred — nothing leaves the instance on enrollment):
  90%   → prize pool         (held on instance until conclusion)
  7.5%  → owner accrued      (held on instance until conclusion)
  2.5%  → protocol raffle    (held on instance until conclusion)
  ────────────────────────────────────────────────────────────
  100%  → stays on instance  (full entry fee always refundable pre-conclusion)
```

At conclusion:
```
instance balance = 100% × enrolledCount × entryFee

Step 1: prize pool (90%) → distributed to winner(s) via MODULE_PRIZES
Step 2: owner accrued (7.5%) → forwarded to factory.receiveOwnerShare()
Step 3: profile callbacks → best-effort, no ETH moved
Step 4: remaining balance (2.5% protocol) → instant raffle among enrolledPlayers[]
```

### 10.3 Raffle Mechanics

- **Eligible players:** all `enrolledPlayers[]` — everyone who enrolled, including losers
- **Selection:** uniform random (no weights) — one winner takes all remaining balance
- **Randomness:** `keccak256(block.prevrandao, block.timestamp, block.number, address(this), enrolledCount)` — pseudo-random, acceptable for this use case (not a high-value standalone lottery; players already have skin in the game)
- **Timing:** fires in `_handleTournamentConclusion()`, after prize distribution, after profile callbacks
- **Transfer:** best-effort `call{value: raffleAmount}("")` to winner — if transfer fails, funds remain on concluded instance (recoverable by owner via a factory rescue function)
- **Minimum:** if `rafflePool == 0` (e.g. single-player force-start consumed all), skip silently

### 10.4 Implementation Location

The raffle runs directly in `ETourInstance_Base._handleTournamentConclusion()`. No new module — it's tightly coupled to conclusion and has direct access to `enrolledPlayers[]` and the instance's ETH balance.

```solidity
// In _handleTournamentConclusion(), after prize distribution + profile callbacks:
uint256 rafflePool = address(this).balance;  // whatever protocol share remains
if (rafflePool > 0 && enrolledPlayers.length > 0) {
    uint256 idx = uint256(keccak256(abi.encodePacked(
        block.prevrandao, block.timestamp, block.number,
        address(this), tournament.enrolledCount
    ))) % enrolledPlayers.length;
    address raffleWinner = enrolledPlayers[idx];
    (bool sent, ) = payable(raffleWinner).call{value: rafflePool}("");
    // if sent fails, funds stay on instance (owner can rescue)
    emit TournamentRaffleAwarded(address(this), raffleWinner, rafflePool, sent);
}
```

### 10.5 New Event

```solidity
event TournamentRaffleAwarded(
    address indexed instance,
    address indexed winner,
    uint256 amount,
    bool transferred  // false = stuck on instance, owner rescue needed
);
```

### 10.6 Owner Rescue Function

Since a failed raffle transfer leaves ETH on a concluded instance, add a rescue path:

```solidity
// On ETourInstance_Base (callable only by factory owner)
function rescueStuckFunds(address to) external {
    require(msg.sender == ETourFactory(factory).owner(), "Not owner");
    require(tournament.status == TournamentStatus.Concluded, "Not concluded");
    uint256 balance = address(this).balance;
    require(balance > 0, "Nothing to rescue");
    (bool ok, ) = payable(to).call{value: balance}("");
    require(ok, "Transfer failed");
}
```

### 10.7 Factory Simplification Summary

After removing the community raffle, `ETourFactory` shrinks significantly:

| Was | Now |
|-----|-----|
| Accumulates protocol fees indefinitely | Never holds protocol fees |
| Community raffle triggered by threshold | No factory-level raffle at all |
| `accumulatedProtocolShare` storage var | Gone |
| `raffleResults[]` array (unbounded) | Gone |
| `raffleThresholds[]` config | Gone |
| ~150 lines of raffle logic | Gone |
| `receiveProtocolShare()` | Gone |

Factory now only holds: owner balance (7.5% share), tier registry, global instance list, player registry reference.

---

## 13. Deferred Owner Cut — Full Refunds on Abandoned Tournaments

### 13.1 The Change

The 7.5% owner share is **no longer sent at enrollment time**. It stays on the instance alongside the prize pool and protocol raffle pool. All three buckets are forwarded at conclusion time only.

**Why this matters:**

| Scenario | Old behaviour | New behaviour |
|----------|--------------|---------------|
| Normal win | Winner gets 90%, owner got 7.5% at enroll | Winner gets 90%, owner gets 7.5% at conclusion — same net |
| EL1 — solo force start | Solo player gets 90% back (7.5% already gone to owner) | Solo player gets **100%** back — full refund, owner gets nothing |
| EL2 — abandoned pool claim | Claimer gets `forfeitPool` = 90% × enrolled players | Claimer gets **100%** × enrolled entry fees — full refund of all enrolled funds |
| Partial start (e.g. 3 of 8 enrolled, force start) | Normal split on 3 players' fees | Normal split on 3 players' fees — unchanged |

This is the fair outcome: the owner and protocol only earn their cut when a real tournament completes (or partially completes). They don't extract fees from tournaments that never ran.

### 13.2 Storage Changes

Remove from `TournamentState`:
- No new fields needed — the owner accrued amount is implicit: `7.5% × enrolledCount × entryFee`

Add to `TournamentState`:
```solidity
uint256 ownerAccrued;     // tracks 7.5% accumulated across enrollments — sent at conclusion
uint256 protocolAccrued;  // tracks 2.5% accumulated — raffled at conclusion
// prizePool stays as-is (90% accumulated)
```

(Alternatively, `ownerAccrued` and `protocolAccrued` can be computed from `enrolledCount × entryFee × BPS` at conclusion time without storing them, since `entryFee` and `enrolledCount` are already in storage. Either approach works; explicit storage is clearer.)

### 13.3 Changes to `ETourInstance_Core.coreEnroll()` / `coreEnrollOnBehalf()`

**Remove:**
```solidity
// Owner share → factory immediately
(bool ownerOk, ) = payable(factory).call{value: ownerShare}(...);
require(ownerOk, "Owner fee transfer failed");

// Protocol share → factory immediately
(bool protocolOk, ) = payable(factory).call{value: protocolShare}(...);
require(protocolOk, "Protocol fee transfer failed");
```

**Replace with:**
```solidity
// All fee buckets stay on the instance — just track them in storage
tournament.prizePool      += participantsShare;   // 90%
tournament.ownerAccrued   += ownerShare;          // 7.5%
tournament.protocolAccrued += protocolShare;      // 2.5%
// forfeitPool also gets the full entry fee for EL2 refund purposes
tournament.enrollmentTimeout.forfeitPool += msg.value;  // was participantsShare, now full entryFee
```

### 13.4 Changes to Conclusion / EL1 / EL2 Paths

**Normal conclusion (`_handleTournamentConclusion`):**
```
Step 1: MODULE_PRIZES distributes prizePool (90%) to winner(s)
Step 2: send ownerAccrued (7.5%) → factory.receiveOwnerShare()   ← deferred from enrollment
Step 3: profile callbacks (best-effort, no ETH)
Step 4: raffle remaining balance (protocolAccrued = 2.5%) among enrolledPlayers[]
```

**EL1 — solo force start (`_startTournament` solo path in `ETourInstance_Core`):**
```
// Before: sent 90% back
// Now: send 100% back (full msg.value still on instance)
uint256 refund = tournament.prizePool + tournament.ownerAccrued + tournament.protocolAccrued;
// = entryFee × 1 player = 100% refund
(bool sent, ) = payable(soloWinner).call{value: refund}("");
```

**EL2 — abandoned pool claim (`coreClaimAbandonedPool`):**
```
// Before: claimAmount = forfeitPool (90% × enrolled)
// Now:    claimAmount = forfeitPool (100% × enrolled, since forfeitPool += msg.value on each enroll)
uint256 claimAmount = tournament.enrollmentTimeout.forfeitPool;  // already 100%
tournament.enrollmentTimeout.forfeitPool = 0;
// owner and protocol get nothing — tournament never ran
```

No changes needed to EL2 logic itself — just the `forfeitPool` accumulation change in `coreEnroll` (from `+= participantsShare` to `+= msg.value`) means it naturally holds 100%.

### 13.5 `receiveOwnerShare()` on Factory — Stays

`ETourFactory.receiveOwnerShare()` remains but is now called once at conclusion rather than once per enrollment. The factory's `ownerBalance` still accumulates correctly; `withdrawOwnerBalance()` is unchanged.

### 13.6 Updated Conclusion Flow (all three changes combined)

```
_handleTournamentConclusion()
  1. Determine winner type (normal / draw / all-draw)
  2. MODULE_PRIZES.delegatecall → distribute prizePool (90%) to winner(s)
  3. Send ownerAccrued (7.5%) → factory.receiveOwnerShare()     [deferred owner cut]
  4. Best-effort profile callbacks via registry.recordResult() for each player
  5. Raffle address(this).balance (≈2.5%) among enrolledPlayers[] → emit TournamentRaffleAwarded

EL1 solo path (in _startTournament):
  → refund 100% (prizePool + ownerAccrued + protocolAccrued) to soloWinner
  → no owner cut, no raffle

EL2 abandoned path (in coreClaimAbandonedPool):
  → claimAmount = forfeitPool = 100% × enrolled entry fees
  → no owner cut, no raffle
```

After step 5, instance ETH balance = 0 (barring a failed transfer, rescuable via `rescueStuckFunds`).

---

## 11. Updated Changed Files

| File | Changes |
|------|---------|
| `ETourFactory.sol` | Remove raffle entirely (accumulatedProtocolShare, raffleResults, thresholds, executeProtocolRaffle, receiveProtocolShare, all helpers); add `PLAYER_REGISTRY` immutable; replace `playerInstances` |
| `ETourInstance_Core.sol` | **Deferred fees**: remove immediate owner + protocol transfers on enroll; accumulate all three buckets in storage (`prizePool`, `ownerAccrued`, `protocolAccrued`); update `forfeitPool` to full entry fee; update EL1 solo refund to 100%; update EL2 claim to use full `forfeitPool` |
| `ETourInstance_Base.sol` | Add `ownerAccrued` + `protocolAccrued` to `TournamentState`; add deferred owner send + raffle in `_handleTournamentConclusion()`; add profile callback loop; add `rescueStuckFunds()`; add `TournamentRaffleAwarded` event; cap playerCount at 32 |
| `TicTacChainFactory.sol` | Add `GAME_TYPE = 0`; pass registry |
| `ConnectFourFactory.sol` | Add `GAME_TYPE = 1`; pass registry |
| `ChessOnChainFactory.sol` | Add `GAME_TYPE = 2`; pass registry |
| Deploy scripts | Deploy registry first; `authorizeFactory` after each factory |

---

## 12. Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Profile callback reverts, blocking tournament conclusion | **Critical** | Wrap in best-effort `call{gas:50_000}` — failure silently ignored |
| Profile clone deployment OOG on first enrollment | Medium | EIP-1167 clone is ~700 gas; acceptable |
| Factory not authorized in registry, enrollment silently drops profile creation | Medium | Deploy script must call `authorizeFactory` immediately; add integration test |
| `recordResult` called with wrong instance (mismatched enrollment) | Low | Profile scans enrollment array for matching instance address |
| 32-player conclusion uses ~1.6M gas for callbacks | Medium | Fits within block gas limit; absorbed by protocol fees |
| Raffle winner transfer fails → ETH stuck on concluded instance | Medium | `rescueStuckFunds()` on instance callable by factory owner; `TournamentRaffleAwarded` event with `transferred=false` flags it |
| Pseudo-random raffle manipulable by block proposer | Low | Acceptable for in-game raffle among participants who already have stake; not a standalone high-value lottery |
| Protocol share depleted by profile callbacks before raffle fires | Low | Callbacks use `call{gas: 50_000}` with no `value` — they don't drain ETH, only consume gas paid by the conclusion tx caller |
| Owner cut send fails at conclusion → ETH stuck | Medium | `receiveOwnerShare()` call wrapped best-effort; stuck funds rescuable via `rescueStuckFunds()` |
| Instance holds 100% of entry fees until conclusion — larger attack surface | Low-Med | Instance contracts are already trusted; no change to access control; just more ETH on-instance for longer |
| EL1 solo refund sends wrong amount if storage tracking is off | High | Unit test: solo enroll → forceStart → assert 100% refund; verify `prizePool + ownerAccrued + protocolAccrued == entryFee` invariant |
