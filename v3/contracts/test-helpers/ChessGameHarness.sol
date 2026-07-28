// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ChessInstance} from "../ChessInstance.sol";

/**
 * @title ChessGameHarness
 * @author ETour
 * @notice Test-only harness for validating Chess bookkeeping across the shared
 * ETourGame reset/restart lifecycle.
 */
contract ChessGameHarness is ChessInstance {
    /// @notice Creates a match through the protected self-call bridge.
    /// @param roundNumber Round containing the match.
    /// @param matchNumber Match index within the round.
    /// @param player1 First test player.
    /// @param player2 Second test player.
    function createHarnessMatch(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) external {
        this._createMatchGame(
            roundNumber,
            matchNumber,
            player1,
            player2
        );
    }

    /// @notice Resets, repairs, and restarts a test match.
    /// @param matchId Canonical match identifier.
    /// @param player1 First test player.
    /// @param player2 Second test player.
    function resetAndRestartHarnessMatch(
        bytes32 matchId,
        address player1,
        address player2
    ) external {
        this._resetMatchGame(matchId);
        this._setMatchPlayer(matchId, 0, player1);
        this._setMatchPlayer(matchId, 1, player2);
        this._initializeMatchForPlay(matchId);
    }

    /// @notice Reads the Chess replay nonce for a test match.
    /// @param matchId Canonical match identifier.
    function gameNonce(bytes32 matchId) external view returns (uint256) {
        return _gameNonce[matchId];
    }

    /// @notice Reads the current initial-position repetition count.
    /// @param matchId Canonical match identifier.
    function initialPositionCount(bytes32 matchId)
        external
        view
        returns (uint8)
    {
        bytes32 positionHash = _computePositionHash(
            matches[matchId].packedBoard,
            matches[matchId].packedState,
            true,
            _gameNonce[matchId]
        );
        return _positionCounts[matchId][positionHash];
    }
}
