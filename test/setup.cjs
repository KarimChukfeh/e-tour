const hre = require("hardhat");
const { StateTracker } = require('./reporter/state-tracker.cjs');
const { createInstrumentedContract } = require('./instrumentation/contract-proxy.cjs');

/**
 * Global Test Setup
 *
 * This file is loaded by Mocha before any tests run (configured in hardhat.config.js).
 * It sets up global instrumentation to capture contract state automatically.
 *
 * Key innovations:
 * 1. Intercepts ethers.getContractFactory to wrap all contracts with Proxy
 * 2. Zero modifications needed to existing test files
 * 3. Automatic state capture for every transaction
 */

// Create global state tracker singleton
global.stateTracker = new StateTracker();
console.log('StateTracker initialized:', typeof global.stateTracker);
console.log('StateTracker methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(global.stateTracker)));

// Global library addresses storage
global.deployedLibraries = null;

/**
 * Deploy shared libraries once before any tests
 * These libraries are used by all game contracts
 */
async function deployLibraries() {
  if (global.deployedLibraries) {
    return global.deployedLibraries;
  }

  console.log('📚 Deploying shared ETour libraries for tests...');

  const libraries = {};

  // Deploy ETourLib_Core (no dependencies)
  const ETourLib_Core = await hre.ethers.getContractFactory("ETourLib_Core");
  const coreLib = await ETourLib_Core.deploy();
  await coreLib.waitForDeployment();
  libraries.ETourLib_Core = await coreLib.getAddress();

  // Deploy ETourLib_Matches (depends on ETourLib_Core)
  const ETourLib_Matches = await hre.ethers.getContractFactory("ETourLib_Matches", {
    libraries: { ETourLib_Core: libraries.ETourLib_Core }
  });
  const matchesLib = await ETourLib_Matches.deploy();
  await matchesLib.waitForDeployment();
  libraries.ETourLib_Matches = await matchesLib.getAddress();

  // Deploy ETourLib_Prizes (no dependencies)
  const ETourLib_Prizes = await hre.ethers.getContractFactory("ETourLib_Prizes");
  const prizesLib = await ETourLib_Prizes.deploy();
  await prizesLib.waitForDeployment();
  libraries.ETourLib_Prizes = await prizesLib.getAddress();

  // Deploy ChessRules (no dependencies)
  const ChessRules = await hre.ethers.getContractFactory("ChessRules");
  const chessRules = await ChessRules.deploy();
  await chessRules.waitForDeployment();
  libraries.ChessRules = await chessRules.getAddress();

  console.log('  ✓ ETourLib_Core:', libraries.ETourLib_Core);
  console.log('  ✓ ETourLib_Matches:', libraries.ETourLib_Matches);
  console.log('  ✓ ETourLib_Prizes:', libraries.ETourLib_Prizes);
  console.log('  ✓ ChessRules:', libraries.ChessRules);

  global.deployedLibraries = libraries;
  return libraries;
}

/**
 * Intercept contract factory creation
 * This is the magic that makes zero-modification instrumentation work
 */
const originalGetContractFactory = hre.ethers.getContractFactory;

hre.ethers.getContractFactory = async function(contractName, ...args) {
  // Auto-inject library addresses for game contracts
  const gameContracts = ['TicTacChain', 'ChessOnChain', 'ConnectFourOnChain'];

  if (gameContracts.includes(contractName)) {
    // Ensure libraries are deployed
    const libraries = await deployLibraries();

    // If no options object was passed, create one with libraries
    if (args.length === 0 || typeof args[0] !== 'object' || args[0]._isSigner) {
      // Either no args, or first arg is a signer
      const signer = args[0]?._isSigner ? args[0] : undefined;
      const options = {
        libraries: {
          ETourLib_Core: libraries.ETourLib_Core,
          ETourLib_Matches: libraries.ETourLib_Matches,
          ETourLib_Prizes: libraries.ETourLib_Prizes
        }
      };

      // If ChessOnChain, also add ChessRules
      if (contractName === 'ChessOnChain') {
        options.libraries.ChessRules = libraries.ChessRules;
      }

      // Call original with proper args
      args = signer ? [signer, options] : [options];
    }
  }

  // Get the original factory
  const factory = await originalGetContractFactory.call(this, contractName, ...args);

  // Wrap the deploy method to instrument contracts
  const originalDeploy = factory.deploy;
  factory.deploy = async function(...deployArgs) {
    // Deploy the contract normally
    const contract = await originalDeploy.apply(this, deployArgs);

    // Wait for deployment
    await contract.waitForDeployment();

    // Return instrumented version
    return createInstrumentedContract(contract, contractName);
  };

  // Also wrap the attach method for connecting to existing contracts
  const originalAttach = factory.attach;
  factory.attach = function(address) {
    const contract = originalAttach.call(this, address);
    return createInstrumentedContract(contract, contractName);
  };

  return factory;
};

/**
 * Also intercept getContractAt for contracts connected via address
 */
const originalGetContractAt = hre.ethers.getContractAt;

hre.ethers.getContractAt = async function(contractName, address, ...args) {
  const contract = await originalGetContractAt.call(this, contractName, address, ...args);
  return createInstrumentedContract(contract, contractName);
};

/**
 * Mocha hooks - these run before/after each test
 */
beforeEach(function() {
  // Only track if we have a current test context
  if (this.currentTest) {
    const testId = generateTestId(this.currentTest);
    const testName = this.currentTest.fullTitle();
    const testFile = this.currentTest.file || 'unknown';

    global.stateTracker.startTest(testId, testName, testFile);
  }
});

afterEach(function() {
  // End tracking for this test
  if (this.currentTest) {
    const testId = generateTestId(this.currentTest);
    const status = this.currentTest.state || 'unknown'; // passed, failed, pending
    const error = this.currentTest.err ? {
      message: this.currentTest.err.message,
      stack: this.currentTest.err.stack
    } : null;

    global.stateTracker.endTest(testId, status, error);
  }
});

/**
 * Generate a unique ID for a test
 */
function generateTestId(test) {
  // Use full title + file path for uniqueness
  const fullTitle = test.fullTitle();
  const file = test.file || '';

  // Create a simple hash
  let hash = 0;
  const str = fullTitle + file;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return `test-${Math.abs(hash)}`;
}

// Log setup completion (only visible if tests fail to start)
console.log('Scientific test reporter setup complete. State capture enabled.');
