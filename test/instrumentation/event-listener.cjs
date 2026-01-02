const hre = require("hardhat");

/**
 * Event Listener and Parser
 *
 * Parses transaction receipt logs into structured event data.
 * Handles events from multiple contracts and formats arguments for display.
 */

/**
 * Parses events from a transaction receipt
 * @param {TransactionReceipt} receipt - The transaction receipt
 * @param {Contract} contract - The contract instance (for ABI)
 * @returns {Array} - Array of parsed events
 */
function parseEvents(receipt, contract) {
  if (!receipt || !receipt.logs) {
    return [];
  }

  const events = [];

  for (const log of receipt.logs) {
    try {
      // Try to parse with the contract's interface
      const parsed = contract.interface.parseLog({
        topics: log.topics,
        data: log.data
      });

      if (parsed) {
        events.push({
          name: parsed.name,
          signature: parsed.signature,
          args: formatEventArgs(parsed.args, parsed.fragment),
          address: log.address,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex
        });
      }
    } catch (e) {
      // Event not from this contract or parsing failed
      // Try to decode as a generic log
      try {
        events.push({
          name: 'UnknownEvent',
          topics: log.topics,
          data: log.data,
          address: log.address,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex
        });
      } catch (innerError) {
        // Skip this log
        continue;
      }
    }
  }

  return events;
}

/**
 * Formats event arguments for human-readable display
 * @param {Result} args - Ethers.js Result object from parseLog
 * @param {Fragment} fragment - Event fragment (optional, for param names)
 * @returns {Object} - Formatted arguments as key-value pairs
 */
function formatEventArgs(args, fragment) {
  const formatted = {};

  // Get parameter names from fragment if available
  const paramNames = fragment?.inputs?.map(input => input.name) || [];

  // Iterate through the Result object
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    const paramName = paramNames[i] || `arg${i}`;

    formatted[paramName] = formatValue(value);
  }

  // Also include named properties (Result objects have both indexed and named access)
  if (fragment && fragment.inputs) {
    for (const input of fragment.inputs) {
      if (input.name && args[input.name] !== undefined) {
        formatted[input.name] = formatValue(args[input.name]);
      }
    }
  }

  return formatted;
}

/**
 * Formats a single value for display
 */
function formatValue(value) {
  try {
    // Handle BigInt / BigNumber
    if (typeof value === 'bigint') {
      // Try to format as ETH if it looks like a wei amount
      if (value > 1000000000000000n) { // > 0.001 ETH
        return {
          wei: value.toString(),
          eth: hre.ethers.formatEther(value),
          type: 'bigint'
        };
      }
      return value.toString();
    }

    // Handle ethers.js BigNumber (v5) or BigInt wrapper
    if (value && typeof value === 'object' && (value._isBigNumber || value._hex)) {
      const bigIntValue = BigInt(value.toString());
      if (bigIntValue > 1000000000000000n) {
        return {
          wei: bigIntValue.toString(),
          eth: hre.ethers.formatEther(bigIntValue),
          type: 'bigint'
        };
      }
      return bigIntValue.toString();
    }

    // Handle addresses
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      return value; // Ethereum address
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map(formatValue);
    }

    // Handle objects
    if (typeof value === 'object' && value !== null) {
      const formatted = {};
      for (const key in value) {
        // Skip numeric indices (already handled above)
        if (!isNaN(parseInt(key))) continue;
        formatted[key] = formatValue(value[key]);
      }
      return formatted;
    }

    // Handle booleans, numbers, strings
    return value;
  } catch (error) {
    return `<formatting error: ${error.message}>`;
  }
}

/**
 * Filters events by name
 */
function filterEventsByName(events, eventName) {
  return events.filter(event => event.name === eventName);
}

/**
 * Gets all unique event names from a set of events
 */
function getUniqueEventNames(events) {
  return [...new Set(events.map(e => e.name))];
}

/**
 * Groups events by name
 */
function groupEventsByName(events) {
  const grouped = {};
  for (const event of events) {
    if (!grouped[event.name]) {
      grouped[event.name] = [];
    }
    grouped[event.name].push(event);
  }
  return grouped;
}

/**
 * Formats events for HTML display
 */
function formatEventsForHTML(events) {
  return events.map(event => ({
    name: event.name,
    argsHTML: formatArgsAsHTML(event.args),
    signature: event.signature,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex
  }));
}

/**
 * Formats event arguments as HTML-friendly structure
 */
function formatArgsAsHTML(args) {
  const lines = [];
  for (const [key, value] of Object.entries(args)) {
    // Skip numeric keys (they're duplicates of named keys)
    if (!isNaN(parseInt(key))) continue;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Complex value (like wei/eth object)
      if (value.eth !== undefined) {
        lines.push(`${key}: ${value.eth} ETH (${value.wei} wei)`);
      } else {
        lines.push(`${key}: ${JSON.stringify(value, null, 2)}`);
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  parseEvents,
  formatEventArgs,
  formatValue,
  filterEventsByName,
  getUniqueEventNames,
  groupEventsByName,
  formatEventsForHTML
};
