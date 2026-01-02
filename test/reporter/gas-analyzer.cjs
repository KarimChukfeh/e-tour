const hre = require("hardhat");

/**
 * Gas Analyzer
 *
 * Provides multi-network gas cost analysis, player journey tracking,
 * and optimization insights.
 */

class GasAnalyzer {
  constructor() {
    // Network pricing configuration
    this.networks = {
      ethereum: {
        name: 'Ethereum Mainnet',
        gasPrice: 30, // Gwei
        nativePrice: 3000, // USD per ETH
        symbol: 'ETH'
      },
      arbitrum: {
        name: 'Arbitrum One',
        gasPrice: 0.05, // Gwei
        nativePrice: 3000, // USD per ETH
        symbol: 'ETH'
      },
      polygon: {
        name: 'Polygon PoS',
        gasPrice: 50, // Gwei
        nativePrice: 0.80, // USD per MATIC
        symbol: 'MATIC'
      }
    };
  }

  /**
   * Calculate costs across all networks for a given gas amount
   */
  calculateCosts(gasUsed) {
    const costs = {};

    for (const [networkId, network] of Object.entries(this.networks)) {
      const gasPriceWei = BigInt(Math.floor(network.gasPrice * 1e9)); // Convert Gwei to Wei
      const costWei = BigInt(gasUsed) * gasPriceWei;
      const costNative = parseFloat(hre.ethers.formatEther(costWei));
      const costUsd = costNative * network.nativePrice;

      costs[networkId] = {
        name: network.name,
        gasUsed: gasUsed.toString(),
        gasPriceGwei: network.gasPrice,
        costNative: costNative.toFixed(6),
        costUsd: costUsd.toFixed(4),
        symbol: network.symbol
      };
    }

    return costs;
  }

  /**
   * Analyze a single test's gas usage
   */
  analyzeTest(test) {
    if (!test.timeline || test.timeline.length === 0) {
      return null;
    }

    const analysis = {
      testId: test.id,
      testName: test.name,
      totalGas: 0n,
      transactionCount: 0,
      operations: {}, // operation name -> { count, totalGas, minGas, maxGas, avgGas }
      playerJourneys: {}, // player address -> { totalGas, transactions, costs }
      timeline: []
    };

    // Process each timeline entry
    for (const entry of test.timeline) {
      if (!entry.gasUsed) continue;

      const gasUsed = BigInt(entry.gasUsed);
      analysis.totalGas += gasUsed;
      analysis.transactionCount++;

      // Track by operation
      const opName = entry.action || 'unknown';
      if (!analysis.operations[opName]) {
        analysis.operations[opName] = {
          count: 0,
          totalGas: 0n,
          minGas: gasUsed,
          maxGas: gasUsed,
          avgGas: 0n
        };
      }

      const op = analysis.operations[opName];
      op.count++;
      op.totalGas += gasUsed;
      op.minGas = gasUsed < op.minGas ? gasUsed : op.minGas;
      op.maxGas = gasUsed > op.maxGas ? gasUsed : op.maxGas;

      // Track by player
      const player = entry.caller || 'unknown';
      if (!analysis.playerJourneys[player]) {
        analysis.playerJourneys[player] = {
          totalGas: 0n,
          transactions: [],
          operationCounts: {}
        };
      }

      const journey = analysis.playerJourneys[player];
      journey.totalGas += gasUsed;
      journey.transactions.push({
        sequence: entry.sequence,
        action: opName,
        gasUsed: gasUsed.toString(),
        blockNumber: entry.blockNumber
      });

      // Track operation counts per player
      journey.operationCounts[opName] = (journey.operationCounts[opName] || 0) + 1;
    }

    // Calculate averages for operations
    for (const op of Object.values(analysis.operations)) {
      op.avgGas = op.totalGas / BigInt(op.count);
    }

    // Calculate multi-network costs
    analysis.costs = this.calculateCosts(analysis.totalGas);

    // Calculate costs per player
    for (const [player, journey] of Object.entries(analysis.playerJourneys)) {
      journey.costs = this.calculateCosts(journey.totalGas);
    }

    return analysis;
  }

  /**
   * Analyze all tests and generate summary
   */
  analyzeSuite(tests) {
    const summary = {
      totalTests: tests.length,
      totalGas: 0n,
      totalTransactions: 0,
      operations: {},
      playerActivity: {},
      costs: null,
      testAnalyses: []
    };

    for (const test of tests) {
      const testAnalysis = this.analyzeTest(test);
      if (!testAnalysis) continue;

      summary.testAnalyses.push(testAnalysis);
      summary.totalGas += testAnalysis.totalGas;
      summary.totalTransactions += testAnalysis.transactionCount;

      // Aggregate operations
      for (const [opName, opData] of Object.entries(testAnalysis.operations)) {
        if (!summary.operations[opName]) {
          summary.operations[opName] = {
            count: 0,
            totalGas: 0n,
            minGas: opData.minGas,
            maxGas: opData.maxGas
          };
        }

        const sumOp = summary.operations[opName];
        sumOp.count += opData.count;
        sumOp.totalGas += opData.totalGas;
        sumOp.minGas = opData.minGas < sumOp.minGas ? opData.minGas : sumOp.minGas;
        sumOp.maxGas = opData.maxGas > sumOp.maxGas ? opData.maxGas : sumOp.maxGas;
      }

      // Aggregate player activity
      for (const [player, journey] of Object.entries(testAnalysis.playerJourneys)) {
        if (!summary.playerActivity[player]) {
          summary.playerActivity[player] = {
            totalGas: 0n,
            transactionCount: 0,
            testsParticipated: new Set()
          };
        }

        const playerSum = summary.playerActivity[player];
        playerSum.totalGas += journey.totalGas;
        playerSum.transactionCount += journey.transactions.length;
        playerSum.testsParticipated.add(test.id);
      }
    }

    // Calculate averages for operations
    for (const op of Object.values(summary.operations)) {
      op.avgGas = op.totalGas / BigInt(op.count);
    }

    // Calculate suite-wide costs
    summary.costs = this.calculateCosts(summary.totalGas);

    // Convert player Sets to counts
    for (const player of Object.values(summary.playerActivity)) {
      player.testsCount = player.testsParticipated.size;
      delete player.testsParticipated;
      player.costs = this.calculateCosts(player.totalGas);
    }

    return summary;
  }

  /**
   * Generate optimization insights based on gas analysis
   */
  generateInsights(analysis) {
    const insights = [];

    // Check for high variance operations
    for (const [opName, opData] of Object.entries(analysis.operations)) {
      if (opData.count < 2) continue; // Need at least 2 samples

      const variance = Number(opData.maxGas - opData.minGas);
      const avgGasNumber = Number(opData.avgGas);

      if (variance > avgGasNumber * 0.3) { // More than 30% variance
        insights.push({
          type: 'variance',
          severity: 'warning',
          operation: opName,
          message: `${opName} shows ${((variance / avgGasNumber) * 100).toFixed(0)}% gas variance (min: ${this.formatGas(opData.minGas)}, max: ${this.formatGas(opData.maxGas)}, avg: ${this.formatGas(opData.avgGas)}). Consider investigating state-dependent gas costs.`
        });
      }
    }

    // Check for expensive operations
    const opsByGas = Object.entries(analysis.operations)
      .sort((a, b) => Number(b[1].totalGas - a[1].totalGas));

    if (opsByGas.length > 0) {
      const mostExpensive = opsByGas[0];
      const totalGas = analysis.totalGas;
      const percentage = (Number(mostExpensive[1].totalGas) / Number(totalGas)) * 100;

      if (percentage > 50) {
        insights.push({
          type: 'expensive',
          severity: 'info',
          operation: mostExpensive[0],
          message: `${mostExpensive[0]} accounts for ${percentage.toFixed(1)}% of total gas (${this.formatGas(mostExpensive[1].totalGas)} gas). This is the primary gas consumer.`
        });
      }
    }

    // Check for expensive player journeys
    const playersByGas = Object.entries(analysis.playerJourneys)
      .sort((a, b) => Number(b[1].totalGas - a[1].totalGas));

    if (playersByGas.length > 1) {
      const mostExpensivePlayer = playersByGas[0];
      const leastExpensivePlayer = playersByGas[playersByGas.length - 1];
      const difference = Number(mostExpensivePlayer[1].totalGas - leastExpensivePlayer[1].totalGas);
      const avgPlayerGas = Number(analysis.totalGas) / playersByGas.length;

      if (difference > avgPlayerGas * 0.5) {
        const ethCost = mostExpensivePlayer[1].costs.ethereum.costUsd;
        insights.push({
          type: 'player-variance',
          severity: 'info',
          message: `Significant player gas variance detected. Most expensive player: ${this.shortenAddress(mostExpensivePlayer[0])} at $${ethCost} (Ethereum mainnet). Consider gas rebate mechanisms for early/late participants.`
        });
      }
    }

    // L2 savings insight
    if (analysis.costs) {
      const ethCost = parseFloat(analysis.costs.ethereum.costUsd);
      const arbCost = parseFloat(analysis.costs.arbitrum.costUsd);
      const savings = ethCost - arbCost;
      const savingsPercent = (savings / ethCost) * 100;

      insights.push({
        type: 'l2-savings',
        severity: 'success',
        message: `Deploying on Arbitrum L2 would save $${savings.toFixed(2)} per test (${savingsPercent.toFixed(1)}% reduction vs Ethereum mainnet).`
      });
    }

    return insights;
  }

  /**
   * Format gas amount for display
   */
  formatGas(gas) {
    const gasNum = Number(gas);
    if (gasNum >= 1000000) {
      return `${(gasNum / 1000000).toFixed(2)}M`;
    } else if (gasNum >= 1000) {
      return `${(gasNum / 1000).toFixed(1)}k`;
    }
    return gasNum.toString();
  }

  /**
   * Shorten Ethereum address for display
   */
  shortenAddress(address) {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

module.exports = { GasAnalyzer };
