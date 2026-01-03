// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";

/**
 * @title IETourGame
 * @dev Interface for game-specific abstract functions
 *
 * Modules use this interface to call game contract's implementations
 * when executing via delegatecall. The interface provides type-safe
 * access to game-specific logic.
 *
 * All game contracts (TicTacChain, ChessOnChain, ConnectFourOnChain)
 * must implement these functions.
 */
interface IETourGame {

    /**
     * @dev Create a new match in game-specific storage
     * @param tierId Tournament tier
     * @param instanceId Instance within tier
     * @param roundNumber Round number
     * @param matchNumber Match number within round
     * @param player1 First player address
     * @param player2 Second player address
     */
    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) external;

    /**
     * @dev Reset match game state
     * @param matchId Match identifier
     */
    function _resetMatchGame(bytes32 matchId) external;

    /**
     * @dev Get match result from game-specific storage
     * @param matchId Match identifier
     * @return winner Winner address (address(0) if no winner yet)
     * @return isDraw True if match ended in draw
     * @return status Match status (NotStarted, InProgress, Completed)
     */
    function _getMatchResult(bytes32 matchId) external view returns (
        address winner,
        bool isDraw,
        ETour_Storage.MatchStatus status
    );

    /**
     * @dev Add match to game-specific cache for historical preservation
     * @param tierId Tournament tier
     * @param instanceId Instance within tier
     * @param roundNumber Round number
     * @param matchNumber Match number within round
     */
    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external;

    /**
     * @dev Get match players from game-specific storage
     * @param matchId Match identifier
     * @return player1 First player address
     * @return player2 Second player address
     */
    function _getMatchPlayers(bytes32 matchId) external view returns (
        address player1,
        address player2
    );

    /**
     * @dev Set player in match slot (used for player replacement)
     * @param matchId Match identifier
     * @param slot Player slot (0 or 1)
     * @param player Player address to set
     */
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) external;

    /**
     * @dev Initialize match for play after players are assigned
     * @param matchId Match identifier
     * @param tierId Tournament tier (for time control configuration)
     */
    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) external;

    /**
     * @dev Complete match with result
     * @param matchId Match identifier
     * @param winner Winner address (address(0) for draw)
     * @param isDraw True if match ended in draw
     */
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) external;

    /**
     * @dev Get time increment per move (Fischer increment)
     * @return Time increment in seconds
     */
    function _getTimeIncrement() external view returns (uint256);

    /**
     * @dev Check if current player has timed out
     * @param matchId Match identifier
     * @return True if current player has run out of time
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) external view returns (bool);

    /**
     * @dev Check if match is active in game-specific storage
     * @param matchId Match identifier
     * @return True if match exists and is not completed/cancelled
     */
    function _isMatchActive(bytes32 matchId) external view returns (bool);

    /**
     * @dev Get active match data from game-specific storage
     * @param matchId Match identifier
     * @param tierId Tournament tier
     * @param instanceId Instance within tier
     * @param roundNumber Round number
     * @param matchNumber Match number within round
     * @return Common match data with isCached = false
     */
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (ETour_Storage.CommonMatchData memory);

    /**
     * @dev Get match data from game-specific cache
     * @param matchId Match identifier
     * @param tierId Tournament tier
     * @param instanceId Instance within tier
     * @param roundNumber Round number
     * @param matchNumber Match number within round
     * @return data Common match data with isCached = true
     * @return exists False if not in cache or context doesn't match
     */
    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external returns (ETour_Storage.CommonMatchData memory data, bool exists);
}
