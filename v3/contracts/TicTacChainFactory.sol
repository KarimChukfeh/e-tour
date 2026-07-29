// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./TicTacInstance.sol";

/**
 * @title TicTacChainFactory
 * @dev Factory contract for Tic-Tac-Toe tournament instances.
 */
contract TicTacChainFactory is ETourFactory {

    /**
     * @notice Initializes the tic tac chain factory constructor.
     * @param moduleCore The module core address.
     * @param moduleMatches The module matches address.
     * @param modulePrizes The module prizes address.
     * @param moduleEscalation The module escalation address.
     * @param playerRegistry The player registry address.
     * @param sessionRegistry The session registry address.
     */
    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry,
        address sessionRegistry
    ) ETourFactory(
        address(new TicTacInstance()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry,
        sessionRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 0;
    }
}
