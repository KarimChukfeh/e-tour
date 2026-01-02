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

/**
 * Intercept contract factory creation
 * This is the magic that makes zero-modification instrumentation work
 */
const originalGetContractFactory = hre.ethers.getContractFactory;

hre.ethers.getContractFactory = async function(contractName, ...args) {
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
