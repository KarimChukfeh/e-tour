// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./Checkers.sol";

/**
 * @title CheckersFactory
 * @dev Reference ETour factory for the Checkers game implementation.
 */
contract CheckersFactory is ETourFactory {

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry
    ) ETourFactory(
        address(new Checkers()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 3;
    }
}
