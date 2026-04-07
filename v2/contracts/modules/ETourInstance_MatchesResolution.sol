// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourTournamentBase.sol";

/**
 * @title ETourInstance_MatchesResolution
 * @dev Heavy round resolution and bracket consolidation logic extracted from
 * ETourInstance_Matches so both deployable modules stay below 24 KB.
 *
 * Called only via delegatecall from ETourInstance_Matches.
 */
contract ETourInstance_MatchesResolution is ETourTournamentBase {

    error DuplicatePlayers();
    error MatchesEntryDelegatecallFailed();

    // ============ Abstract Stubs ============

    function moduleCreateMatch(uint8, uint8, address, address) public override {}
    function moduleResetMatch(bytes32) public override {}
    function moduleInitializeMatchForPlay(bytes32) public override {}
    function initializeRound(uint8) public payable override {}

    // ============ Entry Points ============ 

    function advanceWinner(uint8 roundNumber, uint8 matchNumber, address winner) external payable onlyDelegateCall {
        _advanceWinner(roundNumber, matchNumber, winner);
    }

    function resolveCompletedRound(uint8 roundNumber, uint8 reasonRaw) external payable onlyDelegateCall {
        if (hasOrphanedWinners(roundNumber)) {
            processOrphanedWinners(roundNumber);
            checkForSoleWinnerCompletion(roundNumber);
        }
        _completeRound(roundNumber, MatchCompletionReason(reasonRaw));
    }

    function consolidateAndStartOddRound(uint8 completedRound) external payable onlyDelegateCall {
        Round storage completedRoundStruct = rounds[completedRound];
        if (!completedRoundStruct.initialized) return;

        address[] memory winners = new address[](completedRoundStruct.totalMatches * 2);
        uint8 winnersCount = 0;

        for (uint8 i = 0; i < completedRoundStruct.totalMatches;) {
            bytes32 matchId = _getMatchId(completedRound, i);
            (address winner, bool isDraw, MatchStatus status) = this.moduleGetMatchResult(matchId);
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
            this.moduleCreateMatch(nextRound, i, winners[i * 2], winners[i * 2 + 1]);
            unchecked { i++; }
        }

        if (nextRound < tournament.actualTotalRounds - 1) {
            _advanceWinner(nextRound, properMatchCount, walkoverPlayer);
        }
    }

    // ============ Winner Advancement ============

    function _advanceWinner(uint8 roundNumber, uint8 matchNumber, address winner) internal {
        uint8 nextRound = roundNumber + 1;
        Round storage nextRoundData = rounds[nextRound];
        if (!nextRoundData.initialized) {
            (bool ok, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("initializeRound(uint8)", nextRound)
            );
            if (!ok) revert MatchesEntryDelegatecallFailed();
        }

        bytes32 nextMatchId = _getMatchId(nextRound, matchNumber / 2);
        this.moduleSetMatchPlayer(nextMatchId, matchNumber & 1, winner);

        (address p1, address p2) = this.moduleGetMatchPlayers(nextMatchId);
        if (p1 != address(0) && p2 != address(0)) {
            if (p1 == p2) revert DuplicatePlayers();
            this.moduleInitializeMatchForPlay(nextMatchId);
        }
    }

    // ============ Round Completion ============

    function _completeRound(uint8 roundNumber, MatchCompletionReason reason) internal {
        if (_isActualFinalsRound(roundNumber)) {
            _handleFinalsCompletion(roundNumber, reason);
            return;
        }

        Round storage round = rounds[roundNumber];
        if (round.drawCount == round.totalMatches && round.totalMatches > 0) {
            (uint8 playersInNextRound, address soleAdvancedPlayer) =
                _getAdvancedPlayersInRound(roundNumber + 1);
            if (playersInNextRound == 1 && soleAdvancedPlayer != address(0)) {
                _completeTournamentAsUncontestedFinalsWin(soleAdvancedPlayer);
                return;
            }

            address[] memory remainingPlayers = getRemainingPlayers(roundNumber);
            completeTournamentAllDraw(roundNumber, remainingPlayers);
            return;
        }

        tournament.currentRound = roundNumber + 1;
        consolidateScatteredPlayers(roundNumber + 1);

        if (tournament.status == TournamentStatus.Concluded) return;
        if (_checkAndHandleSoleWinner(roundNumber)) return;

        uint8 nextRound = roundNumber + 1;
        if (nextRound == tournament.actualTotalRounds - 1) {
            bytes32 finalsMatchId = _getMatchId(nextRound, 0);
            (address fp1, address fp2) = this.moduleGetMatchPlayers(finalsMatchId);
            if ((fp1 != address(0) && fp2 == address(0)) || (fp2 != address(0) && fp1 == address(0))) {
                _completeTournamentAsUncontestedFinalsWin(fp1 != address(0) ? fp1 : fp2);
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
            (address p1, address p2) = this.moduleGetMatchPlayers(nextMatchId);
            if (p1 != address(0) || p2 != address(0)) return false;
            unchecked { m++; }
        }
        return true;
    }

    function _handleFinalsCompletion(uint8 roundNumber, MatchCompletionReason reason) internal {
        bytes32 finalMatchId = _getMatchId(roundNumber, 0);
        (address finalWinner, bool finalIsDraw, ) = this.moduleGetMatchResult(finalMatchId);

        if (finalIsDraw) {
            tournament.finalsWasDraw = true;
            _setTournamentResolution(TournamentResolutionReason.Draw);
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
            (address matchWinner, bool matchIsDraw, MatchStatus matchStatus) = this.moduleGetMatchResult(matchId);
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
            (address p1, address p2) = this.moduleGetMatchPlayers(nextMatchId);
            if (p1 != address(0)) playersInNextRound++;
            if (p2 != address(0)) playersInNextRound++;
            if (p1 == address(0) && p2 == address(0)) break;
            unchecked { m++; }
        }
        if (playersInNextRound == 0) {
            if (nextRound == tournament.actualTotalRounds - 1) {
                _completeTournamentAsUncontestedFinalsWin(soleWinner);
            } else {
                completeTournament(soleWinner);
            }
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
    }

    function completeTournamentAllDraw(uint8 roundNumber, address[] memory remainingPlayers) internal {
        tournament.status = TournamentStatus.Concluded;
        tournament.allDrawResolution = true;
        tournament.allDrawRound = roundNumber;
        tournament.winner = address(0);
        _setTournamentResolution(TournamentResolutionReason.Draw);
        remainingPlayers;
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
            (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
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
            this.moduleResetMatch(matchId);
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
            this.moduleCreateMatch(roundNumber, i, playersInRound[i * 2], playersInRound[i * 2 + 1]);
            unchecked { i++; }
        }

        if (walkoverPlayer != address(0)) {
            _advanceWinner(roundNumber, newMatchCount, walkoverPlayer);
        }
    }

    // ============ Orphaned Winner Handling ============

    function hasOrphanedWinners(uint8 roundNumber) internal view returns (bool) {
        uint8 matchCount = rounds[roundNumber].totalMatches;
        for (uint8 i = 0; i < matchCount;) {
            if (i + 1 >= matchCount) break;
            bytes32 mid1 = _getMatchId(roundNumber, i);
            bytes32 mid2 = _getMatchId(roundNumber, i + 1);
            (address w1, bool d1, MatchStatus s1) = this.moduleGetMatchResult(mid1);
            (address w2, bool d2, MatchStatus s2) = this.moduleGetMatchResult(mid2);
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
            (address w1, bool d1, MatchStatus s1) = this.moduleGetMatchResult(mid1);
            (address w2, bool d2, MatchStatus s2) = this.moduleGetMatchResult(mid2);
            bool m1Complete = s1 == MatchStatus.Completed;
            bool m2Complete = s2 == MatchStatus.Completed;
            if (m1Complete && m2Complete) {
                bool m1HasWinner = w1 != address(0) && !d1;
                bool m2HasWinner = w2 != address(0) && !d2;
                if (m1HasWinner && !m2HasWinner) _advanceWinner(roundNumber, i, w1);
                else if (m2HasWinner && !m1HasWinner) _advanceWinner(roundNumber, i + 1, w2);
            }
            unchecked { i += 2; }
        }
    }

    function getRemainingPlayers(uint8 roundNumber) internal view returns (address[] memory) {
        Round storage round = rounds[roundNumber];
        uint8 count = 0;
        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
            if (p1 != address(0)) count++;
            if (p2 != address(0)) count++;
            unchecked { i++; }
        }
        address[] memory result = new address[](count);
        uint8 index = 0;
        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
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
        (uint8 advancedPlayerCount, address soleWinner) = _getAdvancedPlayersInRound(nextRound);
        if (advancedPlayerCount == 1) {
            if (nextRound == tournament.actualTotalRounds - 1) {
                _completeTournamentAsUncontestedFinalsWin(soleWinner);
            } else {
                completeTournament(soleWinner);
            }
        }
    }

    function _completeTournamentAsUncontestedFinalsWin(address winner) internal {
        _setTournamentResolution(TournamentResolutionReason.UncontestedFinalsWin);
        completeTournament(winner);
    }

    function _getAdvancedPlayersInRound(uint8 roundNumber)
        internal
        view
        returns (uint8 playerCount, address solePlayer)
    {
        Round storage round = rounds[roundNumber];
        if (!round.initialized) return (0, address(0));

        for (uint8 i = 0; i < round.totalMatches;) {
            bytes32 matchId = _getMatchId(roundNumber, i);
            (address p1, address p2) = this.moduleGetMatchPlayers(matchId);
            if (p1 != address(0)) { solePlayer = p1; playerCount++; }
            if (p2 != address(0)) { solePlayer = p2; playerCount++; }
            unchecked { i++; }
        }

        if (round.playerCount % 2 == 1) {
            bytes32 byeMatchId = _getMatchId(roundNumber, round.totalMatches);
            (address byeP1, address byeP2) = this.moduleGetMatchPlayers(byeMatchId);
            if (byeP1 != address(0)) { solePlayer = byeP1; playerCount++; }
            if (byeP2 != address(0)) { solePlayer = byeP2; playerCount++; }
        }
    }

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
