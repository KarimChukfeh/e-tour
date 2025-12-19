# ETour Protocol - Multi-Game Tournament Platform

## Overview

This project implements **blockchain-based tournament infrastructure** with multiple game implementations:

### Contracts

1. **ETour.sol** - Universal tournament protocol (abstract base)
   - Stateless tournament infrastructure
   - Reusable across any competitive game
   - "The HTTP of blockchain gaming"

2. **TicTacChain.sol** - Tic-tac-toe tournament game
   - Inherits from ETour protocol
   - 6 tournament tiers (2-128 players)
   - Classic game mode with timeout mechanics

3. **ChessOnChain.sol** - Chess tournament game
   - Full chess rule enforcement
   - Castling, en passant, promotion support
   - 2 tournament tiers

4. **ConnectFourOnChain.sol** - Connect Four tournament game
   - Gravity-based piece dropping
   - 5 tournament tiers (2-32 players)

## Architecture

```
┌─────────────────────────────────────┐
│         ETour Protocol              │
│   (Abstract Tournament Base)        │
│                                     │
│  • calculateTotalRounds()           │
│  • calculateRoundMatchCount()       │
│  • calculateThreeWaySplit()         │
│  • calculatePrizeAmounts()          │
│  • Tournament validation            │
└──────────────┬──────────────────────┘
               │ Inherits
    ┌──────────┼──────────┬───────────┐
    ▼          ▼          ▼           ▼
┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│TicTac   │ │Chess    │ │Connect   │ │Future    │
│Chain    │ │OnChain  │ │Four      │ │Games...  │
└─────────┘ └─────────┘ └──────────┘ └──────────┘
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

#### Option A: Deploy All Games

```bash
# Terminal 1: Start Hardhat node
npm run node

# Terminal 2: Deploy all contracts
npm run deploy:all
```

#### Option B: Deploy Individual Games

```bash
# Start node first
npm run node

# Deploy individual contracts
npx hardhat run scripts/deploy-tictacchain.js --network localhost
npx hardhat run scripts/deploy-chessonchain.js --network localhost
npx hardhat run scripts/deploy-connectfour.js --network localhost
```

#### Option C: Anvil Node (with EIP-4844 support)

```bash
# Terminal 1: Start Anvil
./start-anvil.sh

# Terminal 2: Deploy contracts
npm run deploy:all
```

## Deployment Artifacts

After deployment, you'll find the following files in `deployments/`:

- **`localhost.json`** - Network metadata with contract addresses
- **`TTTABI.json`** - TicTacChain contract ABI and address
- **`COCABI.json`** - ChessOnChain contract ABI and address
- **`CFOCABI.json`** - ConnectFourOnChain contract ABI and address

## Integration with React Client

The frontend is located at `/Users/karim/Documents/workspace/zero-trust/tic-tac-react/`.

### Sync ABIs to Frontend

```bash
npm run sync:abis
```

This copies the compiled ABIs to the frontend project with correct naming.

### Manual Integration

```javascript
import TicTacChainABI from './TicTacChainABI.json';
import ChessABI from './COCABI.json';
import ConnectFourABI from './CFOCABI.json';

const TICTACCHAIN_ADDRESS = "0x...";  // From TTTABI.json
const CHESS_ADDRESS = "0x...";         // From COCABI.json
const CONNECTFOUR_ADDRESS = "0x...";   // From CFOCABI.json

// Create contract instances
const ticTacChain = new ethers.Contract(TICTACCHAIN_ADDRESS, TicTacChainABI.abi, provider);
const chess = new ethers.Contract(CHESS_ADDRESS, ChessABI.abi, provider);
const connectFour = new ethers.Contract(CONNECTFOUR_ADDRESS, ConnectFourABI.abi, provider);
```

## Contract Features

### ETour Protocol (Inherited by all games)

**Pure Functions (Stateless):**
- `calculateTotalRounds(playerCount)` - Tournament depth
- `calculateRoundMatchCount(enrolledCount, round, totalRounds)` - Matches per round
- `calculateFirstRoundPairings(players, randomSeed)` - Initial bracket with walkover
- `calculateThreeWaySplit(totalAmount)` - 90/7.5/2.5% fee split
- `calculatePrizeAmounts(pot, rank, percentages, playersAtRank)` - Prize distribution
- `isRoundComplete(completed, total)` - Round completion check
- `canStartTournament(enrolled, max)` - Full enrollment check
- `isPowerOfTwo(n)` - Power of 2 validation

### TicTacChain

**Tournament Configuration:**
- 6 tiers (2, 4, 8, 16, 32, 64 players)
- Multiple instances per tier
- Auto-start when full enrollment
- Force-start after timeout

**Game Features:**
- 3x3 board
- Win detection (rows, columns, diagonals)
- Draw detection and replay

### ChessOnChain

**Tournament Configuration:**
- 2 tiers (2-player duels, 4-player mini tournaments)
- Full chess rules enforcement

**Game Features:**
- All piece movements validated
- Castling, en passant, promotion
- Check/checkmate detection

### ConnectFourOnChain

**Tournament Configuration:**
- 5 tiers (2, 4, 8, 16, 32 players)

**Game Features:**
- 6x7 board with gravity mechanics
- 4-in-a-row win detection
- Column-based move system

## Network Configuration

### Localhost (Hardhat/Anvil)
- **URL:** http://127.0.0.1:8545
- **Chain ID:** 412346 (localhost config)
- **Gas Limit:** 1B

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
npm run deploy:all        # Deploy all games to localhost
npm run sync:abis         # Sync ABIs to frontend

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
│   ├── ETour.sol              # Universal tournament protocol (abstract)
│   ├── TicTacChain.sol        # Tic-tac-toe game
│   ├── ChessOnChain.sol       # Chess game
│   └── ConnectFourOnChain.sol # Connect Four game
├── scripts/
│   ├── deploy-tictacchain.js  # TicTacChain deployment
│   ├── deploy-chessonchain.js # ChessOnChain deployment
│   ├── deploy-connectfour.js  # ConnectFour deployment
│   ├── deploy-all.js          # Deploy all games
│   └── sync-abis.js           # Sync ABIs to frontend
├── test/
│   ├── ETourIntegration.test.js
│   ├── ChessOnChain.test.js
│   └── ConnectFourOnChain.test.js
├── docs/
│   ├── DELIVERY_SUMMARY.md
│   └── DeploymentGuide.md
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

### Multi-Game Architecture
1. **Separation of Concerns**: Tournament logic in ETour, game rules in each contract
2. **Reusability**: ETour abstract contract inherited by all games
3. **Extensibility**: Easy to add new games following the same pattern

### Tournament Features
- Entry fees: 0.001 - 0.01 ETH depending on tier
- Prize pools: 90% to participants, 7.5% to owner, 2.5% to protocol
- Automatic round progression
- Draw handling with replay mechanism
- Comprehensive event logging

### Anti-Griefing Measures
- Enrollment timeouts
- Move timeouts with escalation (3 levels)
- Stuck tournament resolution
- External player intervention

## Testing

The test suite covers:
- ETour protocol functions (calculations, validations)
- Game-specific integration with ETour
- Tournament enrollment and auto-start
- Fee splitting (90/7.5/2.5%)
- Match initialization and gameplay
- Timeout escalation system
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
Already handled with `viaIR: true` in hardhat.config.js

### Contract size too large
Already configured with `allowUnlimitedContractSize: true`

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

### Phase 1: Local Development
- [x] Multi-game contract deployment
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
