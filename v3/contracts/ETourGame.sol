// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ETourInstance} from "./ETourInstance.sol";
import {ISessionKeyRegistry} from "./interfaces/ISessionKeyRegistry.sol";

/* solhint-disable gas-custom-errors, gas-small-strings, gas-strict-inequalities, function-max-lines */

/**
 * @title ETourGame
 * @author ETour
 * @notice Canonical tournament-game lifecycle shared by every concrete game.
 *
 * Concrete games own board representation, legal-move validation, mutation,
 * terminal-state detection, move-history encoding, and game-specific reset
 * bookkeeping. This abstraction owns the module bridge, match lifecycle,
 * Fischer clock, gameplay-actor validation, escalation clearing, and match
 * completion boundary.
 */
abstract contract ETourGame is ETourInstance {
    // ============ Protected module bridges ============

    /// @notice Initializes one tournament round through the matches module.
    /// @param roundNumber Round to initialize.
    function initializeRound(uint8 roundNumber)
        public
        payable
        override
        onlySelfCall
    {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("initializeRound(uint8)", roundNumber)
        );
        require(success, "IR");
    }

    /// @notice Creates and initializes a newly paired match.
    /// @param roundNumber Round containing the match.
    /// @param matchNumber Match index within the round.
    /// @param player1 First paired primary player.
    /// @param player2 Second paired primary player.
    function _createMatchGame(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public override onlySelfCall {
        require(
            player1 != player2 &&
                player1 != address(0) &&
                player2 != address(0),
            "IP"
        );

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        _assignPlayersAndStarter(
            matchData,
            player1,
            player2,
            ENTROPY_MATCH_CREATE,
            keccak256(
                abi.encodePacked(
                    roundNumber,
                    matchNumber,
                    player1,
                    player2
                )
            )
        );
        _initializeCommonMatch(matchId, matchData);
        _afterMatchInitialized(matchId, false);
    }

    /// @notice Clears all common and game-specific match state.
    /// @param matchId Canonical match identifier.
    function _resetMatchGame(bytes32 matchId)
        public
        override
        onlySelfCall
    {
        Match storage matchData = matches[matchId];
        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.winner = address(0);
        matchData.currentTurn = address(0);
        matchData.firstPlayer = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.isDraw = false;
        matchData.packedBoard = 0;
        matchData.packedState = 0;
        matchData.startTime = 0;
        matchData.lastMoveTime = 0;
        matchData.player1TimeRemaining = 0;
        matchData.player2TimeRemaining = 0;
        matchData.moves = "";
        matchData.completionReason = MatchCompletionReason.NormalWin;
        matchData.completionCategory = MatchCompletionCategory.None;
        _afterMatchReset(matchId);
    }

    /// @notice Reads a match's canonical result.
    /// @param matchId Canonical match identifier.
    /// @return winner Recorded winner.
    /// @return isDraw Whether the match ended in a draw.
    /// @return status Current match status.
    function _getMatchResult(bytes32 matchId)
        public
        view
        override
        returns (address winner, bool isDraw, MatchStatus status)
    {
        Match storage matchData = matches[matchId];
        return (
            matchData.winner,
            matchData.isDraw,
            matchData.status
        );
    }

    /// @notice Reads the primary players assigned to a match.
    /// @param matchId Canonical match identifier.
    /// @return player1 First assigned primary player.
    /// @return player2 Second assigned primary player.
    function _getMatchPlayers(bytes32 matchId)
        public
        view
        override
        returns (address player1, address player2)
    {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    /// @notice Assigns a primary player to one bracket slot.
    /// @param matchId Canonical match identifier.
    /// @param slot Slot zero for player one, otherwise player two.
    /// @param player Primary player to assign.
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player)
        public
        override
        onlySelfCall
    {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    /// @notice Initializes an already paired match for play or replay.
    /// @param matchId Canonical match identifier.
    function _initializeMatchForPlay(bytes32 matchId)
        public
        override
        onlySelfCall
    {
        Match storage matchData = matches[matchId];
        address player1 = matchData.player1;
        address player2 = matchData.player2;
        _assignPlayersAndStarter(
            matchData,
            player1,
            player2,
            ENTROPY_MATCH_RESTART,
            keccak256(abi.encodePacked(matchId, player1, player2))
        );
        _initializeCommonMatch(matchId, matchData);
        _afterMatchInitialized(matchId, true);
    }

    /// @notice Stores a canonical match result for an infrastructure module.
    /// @param matchId Canonical match identifier.
    /// @param winner Primary player that won, or the zero address.
    /// @param isDraw Whether the result is a draw.
    function _completeMatchWithResult(
        bytes32 matchId,
        address winner,
        bool isDraw
    ) public override onlySelfCall {
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = isDraw ? address(0) : winner;
        matchData.isDraw = isDraw;
    }

    /// @notice Reads the configured Fischer increment.
    /// @return The requested value.
    function _getTimeIncrement()
        public
        view
        override
        returns (uint256)
    {
        return tierConfig.timeouts.timeIncrementPerMove;
    }

    /// @notice Reports whether the current player exhausted their clock.
    /// @param matchId Canonical match identifier.
    /// @return The requested value.
    function _hasCurrentPlayerTimedOut(bytes32 matchId)
        public
        view
        override
        returns (bool)
    {
        Match storage matchData = matches[matchId];
        if (matchData.status != MatchStatus.InProgress) return false;
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = matchData.currentTurn == matchData.player1
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;
        return elapsed >= currentPlayerTime;
    }

    /// @notice Reports whether a match remains active.
    /// @param matchId Canonical match identifier.
    /// @return The requested value.
    function _isMatchActive(bytes32 matchId)
        public
        view
        override
        returns (bool)
    {
        Match storage matchData = matches[matchId];
        return
            matchData.player1 != address(0) &&
            matchData.status != MatchStatus.Completed;
    }

    /// @notice Reads common match state used by infrastructure modules.
    /// @param matchId Canonical match identifier.
    /// @param roundNumber Round containing the match.
    /// @param matchNumber Match index within the round.
    /// @return The requested value.
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view override returns (CommonMatchData memory) {
        Match storage matchData = matches[matchId];
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = matchData.winner == matchData.player1
                ? matchData.player2
                : matchData.player1;
        }
        return
            CommonMatchData({
                player1: matchData.player1,
                player2: matchData.player2,
                winner: matchData.winner,
                loser: loser,
                status: matchData.status,
                isDraw: matchData.isDraw,
                startTime: matchData.startTime,
                lastMoveTime: matchData.lastMoveTime,
                roundNumber: roundNumber,
                matchNumber: matchNumber,
                isCached: false
            });
    }

    // ============ Shared move boundary ============

    /**
     * @notice Resolves an executor to the primary identity it would use for a
     * move. Enrolled wallets resolve directly; inactive executors resolve to
     * zero. Full session metadata remains available from SESSION_REGISTRY.
     * @param executor Wallet or temporary gameplay executor to inspect.
     * @return player Direct or delegated primary identity, or zero.
     */
    function resolveGameplayPlayer(address executor)
        public
        view
        returns (address player)
    {
        if (isEnrolled[executor]) return executor;
        (player, , ) = ISessionKeyRegistry(SESSION_REGISTRY).resolveSession(
            address(this),
            executor
        );
    }

    function _requireCurrentGameplayPlayer(Match storage matchData)
        internal
        view
        returns (address player, address executor)
    {
        require(matchData.status == MatchStatus.InProgress, "MA");
        executor = msg.sender;
        player = resolveGameplayPlayer(executor);
        require(
            isEnrolled[player] &&
                (player == matchData.player1 || player == matchData.player2),
            "NP"
        );
        require(player == matchData.currentTurn, "NT");
    }

    function _accountForMove(
        bytes32 matchId,
        Match storage matchData,
        address player
    ) internal {
        uint256 increment = tierConfig.timeouts.timeIncrementPerMove;
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        if (player == matchData.player1) {
            matchData.player1TimeRemaining =
                matchData.player1TimeRemaining > elapsed
                    ? matchData.player1TimeRemaining - elapsed + increment
                    : increment;
        } else {
            matchData.player2TimeRemaining =
                matchData.player2TimeRemaining > elapsed
                    ? matchData.player2TimeRemaining - elapsed + increment
                    : increment;
        }
        matchData.lastMoveTime = block.timestamp;
        _clearMatchEscalation(matchId);
    }

    function _clearMatchEscalation(bytes32 matchId) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    // ============ Shared completion ============

    function _completeMatchInternal(
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason
    ) internal override {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.winner = isDraw ? address(0) : winner;
        matchData.isDraw = isDraw;
        matchData.status = MatchStatus.Completed;
        matchData.completionReason = reason;
        matchData.completionCategory = _matchCompletionCategoryFor(reason);
        _clearMatchEscalation(matchId);

        _mixEntropy(
            ENTROPY_MATCH_RESULT,
            keccak256(
                abi.encodePacked(
                    roundNumber,
                    matchNumber,
                    matchData.player1,
                    matchData.player2,
                    winner,
                    isDraw,
                    uint8(reason),
                    _gameStateHash(matchId),
                    matchData.startTime,
                    matchData.lastMoveTime
                )
            )
        );

        // solhint-disable-next-line avoid-low-level-calls
        (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature(
                "completeMatch(uint8,uint8,address,bool,uint8)",
                roundNumber,
                matchNumber,
                winner,
                isDraw,
                uint8(reason)
            )
        );
        require(completeSuccess, "CM");

        _recordStandardMatchOutcomes(
            matchData,
            roundNumber,
            matchNumber,
            winner,
            isDraw,
            reason
        );

        emit MatchCompleted(
            address(this),
            roundNumber,
            matchNumber,
            winner,
            isDraw,
            matchData.completionReason,
            matchData.completionCategory
        );

        _handleTournamentConclusion();
    }

    // ============ Common match initialization ============

    function _assignPlayersAndStarter(
        Match storage matchData,
        address player1,
        address player2,
        bytes32 entropyDomain,
        bytes32 entropySalt
    ) private {
        if (_randomizesPlayerOrder()) {
            (matchData.player1, matchData.player2) = _drawRandomizedPlayerOrder(
                entropyDomain,
                entropySalt,
                player1,
                player2
            );
            matchData.currentTurn = matchData.player1;
        } else {
            matchData.player1 = player1;
            matchData.player2 = player2;
            matchData.currentTurn = _drawRandomStarter(
                entropyDomain,
                entropySalt,
                player1,
                player2
            );
        }
        matchData.firstPlayer = matchData.currentTurn;
    }

    function _initializeCommonMatch(
        bytes32 matchId,
        Match storage matchData
    ) private {
        (uint256 board, uint256 state) = _initialGameState(matchId);
        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.lastMoveTime = block.timestamp;
        matchData.winner = address(0);
        matchData.isDraw = false;
        matchData.packedBoard = board;
        matchData.packedState = state;
        matchData.moves = "";
        matchData.player1TimeRemaining = tierConfig
            .timeouts
            .matchTimePerPlayer;
        matchData.player2TimeRemaining = tierConfig
            .timeouts
            .matchTimePerPlayer;
    }

    // ============ Concrete-game hook surface ============

    /// @dev Whether colors/sides are assigned by randomizing player slots.
    function _randomizesPlayerOrder() internal pure virtual returns (bool);

    /// @dev Returns the initial packed board and auxiliary state.
    function _initialGameState(bytes32 matchId)
        internal
        view
        virtual
        returns (uint256 board, uint256 state);

    /// @dev Hashes only game-owned state for tournament entropy mixing.
    function _gameStateHash(bytes32 matchId)
        internal
        view
        virtual
        returns (bytes32);

    /// @dev Optional hook for game bookkeeping after reset.
    function _afterMatchReset(bytes32 matchId) internal virtual {
        matchId;
    }

    /// @dev Optional hook after common initialization or replay initialization.
    function _afterMatchInitialized(
        bytes32 matchId,
        bool isRestart
    ) internal virtual {
        matchId;
        isRestart;
    }
}
