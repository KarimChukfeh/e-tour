const hre = require("hardhat");
const { parseEvents } = require('./event-listener.cjs');

/**
 * Contract Proxy Instrumentation
 *
 * This module wraps ethers.js contracts with Proxy objects to automatically capture:
 * - Before/after state for every transaction
 * - All events emitted
 * - Gas costs and transaction details
 * - Timeline of all actions
 *
 * Zero modification to test files - works via global interception in setup.cjs
 */

/**
 * Creates an instrumented contract that captures all state changes
 * @param {Contract} contract - The ethers.js contract instance
 * @param {string} contractName - Name of the contract (e.g., "TicTacChain", "ConnectFourOnChain")
 * @returns {Proxy} - Proxied contract that captures state
 */
function createInstrumentedContract(contract, contractName) {
  return new Proxy(contract, {
    get(target, prop) {
      const original = target[prop];

      // Only intercept contract functions that might change state
      if (typeof original === 'function' && isStateMutatingMethod(prop)) {
        return async function(...args) {
          const stateTracker = global.stateTracker;
          if (!stateTracker || !stateTracker.isTracking()) {
            // No tracking active, execute normally
            return await original.apply(target, args);
          }

          try {
            // Capture state BEFORE transaction
            const stateBefore = await captureContractState(target, contractName);

            // Execute the original transaction
            const txResponse = await original.apply(target, args);

            // Wait for transaction to be mined
            const receipt = await txResponse.wait();

            // Capture state AFTER transaction
            const stateAfter = await captureContractState(target, contractName);

            // Parse events from receipt
            const events = parseEvents(receipt, target);

            // Calculate state diff
            const stateDiff = calculateStateDiff(stateBefore, stateAfter);

            // Record timeline entry
            stateTracker.recordTimelineEntry({
              timestamp: Date.now(),
              blockNumber: receipt.blockNumber,
              action: prop,
              caller: args[0]?.address || await getTransactionSender(receipt),
              parameters: formatParameters(args),
              gasUsed: receipt.gasUsed.toString(),
              gasPrice: receipt.gasPrice ? hre.ethers.formatUnits(receipt.gasPrice, "gwei") : '0.05',
              txHash: receipt.hash,
              stateBefore,
              stateAfter,
              stateDiff,
              events
            });

            return txResponse;
          } catch (error) {
            // Record error in timeline
            if (global.stateTracker && global.stateTracker.isTracking()) {
              global.stateTracker.recordTimelineEntry({
                timestamp: Date.now(),
                action: prop,
                error: error.message,
                parameters: formatParameters(args)
              });
            }
            throw error;
          }
        };
      }

      return original;
    }
  });
}

/**
 * Determines if a method is likely to mutate state (send transaction)
 */
function isStateMutatingMethod(methodName) {
  // Skip utility functions and view/pure functions
  const skipMethods = [
    'interface', 'connect', 'attach', 'deployed', 'deploymentTransaction',
    'getAddress', 'getDeployedCode', 'waitForDeployment', 'queryFilter',
    'filters', 'off', 'on', 'once', 'removeAllListeners', 'removeListener',
    'target', 'runner', 'provider', 'fallback'
  ];

  if (skipMethods.includes(methodName)) {
    return false;
  }

  // Also skip methods starting with underscore or get
  if (methodName.startsWith('_') || methodName.startsWith('get')) {
    return false;
  }

  // Skip pure view methods - these are common view-only patterns
  const viewPatterns = ['view', 'total', 'balance', 'owner', 'name', 'symbol'];
  if (viewPatterns.some(pattern => methodName.toLowerCase().includes(pattern))) {
    return false;
  }

  return true;
}

/**
 * Captures comprehensive contract state
 */
async function captureContractState(contract, contractName) {
  try {
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    const block = await hre.ethers.provider.getBlock(blockNumber);

    const state = {
      timeState: {
        blockNumber: blockNumber,
        timestamp: block.timestamp,
        blockHash: block.hash
      },
      tournaments: {},
      rounds: {},
      matches: {},
      players: {},
      cache: {}
    };

    // Capture tournament state for ETour-based contracts
    if (contractName.includes('TicTacChain') || contractName.includes('ConnectFour') || contractName.includes('Chess')) {
      await captureTournamentStates(contract, state);
    }

    return state;
  } catch (error) {
    // If state capture fails, return minimal state
    return {
      error: `State capture failed: ${error.message}`,
      timeState: {
        blockNumber: await hre.ethers.provider.getBlockNumber()
      }
    };
  }
}

/**
 * Captures tournament state across all tiers and instances
 */
async function captureTournamentStates(contract, state) {
  try {
    // Try to capture state for common tiers (0-3) and instances (0-9)
    // In production, we'd query events to know which tournaments exist
    for (let tierId = 0; tierId < 4; tierId++) {
      for (let instanceId = 0; instanceId < 10; instanceId++) {
        try {
          const tournament = await contract.tournaments(tierId, instanceId);
          const key = `${tierId}-${instanceId}`;

          // Only store if tournament has data (not default empty state)
          if (tournament.enrolledCount > 0 || tournament.status > 0) {
            state.tournaments[key] = {
              status: Number(tournament.status),
              enrolledCount: Number(tournament.enrolledCount),
              prizePool: tournament.prizePool.toString(),
              startTime: tournament.startTime ? Number(tournament.startTime) : 0,
              winner: tournament.winner || '0x0',
              coWinner: tournament.coWinner || '0x0',
              finalsWasDraw: tournament.finalsWasDraw || false,
              currentRound: Number(tournament.currentRound || 0)
            };

            // Capture round state for active tournaments
            if (tournament.currentRound > 0) {
              await captureRoundStates(contract, state, tierId, instanceId, tournament.currentRound);
            }
          }
        } catch (e) {
          // Tournament doesn't exist or not initialized, skip
          continue;
        }
      }
    }

    // Capture cache state
    try {
      const nextCacheIndex = await contract.nextCacheIndex();
      state.cache.nextIndex = Number(nextCacheIndex);
    } catch (e) {
      // Cache not available
    }
  } catch (error) {
    state.tournaments.error = error.message;
  }
}

/**
 * Captures round state for a tournament
 */
async function captureRoundStates(contract, state, tierId, instanceId, currentRound) {
  try {
    for (let roundNum = 0; roundNum <= currentRound; roundNum++) {
      try {
        const round = await contract.rounds(tierId, instanceId, roundNum);
        const key = `${tierId}-${instanceId}-${roundNum}`;

        if (round.initialized) {
          state.rounds[key] = {
            totalMatches: Number(round.totalMatches),
            completedMatches: Number(round.completedMatches),
            initialized: round.initialized,
            drawCount: Number(round.drawCount || 0),
            allMatchesDrew: round.allMatchesDrew || false
          };
        }
      } catch (e) {
        // Round doesn't exist
        continue;
      }
    }
  } catch (error) {
    // Ignore round capture errors
  }
}

/**
 * Calculates the difference between two state snapshots
 */
function calculateStateDiff(before, after, path = '', maxDepth = 5) {
  if (maxDepth === 0) {
    return {}; // Prevent infinite recursion
  }

  const diffs = {};

  // Handle null/undefined
  if (before == null && after == null) {
    return diffs;
  }
  if (before == null) {
    diffs[path || 'root'] = { from: null, to: after };
    return diffs;
  }
  if (after == null) {
    diffs[path || 'root'] = { from: before, to: null };
    return diffs;
  }

  // Compare primitive values
  const beforeType = typeof before;
  const afterType = typeof after;

  if (beforeType !== 'object' || afterType !== 'object') {
    if (before !== after) {
      diffs[path] = { from: before, to: after };
    }
    return diffs;
  }

  // Both are objects - recursively compare
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const newPath = path ? `${path}.${key}` : key;
    const childDiffs = calculateStateDiff(before[key], after[key], newPath, maxDepth - 1);
    Object.assign(diffs, childDiffs);
  }

  return diffs;
}

/**
 * Formats function parameters for display
 */
function formatParameters(args) {
  try {
    return args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        // Handle ethers.js objects
        if (arg.address) return arg.address;
        if (arg._isBigNumber || typeof arg === 'bigint') return arg.toString();
        if (arg.hash) return arg.hash;
        return JSON.stringify(arg);
      }
      return String(arg);
    });
  } catch (e) {
    return ['<formatting error>'];
  }
}

/**
 * Extracts the sender address from a transaction receipt
 */
async function getTransactionSender(receipt) {
  try {
    const tx = await hre.ethers.provider.getTransaction(receipt.hash);
    return tx.from;
  } catch (e) {
    return '0x0';
  }
}

module.exports = {
  createInstrumentedContract
};
