// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourInstance_Base.sol";

/**
 * @title ETourInstance_Matches
 * @dev Stateless module for match creation, round progression, and winner advancement.
 *
 * Adapted from ETour_Matches for single-instance storage:
 * - No tierId/instanceId parameters
 * - Match IDs: keccak256(roundNumber, matchNumber)
 * - tournament.status uses TournamentStatus.Concluded (not .Completed)
 * - Removed all tournament reset calls
 *
 * DELEGATECALL SEMANTICS: Executes in instance contract's storage context.
 */
contract ETourInstance_Matches is ETourInstance_Base {

    constructor() {}

    // ============ Abstract Stubs ============

    function _createMatchGame(uint8, uint8, address, address) public override {}
    function _resetMatchGame(bytes32) public override {}
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { return (address(0), false, MatchStatus.NotStarted); }
    function _getMatchPlayers(bytes32) public view override returns (address, address) { return (address(0), address(0)); }
    function _setMatchPlayer(bytes32, uint8, address) public override {}
    function _initializeMatchForPlay(bytes32) public override {}
    function _completeMatchWithResult(bytes32, address, bool) public override {}
    function _getTimeIncrement() public view override returns (uint256) { return 0; }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { return false; }
    function _isMatchActive(bytes32) public view override returns (bool) { return false; }
    function _getActiveMatchData(bytes32, uint8, uint8) public view override returns (CommonMatchData memory) {
        return CommonMatchData({ player1: address(0), player2: address(0), winner: address(0), loser: address(0),
            status: MatchStatus.NotStarted, isDraw: false, startTime: 0, lastMoveTime: 0,
            roundNumber: 0, matchNumber: 0, isCached: false });
    }

    // ============ Round Initialization ============

    /**
     * @dev Initialize a new round with matches.
     * Called via delegatecall from the instance after tournament starts or round completes.
     */
    function initializeRound(uint8 roundNumber) public payable override onlyDelegateCall {
        uint8 playerCount;
        if (roundNumber == 0) {
            playerCount = tournament.enrolledCount;
        } else {
            Round storage prevRound = rounds[roundNumber - 1];
            playerCount = (prevRound.totalMatches - prevRound.drawCount) + (prevRound.playerCount % 2);
        }

        uint8 matchCount = playerCount / 2;
        require(matchCount > 0 || roundNumber > 0, "Invalid match count");

        Round storage round = rounds[roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.playerCount = playerCount;

        if (roundNumber == 0) {
            require(enrolledPlayers.length >= 2, "Not enough players");

            address walkoverPlayer = address(0);
            if (tournament.enrolledCount % 2 == 1) {
                uint8 walkoverIndex = uint8(_drawRandomIndex(
                    ENTROPY_WALKOVER,
                    keccak256(abi.encodePacked(roundNumber, tournament.enrolledCount)),
                    tournament.enrolledCount
                ));

                walkoverPlayer = enrolledPlayers[walkoverIndex];
                enrolledPlayers[walkoverIndex] = enrolledPlayers[tournament.enrolledCount - 1];
                enrolledPlayers[tournament.enrolledCount - 1] = walkoverPlayer;
            }

            for (uint8 i = 0; i < matchCount;) {
                require(enrolledPlayers[i * 2] != address(0) && enrolledPlayers[i * 2 + 1] != address(0), "Invalid player addresses");
                this._createMatchGame(roundNumber, i, enrolledPlayers[i * 2], enrolledPlayers[i * 2 + 1]);
                unchecked { i++; }
            }

            if (walkoverPlayer != address(0)) {
                advanceWinner(roundNumber, matchCount, walkoverPlayer);
            }
        }
    }

    // ============ Match Completion ============

    /**
     * @dev Complete a match and handle advancement logic.
     * Called via delegatecall from ETourInstance_Base._completeMatchInternal().
     */
    function completeMatch(
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason
    ) public payable onlyDelegateCall {
        if (!isDraw) {
            if (roundNumber < tournament.actualTotalRounds - 1) {
                advanceWinner(roundNumber, matchNumber, winner);
            }
        }

        Round storage round = rounds[roundNumber];
        round.completedMatches++;
        if (isDraw) round.drawCount++;

        bool isRoundComplete = (round.completedMatches == round.totalMatches) ||
                               (round.totalMatches == 0 && round.completedMatches == 1);

        if (isRoundComplete) {
            if (hasOrphanedWinners(roundNumber)) {
                processOrphanedWinners(roundNumber);
                checkForSoleWinnerCompletion(roundNumber);
            }
            completeRound(roundNumber, reason);
        }
    }

    // ============ Winner Advancement ============

    function advanceWinner(uint8 roundNumber, uint8 matchNumber, address winner) public payable onlyDelegateCall {
        uint8 nextRound = roundNumber + 1;
        Round storage nextRoundData = rounds[nextRound];
        if (!nextRoundData.initialized) {
            initializeRound(nextRound);
        }

        bytes32 nextMatchId = _getMatchId(nextRound, matchNumber / 2);
        this._setMatchPlayer(nextMatchId, matchNumber & 1, winner);

        (address p1, address p2) = this._getMatchPlayers(nextMatchId);
        if (p1 != address(0) && p2 != address(0)) {
            require(p1 != p2, "Cannot match player against themselves");
            this._initializeMatchForPlay(nextMatchId);
        }
    }

    // ============ Round Completion ============

    function completeRound(uint8 roundNumber, MatchCompletionReason reason) internal {
        if (_isActualFinalsRound(roundNumber)) {
            _handleFinalsCompletion(roundNumber, reason);
            return;
        }

        Round storage round = rounds[roundNumber];
        if (round.drawCount == round.totalMatches && round.totalMatches > 0) {
            address[] memory remainingPlayers = getRemainingPlayers(roundNumber);
            completeTournamentAllDraw(roundNumber, remainingPlayers);
            return;
        }

        tournament.currentRound = roundNumber + 1;
        consolidateScatteredPlayers(roundNumber + 1);

        if (tournament.status == TournamentStatus.Concluded) return;

        if (_checkAndHandleSoleWinner(roundNumber)) return;

        // Handle finals walkover
        uint8 nextRound = roundNumber + 1;
        if (nextRound == tournament.actualTotalRounds - 1) {
            bytes32 finalsMatchId = _getMatchId(nextRound, 0);
            (address fp1, address fp2) = this._getMatchPlayers(finalsMatchId);
            if ((fp1 != address(0) && fp2 == address(0)) || (fp2 != address(0) && fp1 == address(0))) {
                completeTournament(fp1 != address(0) ? fp1 : fp2);
            }
        }
    }

    function _isActualFinalsRound(uint8 roundNumber) internal view returns (bool) {
        Round storage round = rounds[roundNumber];
        if (roundNumber == tournament.actualTotalRounds - 1) return true;

        bool appearsToBeFinalsMatch = (roundNumber > 0 && round.completedMatches == 1 &&
                                      (round.totalMatches == 1 || round.totalMatches == 0));
        if (!appearsToBeFinalsMatch || roundNumber >= tournament.actualTotalRounds - 1) return false;

        uint8 nextRound = roundNumber + 1;
        for (uint8 m = 0; m < 4;) {
            bytes32 nextMatchId = _getMatchId(nextRound, m);
            (address p1, address p2) = this._getMatchPlayers(nextMatchId);
            if (p1 != address(0) || p2 != address(0)) return false;
            unchecked { m++; }
        }
        return true;
    }

    function _handleFinalsCompletion(uint8 roundNumber, MatchCompletionReason reason) internal {
        bytes32 finalMatchId = _getMatchId(roundNumber, 0);
        (address finalWinner, bool finalIsDraw, ) = this._getMatchResult(finalMatchId);

        if (finalIsDraw) {
            tournament.finalsWasDraw = true;
            _setTournamentResolution(TournamentResolutionReason.FinalsDraw);
            tournament.winner = address(0);
            completeTournament(address(0));
        } else {
            if (reason == MatchCompletionReason.Timeout) {
                _setTournamentResolution(TournamentResolutionReason.Timeout);
            } else {
                _setTournamentResolution(TournamentResolutionReason.NormalWin);
            }
            completeTournament(finalWinner);
        }
    }

    function _checkAndHandleSoleWinner(uint8 roundNumber) internal returns (bool) {
        Round storage nextRoundData = rounds[roundNumber + 1];
        if (!nextRoundData.initialized || nextRoundData.totalMatches != 0) return false;

        Round storage round = rounds[roundNumber];
        address soleWinner = address(0);
        uint8 winnerCount = 0;

        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address matchWinner, bool matchIsDraw, MatchStatus matchStatus) = this._getMatchResult(matchId);
            if (matchStatus == MatchStatus.Completed && matchWinner != address(0) && !matchIsDraw) {
                soleWinner = matchWinner;
                winnerCount++;
            }
            unchecked { i++; }
        }
        if (winnerCount != 1) return false;

        uint8 nextRound = roundNumber + 1;
        uint8 playersInNextRound = 0;
        for (uint8 m = 0; m < 4;) {
            bytes32 nextMatchId = _getMatchId(nextRound, m);
            (address p1, address p2) = this._getMatchPlayers(nextMatchId);
            if (p1 != address(0)) playersInNextRound++;
            if (p2 != address(0)) playersInNextRound++;
            if (p1 == address(0) && p2 == address(0)) break;
            unchecked { m++; }
        }
        if (playersInNextRound == 0) {
            completeTournament(soleWinner);
            return true;
        }
        return false;
    }

    // ============ Tournament Conclusion ============

    function completeTournament(address winner) internal {
        tournament.status = TournamentStatus.Concluded;
        if (tournament.winner == address(0)) {
            tournament.winner = winner;
        }
        // Prize distribution and event emission handled by ETourInstance_Base._handleTournamentConclusion()
    }

    function completeTournamentAllDraw(uint8 roundNumber, address[] memory remainingPlayers) internal {
        tournament.status = TournamentStatus.Concluded;
        tournament.allDrawResolution = true;
        tournament.allDrawRound = roundNumber;
        tournament.winner = address(0);
        _setTournamentResolution(TournamentResolutionReason.AllDrawScenario);
        remainingPlayers; // silence unused warning
    }

    // ============ Player Consolidation ============

    function consolidateScatteredPlayers(uint8 roundNumber) internal {
        Round storage round = rounds[roundNumber];
        if (!round.initialized) return;

        address[] memory playersInRound = new address[](round.totalMatches * 2);
        uint8 playerCount = 0;
        bool needsConsolidation = false;

        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);
            bool hasP1 = p1 != address(0);
            bool hasP2 = p2 != address(0);
            if (hasP1) playersInRound[playerCount++] = p1;
            if (hasP2) playersInRound[playerCount++] = p2;
            if (hasP1 != hasP2) needsConsolidation = true;
            unchecked { i++; }
        }

        if (playerCount == 0 || !needsConsolidation) return;
        if (playerCount == 1) { completeTournament(playersInRound[0]); return; }

        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            this._resetMatchGame(matchId);
            unchecked { i++; }
        }

        uint8 originalPlayerCount = playerCount;
        address walkoverPlayer = address(0);
        if (playerCount % 2 == 1) {
            (walkoverPlayer, playerCount) = _selectWalkoverPlayer(playersInRound, playerCount, roundNumber);
        }

        uint8 newMatchCount = playerCount / 2;
        round.totalMatches = newMatchCount;
        round.completedMatches = 0;
        round.drawCount = 0;
        round.playerCount = originalPlayerCount;

        for (uint8 i = 0; i < newMatchCount;) {
            this._createMatchGame(roundNumber, i, playersInRound[i * 2], playersInRound[i * 2 + 1]);
            unchecked { i++; }
        }

        if (walkoverPlayer != address(0)) {
            advanceWinner(roundNumber, newMatchCount, walkoverPlayer);
        }
    }

    function consolidateAndStartOddRound(uint8 completedRound) public payable onlyDelegateCall {
        Round storage completedRoundStruct = rounds[completedRound];
        if (!completedRoundStruct.initialized) return;

        address[] memory winners = new address[](completedRoundStruct.totalMatches * 2);
        uint8 winnersCount = 0;

        for (uint8 i = 0; i < completedRoundStruct.totalMatches;) {
            bytes32 matchId = _getMatchId(completedRound, i);
            (address winner, bool isDraw, MatchStatus status) = this._getMatchResult(matchId);
            if (status == MatchStatus.Completed && !isDraw && winner != address(0)) {
                winners[winnersCount++] = winner;
            }
            unchecked { i++; }
        }

        if (winnersCount == 0 || winnersCount % 2 == 0) return;

        uint8 nextRound = completedRound + 1;
        Round storage nextRoundStruct = rounds[nextRound];

        if (nextRoundStruct.initialized) {
            consolidateScatteredPlayers(nextRound);
            return;
        }

        uint8 properMatchCount = (winnersCount - 1) / 2;
        nextRoundStruct.initialized = true;
        nextRoundStruct.totalMatches = properMatchCount;
        nextRoundStruct.completedMatches = 0;
        nextRoundStruct.drawCount = 0;
        nextRoundStruct.playerCount = winnersCount;

        address walkoverPlayer;
        (walkoverPlayer, winnersCount) = _selectWalkoverPlayer(winners, winnersCount, nextRound);

        for (uint8 i = 0; i < properMatchCount;) {
            this._createMatchGame(nextRound, i, winners[i * 2], winners[i * 2 + 1]);
            unchecked { i++; }
        }

        if (nextRound < tournament.actualTotalRounds - 1) {
            advanceWinner(nextRound, properMatchCount, walkoverPlayer);
        }
    }

    // ============ Orphaned Winner Handling ============

    function hasOrphanedWinners(uint8 roundNumber) internal view returns (bool) {
        uint8 matchCount = rounds[roundNumber].totalMatches;
        for (uint8 i = 0; i < matchCount;) {
            if (i + 1 >= matchCount) break;
            bytes32 mid1 = _getMatchId(roundNumber, i);
            bytes32 mid2 = _getMatchId(roundNumber, i + 1);
            (address w1, bool d1, MatchStatus s1) = this._getMatchResult(mid1);
            (address w2, bool d2, MatchStatus s2) = this._getMatchResult(mid2);
            bool m1Complete = s1 == MatchStatus.Completed;
            bool m2Complete = s2 == MatchStatus.Completed;
            bool m1HasWinner = w1 != address(0) && !d1;
            bool m2HasWinner = w2 != address(0) && !d2;
            if (m1Complete && m2Complete && (m1HasWinner != m2HasWinner)) return true;
            unchecked { i += 2; }
        }
        return false;
    }

    function processOrphanedWinners(uint8 roundNumber) internal {
        if (roundNumber >= tournament.actualTotalRounds - 1) return;
        uint8 matchCount = rounds[roundNumber].totalMatches;
        for (uint8 i = 0; i < matchCount;) {
            if (i + 1 >= matchCount) break;
            bytes32 mid1 = _getMatchId(roundNumber, i);
            bytes32 mid2 = _getMatchId(roundNumber, i + 1);
            (address w1, bool d1, MatchStatus s1) = this._getMatchResult(mid1);
            (address w2, bool d2, MatchStatus s2) = this._getMatchResult(mid2);
            bool m1Complete = s1 == MatchStatus.Completed;
            bool m2Complete = s2 == MatchStatus.Completed;
            if (m1Complete && m2Complete) {
                bool m1HasWinner = w1 != address(0) && !d1;
                bool m2HasWinner = w2 != address(0) && !d2;
                if (m1HasWinner && !m2HasWinner) advanceWinner(roundNumber, i, w1);
                else if (m2HasWinner && !m1HasWinner) advanceWinner(roundNumber, i + 1, w2);
            }
            unchecked { i += 2; }
        }
    }

    function getRemainingPlayers(uint8 roundNumber) internal view returns (address[] memory) {
        Round storage round = rounds[roundNumber];
        uint8 count = 0;
        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);
            if (p1 != address(0)) count++;
            if (p2 != address(0)) count++;
            unchecked { i++; }
        }
        address[] memory result = new address[](count);
        uint8 index = 0;
        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);
            if (p1 != address(0)) result[index++] = p1;
            if (p2 != address(0)) result[index++] = p2;
            unchecked { i++; }
        }
        return result;
    }

    function checkForSoleWinnerCompletion(uint8 roundNumber) internal {
        if (tournament.status == TournamentStatus.Concluded) return;
        if (roundNumber >= tournament.actualTotalRounds - 1) return;

        uint8 nextRound = roundNumber + 1;
        Round storage nextRoundData = rounds[nextRound];
        if (!nextRoundData.initialized) return;

        address soleWinner = address(0);
        uint8 advancedPlayerCount = 0;

        for (uint8 i = 0; i < nextRoundData.totalMatches;) {
            bytes32 matchId = _getMatchId(nextRound, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);
            if (p1 != address(0)) { soleWinner = p1; advancedPlayerCount++; }
            if (p2 != address(0)) { soleWinner = p2; advancedPlayerCount++; }
            unchecked { i++; }
        }

        if (nextRoundData.playerCount % 2 == 1) {
            bytes32 byeMatchId = _getMatchId(nextRound, nextRoundData.totalMatches);
            (address byeP1, address byeP2) = this._getMatchPlayers(byeMatchId);
            if (byeP1 != address(0)) { soleWinner = byeP1; advancedPlayerCount++; }
            if (byeP2 != address(0)) { soleWinner = byeP2; advancedPlayerCount++; }
        }

        if (advancedPlayerCount == 1) completeTournament(soleWinner);
    }

    // ============ Helper ============

    function _selectWalkoverPlayer(
        address[] memory players,
        uint8 playerCount,
        uint8 roundNumber
    ) internal returns (address walkoverPlayer, uint8 newPlayerCount) {
        uint8 walkoverIndex = uint8(_drawRandomIndex(
            ENTROPY_WALKOVER,
            keccak256(abi.encode(roundNumber, playerCount, players)),
            playerCount
        ));
        walkoverPlayer = players[walkoverIndex];
        players[walkoverIndex] = players[playerCount - 1];
        newPlayerCount = playerCount - 1;
    }
}
