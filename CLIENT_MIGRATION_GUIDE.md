# Client Migration Guide - Library Architecture Update

## What Changed?

We've refactored the game contracts to use external libraries for code reuse and size optimization. This is **transparent to the client** - the contracts' public interfaces (ABIs) remain **identical**.

### Architecture Changes

**Before:**
```
TicTacChain.sol (contained all code)
ChessOnChain.sol (contained all code)
ConnectFourOnChain.sol (contained all code)
```

**After:**
```
Libraries (deployed once):
  ├── ETourLib_Core.sol (tournament core logic)
  ├── ETourLib_Matches.sol (match management)
  ├── ETourLib_Prizes.sol (prize distribution)
  └── ChessRules.sol (chess-specific rules)

Game Contracts (link to libraries):
  ├── TicTacChain.sol
  ├── ChessOnChain.sol
  └── ConnectFourOnChain.sol
```

---

## What the Client Needs to Do

### ✅ **GOOD NEWS: Minimal Changes Required**

The client code **does NOT need to change** because:
- ✅ All public functions remain identical (`enrollInTournament`, `makeMove`, etc.)
- ✅ All event signatures are the same
- ✅ Function parameters and return types unchanged
- ✅ Libraries are linked internally (transparent to external callers)

### 📝 **Required Actions**

#### 1. **Redeploy Contracts** (REQUIRED)

The old deployment scripts didn't deploy libraries. Use the NEW deployment commands:

```bash
# Step 1: Kill existing Anvil
pkill -f anvil || true

# Step 2: Start fresh Anvil
./start-anvil.sh

# Step 3: Clean and compile
npx hardhat clean && npx hardhat compile

# Step 4: Deploy everything (RECOMMENDED)
npx hardhat run scripts/deploy-all.js --network localhost

# OR deploy individually (MUST deploy libraries first):
# Step 4a: Deploy shared libraries ONCE
npx hardhat run scripts/deploy-libraries.js --network localhost

# Step 4b: Deploy game contracts (reuse libraries)
npx hardhat run scripts/deploy-tictacchain.js --network localhost
npx hardhat run scripts/deploy-chessonchain.js --network localhost
npx hardhat run scripts/deploy-connectfour.js --network localhost
```

**IMPORTANT**: If deploying individually, you MUST deploy libraries first using `deploy-libraries.js` before deploying any game contracts. The game contracts require library addresses to be saved in `deployments/localhost-libraries.json`.

#### 2. **Update Contract Addresses** (REQUIRED)

After redeployment, update your client config with the NEW contract addresses:

**Before** (old addresses):
```javascript
const TICTACCHAIN_ADDRESS = "0xOldAddress...";
const CHESSONCHAIN_ADDRESS = "0xOldAddress...";
const CONNECTFOUR_ADDRESS = "0xOldAddress...";
```

**After** (new addresses from deployment output):
```javascript
const TICTACCHAIN_ADDRESS = "0xNewAddress..."; // From deploy script output
const CHESSONCHAIN_ADDRESS = "0xNewAddress..."; // From deploy script output
const CONNECTFOUR_ADDRESS = "0xNewAddress..."; // From deploy script output
```

You can find the addresses in:
- Console output from deployment
- `deployments/localhost.json` (from deploy-all.js)
- `deployments/TTTABI.json`, `COCABI.json`, `CFOCABI.json`

#### 3. **Refresh ABIs** (OPTIONAL - probably not needed)

The ABIs are identical, but if you want to refresh them:

```bash
# Copy new ABIs to your client
cp deployments/TTTABI.json ../client/src/abis/
cp deployments/COCABI.json ../client/src/abis/
cp deployments/CFOCABI.json ../client/src/abis/
```

---

## What the Client Does NOT Need to Do

### ❌ **NO Changes Required**

- ❌ NO need to interact with library contracts directly
- ❌ NO need to know library addresses
- ❌ NO need to change function calls
- ❌ NO need to update event listeners
- ❌ NO need to modify contract interaction code

### Example: Code Remains Identical

**Enrolling in a tournament** (unchanged):
```javascript
// Before library refactoring - worked like this
const tx = await tictacchain.enrollInTournament(tierId, instanceId, {
  value: ethers.parseEther("0.001")
});

// After library refactoring - STILL works exactly the same
const tx = await tictacchain.enrollInTournament(tierId, instanceId, {
  value: ethers.parseEther("0.001")
});
```

**Making a move** (unchanged):
```javascript
// Before and After - identical
const tx = await chess.makeMove(tierId, instanceId, roundNum, matchNum, from, to, promotion);
```

---

## Deployment Script Changes

### What Changed in Deployment Scripts

All deployment scripts now include **Phase 1: Deploy Libraries** before deploying game contracts.

**Example: ChessOnChain Deployment**

```javascript
// Phase 1: Deploy libraries
const ETourLib_Core = await ethers.getContractFactory("ETourLib_Core");
const coreLib = await ETourLib_Core.deploy();

const ETourLib_Matches = await ethers.getContractFactory("ETourLib_Matches", {
  libraries: { ETourLib_Core: coreLib.address }
});
const matchesLib = await ETourLib_Matches.deploy();

// ... deploy other libraries

// Phase 2: Deploy game contract WITH library linking
const ChessOnChain = await ethers.getContractFactory("ChessOnChain", {
  libraries: {
    ETourLib_Core: coreLib.address,
    ETourLib_Matches: matchesLib.address,
    ETourLib_Prizes: prizesLib.address,
    ChessRules: chessRules.address
  }
});
const chess = await ChessOnChain.deploy();
```

---

## Troubleshooting

### Error: "Contract is missing links for libraries"

**Cause**: Trying to deploy game contracts without deploying libraries first.

**Fix**: Use the NEW deployment scripts that include library deployment:
```bash
npx hardhat run scripts/deploy-all.js --network localhost
```

### Error: "Function not found" or "Invalid ABI"

**Cause**: Using old contract addresses or outdated ABIs.

**Fix**: 
1. Redeploy contracts with NEW scripts
2. Update contract addresses in client config
3. (Optional) Refresh ABIs from `deployments/` folder

### Error: Client can't connect to contracts

**Cause**: Contract addresses changed after redeployment.

**Fix**: Check deployment output and update addresses:
```bash
# Find new addresses
cat deployments/localhost.json

# Or check individual ABI files
cat deployments/TTTABI.json | grep address
cat deployments/COCABI.json | grep address
cat deployments/CFOCABI.json | grep address
```

---

## Summary

### ✅ What You Must Do:
1. **Redeploy contracts** using NEW deployment scripts
2. **Update contract addresses** in your client config

### ❌ What You Don't Need to Do:
- Change any client interaction code
- Update function calls
- Modify event listeners
- Interact with library contracts

### 📊 Benefits of This Change:
- **Reduced contract sizes**: ChessOnChain reduced by 4.5 kB (10.5%)
- **Code reuse**: Tournament logic shared across all games
- **Easier maintenance**: Fix bugs once, benefits all games
- **Gas efficiency**: Libraries deployed once, used by all contracts

---

## Questions?

If you encounter issues:
1. Check that you're using the NEW deployment scripts
2. Verify contract addresses match deployment output
3. Ensure Anvil is running on the correct port
4. Check that ABIs are up to date (though they should be identical)

**The client interface is 100% backward compatible - no code changes needed!**
