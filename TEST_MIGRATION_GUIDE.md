# Test Suite Migration Guide - ABI Changes

This guide shows how to update test files to work with the new library-based architecture.

## Core ABI Changes

### 1. Tier Count

**Old:**
```javascript
const count = await game.tierCount();
```

**New:**
```javascript
const count = (await game.getAllTierIds()).length;
```

### 2. Tier Configuration

**Old:**
```javascript
const tier = await game.tierConfigs(tierId);
// Access: tier.playerCount, tier.instanceCount, tier.entryFee
```

**New (Basic Info):**
```javascript
const tierInfo = await game.getTierInfo(tierId);
// Returns: [playerCount, instanceCount, entryFee]
// Access as array or destructure:
const [playerCount, instanceCount, entryFee] = await game.getTierInfo(tierId);
```

**New (Full Config):**
```javascript
const config = await game.getTierConfiguration(tierId);
// Returns: [playerCount, instanceCount, entryFee, matchTimePerPlayer, timeIncrementPerMove,
//           matchLevel2Delay, matchLevel3Delay, enrollmentWindow, enrollmentLevel2Delay, prizeDistribution]
```

### 3. Tournament State

**Old:**
```javascript
const tournament = await game.tournaments(tierId, instanceId);
// Access: tournament.status, tournament.enrolledCount, etc.
```

**New (Full State):**
```javascript
const tournament = await game.getTournament(tierId, instanceId);
// Returns full TournamentInstance struct
// Access: tournament.status, tournament.enrolledCount, tournament.prizePool, etc.
```

**New (Basic Info):**
```javascript
const [status, enrolledCount, currentRound, winner, prizePool] =
    await game.getTournamentInfo(tierId, instanceId);
```

### 4. Round State

**Old:**
```javascript
const round = await game.rounds(tierId, instanceId, roundNum);
```

**New:**
```javascript
const round = await game.getRound(tierId, instanceId, roundNum);
// or
const roundInfo = await game.getRoundInfo(tierId, instanceId, roundNum);
```

### 5. Match State

**Old:**
```javascript
const match = await game.matches(tierId, instanceId, roundNum, matchNum);
```

**New:**
```javascript
const match = await game.getMatch(tierId, instanceId, roundNum, matchNum);
```

### 6. Player Activity Tracking

**Old (Array Element Access):**
```javascript
const enrollingTournament = await game.playerEnrolling(player.address, 0);
const activeTournament = await game.playerActiveTournaments(player.address, 0);
```

**New (Full Array Return):**
```javascript
const enrollingTournaments = await game.getPlayerEnrollingTournaments(player.address);
// Access first element: enrollingTournaments[0]

const activeTournaments = await game.getPlayerActiveTournaments(player.address);
// Access first element: activeTournaments[0]
```

## Example Conversions

### Example 1: Checking Tier Count
```javascript
// OLD
it("Should have 3 tiers configured", async function () {
    expect(await game.tierCount()).to.equal(3);
});

// NEW
it("Should have 3 tiers configured", async function () {
    expect((await game.getAllTierIds()).length).to.equal(3);
});
```

### Example 2: Checking Tier Configuration
```javascript
// OLD
it("Should have correct tier 0 configuration", async function () {
    const tier0 = await game.tierConfigs(0);
    expect(tier0.playerCount).to.equal(2);
    expect(tier0.instanceCount).to.equal(100);
    expect(tier0.entryFee).to.equal(TIER_0_FEE);
});

// NEW
it("Should have correct tier 0 configuration", async function () {
    const [playerCount, instanceCount, entryFee] = await game.getTierInfo(0);
    expect(playerCount).to.equal(2);
    expect(instanceCount).to.equal(100);
    expect(entryFee).to.equal(TIER_0_FEE);
});
```

### Example 3: Checking Tournament Status
```javascript
// OLD
let tournament = await game.tournaments(tierId, instanceId);
expect(tournament.status).to.equal(0); // Enrolling

// NEW
let tournament = await game.getTournament(tierId, instanceId);
expect(tournament.status).to.equal(0); // Enrolling
```

### Example 4: Player Activity Arrays
```javascript
// OLD - Accessing specific index
const tournament = await game.playerActiveTournaments(player.address, 0);
expect(tournament.tierId).to.equal(expectedTierId);

// NEW - Get array first, then access
const activeTournaments = await game.getPlayerActiveTournaments(player.address);
expect(activeTournaments.length).to.equal(1);
expect(activeTournaments[0].tierId).to.equal(expectedTierId);
```

## All Affected View Functions

Replace these direct state variable accesses with getter functions:

| Old Access Pattern | New Getter Function | Notes |
|-------------------|---------------------|-------|
| `tierCount()` | `getAllTierIds().length` | Get length of tier IDs array |
| `tierConfigs(id)` | `getTierInfo(id)` or `getTierConfiguration(id)` | Use Info for basic, Configuration for full |
| `tournaments(tier, inst)` | `getTournament(tier, inst)` | Returns full struct |
| `rounds(tier, inst, round)` | `getRound(tier, inst, round)` | Full round data |
| `matches(tier, inst, round, match)` | `getMatch(tier, inst, round, match)` | Full match data |
| `playerEnrolling(addr, idx)` | `getPlayerEnrollingTournaments(addr)` | Returns array |
| `playerActiveTournaments(addr, idx)` | `getPlayerActiveTournaments(addr)` | Returns array |

## Helper Functions Available

Additional view functions that may be useful:
- `getEnrolledPlayers(tierId, instanceId)` - Get all enrolled players
- `getPlayerStats(address)` - Get player statistics
- `getPlayerActivityCounts(address)` - Get count of enrolling/active tournaments
- `getTournamentInfo(tierId, instanceId)` - Get basic tournament info
- `getTierCapacity(tierId)` - Calculate tier capacity
- `getTotalCapacity()` - Calculate total contract capacity
- `getAllTierIds()` - Get array of all tier IDs

## Migration Strategy

1. Search for all uses of the old patterns in test files
2. Replace with new getter functions
3. Update assertions to work with returned structs/arrays
4. Test incrementally by running specific test files
5. For TicTacToe tests, focus on files in `/test/` that reference TicTacChain

## Common Pitfalls

1. **Array access changed**: Player activity functions now return full arrays, not individual elements
2. **Tier info returns array**: getTierInfo returns destructurable array, not object with named properties
3. **Tournament getter needs both IDs**: Always pass both tierId and instanceId
4. **No tierCount function**: Must use `getAllTierIds().length` instead
