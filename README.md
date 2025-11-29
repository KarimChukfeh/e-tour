# ETour Protocol + TicTacBlock - Dual Contract Deployment

## Overview

This project deploys **two smart contracts** on the same local Hardhat blockchain node:

1. **ETour.sol** - Universal tournament protocol (425 lines)
   - Stateless tournament infrastructure
   - Reusable across any competitive game
   - "The HTTP of blockchain gaming"

2. **TicTacBlock.sol** - Tic-tac-toe tournament game
   - Integrates with ETour protocol
   - Multi-tiered tournament system (7 tiers)
   - Classic and Pro game modes
   - Prize distribution and timeout mechanics

## Architecture

```
┌─────────────────────────────────────┐
│         ETour Protocol              │
│  (Universal Tournament Logic)       │
│                                     │
│  • calculateTotalRounds()           │
│  • calculateRoundMatchCount()       │
│  • calculateThreeWaySplit()         │
│  • calculatePrizeAmounts()          │
│  • Tournament validation            │
└──────────────┬──────────────────────┘
               │ Uses
               ▼
┌─────────────────────────────────────┐
│        TicTacBlock Game             │
│   (Tic-Tac-Toe Implementation)      │
│                                     │
│  • Tournament enrollment            │
│  • Game logic (blocking mechanic)   │
│  • Match management                 │
│  • Prize distribution               │
└─────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Compile Contracts

```bash
npm run compile
```

### 3. Run Tests

```bash
npm test
```

### 4. Deploy to Local Network

#### Option A: Hardhat Node

```bash
# Terminal 1: Start Hardhat node
npm run node

# Terminal 2: Deploy contracts
npm run deploy:localhost
```

#### Option B: Anvil Node (with EIP-4844 support)

```bash
# Terminal 1: Start Anvil
./start-anvil.sh

# Terminal 2: Deploy contracts
npm run deploy:localhost
```

## Deployment Artifacts

After deployment, you'll find the following files in `deployments/`:

- **`localhost.json`** - Network metadata with both contract addresses
- **`ETour-localhost.json`** - ETour contract ABI and address
- **`TicTacBlock-localhost.json`** - TicTacBlock contract ABI and address

## Integration with React Client

To connect your React client at `/Users/karim/Documents/workspace/zero-trust/tic-tac-react/`:

```javascript
// Update your React app configuration
import ETourABI from './abis/ETour-localhost.json';
import TicTacBlockABI from './abis/TicTacBlock-localhost.json';

const ETOUR_ADDRESS = "0x...";        // From ETour-localhost.json
const TICTACBLOCK_ADDRESS = "0x...";  // From TicTacBlock-localhost.json

// Create contract instances
const etourContract = new ethers.Contract(ETOUR_ADDRESS, ETourABI.abi, provider);
const gameContract = new ethers.Contract(TICTACBLOCK_ADDRESS, TicTacBlockABI.abi, provider);
```

## Contract Features

### ETour Protocol

**Pure Functions (Stateless):**
- `calculateTotalRounds(playerCount)` - Tournament depth
- `calculateRoundMatchCount(enrolledCount, round, totalRounds)` - Matches per round
- `calculateFirstRoundPairings(players, randomSeed)` - Initial bracket with walkover
- `calculateThreeWaySplit(totalAmount)` - 90/7.5/2.5% fee split
- `calculatePrizeAmounts(pot, rank, percentages, playersAtRank)` - Prize distribution
- `isRoundComplete(completed, total)` - Round completion check
- `canStartTournament(enrolled, max)` - Full enrollment check
- `isPowerOfTwo(n)` - Power of 2 validation

### TicTacBlock Game

**Tournament Management:**
- 7 tiers (2, 4, 8, 16, 64, 128, 2-player Pro)
- Multiple instances per tier (2-12 concurrent tournaments)
- Auto-start when full enrollment
- Force-start after timeout

**Game Modes:**
- **Classic**: Standard tic-tac-toe
- **Pro**: Includes blocking mechanic

**Anti-Stalling System:**
- Move timeouts (1 minute base)
- Opponent can claim victory
- Advanced/external player intervention

## Network Configuration

### Localhost (Hardhat/Anvil)
- **URL:** http://127.0.0.1:8545
- **Chain ID:** 31337
- **Gas Limit:** 30M (Hardhat) / 1.125e18 (Anvil)

### Supported Networks
- Arbitrum Sepolia (testnet)
- Optimism Sepolia (testnet)
- Base Sepolia (testnet)
- Arbitrum (mainnet)
- Optimism (mainnet)
- Base (mainnet)
- Polygon (mainnet)

## Scripts

```bash
# Testing
npm test                  # Run all tests
npm run test:report       # Generate detailed HTML report

# Compilation
npm run compile           # Compile contracts

# Deployment
npm run deploy            # Deploy to default network
npm run deploy:localhost  # Deploy to localhost

# Local Node
npm run node              # Start Hardhat node

# Arbitrum Local (Docker)
npm run arbitrum:start    # Start Arbitrum local node
npm run arbitrum:deploy   # Deploy to Arbitrum local
npm run arbitrum:stop     # Stop Arbitrum node
```

## Project Structure

```
e-tour/
├── contracts/
│   ├── ETour.sol              # Universal tournament protocol
│   └── TicTacBlock.sol        # Tic-tac-toe game
├── scripts/
│   └── deploy.js              # Dual-contract deployment
├── test/
│   └── ETourIntegration.test.js  # Integration tests
├── docs/
│   ├── DELIVERY_SUMMARY.md    # Project overview
│   └── DeploymentGuide.md     # Detailed deployment guide
├── deployments/               # Generated deployment artifacts
├── artifacts/                 # Compiled contract artifacts (generated)
├── cache/                     # Hardhat cache (generated)
├── hardhat.config.js          # Hardhat configuration
├── package.json               # Dependencies and scripts
├── .env.example               # Environment variables template
├── start-anvil.sh             # Anvil startup script
└── README.md                  # This file
```

## Key Features

### Dual Contract Benefits
1. **Separation of Concerns**: Tournament logic separate from game logic
2. **Reusability**: ETour can be used by other games
3. **Upgradability**: Can deploy new games using same ETour instance
4. **Gas Optimization**: Shared logic reduces deployment costs

### Tournament Features
- Entry fees: 0.001 - 0.01 ETH depending on tier
- Prize pools: 90% to participants, 7.5% to owner, 2.5% to protocol
- Automatic round progression
- Draw handling with replay mechanism
- Comprehensive event logging

### Anti-Griefing Measures
- Enrollment timeouts
- Move timeouts with escalation
- Stuck tournament resolution
- External player intervention

## Testing

The test suite covers:
- ETour protocol functions (calculations, validations)
- TicTacBlock integration with ETour
- Tournament enrollment and auto-start
- Fee splitting (90/7.5/2.5%)
- Match initialization and gameplay
- Blocking mechanic (Pro mode)
- ABI compatibility
- Gas optimization

Run tests with:
```bash
npm test
```

## Environment Variables

Create a `.env` file based on `.env.example`:

```bash
PRIVATE_KEY=your_private_key_here
ARBITRUM_LOCAL_RPC_URL=http://127.0.0.1:8547
REPORT_GAS=false
```

## Troubleshooting

### "Stack too deep" errors
✅ Already handled with `viaIR: true` in hardhat.config.js

### Contract size too large
✅ Already configured with `allowUnlimitedContractSize: true`

### Gas estimation errors
- Increase gas limit in hardhat.config.js
- Use Anvil node for ultra-high gas limits

### Deployment fails
- Ensure node is running (`npm run node`)
- Check account has sufficient balance
- Verify network configuration in hardhat.config.js

## Documentation

For more detailed information, see:
- **[DELIVERY_SUMMARY.md](./docs/DELIVERY_SUMMARY.md)** - Complete project delivery summary
- **[DeploymentGuide.md](./docs/DeploymentGuide.md)** - Step-by-step deployment guide

## Development Roadmap

### Phase 1: Local Development ✅
- [x] Dual contract deployment
- [x] Integration testing
- [x] React client integration

### Phase 2: Testnet Deployment
- [ ] Deploy to Arbitrum Sepolia
- [ ] Frontend testing on testnet
- [ ] Multi-wallet testing

### Phase 3: Mainnet Launch
- [ ] Deploy to Arbitrum mainnet
- [ ] Deploy to other L2s (Optimism, Base)
- [ ] Production monitoring

### Phase 4: Ecosystem Expansion
- [ ] Deploy additional games using ETour
- [ ] Cross-chain tournament support
- [ ] Protocol governance

## License

MIT

## Support

For issues or questions:
1. Check the documentation in `docs/`
2. Review test files for examples
3. Verify network configuration
4. Ensure all dependencies are installed

---

**The revolution has begun! 🚀**

ETour is the foundational protocol for Web3 gaming - universal tournament infrastructure that any competitive game can use.




./start-anvil.sh && npm run compile && npx hardhat run scripts/deploy-tictacchain.js --network localhost && npx hardhat run scripts/deploy-chessonchain.js --network localhost