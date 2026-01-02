/**
 * State Tracker
 *
 * Manages state capture for all tests. Singleton that stores timeline entries
 * for each test and provides data to the reporter.
 */

class StateTracker {
  constructor() {
    this.tests = new Map(); // testId -> test data
    this.currentTestId = null;
    this.currentTestName = null;
    this.currentTestFile = null;
    this.testStartTime = null;
    this.tracking = false;
  }

  /**
   * Start tracking a new test
   */
  startTest(testId, testName, testFile) {
    this.currentTestId = testId;
    this.currentTestName = testName;
    this.currentTestFile = testFile;
    this.testStartTime = Date.now();
    this.tracking = true;

    this.tests.set(testId, {
      id: testId,
      name: testName,
      file: testFile,
      status: 'running',
      startTime: this.testStartTime,
      endTime: null,
      duration: null,
      timeline: [],
      error: null
    });
  }

  /**
   * Record a timeline entry for the current test
   */
  recordTimelineEntry(entry) {
    if (!this.tracking || !this.currentTestId) {
      return;
    }

    const test = this.tests.get(this.currentTestId);
    if (!test) {
      return;
    }

    // Add sequence number
    entry.sequence = test.timeline.length;

    test.timeline.push(entry);
  }

  /**
   * End tracking for the current test
   */
  endTest(testId, status, error = null) {
    const test = this.tests.get(testId);
    if (!test) {
      return;
    }

    test.status = status;
    test.endTime = Date.now();
    test.duration = test.endTime - test.startTime;
    test.error = error;

    this.currentTestId = null;
    this.currentTestName = null;
    this.currentTestFile = null;
    this.tracking = false;
  }

  /**
   * Check if currently tracking a test
   */
  isTracking() {
    return this.tracking;
  }

  /**
   * Get data for a specific test
   */
  getTestData(testId) {
    return this.tests.get(testId);
  }

  /**
   * Get all test data
   */
  getAllTests() {
    return Array.from(this.tests.values());
  }

  /**
   * Get current test ID
   */
  getCurrentTestId() {
    return this.currentTestId;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const tests = this.getAllTests();
    const summary = {
      total: tests.length,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      totalDuration: 0,
      totalGas: 0n,
      totalTransactions: 0
    };

    for (const test of tests) {
      if (test.status === 'passed') summary.passed++;
      else if (test.status === 'failed') summary.failed++;
      else if (test.status === 'pending') summary.pending++;
      else if (test.status === 'skipped') summary.skipped++;

      summary.totalDuration += test.duration || 0;

      // Sum gas from timeline entries
      for (const entry of test.timeline) {
        if (entry.gasUsed) {
          try {
            summary.totalGas += BigInt(entry.gasUsed);
            summary.totalTransactions++;
          } catch (e) {
            // Skip invalid gas values
          }
        }
      }
    }

    return summary;
  }

  /**
   * Get all tests grouped by file
   */
  getTestsByFile() {
    const byFile = {};
    for (const test of this.getAllTests()) {
      if (!byFile[test.file]) {
        byFile[test.file] = [];
      }
      byFile[test.file].push(test);
    }
    return byFile;
  }

  /**
   * Get all tests filtered by status
   */
  getTestsByStatus(status) {
    return this.getAllTests().filter(test => test.status === status);
  }

  /**
   * Clear all test data (for new test run)
   */
  clear() {
    this.tests.clear();
    this.currentTestId = null;
    this.currentTestName = null;
    this.currentTestFile = null;
    this.testStartTime = null;
    this.tracking = false;
  }

  /**
   * Export data as JSON
   */
  toJSON() {
    return {
      summary: this.getSummary(),
      tests: this.getAllTests().map(test => ({
        ...test,
        // Convert BigInt values to strings for JSON serialization
        timeline: test.timeline.map(entry => ({
          ...entry,
          gasUsed: entry.gasUsed?.toString(),
          // Recursively stringify any BigInt in state objects
          stateBefore: stringifyBigInts(entry.stateBefore),
          stateAfter: stringifyBigInts(entry.stateAfter)
        }))
      }))
    };
  }

  /**
   * Load data from JSON
   */
  fromJSON(data) {
    this.clear();
    for (const test of data.tests) {
      this.tests.set(test.id, test);
    }
  }
}

/**
 * Helper function to recursively convert BigInt to strings for JSON
 */
function stringifyBigInts(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(stringifyBigInts);
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = stringifyBigInts(value);
    }
    return result;
  }

  return obj;
}

module.exports = { StateTracker };
