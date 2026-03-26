// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ChessInstance.sol";

/**
 * @title ChessOnChainFactory
 * @dev Factory contract for Chess tournament instances.
 *
 * Overrides createInstance() to also pass the CHESS_RULES address to each
 * newly deployed ChessInstance clone via initializeChess().
 */
contract ChessOnChainFactory is ETourFactory {

    address public immutable CHESS_RULES;

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address chessRules,
        address playerRegistry
    ) ETourFactory(
        address(new ChessInstance()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) {
        require(chessRules != address(0), "CR");
        CHESS_RULES = chessRules;
    }

    function _gameType() internal pure override returns (uint8) {
        return 2;
    }

    /**
     * @dev Override createInstance to pass CHESS_RULES to each clone via initializeChess().
     */
    function createInstance(
        uint8 playerCount,
        uint256 entryFee,
        uint256 enrollmentWindow,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove
    ) external payable override returns (address instance) {
        require(msg.value == entryFee, "Must send exact entry fee to auto-enroll");
        _validatePlayerCount(playerCount);
        _validateEntryFee(entryFee);
        _validateUserTimeouts(enrollmentWindow, matchTimePerPlayer, timeIncrementPerMove);

        // Construct full TimeoutConfig with hardcoded escalation delays
        ETourInstance_Base.TimeoutConfig memory timeouts = ETourInstance_Base.TimeoutConfig({
            matchTimePerPlayer: matchTimePerPlayer,
            timeIncrementPerMove: timeIncrementPerMove,
            matchLevel2Delay: MATCH_LEVEL_2_DELAY,
            matchLevel3Delay: MATCH_LEVEL_3_DELAY,
            enrollmentWindow: enrollmentWindow,
            enrollmentLevel2Delay: ENROLLMENT_LEVEL_2_DELAY
        });

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

        instance = _clone(implementation);

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

        instances.push(instance);
        tierInstances[tierKey].push(instance);

        emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);

        ETourInstance_Base(instance).enrollOnBehalf{value: entryFee}(msg.sender);
    }
}
