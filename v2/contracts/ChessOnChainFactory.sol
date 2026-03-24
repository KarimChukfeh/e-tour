// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ChessInstance.sol";

/**
 * @title ChessOnChainFactory
 * @dev Factory contract for Chess tournament instances.
 *
 * Inherits ETourFactory and overrides createInstance() to also pass
 * the CHESS_RULES address to each newly deployed ChessInstance clone.
 *
 * Usage:
 * 1. Deploy shared modules (ETourInstance_Core, ETourInstance_Matches,
 *    ETourInstance_Prizes, ETourInstance_Escalation) + IChessRules implementation
 * 2. Deploy ChessOnChainFactory(moduleCore, moduleMatches, modulePrizes, moduleEscalation, chessRules)
 * 3. Call createInstance(playerCount, entryFee, timeouts) to start tournaments
 */
contract ChessOnChainFactory is ETourFactory {

    address public immutable CHESS_RULES;

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address chessRules
    ) ETourFactory(
        address(new ChessInstance()),  // deploy implementation inline
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation
    ) {
        require(chessRules != address(0), "CR");
        CHESS_RULES = chessRules;

        // Progressive raffle thresholds (last repeats for all future raffles)
        raffleThresholds.push(0.005 ether);  // Raffle #0
        raffleThresholds.push(0.02 ether);   // Raffle #1
        raffleThresholds.push(0.05 ether);   // Raffle #2
        raffleThresholds.push(0.15 ether);   // Raffle #3
        raffleThresholds.push(0.5 ether);    // Raffle #4
        raffleThresholds.push(1.0 ether);    // Raffle #5+ (repeats)
    }

    /**
     * @dev Override createInstance to pass CHESS_RULES to each clone via initializeChess().
     */
    function createInstance(
        uint8 playerCount,
        uint256 entryFee,
        ETourInstance_Base.TimeoutConfig calldata timeouts
    ) external override returns (address instance) {
        _validatePlayerCount(playerCount);
        _validateEntryFee(entryFee);
        _validateTimeouts(timeouts);

        bytes32 tierKey = _computeTierKey(playerCount, entryFee);
        if (!_tierExists(tierKey)) {
            _registerTier(tierKey, playerCount, entryFee, timeouts);
        }

        TierConfig storage config = tierRegistry[tierKey];

        ETourInstance_Base.TierConfig memory instanceTierConfig = ETourInstance_Base.TierConfig({
            playerCount: playerCount,
            entryFee: entryFee,
            timeouts: config.timeouts,
            totalRounds: config.totalRounds,
            tierKey: tierKey
        });

        // Deploy EIP-1167 clone
        instance = _clone(implementation);

        // Chess-specific initialization (sets CHESS_RULES + calls base initialize)
        ChessInstance(instance).initializeChess(
            instanceTierConfig,
            address(this),
            msg.sender,
            MODULE_CORE,
            MODULE_MATCHES,
            MODULE_PRIZES,
            MODULE_ESCALATION,
            CHESS_RULES
        );

        // Track instance
        instances.push(instance);
        tierInstances[tierKey].push(instance);

        emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);
    }
}
