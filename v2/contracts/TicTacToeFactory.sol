// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./TicTacToe.sol";

/**
 * @title TicTacToeFactory
 * @dev Factory contract for Tic-Tac-Toe tournament instances.
 */
contract TicTacToeFactory is ETourFactory {

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry
    ) ETourFactory(
        address(new TicTacToe()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 0;
    }
}
