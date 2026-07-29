// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ETourStorage} from "../storage/ETourStorage.sol";

/**
 * @title IETourInstanceSelf
 * @author ETour
 * @notice Explicit host surface used by delegatecall modules for instance
 * self-calls. State-changing implementations must enforce `onlySelfCall`.
 */
interface IETourInstanceSelf {
    /// @notice Initializes one tournament round.
    /// @param roundNumber Round to initialize.
    function initializeRound(uint8 roundNumber) external payable;

    /// @notice Creates game state for a newly paired match.
    /// @param roundNumber Round containing the match.
    /// @param matchNumber Match index within the round.
    /// @param player1 First paired primary player.
    /// @param player2 Second paired primary player.
    function _createMatchGame(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) external;

    /// @notice Clears game state for a match being rebuilt.
    /// @param matchId Canonical match identifier.
    function _resetMatchGame(bytes32 matchId) external;

    /// @notice Reads the canonical result of a match.
    /// @param matchId Canonical match identifier.
    /// @return winner Recorded winner.
    /// @return isDraw Whether the match ended in a draw.
    /// @return status Current match status.
    function _getMatchResult(bytes32 matchId)
        external
        view
        returns (address winner, bool isDraw, ETourStorage.MatchStatus status);

    /// @notice Reads the two primary players assigned to a match.
    /// @param matchId Canonical match identifier.
    /// @return player1 First assigned primary player.
    /// @return player2 Second assigned primary player.
    function _getMatchPlayers(bytes32 matchId)
        external
        view
        returns (address player1, address player2);

    /// @notice Assigns one primary player to a match slot.
    /// @param matchId Canonical match identifier.
    /// @param slot Player slot, where zero is player one and one is player two.
    /// @param player Primary player to assign.
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) external;

    /// @notice Initializes an already paired match for play.
    /// @param matchId Canonical match identifier.
    function _initializeMatchForPlay(bytes32 matchId) external;

    /// @notice Completes a match with the supplied canonical result.
    /// @param matchId Canonical match identifier.
    /// @param winner Primary player that won, or the zero address.
    /// @param isDraw Whether the result is a draw.
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) external;

    /// @notice Reads the configured Fischer increment.
    /// @return The requested value.
    function _getTimeIncrement() external view returns (uint256);

    /// @notice Reports whether the current player has exhausted their clock.
    /// @param matchId Canonical match identifier.
    /// @return The requested value.
    function _hasCurrentPlayerTimedOut(bytes32 matchId) external view returns (bool);

    /// @notice Reports whether a match is active.
    /// @param matchId Canonical match identifier.
    /// @return The requested value.
    function _isMatchActive(bytes32 matchId) external view returns (bool);

    /// @notice Reads common active-match state used by infrastructure modules.
    /// @param matchId Canonical match identifier.
    /// @param roundNumber Round containing the match.
    /// @param matchNumber Match index within the round.
    /// @return The requested value.
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (ETourStorage.CommonMatchData memory);
}
