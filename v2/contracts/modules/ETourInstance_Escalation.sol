// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourInstance_Base.sol";

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
contract ETourInstance_Escalation is ETourInstance_Base {

    constructor() {}

    // ============ Abstract Stubs ============

    function moduleCreateMatch(uint8, uint8, address, address) public override { revert("Module stub"); }
    function moduleResetMatch(bytes32) public override { revert("Module stub"); }
    function moduleInitializeMatchForPlay(bytes32) public override { revert("Module stub"); }
    function initializeRound(uint8) public payable override { revert("Module stub"); }

    // ============ Match Stalling ============

    /**
     * @dev Mark a match as stalled when timeout is claimable.
     * Called via delegatecall from ETourInstance_Base.claimTimeoutWin().
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
        if (!this.moduleIsMatchActive(matchId)) return false;

        CommonMatchData memory matchData = this.moduleGetActiveMatchData(matchId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) return false;

        if (this.moduleHasCurrentPlayerTimedOut(matchId)) {
            uint256 timeoutOccurredAt = matchData.lastMoveTime + tierConfig.timeouts.matchTimePerPlayer;
            _markMatchStalled(matchId, timeoutOccurredAt);
            return true;
        }
        return false;
    }

    // ============ Level 2 Escalation: Advanced player force-eliminates stalled match ============

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

        this.moduleCompleteMatchWithResult(matchId, address(0), false);
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

        this.moduleCompleteMatchWithResult(matchId, replacementPlayer, false);
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
        this.moduleSetMatchPlayer(nextMatchId, slot, winner);

        (address p1, address p2) = this.moduleGetMatchPlayers(nextMatchId);
        if (p1 != address(0) && p2 != address(0)) {
            this.moduleInitializeMatchForPlay(nextMatchId);
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
            (address winner, bool isDraw, ) = this.moduleGetMatchResult(finalsMatchId);
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
                (address winner, bool isDraw, MatchStatus status) = this.moduleGetMatchResult(matchId);
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
                    (address p1, address p2) = this.moduleGetMatchPlayers(nextMatchId);
                    if (p1 != address(0)) { playersInNextRound++; solePlayerInNextRound = p1; }
                    if (p2 != address(0)) { playersInNextRound++; solePlayerInNextRound = p2; }
                }
                if (nextRoundStruct.playerCount % 2 == 1) {
                    bytes32 byeMatchId = _getMatchId(nextRound, nextRoundStruct.totalMatches);
                    (address byeP1, address byeP2) = this.moduleGetMatchPlayers(byeMatchId);
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
                (address winner, bool isDraw, MatchStatus status) = this.moduleGetMatchResult(matchId);
                if (status == MatchStatus.Completed && winner == player && !isDraw) return true;
            }
        }

        for (uint8 r = stalledRoundNumber + 1; r < tierConfig.totalRounds; r++) {
            Round storage round = rounds[r];
            if (!round.initialized) continue;
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
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
                (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
                if (p1 == player || p2 == player) {
                    (, , MatchStatus status) = this.moduleGetMatchResult(matchId);
                    if (status == MatchStatus.InProgress) return true;
                }
            }
        }
        return false;
    }
}
