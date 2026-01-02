# ABI Migration Guide - Library Refactoring

## Overview

The library refactoring changed the contract ABIs significantly. This document details all changes between the old ETour-based contracts and the new library-based contracts.

---

## ❌ REMOVED FUNCTIONS

### 1. Escalation Management Functions
These functions were in ETour but not migrated to library architecture:

```solidity
// OLD - REMOVED
function isMatchEscL1Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external view returns (bool);
function isMatchEscL2Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external view returns (bool);
function isMatchEscL3Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external view returns (bool);
```

**Impact**: Client cannot determine escalation availability for timeout UI

**Solution**: Need to add these back or client must calculate from `matchTimeouts` mapping

---

### 2. Match Replacement Functions
```solidity
// OLD - REMOVED
function claimMatchSlotByReplacement(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external;
function forceEliminateStalledMatch(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external;
```

**Impact**: Anti-griefing mechanism non-functional

**Solution**: These need to be re-added to game contracts

---

### 3. Enrollment Management Functions
```solidity
// OLD - REMOVED
function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external;
function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool);
function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external;
```

**Impact**: Cannot manage enrollment windows or claim abandoned pools

**Solution**: Need to be re-added

---

### 4. Raffle System (ENTIRELY REMOVED)
```solidity
// OLD - REMOVED
function executeProtocolRaffle() external returns (address winner, uint256 ownerAmount, uint256 winnerAmount);
function getRaffleInfo() external view returns (...);
function getRaffleConfiguration() external view returns (...);
function getRaffleThresholds() external view returns (...);
function currentRaffleIndex() external view returns (uint256);
function accumulatedProtocolShare() external view returns (uint256);
```

**Impact**: Entire raffle feature non-functional

**Solution**: Remove from client OR re-implement in contracts

---

### 5. Constants & Simple Getters
```solidity
// OLD - REMOVED
function BASIS_POINTS() external view returns (uint256);
function OWNER_SHARE_BPS() external view returns (uint256);
function PROTOCOL_SHARE_BPS() external view returns (uint256);
function PARTICIPANTS_SHARE_BPS() external view returns (uint256);
function ENTRY_FEES(uint8 tierId) external view returns (uint256);
function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8);
function TIER_SIZES(uint8 tierId) external view returns (uint8);
function NO_ROUND() external view returns (uint8);
```

**Replacement**: Use `tierConfigs(tierId)` struct fields:
```solidity
// NEW - Use struct
TierConfig memory config = tierConfigs(tierId);
uint256 entryFee = config.entryFee;
uint8 instanceCount = config.instanceCount;
uint8 playerCount = config.playerCount;
```

---

### 6. Player Activity Tracking
```solidity
// OLD - REMOVED
function isPlayerInAdvancedRound(address player, uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (bool);
```

**Solution**: Client must track this from tournament state

---

### 7. Legacy Helper Functions
```solidity
// OLD - REMOVED
function declareRW3() external view returns (string);
function getTournamentCount() external view returns (uint256);
function getMatchId(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external view returns (bytes32);
```

**Impact**: Minor - mostly internal utilities

---

## 🔄 CHANGED FUNCTIONS

### 1. `getRoundInfo` → `getRound`

**OLD**:
```solidity
function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber)
    external view
    returns (uint8 totalMatches, uint8 completedMatches, bool initialized);
```

**NEW**:
```solidity
function getRound(uint8 tierId, uint8 instanceId, uint8 roundNumber)
    external view
    returns (Round memory);

struct Round {
    uint8 totalMatches;
    uint8 completedMatches;
    bool initialized;
    uint8 drawCount;
    bool allMatchesDrew;
}
```

**Migration**:
```javascript
// OLD
const [totalMatches, completedMatches, initialized] = await contract.getRoundInfo(t, i, r);

// NEW
const roundInfo = await contract.getRound(t, i, r);
const totalMatches = roundInfo.totalMatches;
const completedMatches = roundInfo.completedMatches;
const initialized = roundInfo.initialized;
```

---

### 2. `getPlayerStats` - Now Requires Address Parameter

**OLD**:
```solidity
function getPlayerStats() external view returns (int256 totalEarnings);
```

**NEW**:
```solidity
function getPlayerStats(address player) external view returns (PlayerStats memory);

struct PlayerStats {
    uint256 tournamentsWon;
    uint256 tournamentsPlayed;
    uint256 matchesWon;
    uint256 matchesPlayed;
}
```

**Migration**:
```javascript
// OLD
const earnings = await contract.getPlayerStats(); // Uses msg.sender

// NEW
const stats = await contract.getPlayerStats(account);
// earnings data now in playerEarnings mapping, not in stats
```

---

### 3. `getLeaderboard` - Now Requires Pagination

**OLD**:
```solidity
function getLeaderboard() external view returns (LeaderboardEntry[] memory);
```

**NEW**:
```solidity
function getLeaderboard(uint256 startIndex, uint256 count)
    external view
    returns (LeaderboardEntry[] memory);

struct LeaderboardEntry {
    address player;
    int256 netEarnings;  // Changed from 'earnings' to 'netEarnings'
}
```

**Migration**:
```javascript
// OLD
const leaderboard = await contract.getLeaderboard();

// NEW
const leaderboard = await contract.getLeaderboard(0, 100); // Get first 100
```

---

### 4. `getTournamentInfo` - Simplified Return Values

**OLD**:
```solidity
function getTournamentInfo(uint8 tierId, uint8 instanceId)
    external view
    returns (
        TournamentStatus status,
        Mode mode,              // REMOVED
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    );
```

**NEW**:
```solidity
function getTournamentInfo(uint8 tierId, uint8 instanceId)
    external view
    returns (
        TournamentStatus status,
        // Mode removed
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    );
```

**Better Alternative - Use `getTournament()`**:
```solidity
function getTournament(uint8 tierId, uint8 instanceId)
    external view
    returns (TournamentInstance memory);

struct TournamentInstance {
    uint8 tierId;
    uint8 instanceId;
    TournamentStatus status;
    Mode mode;
    uint8 currentRound;
    uint8 enrolledCount;
    uint256 prizePool;
    uint256 startTime;
    address winner;
    address coWinner;
    bool finalsWasDraw;
    bool allDrawResolution;
    uint8 allDrawRound;
    EnrollmentTimeoutState enrollmentTimeout;
    bool hasStartedViaTimeout;
}
```

**Migration**:
```javascript
// OLD
const [status, mode, round, count, pool, winner] = await contract.getTournamentInfo(t, i);

// NEW - Option 1: Use getTournamentInfo (no mode)
const [status, round, count, pool, winner] = await contract.getTournamentInfo(t, i);

// NEW - Option 2: Use getTournament (full data)
const tournament = await contract.getTournament(t, i);
const { status, mode, currentRound, enrolledCount, prizePool, winner } = tournament;
```

---

### 5. `getTierConfiguration` - REMOVED

**OLD**:
```solidity
function getTierConfiguration(uint8 tierId)
    external view
    returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        uint256 matchLevel2Delay,
        uint256 matchLevel3Delay,
        uint256 enrollmentWindow,
        uint256 enrollmentLevel2Delay,
        uint8[] memory prizeDistribution
    );
```

**NEW - Use `tierConfigs` mapping**:
```solidity
function tierConfigs(uint8 tierId) external view returns (TierConfig memory);

struct TierConfig {
    uint8 playerCount;
    uint8 instanceCount;
    uint256 entryFee;
    Mode mode;
    TimeoutConfig timeouts;
    uint8 totalRounds;
    bool initialized;
}
```

**Migration**:
```javascript
// OLD
const [pCount, iCount, fee, matchTime, incr, l2, l3, enrollWin, enrollL2, prizes] =
    await contract.getTierConfiguration(tierId);

// NEW
const config = await contract.tierConfigs(tierId);
const {
    playerCount,
    instanceCount,
    entryFee,
    mode,
    timeouts: { matchTimePerPlayer, timeIncrementPerMove, matchLevel2Delay, matchLevel3Delay, enrollmentWindow, enrollmentLevel2Delay }
} = config;

// For prizes - separate call
const prizes = await contract.getTierPrizeDistribution(tierId);
```

---

### 6. `getTierTimeouts` - REMOVED

**OLD**:
```solidity
function getTierTimeouts(uint8 tierId)
    external view
    returns (
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        uint256 matchLevel2Delay,
        uint256 matchLevel3Delay,
        uint256 enrollmentWindow,
        uint256 enrollmentLevel2Delay
    );
```

**NEW - Use `getTimeoutConfig`**:
```solidity
function getTimeoutConfig(uint8 tierId)
    external view
    returns (TimeoutConfig memory);
```

**Migration**:
```javascript
// OLD
const [matchTime, incr, l2, l3, enrollWin, enrollL2] = await contract.getTierTimeouts(tierId);

// NEW
const timeouts = await contract.getTimeoutConfig(tierId);
const { matchTimePerPlayer, timeIncrementPerMove, matchLevel2Delay, matchLevel3Delay, enrollmentWindow, enrollmentLevel2Delay } = timeouts;
```

---

### 7. `getFeeDistribution` - REMOVED

**OLD**:
```solidity
function getFeeDistribution()
    external pure
    returns (
        uint256 prizePoolPercentage,
        uint256 ownerFeePercentage,
        uint256 protocolFeePercentage,
        uint256 basisPoints
    );
```

**NEW - Hardcoded Constants**:
```javascript
// Use constants in client
const BASIS_POINTS = 10000;
const PARTICIPANTS_SHARE_BPS = 9000; // 90%
const OWNER_SHARE_BPS = 500; // 5%
const PROTOCOL_SHARE_BPS = 500; // 5%
```

---

### 8. `getTierPrizeDistribution` & `getPrizePercentage` - REMOVED

**OLD**:
```solidity
function getTierPrizeDistribution(uint8 tierId) external view returns (uint8[] memory);
function getPrizePercentage(uint8 tierId, uint8 ranking) external view returns (uint8);
```

**NEW - Access via storage**:
Client needs to call library function or access storage mapping directly (requires adding view functions)

---

### 9. `getTierInfo` - REMOVED

**OLD**:
```solidity
function getTierInfo(uint8 tierId)
    external view
    returns (uint8 playerCount, uint8 instanceCount, uint256 entryFee);
```

**NEW - Use `tierConfigs`**:
```javascript
// OLD
const [playerCount, instanceCount, entryFee] = await contract.getTierInfo(tierId);

// NEW
const config = await contract.tierConfigs(tierId);
const { playerCount, instanceCount, entryFee } = config;
```

---

### 10. `getTierOverview` - REMOVED

**OLD**:
```solidity
function getTierOverview(uint8 tierId)
    external view
    returns (
        TournamentStatus[] memory statuses,
        uint8[] memory enrolledCounts,
        uint256[] memory prizePools
    );
```

**NEW - Must iterate manually**:
```javascript
// OLD
const [statuses, enrolledCounts, prizePools] = await contract.getTierOverview(tierId);

// NEW - Manual iteration
const config = await contract.tierConfigs(tierId);
const instanceCount = config.instanceCount;
const tournaments = [];

for (let i = 0; i < instanceCount; i++) {
    const tournament = await contract.getTournament(tierId, i);
    tournaments.push({
        status: tournament.status,
        enrolledCount: tournament.enrolledCount,
        prizePool: tournament.prizePool
    });
}
```

---

## ✅ NEW FUNCTIONS AVAILABLE

### 1. Enhanced Tournament Data
```solidity
// NEW - Comprehensive tournament data
function getTournament(uint8 tierId, uint8 instanceId)
    external view
    returns (TournamentInstance memory);
```

### 2. Tier Management
```solidity
// NEW - Get all configured tiers
function getAllTierIds() external view returns (uint8[] memory);
```

### 3. Player Activity
```solidity
// NEW - Comprehensive activity tracking
function getPlayerActiveTournaments(address player)
    external view
    returns (TournamentRef[] memory);

function getPlayerEnrollingTournaments(address player)
    external view
    returns (TournamentRef[] memory);

function getPlayerActivityCounts(address player)
    external view
    returns (uint256 enrollingCount, uint256 activeCount);
```

### 4. Match Caching
```solidity
// NEW - Match caching system
function getCachedMatch(address player1, address player2)
    external view
    returns (CachedMatchData memory);

function getCachedMatchByIndex(uint16 index)
    external view
    returns (CachedMatchData memory);

function getAllCachedMatches()
    external view
    returns (CachedMatchData[] memory);

function getRecentCachedMatches(uint16 count)
    external view
    returns (CachedMatchData[] memory);

function isMatchCached(address player1, address player2)
    external view
    returns (bool);
```

### 5. Enhanced State Queries
```solidity
// NEW - More detailed queries
function isEnrolled(uint8 tierId, uint8 instanceId, address player)
    external view
    returns (bool);

function isPlayerInTournament(address player, uint8 tierId, uint8 instanceId)
    external view
    returns (bool isEnrolling, bool isActive);
```

---

## 🔧 FUNCTIONS THAT NEED TO BE RE-ADDED

To maintain full backward compatibility and functionality, these functions should be added back to the game contracts:

### Priority 1 - Critical Functionality
```solidity
// Escalation
function isMatchEscL1Available(...) external view returns (bool);
function isMatchEscL2Available(...) external view returns (bool);
function isMatchEscL3Available(...) external view returns (bool);

// Match Replacement
function claimMatchSlotByReplacement(...) external;
function forceEliminateStalledMatch(...) external;

// Enrollment Management
function resetEnrollmentWindow(...) external;
function canResetEnrollmentWindow(...) external view returns (bool);
function claimAbandonedEnrollmentPool(...) external;
```

### Priority 2 - Convenience Functions
```solidity
// Simple getters
function ENTRY_FEES(uint8 tierId) external view returns (uint256);
function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8);
function TIER_SIZES(uint8 tierId) external view returns (uint8);
function BASIS_POINTS() external pure returns (uint256);
function OWNER_SHARE_BPS() external pure returns (uint256);
function PROTOCOL_SHARE_BPS() external pure returns (uint256);
function PARTICIPANTS_SHARE_BPS() external pure returns (uint256);

// Prize distribution
function getTierPrizeDistribution(uint8 tierId) external view returns (uint8[] memory);
function getPrizePercentage(uint8 tierId, uint8 ranking) external view returns (uint8);

// Tier overview
function getTierInfo(uint8 tierId) external view returns (uint8, uint8, uint256);
function getTierConfiguration(uint8 tierId) external view returns (...);
function getTierTimeouts(uint8 tierId) external view returns (...);
function getTierOverview(uint8 tierId) external view returns (...);
```

### Priority 3 - Raffle (If Keeping Feature)
```solidity
function executeProtocolRaffle() external returns (address, uint256, uint256);
function getRaffleInfo() external view returns (...);
function getRaffleConfiguration() external view returns (...);
function getRaffleThresholds() external view returns (...);
```

---

## 📊 SUMMARY

### Functions Removed: ~40
### Functions Changed: ~12
### Functions Added: ~8

### Client Impact:
- **High**: Escalation, match replacement, enrollment management
- **Medium**: Raffle system, player activity tracking
- **Low**: Convenience getters (can use struct access instead)

### Recommended Approach:
1. Add back Priority 1 functions (escalation, replacement, enrollment)
2. Client updates to use new struct-based getters for constants
3. Remove raffle feature from client OR re-implement in contracts
4. Use new caching functions for performance improvements
