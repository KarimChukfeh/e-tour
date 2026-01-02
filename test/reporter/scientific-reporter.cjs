const Mocha = require('mocha');
const fs = require('fs').promises;
const path = require('path');
const { GasAnalyzer } = require('./gas-analyzer.cjs');
const { HTMLGenerator } = require('./html-generator.cjs');
const { StateTracker } = require('./state-tracker.cjs');

/**
 * Scientific Reporter
 *
 * Custom Mocha reporter that generates comprehensive HTML reports with:
 * - Full state capture timeline for each test
 * - Multi-network gas analysis
 * - Incremental updates during test execution
 * - Collapsible test sections with excruciating detail
 */

const {
  EVENT_RUN_BEGIN,
  EVENT_RUN_END,
  EVENT_TEST_BEGIN,
  EVENT_TEST_END,
  EVENT_TEST_PASS,
  EVENT_TEST_FAIL,
  EVENT_SUITE_BEGIN,
  EVENT_SUITE_END
} = Mocha.Runner.constants;

class ScientificReporter {
  constructor(runner, options) {
    // Call base reporter constructor
    this._defaults = {
      reporterOptions: {}
    };

    this.stats = runner.stats;
    this.runner = runner;
    this.options = options;

    // Initialize components
    this.gasAnalyzer = new GasAnalyzer();
    this.htmlGenerator = new HTMLGenerator(this.gasAnalyzer);
    this.startTime = null;
    this.endTime = null;

    // Output file path
    this.outputPath = path.join(process.cwd(), 'test-report-scientific.html');

    // Test tracking
    this.currentSuite = null;
    this.completedTests = 0;
    this.totalTests = 0;

    // Bind event handlers
    this.bindEvents();

    console.log('\nScientific Reporter initialized. Report will be generated at:');
    console.log(this.outputPath);
    console.log('Incremental updates will be written after each test.\n');
  }

  /**
   * Bind Mocha lifecycle events
   */
  bindEvents() {
    this.runner
      .on(EVENT_RUN_BEGIN, () => this.onRunBegin())
      .on(EVENT_SUITE_BEGIN, suite => this.onSuiteBegin(suite))
      .on(EVENT_TEST_BEGIN, test => this.onTestBegin(test))
      .on(EVENT_TEST_PASS, test => this.onTestPass(test))
      .on(EVENT_TEST_FAIL, (test, err) => this.onTestFail(test, err))
      .on(EVENT_SUITE_END, suite => this.onSuiteEnd(suite))
      .on(EVENT_RUN_END, () => this.onRunEnd());
  }

  /**
   * Run begins
   */
  onRunBegin() {
    this.startTime = Date.now();

    // Initialize global state tracker if not already initialized
    if (!global.stateTracker) {
      console.log('Initializing StateTracker from reporter...');
      global.stateTracker = new StateTracker();

      // Also need to set up the contract instrumentation
      const hre = require('hardhat');
      const { createInstrumentedContract } = require('../instrumentation/contract-proxy.cjs');

      // Intercept contract factory
      const originalGetContractFactory = hre.ethers.getContractFactory;
      hre.ethers.getContractFactory = async function(contractName, ...args) {
        const factory = await originalGetContractFactory.call(this, contractName, ...args);
        const originalDeploy = factory.deploy;
        factory.deploy = async function(...deployArgs) {
          const contract = await originalDeploy.apply(this, deployArgs);
          await contract.waitForDeployment();
          return createInstrumentedContract(contract, contractName);
        };
        return factory;
      };

      // Set up Mocha hooks for test tracking
      this.setupMochaHooks();
    }

    console.log('Starting test execution with scientific reporting...');

    // Count total tests
    this.totalTests = this.countTests(this.runner.suite);
  }

  /**
   * Suite begins
   */
  onSuiteBegin(suite) {
    if (suite.title) {
      this.currentSuite = suite.title;
    }
  }

  /**
   * Test begins
   */
  onTestBegin(test) {
    // Test tracking is handled by setup.cjs hooks
    // Just log progress
    process.stdout.write(`\n  ${this.completedTests + 1}/${this.totalTests}: ${test.title}`);
  }

  /**
   * Test passed
   */
  onTestPass(test) {
    process.stdout.write(' ✓');
    this.completedTests++;
    this.generateIncrementalReport();
  }

  /**
   * Test failed
   */
  onTestFail(test, err) {
    process.stdout.write(' ✗');
    this.completedTests++;
    this.generateIncrementalReport();
  }

  /**
   * Suite ends
   */
  onSuiteEnd(suite) {
    // Nothing special to do
  }

  /**
   * Run ends
   */
  onRunEnd() {
    this.endTime = Date.now();
    console.log('\n\nTest execution complete. Generating final report...');

    this.generateFinalReport();
  }

  /**
   * Generate incremental report after each test
   */
  async generateIncrementalReport() {
    try {
      // Check if stateTracker is available
      if (!global.stateTracker) {
        console.error('\nWarning: global.stateTracker is undefined');
        return;
      }

      // Get current test data
      const tests = global.stateTracker.getAllTests();
      const summary = global.stateTracker.getSummary();

      // Generate HTML
      const html = this.htmlGenerator.generate({
        tests,
        summary,
        startTime: this.startTime,
        endTime: Date.now(),
        isIncremental: true,
        completedTests: this.completedTests,
        totalTests: this.totalTests
      });

      // Write atomically (temp file then rename)
      await this.writeAtomic(this.outputPath, html);
    } catch (error) {
      console.error('\nError generating incremental report:', error.message);
    }
  }

  /**
   * Generate final comprehensive report
   */
  async generateFinalReport() {
    try {
      // Check if stateTracker is available
      if (!global.stateTracker) {
        console.error('\nError: global.stateTracker is undefined. Setup file may not have loaded properly.');
        console.error('Tests passed but state capture failed. Check that test/setup.cjs is being loaded.');
        return;
      }

      // Get all test data
      const tests = global.stateTracker.getAllTests();
      const summary = global.stateTracker.getSummary();

      // Perform comprehensive gas analysis
      const suiteAnalysis = this.gasAnalyzer.analyzeSuite(tests);

      // Generate HTML
      const html = this.htmlGenerator.generate({
        tests,
        summary,
        suiteAnalysis,
        startTime: this.startTime,
        endTime: this.endTime,
        isIncremental: false
      });

      // Write final report
      await this.writeAtomic(this.outputPath, html);

      // Also save JSON data (with BigInt handling)
      const jsonPath = path.join(process.cwd(), 'test', 'report-data', 'test-data.json');
      await this.ensureDirectoryExists(path.dirname(jsonPath));
      const jsonData = JSON.stringify(global.stateTracker.toJSON(), (key, value) =>
        typeof value === 'bigint' ? value.toString() : value, 2);
      await fs.writeFile(jsonPath, jsonData, 'utf8');

      console.log(`\n✓ Final report generated: ${this.outputPath}`);
      console.log(`✓ JSON data saved: ${jsonPath}`);
      console.log(`\n📊 Summary:`);
      console.log(`   Total tests: ${summary.total}`);
      console.log(`   Passed: ${summary.passed}`);
      console.log(`   Failed: ${summary.failed}`);
      console.log(`   Total gas: ${this.gasAnalyzer.formatGas(summary.totalGas)}`);
      console.log(`   Total transactions: ${summary.totalTransactions}`);
      console.log(`   Duration: ${(summary.totalDuration / 1000).toFixed(1)}s`);

      if (suiteAnalysis && suiteAnalysis.costs) {
        console.log(`\n💰 Estimated costs (full suite):`);
        console.log(`   Ethereum: $${suiteAnalysis.costs.ethereum.costUsd}`);
        console.log(`   Arbitrum: $${suiteAnalysis.costs.arbitrum.costUsd}`);
        console.log(`   Polygon:  $${suiteAnalysis.costs.polygon.costUsd}`);
      }
    } catch (error) {
      console.error('\nError generating final report:', error);
      console.error(error.stack);
    }
  }

  /**
   * Write file atomically (temp then rename)
   */
  async writeAtomic(filePath, content) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  }

  /**
   * Ensure directory exists
   */
  async ensureDirectoryExists(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore
    }
  }

  /**
   * Count total tests recursively
   */
  countTests(suite) {
    let count = suite.tests.length;
    for (const child of suite.suites) {
      count += this.countTests(child);
    }
    return count;
  }

  /**
   * Setup Mocha hooks for test tracking
   */
  setupMochaHooks() {
    const self = this;

    // Hook into beforeEach
    this.runner.on(EVENT_TEST_BEGIN, function(test) {
      const testId = self.generateTestId(test);
      const testName = test.fullTitle();
      const testFile = test.file || 'unknown';
      global.stateTracker.startTest(testId, testName, testFile);
    });

    // Hook into afterEach
    this.runner.on(EVENT_TEST_END, function(test) {
      const testId = self.generateTestId(test);
      const status = test.state || 'unknown';
      const error = test.err ? {
        message: test.err.message,
        stack: test.err.stack
      } : null;
      global.stateTracker.endTest(testId, status, error);
    });
  }

  /**
   * Generate a unique ID for a test
   */
  generateTestId(test) {
    const fullTitle = test.fullTitle();
    const file = test.file || '';
    let hash = 0;
    const str = fullTitle + file;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `test-${Math.abs(hash)}`;
  }
}

module.exports = ScientificReporter;
