// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./Chess.sol";

/**
 * @title ChessFactory
 * @dev Factory contract for Chess tournament instances.
 *
 * Uses the ETourFactory post-initialization hook to configure CHESS_RULES on
 * each newly deployed Chess clone.
 */
contract ChessFactory is ETourFactory {

    address public immutable CHESS_RULES;

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address chessRules,
        address playerRegistry
    ) ETourFactory(
        address(new Chess()),
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
        ETourTournamentBase.TierConfig memory,
        address
    ) internal override {
        Chess(instance).setChessRules(CHESS_RULES);
    }
}
