// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ChessInstance.sol";

/**
 * @title ChessOnChainFactory
 * @dev Factory contract for Chess tournament instances.
 *
 * Uses the canonical ETourFactory creation flow and configures CHESS_RULES in
 * its one-time post-initialization hook.
 */
contract ChessOnChainFactory is ETourFactory {

    address public immutable CHESS_RULES;

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address chessRules,
        address playerRegistry,
        address sessionRegistry
    ) ETourFactory(
        address(new ChessInstance()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry,
        sessionRegistry
    ) {
        require(chessRules != address(0), "CR");
        CHESS_RULES = chessRules;
    }

    function _gameType() internal pure override returns (uint8) {
        return 2;
    }

    function _postInitializeInstance(address instance) internal override {
        ChessInstance(instance).initializeChessRules(CHESS_RULES);
    }
}
