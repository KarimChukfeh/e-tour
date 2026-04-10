// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourInstance.sol";

/**
 * @title ETourGame
 * @dev Shared V2 game template for concrete game implementations.
 *
 * Concrete games are expected to implement the narrow hook surface:
 * - _playerAssignmentMode()
 * - _initializeGameState()
 * - _resetGameState() when auxiliary mappings need cleanup
 * - makeMove(...)
 *
 * The module bridge functions remain externally callable because the matches
 * and escalation modules invoke them via this.<fn>() while executing under
 * delegatecall, but only the instance itself may reach them.
 */
abstract contract ETourGame is ETourInstance {

    enum PlayerAssignmentMode {
        RandomizeStarterOnly,
        RandomizePlayerOrder
    }

    function moduleCreateMatch(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public virtual override onlySelfCall {
        require(player1 != player2, "IP");
        require(player1 != address(0) && player2 != address(0), "IP");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        _assignPlayersForMatch(
            m,
            ENTROPY_MATCH_CREATE,
            keccak256(abi.encodePacked(roundNumber, matchNumber, player1, player2)),
            player1,
            player2
        );
        _startFreshMatch(matchId, false);
    }

    function moduleResetMatch(bytes32 matchId) public virtual override onlySelfCall {
        Match storage m = matches[matchId];
        m.player1 = address(0);
        m.player2 = address(0);
        m.winner = address(0);
        m.currentTurn = address(0);
        m.firstPlayer = address(0);
        m.status = MatchStatus.NotStarted;
        m.isDraw = false;
        m.packedBoard = 0;
        m.packedState = 0;
        m.startTime = 0;
        m.lastMoveTime = 0;
        m.player1TimeRemaining = 0;
        m.player2TimeRemaining = 0;
        m.moves = "";
        m.completionReason = MatchCompletionReason.NormalWin;
        m.completionCategory = MatchCompletionCategory.None;
        _resetGameState(matchId);
    }

    function moduleInitializeMatchForPlay(bytes32 matchId) public virtual override onlySelfCall {
        Match storage m = matches[matchId];
        _assignPlayersForMatch(
            m,
            ENTROPY_MATCH_RESTART,
            keccak256(abi.encodePacked(matchId, m.player1, m.player2)),
            m.player1,
            m.player2
        );
        _startFreshMatch(matchId, true);
    }

    function _startFreshMatch(bytes32 matchId, bool isReplay) internal {
        Match storage m = matches[matchId];
        m.status = MatchStatus.InProgress;
        m.winner = address(0);
        m.isDraw = false;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.packedBoard = 0;
        m.packedState = 0;
        m.moves = "";
        m.completionReason = MatchCompletionReason.NormalWin;
        m.completionCategory = MatchCompletionCategory.None;
        _clearMatchEscalation(matchId);
        _initializeGameState(matchId, isReplay);
    }

    function _assignPlayersForMatch(
        Match storage m,
        bytes32 domain,
        bytes32 salt,
        address player1,
        address player2
    ) internal {
        if (_playerAssignmentMode() == PlayerAssignmentMode.RandomizePlayerOrder) {
            (m.player1, m.player2) = _drawRandomizedPlayerOrder(domain, salt, player1, player2);
            m.currentTurn = m.player1;
            m.firstPlayer = m.player1;
            return;
        }

        m.player1 = player1;
        m.player2 = player2;
        m.currentTurn = _drawRandomStarter(domain, salt, player1, player2);
        m.firstPlayer = m.currentTurn;
    }

    function _consumeTurnClock(Match storage m) internal {
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        uint256 increment = tierConfig.timeouts.timeIncrementPerMove;
        if (m.currentTurn == m.player1) {
            m.player1TimeRemaining = (m.player1TimeRemaining > elapsed)
                ? m.player1TimeRemaining - elapsed + increment
                : increment;
        } else {
            m.player2TimeRemaining = (m.player2TimeRemaining > elapsed)
                ? m.player2TimeRemaining - elapsed + increment
                : increment;
        }
        m.lastMoveTime = block.timestamp;
    }

    function _clearMatchEscalation(bytes32 matchId) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    function _switchTurn(Match storage m) internal {
        m.currentTurn = (m.currentTurn == m.player1) ? m.player2 : m.player1;
    }

    /**
     * @dev Controls whether a game randomizes only the starter or the full
     * player seat assignment when a match is created/replayed.
     */
    function _playerAssignmentMode() internal pure virtual returns (PlayerAssignmentMode);

    /**
     * @dev Initialize the game-owned portion of match state.
     * `isReplay` is true when the same players are being restarted into a fresh
     * match after bracket advancement logic has already assigned the seats.
     */
    function _initializeGameState(bytes32 matchId, bool isReplay) internal virtual;

    /**
     * @dev Reset any auxiliary game-owned storage outside the base Match struct.
     * Override this when a game uses extra mappings keyed by matchId.
     */
    function _resetGameState(bytes32 matchId) internal virtual {
        matchId;
    }
}
