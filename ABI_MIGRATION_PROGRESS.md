# ABI Migration Progress - Library Refactoring

**Status**: TicTacChain COMPILES - Some library functions commented out, ChessOnChain & ConnectFourOnChain pending

**Goal**: Restore full backward compatibility with old ETour-based ABIs while maintaining library architecture

**Latest Update**: TicTacChain successfully compiles! Contract size is 34.3 kB (above 24 kB limit but functional)

---

## ✅ COMPLETED

### TicTacChain.sol - Backward Compatibility Functions Added (Lines 1199-1686)

#### 1. Constants & Simple Getters
```solidity
✅ ENTRY_FEES(uint8 tierId) - returns tierConfigs[tierId].entryFee
✅ INSTANCE_COUNTS(uint8 tierId) - returns tierConfigs[tierId].instanceCount
✅ TIER_SIZES(uint8 tierId) - returns tierConfigs[tierId].playerCount
✅ BASIS_POINTS() - returns 10000
✅ OWNER_SHARE_BPS() - returns 500
✅ PROTOCOL_SHARE_BPS() - returns 500
✅ PARTICIPANTS_SHARE_BPS() - returns 9000
✅ NO_ROUND() - returns 255
✅ declareRW3() - returns RW3 message
✅ currentRaffleIndex() - returns _etourStorage.currentRaffleIndex
✅ accumulatedProtocolShare() - returns _etourStorage.accumulatedProtocolShare
```

#### 2. Tier Information Functions
```solidity
✅ getTierInfo(uint8 tierId) - returns (playerCount, instanceCount, entryFee)
✅ getTierConfiguration(uint8 tierId) - returns full tier config with timeouts and prizes
✅ getTierTimeouts(uint8 tierId) - returns all timeout values
✅ getTierOverview(uint8 tierId) - returns arrays of statuses, counts, pools for all instances
✅ getTierPrizeDistribution(uint8 tierId) - returns prize percentages array
✅ getPrizePercentage(uint8 tierId, uint8 ranking) - returns single prize percentage
✅ getFeeDistribution() - returns (9000, 500, 500, 10000)
✅ getTierCapacity(uint8 tierId) - returns playerCount * instanceCount
✅ getTotalCapacity() - iterates all tiers and sums capacity
✅ getMatchTimePerPlayer(uint8 tierId) - returns match time from config
✅ getTimeIncrement() - returns 0 (legacy)
```

#### 3. Legacy View Functions
```solidity
✅ getRoundInfo(uint8, uint8, uint8) - returns (totalMatches, completedMatches, initialized)
✅ getLeaderboardCount() - returns _etourStorage.leaderboardPlayers.length
✅ getPlayerStats() - no params, returns _etourStorage.playerEarnings[msg.sender]
✅ getLeaderboard() - no params, calls ETourLib_Prizes.getLeaderboard(_etourStorage)
```

#### 4. Escalation Check Functions (VIEW ONLY)
```solidity
✅ isMatchEscL1Available(uint8, uint8, uint8, uint8) - checks escalation1Start
✅ isMatchEscL2Available(uint8, uint8, uint8, uint8) - checks escalation1Start
✅ isMatchEscL3Available(uint8, uint8, uint8, uint8) - checks escalation2Start
⚠️ isPlayerInAdvancedRound(address, uint8, uint8, uint8) - NEEDS FIX (see below)
```

#### 5. Enrollment Management Functions
```solidity
✅ canResetEnrollmentWindow(uint8, uint8) - checks conditions
✅ resetEnrollmentWindow(uint8, uint8) - resets escalation timers
✅ claimAbandonedEnrollmentPool(uint8, uint8) - claims forfeit pool
```

#### 6. Match Escalation Functions
```solidity
⚠️ forceEliminateStalledMatch(uint8, uint8, uint8, uint8) - NEEDS FIX (see below)
⚠️ claimMatchSlotByReplacement(uint8, uint8, uint8, uint8) - NEEDS FIX (see below)
```

#### 7. Raffle Functions
```solidity
✅ executeProtocolRaffle() - delegates to ETourLib_Prizes.executeProtocolRaffle()
✅ getRaffleInfo() - delegates to ETourLib_Prizes.getRaffleInfo()
✅ getRaffleConfiguration() - delegates to ETourLib_Prizes.getRaffleConfiguration()
✅ getRaffleThresholds() - delegates to ETourLib_Prizes.getRaffleThresholds()
```

---

## ❌ ISSUES TO FIX

### Issue 1: Match Storage Access in Escalation Functions

**Problem**: Functions try to access `_etourStorage.matches` which doesn't exist. Match data is stored in the game contract's own `matches` mapping, not in `_etourStorage`.

**Affected Functions**:
- `isPlayerInAdvancedRound()` - Line 1442-1443
- `forceEliminateStalledMatch()` - Lines 1559-1560
- `claimMatchSlotByReplacement()` - Lines 1605-1606

**Error**:
```
Member "matches" not found or not visible after argument-dependent lookup in struct ETourLib_Core.ETourStorage storage ref.
```

**Current Code (BROKEN)**:
```solidity
// Line 1442
bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId];
//                                              ^^^^^^^^^^^^^^^^^^^ DOESN'T EXIST
```

**Solution**: Use the game contract's `matches` mapping instead:
```solidity
// FIXED VERSION
bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
Match storage matchData = matches[matchId];

// Check completion status
if (matchData.status == MATCH_COMPLETED &&
    matchData.winner == player &&
    !matchData.isDraw) {
    return true;
}
```

**OR** - Add a helper function:
```solidity
function _getMatchCommonData(bytes32 matchId) internal view returns (
    address winner,
    bool isDraw,
    ETourLib_Core.MatchStatus status
) {
    Match storage matchData = matches[matchId];
    return (matchData.winner, matchData.isDraw, matchData.status);
}
```

### Issue 2: Missing Library Functions

**Problem**: Several functions delegate to library functions that don't exist yet.

**Missing in ETourLib_Matches.sol**:
```solidity
// Line 1547 in TicTacChain.sol calls this
function checkAndMarkStalled(
    ETourStorage storage self,
    bytes32 matchId,
    uint8 tierId,
    uint8 instanceId,
    uint8 roundNumber,
    uint8 matchNumber
) external;
```

**Missing in ETourLib_Prizes.sol**:
```solidity
// These are called but may not exist
function executeProtocolRaffle(ETourStorage storage self, address owner)
    external returns (address winner, uint256 ownerAmount, uint256 winnerAmount);

function getRaffleInfo(ETourStorage storage self)
    external view returns (uint256 raffleIndex, bool isReady, ...);

function getRaffleConfiguration()
    external pure returns (uint256 threshold, uint256 reserve, ...);

function getRaffleThresholds(ETourStorage storage self)
    external view returns (uint256[] memory thresholds, ...);
```

**Solution**: Check if these exist in the libraries, if not, implement them.

### Issue 3: Variable Shadowing Warnings

**Problem**: Lines 1561 and 1607 shadow the `matchId` variable.

**Current Code**:
```solidity
// Line 1544
bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

// ... later in same function, Line 1559
bytes32 matchId2 = _getMatchId(tierId, instanceId, r, m); // Good - renamed
ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId2];
```

**Issue**: The renaming is correct but there's still a shadowing warning. Need to verify the exact line causing it.

---

## 🔄 IN PROGRESS

### TicTacChain.sol Status
- **Lines 1199-1686**: Backward compatibility section added
- **Compilation**: Fails due to Issues 1 & 2 above
- **Next Step**: Fix match storage access, then compile

### ChessOnChain.sol Status
- ❌ **NOT STARTED**: Needs entire backward compatibility section copied from TicTacChain
- **Additional Needs**: Chess-specific match data access patterns

### ConnectFourOnChain.sol Status
- ❌ **NOT STARTED**: Needs entire backward compatibility section copied from TicTacChain
- **Additional Needs**: ConnectFour-specific match data access patterns

---

## 📋 TODO - PRIORITY ORDER

### Priority 1: Fix TicTacChain Match Storage Access

#### Step 1.1: Fix `isPlayerInAdvancedRound()`
**Location**: TicTacChain.sol lines 1429-1453

**Find**:
```solidity
bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId];

if (common.status == ETourLib_Core.MatchStatus.Completed &&
    common.winner == player &&
    !common.isDraw) {
    return true;
}
```

**Replace with**:
```solidity
bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
Match storage matchData = matches[matchId];

if (matchData.status == MATCH_COMPLETED &&
    matchData.winner == player &&
    !matchData.isDraw) {
    return true;
}
```

#### Step 1.2: Fix `forceEliminateStalledMatch()`
**Location**: TicTacChain.sol lines 1554-1570

**Find**:
```solidity
bytes32 matchId2 = _getMatchId(tierId, instanceId, r, m);
ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId2];
if (common.status == ETourLib_Core.MatchStatus.Completed &&
    common.winner == msg.sender &&
    !common.isDraw) {
```

**Replace with**:
```solidity
bytes32 matchId2 = _getMatchId(tierId, instanceId, r, m);
Match storage matchData2 = matches[matchId2];
if (matchData2.status == MATCH_COMPLETED &&
    matchData2.winner == msg.sender &&
    !matchData2.isDraw) {
```

**Also fix the double-eliminate logic at Line 1575**:
```solidity
// OLD - tries to access _etourStorage.matches
ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId];

// NEW - use game contract's matches
Match storage matchData = matches[matchId];
matchData.winner = address(0);
matchData.status = MATCH_COMPLETED;
// Don't set loser field (doesn't exist in Match struct)
```

#### Step 1.3: Fix `claimMatchSlotByReplacement()`
**Location**: TicTacChain.sol lines 1600-1617, 1621-1627

**Same fixes as Step 1.2** - replace all `_etourStorage.matches` with game contract's `matches` mapping.

### Priority 2: Verify/Add Missing Library Functions

#### Step 2.1: Check ETourLib_Matches for `checkAndMarkStalled()`
```bash
grep "function checkAndMarkStalled" contracts/libraries/ETourLib_Matches.sol
```

If missing, need to implement or remove the call from TicTacChain.sol line 1547 and 1593.

#### Step 2.2: Check ETourLib_Prizes for Raffle Functions
```bash
grep "function executeProtocolRaffle\|function getRaffleInfo\|function getRaffleConfiguration\|function getRaffleThresholds" contracts/libraries/ETourLib_Prizes.sol
```

If missing, need to implement them.

### Priority 3: Compile TicTacChain

Once Issues 1 & 2 are fixed:
```bash
npx hardhat compile 2>&1 | grep -A3 "TicTacChain"
```

Expected: Clean compilation or only minor warnings.

### Priority 4: Copy to Other Games

#### Step 4.1: Copy to ChessOnChain.sol
1. Open TicTacChain.sol
2. Copy lines 1199-1686 (entire "Backward Compatibility Functions" section)
3. Open ChessOnChain.sol
4. Find the "Player Activity Tracking Implementation" section
5. Insert the copied section BEFORE that section
6. Fix any Chess-specific match data access (e.g., `chessMatches` instead of `matches`)

#### Step 4.2: Copy to ConnectFourOnChain.sol
Same process as Step 4.1.

### Priority 5: Test Compilation of All Contracts
```bash
npx hardhat clean
npx hardhat compile
```

Expected result: All contracts compile successfully with library linking.

### Priority 6: Generate New ABIs and Deploy
```bash
# Clean
pkill -f anvil || true
npx hardhat clean

# Compile
npx hardhat compile

# Start Anvil
./start-anvil.sh

# Deploy libraries ONCE
npx hardhat run scripts/deploy-libraries.js --network localhost

# Deploy game contracts
npx hardhat run scripts/deploy-tictacchain.js --network localhost
npx hardhat run scripts/deploy-chessonchain.js --network localhost
npx hardhat run scripts/deploy-connectfour.js --network localhost

# OR deploy all at once
npx hardhat run scripts/deploy-all.js --network localhost
```

### Priority 7: Verify ABI Completeness

Run client's ABI analysis to verify all functions exist:
```bash
# In client directory
npm run analyze-abi
```

Expected: All critical functions present, no missing functionality.

---

## 📝 NOTES FOR NEXT INSTANCE

### Key Architecture Points

1. **Storage Split**:
   - `_etourStorage` (ETourLib_Core.ETourStorage) - holds tournament state, tiers, prizes
   - `matches` (game-specific mapping) - holds game-specific match data
   - These are SEPARATE - don't confuse them

2. **Match Data Access Pattern**:
   ```solidity
   // WRONG - tries to use ETour storage
   ETourLib_Core.CommonMatchData storage common = _etourStorage.matches[matchId];

   // RIGHT - use game contract storage
   Match storage matchData = matches[matchId];
   ```

3. **Library vs Contract Functions**:
   - View functions: Can access `_etourStorage` directly in game contract
   - Mutation functions: Should delegate to library functions
   - Escalation functions: Mix of both - check stalled in library, update match in contract

4. **Constants Mapping**:
   - `_etourStorage.tierConfigs[tierId]` for tier configuration
   - `_etourStorage.tierPrizeDistribution[tierId]` for prize percentages (NOT tierPrizes)
   - `_etourStorage.leaderboardPlayers` for leaderboard array (NOT leaderboard)
   - `_etourStorage.tierCount` for total tiers (NOT allTierIds)

5. **Event Emissions**:
   - All events are defined in game contracts
   - Events must be emitted from game contract, not libraries
   - Example: `emit AbandonedPoolClaimed(...)` in TicTacChain.sol

### Common Pitfalls

1. **Don't access game-specific storage from libraries** - libraries only see `ETourStorage`
2. **Don't try to use `_etourStorage.matches`** - it doesn't exist
3. **Prize distribution field name is `tierPrizeDistribution`** not `tierPrizes`
4. **Leaderboard array is `leaderboardPlayers`** not `leaderboard`
5. **Tier iteration uses `tierCount`** not `allTierIds`

### Files Modified So Far

1. ✅ **TicTacChain.sol** - Added lines 1199-1686 (needs fixes)
2. ✅ **ABI_MIGRATION.md** - Reference document for client
3. ✅ **CLIENT_MIGRATION_GUIDE.md** - Updated deployment steps
4. ❌ **ChessOnChain.sol** - NOT YET MODIFIED
5. ❌ **ConnectFourOnChain.sol** - NOT YET MODIFIED

### Quick Start for Next Session

```bash
# 1. Fix the match storage access issues in TicTacChain.sol (see Priority 1)
# 2. Check library functions exist (see Priority 2)
# 3. Compile
npx hardhat compile

# 4. If TicTacChain compiles successfully, copy backward compatibility section to other games
# 5. Test full deployment

# Check current compilation status
npx hardhat compile 2>&1 | grep -E "Error|TypeError|line"
```

### Expected Final State

**All 3 game contracts should have**:
- All original ETour functions available
- Full backward compatibility with old ABI
- No breaking changes for client
- Clean compilation with library linking

**Client can use**:
- All escalation functions (isMatchEscL1/L2/L3Available, forceEliminate, claimSlot)
- All enrollment functions (reset, canReset, claimAbandoned)
- All raffle functions (execute, getInfo, getConfig, getThresholds)
- All convenience getters (ENTRY_FEES, BASIS_POINTS, getTierInfo, etc.)
- All legacy overloads (getPlayerStats(), getLeaderboard(), getRoundInfo())

---

## 🎯 CURRENT STATUS & BLOCKERS

### ✅ RESOLVED
1. ✅ **Match storage access** - Fixed at lines 1443, 1561, 1605, 1620 in TicTacChain.sol
2. ✅ **TicTacChain compilation** - Successfully compiles with warnings only

### ⚠️ TEMPORARY WORKAROUNDS (Commented Out)
1. ⚠️ **checkAndMarkStalled** - Commented out at lines 1549, 1594 (needs implementation)
2. ⚠️ **updateLeaderboard** - Commented out at line 1537 (needs implementation)
3. ⚠️ **Raffle functions** - All 4 functions commented out at lines 1636-1688 (needs implementation)

### 📊 CONTRACT SIZES
- **TicTacChain**: 34.3 kB (compiles, above 24 kB limit)
- **ChessOnChain**: 38.6 kB (no backward compat functions yet)
- **ConnectFourOnChain**: 29.5 kB (no backward compat functions yet)

**Next Steps**: Either implement missing library functions OR accept that raffle/escalation features are temporarily disabled

---

## 📊 COMPLETION CHECKLIST

### TicTacChain.sol
- [x] Add constants section
- [x] Add tier info functions
- [x] Add legacy view function overloads
- [x] Add escalation check functions
- [x] Add enrollment management functions
- [x] Fix match storage access in isPlayerInAdvancedRound
- [x] Fix match storage access in forceEliminateStalledMatch
- [x] Fix match storage access in claimMatchSlotByReplacement
- [x] Compile successfully (with some functions commented out)
- [ ] Implement missing library functions (checkAndMarkStalled, updateLeaderboard, raffle)
- [ ] Optimize contract size to under 24 kB

### ChessOnChain.sol
- [ ] Copy backward compatibility section
- [ ] Adapt for Chess-specific storage (chessMatches)
- [ ] Compile successfully

### ConnectFourOnChain.sol
- [ ] Copy backward compatibility section
- [ ] Adapt for ConnectFour-specific storage
- [ ] Compile successfully

### Final Steps
- [ ] Deploy all contracts with libraries
- [ ] Generate new ABIs
- [ ] Verify client compatibility
- [ ] Update CLIENT_MIGRATION_GUIDE.md with final ABIs
