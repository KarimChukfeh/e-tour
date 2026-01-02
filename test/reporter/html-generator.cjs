/**
 * HTML Generator
 *
 * Generates comprehensive HTML reports with:
 * - Timeline visualization for each test
 * - State diffs before/after each action
 * - Event displays
 * - Gas analysis tables
 * - Collapsible sections
 * - Interactive features (search, filter, expand/collapse)
 */

class HTMLGenerator {
  constructor(gasAnalyzer) {
    this.gasAnalyzer = gasAnalyzer;
  }

  /**
   * Generate complete HTML report
   */
  generate(data) {
    const { tests, summary, suiteAnalysis, startTime, endTime, isIncremental, completedTests, totalTests } = data;

    const duration = endTime - startTime;
    const durationSec = (duration / 1000).toFixed(1);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scientific Test Report - ETour Protocol</title>
    ${this.generateCSS()}
</head>
<body>
    ${this.generateHeader(summary, durationSec, isIncremental, completedTests, totalTests)}
    ${this.generateSummaryDashboard(summary, suiteAnalysis)}
    ${this.generateControls()}
    ${this.generateTestList(tests)}
    ${this.generateFooter()}
    ${this.generateJavaScript()}
</body>
</html>`;
  }

  /**
   * Generate embedded CSS
   */
  generateCSS() {
    return `<style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #0a0e1a;
            color: #e0e0e0;
            line-height: 1.6;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        header {
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }

        header h1 {
            color: white;
            font-size: 2.5em;
            margin-bottom: 10px;
        }

        header .subtitle {
            color: #93c5fd;
            font-size: 1.1em;
        }

        .summary-dashboard {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .summary-card {
            background: #1e293b;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #3b82f6;
        }

        .summary-card h3 {
            color: #94a3b8;
            font-size: 0.9em;
            text-transform: uppercase;
            margin-bottom: 10px;
        }

        .summary-card .value {
            font-size: 2em;
            font-weight: bold;
            color: #3b82f6;
        }

        .summary-card.passed .value { color: #10b981; }
        .summary-card.failed .value { color: #ef4444; }
        .summary-card.gas .value { color: #f59e0b; }

        .controls {
            background: #1e293b;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            align-items: center;
        }

        .controls button {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background 0.2s;
        }

        .controls button:hover {
            background: #2563eb;
        }

        .controls input {
            padding: 10px;
            border-radius: 6px;
            border: 1px solid #475569;
            background: #0f172a;
            color: #e0e0e0;
            flex: 1;
            min-width: 200px;
        }

        .test-scenario {
            background: #1e293b;
            margin-bottom: 15px;
            border-radius: 8px;
            overflow: hidden;
            border-left: 4px solid transparent;
        }

        .test-scenario[data-status="passed"] { border-left-color: #10b981; }
        .test-scenario[data-status="failed"] { border-left-color: #ef4444; }
        .test-scenario[data-status="pending"] { border-left-color: #f59e0b; }

        .test-header {
            padding: 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 15px;
            transition: background 0.2s;
        }

        .test-header:hover {
            background: #2d3748;
        }

        .status-icon {
            font-size: 1.5em;
            width: 30px;
            text-align: center;
        }

        .test-scenario[data-status="passed"] .status-icon { color: #10b981; }
        .test-scenario[data-status="failed"] .status-icon { color: #ef4444; }
        .test-scenario[data-status="pending"] .status-icon { color: #f59e0b; }

        .test-header h3 {
            flex: 1;
            color: #e0e0e0;
            font-size: 1.1em;
        }

        .test-meta {
            color: #94a3b8;
            font-size: 0.9em;
        }

        .expand-icon {
            color: #3b82f6;
            font-size: 1.2em;
            transition: transform 0.3s;
        }

        .test-scenario.expanded .expand-icon {
            transform: rotate(90deg);
        }

        .test-detail {
            padding: 0 20px;
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease-out, padding 0.3s;
        }

        .test-scenario.expanded .test-detail {
            max-height: 100000px;
            padding: 20px;
        }

        .timeline {
            margin: 20px 0;
        }

        .timeline-entry {
            position: relative;
            padding-left: 40px;
            padding-bottom: 30px;
            border-left: 2px solid #475569;
        }

        .timeline-entry:last-child {
            border-left-color: transparent;
        }

        .timeline-marker {
            position: absolute;
            left: -13px;
            top: 0;
            width: 24px;
            height: 24px;
            background: #3b82f6;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
            font-weight: bold;
        }

        .timeline-content {
            background: #0f172a;
            padding: 15px;
            border-radius: 8px;
        }

        .action-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            flex-wrap: wrap;
            gap: 10px;
        }

        .action-name {
            font-weight: bold;
            color: #3b82f6;
            font-size: 1.1em;
        }

        .block-info {
            color: #94a3b8;
            font-size: 0.9em;
        }

        .gas-badge {
            background: #f59e0b;
            color: #000;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: bold;
        }

        .state-diff {
            margin: 15px 0;
        }

        .state-diff h4 {
            color: #94a3b8;
            font-size: 0.9em;
            margin-bottom: 10px;
        }

        .state-diff table {
            width: 100%;
            border-collapse: collapse;
        }

        .state-diff td {
            padding: 8px;
            border-bottom: 1px solid #334155;
        }

        .diff-label {
            color: #cbd5e1;
            font-family: 'Courier New', monospace;
        }

        .diff-before {
            color: #ef4444;
        }

        .diff-arrow {
            color: #3b82f6;
            text-align: center;
        }

        .diff-after {
            color: #10b981;
        }

        .events-section {
            margin: 15px 0;
        }

        .events-section h4 {
            color: #94a3b8;
            font-size: 0.9em;
            margin-bottom: 10px;
        }

        .event {
            background: #1e293b;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 8px;
        }

        .event-name {
            color: #fbbf24;
            font-weight: bold;
            display: block;
            margin-bottom: 5px;
        }

        .event pre {
            color: #94a3b8;
            font-size: 0.85em;
            overflow-x: auto;
        }

        details {
            margin: 15px 0;
        }

        details summary {
            cursor: pointer;
            color: #3b82f6;
            padding: 10px;
            background: #1e293b;
            border-radius: 4px;
        }

        details summary:hover {
            background: #2d3748;
        }

        details pre {
            background: #000;
            padding: 15px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 0.85em;
            color: #94a3b8;
            margin-top: 10px;
        }

        .gas-analysis-summary {
            margin-top: 30px;
            padding: 20px;
            background: #0f172a;
            border-radius: 8px;
        }

        .gas-analysis-summary h4, .gas-analysis-summary h5 {
            color: #fbbf24;
            margin-bottom: 15px;
        }

        .gas-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }

        .gas-table thead {
            background: #1e293b;
        }

        .gas-table th {
            padding: 12px;
            text-align: left;
            color: #94a3b8;
            font-weight: 600;
        }

        .gas-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #334155;
        }

        .gas-table tbody tr:hover {
            background: #1e293b;
        }

        footer {
            margin-top: 40px;
            padding: 20px;
            text-align: center;
            color: #64748b;
            font-size: 0.9em;
        }

        .hidden {
            display: none !important;
        }
    </style>`;
  }

  /**
   * Generate header
   */
  generateHeader(summary, duration, isIncremental, completedTests, totalTests) {
    const status = isIncremental ? `In Progress (${completedTests}/${totalTests} tests)` : 'Complete';
    const timestamp = new Date().toLocaleString();

    return `<div class="container">
        <header>
            <h1>🔬 Scientific Test Report</h1>
            <p class="subtitle">ETour Protocol - Comprehensive State & Gas Analysis</p>
            <p class="subtitle">Generated: ${timestamp} | Status: ${status} | Duration: ${duration}s</p>
        </header>`;
  }

  /**
   * Generate summary dashboard
   */
  generateSummaryDashboard(summary, suiteAnalysis) {
    const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : 0;
    const totalGasFormatted = this.gasAnalyzer.formatGas(summary.totalGas);

    let costInfo = '';
    if (suiteAnalysis && suiteAnalysis.costs) {
      costInfo = `
            <div class="summary-card">
                <h3>Ethereum Cost</h3>
                <div class="value">$${suiteAnalysis.costs.ethereum.costUsd}</div>
            </div>
            <div class="summary-card">
                <h3>Arbitrum Cost</h3>
                <div class="value">$${suiteAnalysis.costs.arbitrum.costUsd}</div>
            </div>`;
    }

    return `<div class="summary-dashboard">
            <div class="summary-card">
                <h3>Total Tests</h3>
                <div class="value">${summary.total}</div>
            </div>
            <div class="summary-card passed">
                <h3>Passed</h3>
                <div class="value">${summary.passed}</div>
            </div>
            <div class="summary-card failed">
                <h3>Failed</h3>
                <div class="value">${summary.failed}</div>
            </div>
            <div class="summary-card">
                <h3>Pass Rate</h3>
                <div class="value">${passRate}%</div>
            </div>
            <div class="summary-card gas">
                <h3>Total Gas</h3>
                <div class="value">${totalGasFormatted}</div>
            </div>
            <div class="summary-card">
                <h3>Transactions</h3>
                <div class="value">${summary.totalTransactions}</div>
            </div>
            ${costInfo}
        </div>`;
  }

  /**
   * Generate controls
   */
  generateControls() {
    return `<div class="controls">
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="filterStatus('passed')">Show Passed</button>
            <button onclick="filterStatus('failed')">Show Failed</button>
            <button onclick="filterStatus('all')">Show All</button>
            <input type="text" id="searchInput" placeholder="Search tests..." onkeyup="searchTests()">
        </div>`;
  }

  /**
   * Generate test list
   */
  generateTestList(tests) {
    let html = '<div id="testList">';

    for (const test of tests) {
      html += this.generateTestSection(test);
    }

    html += '</div>';
    return html;
  }

  /**
   * Generate single test section
   */
  generateTestSection(test) {
    const statusIcon = test.status === 'passed' ? '✓' :
                      test.status === 'failed' ? '✗' : '⚠';

    const testAnalysis = this.gasAnalyzer.analyzeTest(test);
    const gasUsed = testAnalysis ? this.gasAnalyzer.formatGas(testAnalysis.totalGas) : '0';
    const txCount = test.timeline.length;
    const durationSec = test.duration ? (test.duration / 1000).toFixed(2) : '0';

    return `<div class="test-scenario" data-status="${test.status}" data-test-id="${test.id}">
            <div class="test-header" onclick="toggleTest('${test.id}')">
                <span class="status-icon">${statusIcon}</span>
                <h3>${this.escapeHtml(test.name)}</h3>
                <span class="test-meta">${this.escapeHtml(test.file)} | ${durationSec}s | ${txCount} actions | ${gasUsed} gas</span>
                <span class="expand-icon">▶</span>
            </div>
            <div class="test-detail">
                ${this.generateTimeline(test)}
                ${testAnalysis ? this.generateGasAnalysis(testAnalysis) : ''}
                ${test.error ? this.generateErrorSection(test.error) : ''}
            </div>
        </div>`;
  }

  /**
   * Generate timeline for a test
   */
  generateTimeline(test) {
    if (!test.timeline || test.timeline.length === 0) {
      return '<p style="color: #94a3b8;">No timeline data captured for this test.</p>';
    }

    let html = '<div class="timeline">';

    for (const entry of test.timeline) {
      html += this.generateTimelineEntry(entry);
    }

    html += '</div>';
    return html;
  }

  /**
   * Generate single timeline entry
   */
  generateTimelineEntry(entry) {
    const blockInfo = entry.blockNumber ? `Block #${entry.blockNumber}` : '';
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
    const gasFormatted = entry.gasUsed ? this.gasAnalyzer.formatGas(entry.gasUsed) : 'N/A';

    // Calculate cost
    let costBadge = '';
    if (entry.gasUsed) {
      const costs = this.gasAnalyzer.calculateCosts(entry.gasUsed);
      costBadge = `<span class="gas-badge">${gasFormatted} gas | $${costs.ethereum.costUsd} (ETH)</span>`;
    }

    return `<div class="timeline-entry">
            <div class="timeline-marker">${entry.sequence + 1}</div>
            <div class="timeline-content">
                <div class="action-header">
                    <span class="action-name">${this.escapeHtml(entry.action)}(${this.formatParameters(entry.parameters)})</span>
                    <span class="block-info">${blockInfo} | ${timestamp}</span>
                    ${costBadge}
                </div>
                ${this.generateStateDiff(entry.stateDiff)}
                ${this.generateEvents(entry.events)}
                ${this.generateFullState(entry.stateBefore, entry.stateAfter)}
            </div>
        </div>`;
  }

  /**
   * Generate state diff visualization
   */
  generateStateDiff(stateDiff) {
    if (!stateDiff || Object.keys(stateDiff).length === 0) {
      return '';
    }

    let html = '<div class="state-diff"><h4>State Changes</h4><table>';

    for (const [path, diff] of Object.entries(stateDiff)) {
      // Skip certain verbose paths
      if (path.includes('timeState.blockHash') || path.includes('timeState.timestamp')) {
        continue;
      }

      const fromValue = this.formatValue(diff.from);
      const toValue = this.formatValue(diff.to);

      html += `<tr>
                <td class="diff-label">${this.escapeHtml(path)}</td>
                <td class="diff-before">${this.escapeHtml(fromValue)}</td>
                <td class="diff-arrow">→</td>
                <td class="diff-after">${this.escapeHtml(toValue)}</td>
              </tr>`;
    }

    html += '</table></div>';
    return html;
  }

  /**
   * Generate events section
   */
  generateEvents(events) {
    if (!events || events.length === 0) {
      return '';
    }

    let html = `<div class="events-section"><h4>Events Emitted (${events.length})</h4>`;

    for (const event of events) {
      html += `<div class="event">
                <span class="event-name">${this.escapeHtml(event.name)}</span>
                <pre>${this.escapeHtml(this.formatEventArgs(event.args))}</pre>
              </div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * Generate full state (collapsible)
   */
  generateFullState(before, after) {
    if (!before && !after) {
      return '';
    }

    return `<details class="full-state">
            <summary>Full Contract State (Before → After)</summary>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <h5 style="color: #ef4444; margin-bottom: 10px;">Before</h5>
                    <pre>${this.escapeHtml(JSON.stringify(before, null, 2))}</pre>
                </div>
                <div>
                    <h5 style="color: #10b981; margin-bottom: 10px;">After</h5>
                    <pre>${this.escapeHtml(JSON.stringify(after, null, 2))}</pre>
                </div>
            </div>
        </details>`;
  }

  /**
   * Generate gas analysis section
   */
  generateGasAnalysis(analysis) {
    if (!analysis || !analysis.operations) {
      return '';
    }

    let html = '<div class="gas-analysis-summary"><h4>Gas Analysis for This Test</h4>';

    // Operations table
    html += `<table class="gas-table">
            <thead>
                <tr>
                    <th>Operation</th>
                    <th>Count</th>
                    <th>Avg Gas</th>
                    <th>Min Gas</th>
                    <th>Max Gas</th>
                    <th>ETH Mainnet</th>
                    <th>Arbitrum</th>
                    <th>Polygon</th>
                </tr>
            </thead>
            <tbody>`;

    for (const [opName, opData] of Object.entries(analysis.operations)) {
      const costs = this.gasAnalyzer.calculateCosts(opData.totalGas);

      html += `<tr>
                <td>${this.escapeHtml(opName)}</td>
                <td>${opData.count}</td>
                <td>${this.gasAnalyzer.formatGas(opData.avgGas)}</td>
                <td>${this.gasAnalyzer.formatGas(opData.minGas)}</td>
                <td>${this.gasAnalyzer.formatGas(opData.maxGas)}</td>
                <td>$${costs.ethereum.costUsd}</td>
                <td>$${costs.arbitrum.costUsd}</td>
                <td>$${costs.polygon.costUsd}</td>
              </tr>`;
    }

    html += '</tbody></table>';

    // Player journeys if available
    if (analysis.playerJourneys && Object.keys(analysis.playerJourneys).length > 0) {
      html += '<h5>Player Journey Costs</h5>';
      html += `<table class="gas-table">
              <thead>
                  <tr>
                      <th>Player</th>
                      <th>Transactions</th>
                      <th>Total Gas</th>
                      <th>ETH</th>
                      <th>Arbitrum</th>
                      <th>Polygon</th>
                  </tr>
              </thead>
              <tbody>`;

      for (const [player, journey] of Object.entries(analysis.playerJourneys)) {
        html += `<tr>
                  <td>${this.gasAnalyzer.shortenAddress(player)}</td>
                  <td>${journey.transactions.length}</td>
                  <td>${this.gasAnalyzer.formatGas(journey.totalGas)}</td>
                  <td>$${journey.costs.ethereum.costUsd}</td>
                  <td>$${journey.costs.arbitrum.costUsd}</td>
                  <td>$${journey.costs.polygon.costUsd}</td>
                </tr>`;
      }

      html += '</tbody></table>';
    }

    html += '</div>';
    return html;
  }

  /**
   * Generate error section
   */
  generateErrorSection(error) {
    return `<div style="background: #7f1d1d; padding: 20px; border-radius: 8px; margin-top: 20px;">
            <h4 style="color: #fca5a5; margin-bottom: 10px;">Test Error</h4>
            <pre style="color: #fecaca; overflow-x: auto;">${this.escapeHtml(error.message || JSON.stringify(error))}</pre>
        </div>`;
  }

  /**
   * Generate footer
   */
  generateFooter() {
    return `<footer>
            <p>Generated by Scientific Reporter for ETour Protocol</p>
            <p>Comprehensive state capture and gas analysis powered by Hardhat & ethers.js</p>
        </footer>
    </div>`;
  }

  /**
   * Generate JavaScript for interactivity
   */
  generateJavaScript() {
    return `<script>
        function toggleTest(testId) {
            const scenario = document.querySelector('[data-test-id="' + testId + '"]');
            scenario.classList.toggle('expanded');
        }

        function expandAll() {
            document.querySelectorAll('.test-scenario').forEach(el => {
                el.classList.add('expanded');
            });
        }

        function collapseAll() {
            document.querySelectorAll('.test-scenario').forEach(el => {
                el.classList.remove('expanded');
            });
        }

        function filterStatus(status) {
            document.querySelectorAll('.test-scenario').forEach(el => {
                if (status === 'all') {
                    el.classList.remove('hidden');
                } else {
                    if (el.dataset.status === status) {
                        el.classList.remove('hidden');
                    } else {
                        el.classList.add('hidden');
                    }
                }
            });
        }

        function searchTests() {
            const query = document.getElementById('searchInput').value.toLowerCase();
            document.querySelectorAll('.test-scenario').forEach(el => {
                const testName = el.querySelector('h3').textContent.toLowerCase();
                if (testName.includes(query)) {
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            });
        }
    </script>`;
  }

  /**
   * Utility: Format parameters for display
   */
  formatParameters(params) {
    if (!params || params.length === 0) return '';
    return params.map(p => String(p).substring(0, 20)).join(', ');
  }

  /**
   * Utility: Format value for display
   */
  formatValue(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'object') {
      if (value.eth) return `${value.eth} ETH`;
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Utility: Format event args
   */
  formatEventArgs(args) {
    if (!args) return '{}';
    const formatted = {};
    for (const [key, value] of Object.entries(args)) {
      if (isNaN(parseInt(key))) { // Skip numeric indices
        formatted[key] = this.formatValue(value);
      }
    }
    return JSON.stringify(formatted, null, 2);
  }

  /**
   * Utility: Escape HTML
   */
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }
}

module.exports = { HTMLGenerator };
