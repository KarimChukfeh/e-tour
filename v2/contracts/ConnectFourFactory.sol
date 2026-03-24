// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ConnectFourInstance.sol";

/**
 * @title ConnectFourFactory
 * @dev Factory contract for Connect Four tournament instances.
 *
 * Inherits ETourFactory and sets:
 * - Implementation: ConnectFourInstance (deployed in constructor)
 * - Raffle thresholds specific to Connect Four
 *
 * Usage:
 * 1. Deploy shared modules (ETourInstance_Core, ETourInstance_Matches,
 *    ETourInstance_Prizes, ETourInstance_Escalation)
 * 2. Deploy ConnectFourFactory(moduleCore, moduleMatches, modulePrizes, moduleEscalation)
 * 3. Call createInstance(playerCount, entryFee, timeouts) to start tournaments
 */
contract ConnectFourFactory is ETourFactory {

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation
    ) ETourFactory(
        address(new ConnectFourInstance()),  // deploy implementation inline
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation
    ) {
        // Progressive raffle thresholds (last repeats for all future raffles)
        raffleThresholds.push(0.001 ether);  // Raffle #0
        raffleThresholds.push(0.005 ether);  // Raffle #1
        raffleThresholds.push(0.02 ether);   // Raffle #2
        raffleThresholds.push(0.05 ether);   // Raffle #3
        raffleThresholds.push(0.25 ether);   // Raffle #4
        raffleThresholds.push(0.5 ether);    // Raffle #5
        raffleThresholds.push(0.75 ether);   // Raffle #6
        raffleThresholds.push(1.0 ether);    // Raffle #7+ (repeats)
    }
}
