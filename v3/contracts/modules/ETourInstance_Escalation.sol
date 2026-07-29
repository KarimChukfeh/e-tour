// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IETourInstanceSelf} from "../interfaces/IETourInstanceSelf.sol";
import {ETourStorage} from "../storage/ETourStorage.sol";
import {ETourModuleGuard} from "./ETourModuleGuard.sol";

/**
 * @title ETourInstance_Escalation
 * @dev Stateless module for timeout tracking and escalation logic.
 *
 * Adapted from ETour_Escalation for single-instance storage:
 * - No tierId/instanceId parameters
 * - Match IDs: keccak256(roundNumber, matchNumber)
 * - TierConfig accessed via tierConfig (not _tierConfigs[tierId])
 * - Uses TournamentStatus.Concluded (not .Completed)
 *
 * DELEGATECALL SEMANTICS: Executes in instance contract's storage context.
 */
contract ETourInstance_Escalation is ETourStorage, ETourModuleGuard {
    /**
     * @notice Emitted when an escalation completes a match.
     * @param instance Tournament instance whose match completed.
     * @param roundNumber Round containing the completed match.
     * @param matchNumber Match index within the round.
     * @param winner Winner, or the zero address for double elimination.
     * @param isDraw Whether the completed match was a draw.
     * @param reason Match completion reason.
     * @param category Match completion category.
     */
    event MatchCompleted(
        address indexed instance,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason,
        MatchCompletionCategory category
    );

    function _getMatchId(uint8 roundNumber, uint8 matchNumber) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(roundNumber, matchNumber));
    }

    function _matchCompletionCategoryFor(MatchCompletionReason reason)
        internal
        pure
        returns (MatchCompletionCategory)
    {
        if (
            reason == MatchCompletionReason.ForceElimination ||
            reason == MatchCompletionReason.Replacement
        ) {
            return MatchCompletionCategory.Escalation;
        }
        return MatchCompletionCategory.MatchResult;
    }

    function _tournamentResolutionCategoryFor(TournamentResolutionReason reason)
        internal
        pure
        returns (TournamentResolutionCategory)
    {
        if (
            reason == TournamentResolutionReason.SoloEnrollCancelled ||
            reason == TournamentResolutionReason.AbandonedTournamentClaimed
        ) {
            return TournamentResolutionCategory.EnrollmentResolution;
        }
        if (reason == TournamentResolutionReason.Draw) {
            return TournamentResolutionCategory.DrawResolution;
        }
        if (
            reason == TournamentResolutionReason.ForceElimination ||
            reason == TournamentResolutionReason.Replacement
        ) {
            return TournamentResolutionCategory.Escalation;
        }
        return TournamentResolutionCategory.MatchResult;
    }

    function _setTournamentResolution(TournamentResolutionReason reason) internal {
        tournament.completionReason = reason;
        tournament.completionCategory = _tournamentResolutionCategoryFor(reason);
    }

    function _getPlayerRegistry() internal view returns (address reg) {
        (bool ok, bytes memory ret) = factory.staticcall(
            abi.encodeWithSignature("PLAYER_REGISTRY()")
        );
        if (ok && ret.length >= 32) {
            reg = abi.decode(ret, (address));
        }
    }

    function _recordPlayerMatchOutcome(
        address player,
        uint8 roundNumber,
        uint8 matchNumber,
        PlayerMatchOutcome outcome,
        PlayerMatchOutcomeCategory category
    ) internal {
        if (player == address(0) || outcome == PlayerMatchOutcome.None) return;

        address reg = _getPlayerRegistry();
        if (reg == address(0)) return;

        (bool recorded, ) = reg.call{gas: 150_000}(
            abi.encodeWithSignature(
                "recordMatchOutcome(address,address,uint8,uint8,uint8,uint8)",
                player,
                address(this),
                roundNumber,
                matchNumber,
                uint8(outcome),
                uint8(category)
            )
        );
        recorded;
    }

    function _recordEscalationMatchOutcomes(
        Match storage matchData,
        uint8 roundNumber,
        uint8 matchNumber,
        address actor,
        MatchCompletionReason reason
    ) internal {
        PlayerMatchOutcome victoryOutcome = reason == MatchCompletionReason.Replacement
            ? PlayerMatchOutcome.ReplacementVictory
            : PlayerMatchOutcome.ForceEliminationVictory;
        PlayerMatchOutcome defeatOutcome = reason == MatchCompletionReason.Replacement
            ? PlayerMatchOutcome.ReplacementDefeat
            : PlayerMatchOutcome.ForceEliminationDefeat;

        _recordPlayerMatchOutcome(
            matchData.player1,
            roundNumber,
            matchNumber,
            defeatOutcome,
            PlayerMatchOutcomeCategory.Defeat
        );
        _recordPlayerMatchOutcome(
            matchData.player2,
            roundNumber,
            matchNumber,
            defeatOutcome,
            PlayerMatchOutcomeCategory.Defeat
        );
        _recordPlayerMatchOutcome(
            actor,
            roundNumber,
            matchNumber,
            victoryOutcome,
            PlayerMatchOutcomeCategory.Victory
        );
    }

    // ============ Match Stalling ============

    /**
     * @dev Mark a match as stalled when timeout is claimable.
     * Called via delegatecall from ETourInstance_Base.claimTimeoutWin().
     * @param matchId The match id data.
     * @param timeoutOccurredAt The timeout occurred at value.
     */
    function markMatchStalled(bytes32 matchId, uint256 timeoutOccurredAt) external payable onlyDelegateCall {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            timeout.isStalled = true;
            uint256 baseTime = timeoutOccurredAt == 0 ? block.timestamp : timeoutOccurredAt;
            timeout.escalation1Start = baseTime + tierConfig.timeouts.matchLevel2Delay;
            timeout.escalation2Start = baseTime + tierConfig.timeouts.matchLevel3Delay;
            timeout.activeEscalation = EscalationLevel.None;
        }
    }

    function _markMatchStalled(bytes32 matchId, uint256 timeoutOccurredAt) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            timeout.isStalled = true;
            uint256 baseTime = timeoutOccurredAt == 0 ? block.timestamp : timeoutOccurredAt;
            timeout.escalation1Start = baseTime + tierConfig.timeouts.matchLevel2Delay;
            timeout.escalation2Start = baseTime + tierConfig.timeouts.matchLevel3Delay;
            timeout.activeEscalation = EscalationLevel.None;
        }
    }

    /**
     * @notice Clears the escalation state.
     * @param matchId The match id data.
     */
    function clearEscalationState(bytes32 matchId) external payable onlyDelegateCall {
        _clearEscalationState(matchId);
    }

    function _clearEscalationState(bytes32 matchId) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    function _checkAndMarkStalled(
        bytes32 matchId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal returns (bool) {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (timeout.isStalled) return true;
        if (!IETourInstanceSelf(address(this))._isMatchActive(matchId)) return false;

        CommonMatchData memory matchData =
            IETourInstanceSelf(address(this))._getActiveMatchData(
                matchId,
                roundNumber,
                matchNumber
            );
        if (matchData.status != MatchStatus.InProgress) return false;

        if (IETourInstanceSelf(address(this))._hasCurrentPlayerTimedOut(matchId)) {
            uint256 timeoutOccurredAt = matchData.lastMoveTime + tierConfig.timeouts.matchTimePerPlayer;
            _markMatchStalled(matchId, timeoutOccurredAt);
            return true;
        }
        return false;
    }

    // ============ Level 2 Escalation: Advanced player force-eliminates stalled match ============

    /**
     * @notice Force-eliminates a stalled match.
     * @param roundNumber The round number value.
     * @param matchNumber The match number value.
     */
    function forceEliminateStalledMatch(uint8 roundNumber, uint8 matchNumber) external {
        require(tournament.status == TournamentStatus.InProgress, "Tournament not in progress");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        _checkAndMarkStalled(matchId, roundNumber, matchNumber);

        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation1Start, "Level 2 not active yet");

        bool isAdvanced = _isPlayerInAdvancedRoundInternal(roundNumber, msg.sender);
        require(isAdvanced, "Not an advanced player");

        timeout.activeEscalation = EscalationLevel.Escalation2_AdvancedPlayers;
        _completeMatchDoubleEliminationInternal(roundNumber, matchNumber);
    }

    // ============ Level 3 Escalation: External player replaces stalled players ============

    /**
     * @notice Claims a match slot as a replacement player.
     * @param roundNumber The round number value.
     * @param matchNumber The match number value.
     */
    function claimMatchSlotByReplacement(uint8 roundNumber, uint8 matchNumber) external {
        require(tournament.status == TournamentStatus.InProgress, "Tournament not in progress");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        _checkAndMarkStalled(matchId, roundNumber, matchNumber);

        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation2Start, "Level 3 not active yet");

        bool isAdvanced = _isPlayerInAdvancedRoundInternal(roundNumber, msg.sender);
        require(!isAdvanced, "Advanced players cannot claim L3");

        bool inActiveMatch = _isPlayerInActiveMatch(msg.sender);
        require(!inActiveMatch, "Cannot claim while in active match");

        timeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;
        _completeMatchByReplacementInternal(roundNumber, matchNumber, msg.sender);
    }

    // ============ Match Completion Internals ============

    function _completeMatchDoubleEliminationInternal(uint8 roundNumber, uint8 matchNumber) internal {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        IETourInstanceSelf(address(this))._completeMatchWithResult(
            matchId,
            address(0),
            false
        );
        matchData.completionReason = MatchCompletionReason.ForceElimination;
        matchData.completionCategory = _matchCompletionCategoryFor(MatchCompletionReason.ForceElimination);

        Round storage round = rounds[roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            _handleRoundCompletion(roundNumber, MatchCompletionReason.ForceElimination);
        }

        _recordEscalationMatchOutcomes(
            matchData,
            roundNumber,
            matchNumber,
            msg.sender,
            MatchCompletionReason.ForceElimination
        );

        emit MatchCompleted(
            address(this),
            roundNumber,
            matchNumber,
            address(0),
            false,
            matchData.completionReason,
            matchData.completionCategory
        );

        _clearEscalationState(matchId);
    }

    function _completeMatchByReplacementInternal(
        uint8 roundNumber,
        uint8 matchNumber,
        address replacementPlayer
    ) internal {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        IETourInstanceSelf(address(this))._completeMatchWithResult(
            matchId,
            replacementPlayer,
            false
        );
        matchData.completionReason = MatchCompletionReason.Replacement;
        matchData.completionCategory = _matchCompletionCategoryFor(MatchCompletionReason.Replacement);

        // Add replacement player to tournament if not already enrolled
        if (!isEnrolled[replacementPlayer]) {
            enrolledPlayers.push(replacementPlayer);
            isEnrolled[replacementPlayer] = true;
            tournament.enrolledCount++;
        }

        if (roundNumber < tournament.actualTotalRounds - 1) {
            _advanceWinnerToNextRound(roundNumber, matchNumber, replacementPlayer);
        }

        Round storage round = rounds[roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            _handleRoundCompletion(roundNumber, MatchCompletionReason.Replacement);
        }

        _recordEscalationMatchOutcomes(
            matchData,
            roundNumber,
            matchNumber,
            replacementPlayer,
            MatchCompletionReason.Replacement
        );

        emit MatchCompleted(
            address(this),
            roundNumber,
            matchNumber,
            replacementPlayer,
            false,
            matchData.completionReason,
            matchData.completionCategory
        );

        _clearEscalationState(matchId);
    }

    function _advanceWinnerToNextRound(uint8 currentRound, uint8 currentMatchNum, address winner) internal {
        uint8 nextRound = currentRound + 1;
        uint8 nextMatchNum = currentMatchNum / 2;

        Round storage nextRoundStruct = rounds[nextRound];
        if (!nextRoundStruct.initialized) {
            uint8 nextRoundMatches = tierConfig.playerCount / uint8(2 ** (nextRound + 1));
            nextRoundStruct.initialized = true;
            nextRoundStruct.totalMatches = nextRoundMatches;
            nextRoundStruct.completedMatches = 0;
        }

        bytes32 nextMatchId = _getMatchId(nextRound, nextMatchNum);
        uint8 slot = currentMatchNum % 2;
        IETourInstanceSelf(address(this))._setMatchPlayer(nextMatchId, slot, winner);

        (address p1, address p2) =
            IETourInstanceSelf(address(this))._getMatchPlayers(nextMatchId);
        if (p1 != address(0) && p2 != address(0)) {
            IETourInstanceSelf(address(this))._initializeMatchForPlay(nextMatchId);
        }
    }

    function _materializeEscalationFinalMatch(
        uint8 finalRound,
        address winner,
        MatchCompletionReason reason
    ) internal {
        if (winner == address(0)) return;

        Round storage finalRoundStruct = rounds[finalRound];
        if (!finalRoundStruct.initialized) {
            finalRoundStruct.initialized = true;
            finalRoundStruct.totalMatches = 1;
            finalRoundStruct.completedMatches = 0;
            finalRoundStruct.drawCount = 0;
            finalRoundStruct.playerCount = 1;
        } else if (finalRoundStruct.totalMatches == 0) {
            finalRoundStruct.totalMatches = 1;
        }

        bytes32 finalMatchId = _getMatchId(finalRound, 0);
        Match storage finalMatch = matches[finalMatchId];

        if (finalMatch.player1 == address(0) && finalMatch.player2 == address(0)) {
            finalMatch.player1 = winner;
        }

        if (
            finalMatch.status == MatchStatus.Completed &&
            finalMatch.winner == winner &&
            finalMatch.completionReason == reason
        ) {
            finalRoundStruct.completedMatches = finalRoundStruct.totalMatches;
            return;
        }

        finalMatch.winner = winner;
        finalMatch.isDraw = false;
        finalMatch.status = MatchStatus.Completed;
        finalMatch.completionReason = reason;
        finalMatch.completionCategory = _matchCompletionCategoryFor(reason);

        finalRoundStruct.completedMatches = finalRoundStruct.totalMatches;

        emit MatchCompleted(
            address(this),
            finalRound,
            0,
            winner,
            false,
            finalMatch.completionReason,
            finalMatch.completionCategory
        );
    }

    function _handleRoundCompletion(uint8 roundNumber, MatchCompletionReason resolutionReason) internal {
        Round storage round = rounds[roundNumber];
        TournamentState storage t = tournament;

        if (roundNumber == t.actualTotalRounds - 1) {
            bytes32 finalsMatchId = _getMatchId(roundNumber, 0);
            (address winner, bool isDraw, ) =
                IETourInstanceSelf(address(this))._getMatchResult(finalsMatchId);
            if (!isDraw && winner != address(0)) {
                t.winner = winner;
                t.status = TournamentStatus.Concluded;
                _setTournamentResolution(TournamentResolutionReason.Replacement);
            } else if (isDraw) {
                t.finalsWasDraw = true;
                t.status = TournamentStatus.Concluded;
                _setTournamentResolution(TournamentResolutionReason.Draw);
            } else {
                t.status = TournamentStatus.Concluded;
                t.allDrawResolution = true;
                t.allDrawRound = roundNumber;
                t.winner = address(0);
                _setTournamentResolution(TournamentResolutionReason.ForceElimination);
            }
        } else {
            uint8 winnersCount = 0;
            address lastWinner = address(0);
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(roundNumber, m);
                (address winner, bool isDraw, MatchStatus status) =
                    IETourInstanceSelf(address(this))._getMatchResult(matchId);
                if (status == MatchStatus.Completed && !isDraw && winner != address(0)) {
                    winnersCount++;
                    lastWinner = winner;
                }
            }

            uint8 nextRound = roundNumber + 1;
            Round storage nextRoundStruct = rounds[nextRound];
            uint8 playersInNextRound = 0;
            address solePlayerInNextRound = address(0);
            if (nextRoundStruct.initialized) {
                for (uint8 m = 0; m < nextRoundStruct.totalMatches; m++) {
                    bytes32 nextMatchId = _getMatchId(nextRound, m);
                    (address p1, address p2) =
                        IETourInstanceSelf(address(this))._getMatchPlayers(nextMatchId);
                    if (p1 != address(0)) { playersInNextRound++; solePlayerInNextRound = p1; }
                    if (p2 != address(0)) { playersInNextRound++; solePlayerInNextRound = p2; }
                }
                if (nextRoundStruct.playerCount % 2 == 1) {
                    bytes32 byeMatchId = _getMatchId(nextRound, nextRoundStruct.totalMatches);
                    (address byeP1, address byeP2) =
                        IETourInstanceSelf(address(this))._getMatchPlayers(byeMatchId);
                    if (byeP1 != address(0)) { playersInNextRound++; solePlayerInNextRound = byeP1; }
                    if (byeP2 != address(0)) { playersInNextRound++; solePlayerInNextRound = byeP2; }
                }
            }

            if ((playersInNextRound == 1 && solePlayerInNextRound != address(0)) ||
                (winnersCount == 1 && playersInNextRound == 0 && lastWinner != address(0))) {
                address champion = playersInNextRound == 1 ? solePlayerInNextRound : lastWinner;
                if (nextRound == t.actualTotalRounds - 1) {
                    _materializeEscalationFinalMatch(nextRound, champion, resolutionReason);
                }
                t.winner = champion;
                t.status = TournamentStatus.Concluded;
                _setTournamentResolution(
                    resolutionReason == MatchCompletionReason.ForceElimination
                        ? TournamentResolutionReason.ForceElimination
                        : TournamentResolutionReason.Replacement
                );
            }
        }
    }

    // ============ Player Status Helpers ============

    function _isPlayerInAdvancedRoundInternal(uint8 stalledRoundNumber, address player) internal view returns (bool) {
        if (!isEnrolled[player]) return false;

        for (uint8 r = 0; r <= stalledRoundNumber; r++) {
            Round storage round = rounds[r];
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                (address winner, bool isDraw, MatchStatus status) =
                    IETourInstanceSelf(address(this))._getMatchResult(matchId);
                if (status == MatchStatus.Completed && winner == player && !isDraw) return true;
            }
        }

        for (uint8 r = stalledRoundNumber + 1; r < tierConfig.totalRounds; r++) {
            Round storage round = rounds[r];
            if (!round.initialized) continue;
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                (address p1, address p2) =
                    IETourInstanceSelf(address(this))._getMatchPlayers(matchId);
                if (p1 == player || p2 == player) return true;
            }
        }
        return false;
    }

    function _isPlayerInActiveMatch(address player) internal view returns (bool) {
        for (uint8 r = 0; r < tierConfig.totalRounds; r++) {
            Round storage round = rounds[r];
            if (!round.initialized) continue;
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                (address p1, address p2) =
                    IETourInstanceSelf(address(this))._getMatchPlayers(matchId);
                if (p1 == player || p2 == player) {
                    (, , MatchStatus status) =
                        IETourInstanceSelf(address(this))._getMatchResult(matchId);
                    if (status == MatchStatus.InProgress) return true;
                }
            }
        }
        return false;
    }
}
