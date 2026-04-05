// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ChessInstance.sol";

/**
 * @title ChessOnChainFactory
 * @dev Factory contract for Chess tournament instances.
 *
 * Uses the ETourFactory post-initialization hook to configure CHESS_RULES on
 * each newly deployed ChessInstance clone.
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

    function _postInitializeInstance(
        address instance,
        ETourInstance_Base.TierConfig memory,
        address
    ) internal override {
        ChessInstance(instance).setChessRules(CHESS_RULES);
    }
}
