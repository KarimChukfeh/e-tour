// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";
import "../interfaces/IETourGame.sol";

/**
 * @title ETour_Matches
 * @dev Stateless module for match creation, round progression, and winner advancement
 *
 * This module handles:
 * - Round initialization and match creation
 * - Match completion and winner advancement
 * - Round completion and tournament finalization
 * - Orphaned winner handling
 * - Player consolidation logic
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (tournaments, rounds, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract ETour_Matches is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Empty implementations for module deployment) ============
    // During delegatecall, TicTacChain_Refactored's implementations are used instead
    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override {}
    function _resetMatchGame(bytes32) public override {}
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { return (address(0), false, MatchStatus.NotStarted); }
    function _addToMatchCacheGame(uint8, uint8, uint8, uint8) public override {}
    function _getMatchPlayers(bytes32) public view override returns (address, address) { return (address(0), address(0)); }
    function _setMatchPlayer(bytes32, uint8, address) public override {}
    function _initializeMatchForPlay(bytes32, uint8) public override {}
    function _completeMatchWithResult(bytes32, address, bool) public override {}
    function _getTimeIncrement() public view override returns (uint256) { return 0; }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { return false; }
    function _isMatchActive(bytes32) public view override returns (bool) { return false; }
    function _getActiveMatchData(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory) { return CommonMatchData({
        player1: address(0), player2: address(0), winner: address(0), loser: address(0),
        status: MatchStatus.NotStarted, isDraw: false, startTime: 0, lastMoveTime: 0, endTime: 0,
        tierId: 0, instanceId: 0, roundNumber: 0, matchNumber: 0, isCached: false
    }); }
    function _getMatchFromCache(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory, bool) {
        return (CommonMatchData({
            player1: address(0), player2: address(0), winner: address(0), loser: address(0),
            status: MatchStatus.NotStarted, isDraw: false, startTime: 0, lastMoveTime: 0, endTime: 0,
            tierId: 0, instanceId: 0, roundNumber: 0, matchNumber: 0, isCached: false
        }), false);
    }

    // ============ Round Initialization ============

    /**
     * @dev Initialize a new round with matches
     * EXACT COPY from ETour.sol lines 869-911
     */
    function initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId, roundNumber);

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.allMatchesDrew = false;

        emit RoundInitialized(tierId, instanceId, roundNumber, matchCount);

        if (roundNumber == 0) {
            address[] storage players = enrolledPlayers[tierId][instanceId];
            TournamentInstance storage tournament = tournaments[tierId][instanceId];

            address walkoverPlayer = address(0);
            if (tournament.enrolledCount % 2 == 1) {
                uint256 randomness = uint256(keccak256(abi.encodePacked(
                    block.prevrandao,
                    block.timestamp,
                    tierId,
                    instanceId,
                    tournament.enrolledCount
                )));
                uint8 walkoverIndex = uint8(randomness % tournament.enrolledCount);
                walkoverPlayer = players[walkoverIndex];

                address lastPlayer = players[tournament.enrolledCount - 1];
                players[walkoverIndex] = lastPlayer;
                players[tournament.enrolledCount - 1] = walkoverPlayer;

                emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
            }

            for (uint8 i = 0; i < matchCount; i++) {
                this._createMatchGame(tierId, instanceId, roundNumber, i, players[i * 2], players[i * 2 + 1]);
            }

            if (walkoverPlayer != address(0)) {
                advanceWinner(tierId, instanceId, roundNumber, matchCount, walkoverPlayer);
            }
        }
    }

    // ============ Match Completion ============

    /**
     * @dev Complete a match and handle advancement
     * EXACT COPY from ETour.sol lines 999-1047
     * NOTE: Depends on _clearEscalationState from Escalation module
     */
    function completeMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Remove match from both players' active match lists
        (address player1, address player2) = this._getMatchPlayers(matchId);
        removePlayerActiveMatch(player1, matchId);
        removePlayerActiveMatch(player2, matchId);

        // Update player stats
        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            playerStats[winner].matchesWon++;
        }

        // Clear escalation state when match completes - delegate to Escalation module
        (bool clearSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("clearEscalationState(bytes32)", matchId)
        );
        require(clearSuccess, "Clear escalation failed");

        emit MatchCompleted(matchId, winner, isDraw);

        if (!isDraw) {
            TierConfig storage config = _tierConfigs[tierId];
            if (roundNumber < config.totalRounds - 1) {
                advanceWinner(tierId, instanceId, roundNumber, matchNumber, winner);
            }
            // Note: Winner elimination check happens when their next match completes (or tournament ends)
            // This keeps winners in the active tournament list even while waiting for next round to start
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        if (round.completedMatches == round.totalMatches) {
            if (hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                processOrphanedWinners(tierId, instanceId, roundNumber);
                // After processing orphaned winners, check if tournament can complete
                // This handles the case where only one winner remains after force elimination
                checkForSoleWinnerCompletion(tierId, instanceId, roundNumber);
            }
            completeRound(tierId, instanceId, roundNumber);
        }
    }

    // ============ Winner Advancement ============

    /**
     * @dev Advance winner to next round
     * EXACT COPY from ETour.sol lines 937-977
     */
    function advanceWinner(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner
    ) public {
        uint8 nextRound = roundNumber + 1;
        uint8 nextMatchNumber = matchNumber / 2;

        Round storage nextRoundData = rounds[tierId][instanceId][nextRound];
        if (!nextRoundData.initialized) {
            initializeRound(tierId, instanceId, nextRound);
        }

        bytes32 nextMatchId = _getMatchId(tierId, instanceId, nextRound, nextMatchNumber);

        if (matchNumber % 2 == 0) {
            this._setMatchPlayer(nextMatchId, 0, winner);
        } else {
            this._setMatchPlayer(nextMatchId, 1, winner);
        }

        (address p1, address p2) = this._getMatchPlayers(nextMatchId);
        (, , MatchStatus status) = this._getMatchResult(nextMatchId);

        if (p1 != address(0) && p2 != address(0) && status == MatchStatus.NotStarted) {
            require(p1 != p2, "Cannot match player against themselves");
            this._initializeMatchForPlay(nextMatchId, tierId);

            addPlayerActiveMatch(p1, nextMatchId);
            addPlayerActiveMatch(p2, nextMatchId);

            emit MatchStarted(tierId, instanceId, nextRound, nextMatchNumber, p1, p2);
        }
    }

    // ============ Round Completion ============

    /**
     * @dev Complete a round and handle tournament progression
     * EXACT COPY from ETour.sol lines 1049-1140
     */
    function completeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];

        emit RoundCompleted(tierId, instanceId, roundNumber);

        bool isActualFinals = (roundNumber == config.totalRounds - 1) ||
                             (roundNumber > 0 && round.totalMatches == 1 && round.completedMatches == 1);

        if (isActualFinals) {
            bytes32 finalMatchId = _getMatchId(tierId, instanceId, roundNumber, 0);
            (address finalWinner, bool finalIsDraw, ) = this._getMatchResult(finalMatchId);
            (address finalPlayer1, address finalPlayer2) = this._getMatchPlayers(finalMatchId);

            if (finalIsDraw) {
                tournament.finalsWasDraw = true;
                tournament.winner = finalPlayer1;
                tournament.coWinner = finalPlayer2;
                playerRanking[tierId][instanceId][finalPlayer1] = 1;
                playerRanking[tierId][instanceId][finalPlayer2] = 1;
                completeTournament(tierId, instanceId, finalPlayer1);
            } else {
                completeTournament(tierId, instanceId, finalWinner);
            }
        } else if (round.drawCount == round.totalMatches && round.totalMatches > 0) {
            round.allMatchesDrew = true;
            address[] memory remainingPlayers = getRemainingPlayers(tierId, instanceId, roundNumber);
            emit AllDrawRoundDetected(tierId, instanceId, roundNumber, uint8(remainingPlayers.length));
            completeTournamentAllDraw(tierId, instanceId, roundNumber, remainingPlayers);
        } else {
            tournament.currentRound = roundNumber + 1;
            consolidateScatteredPlayers(tierId, instanceId, roundNumber + 1);

            if (tournament.status == TournamentStatus.Completed) {
                return;
            }

            Round storage nextRoundData = rounds[tierId][instanceId][roundNumber + 1];
            if (nextRoundData.initialized && nextRoundData.totalMatches == 0) {
                address soleWinner = address(0);
                uint8 winnerCount = 0;

                for (uint8 i = 0; i < round.totalMatches; i++) {
                    bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                    (address matchWinner, bool matchIsDraw, MatchStatus matchStatus) = this._getMatchResult(matchId);
                    if (matchStatus == MatchStatus.Completed && matchWinner != address(0) && !matchIsDraw) {
                        soleWinner = matchWinner;
                        winnerCount++;
                    }
                }

                if (winnerCount == 1) {
                    completeTournament(tierId, instanceId, soleWinner);
                    return;
                }
            }

            uint8 nextRound = roundNumber + 1;
            if (nextRound == config.totalRounds - 1) {
                bytes32 finalsMatchId = _getMatchId(tierId, instanceId, nextRound, 0);
                (address fp1, address fp2) = this._getMatchPlayers(finalsMatchId);

                bool onlyPlayer1 = fp1 != address(0) && fp2 == address(0);
                bool onlyPlayer2 = fp2 != address(0) && fp1 == address(0);

                if (onlyPlayer1 || onlyPlayer2) {
                    address walkoverWinner = onlyPlayer1 ? fp1 : fp2;

                    bytes32 prevMatchId0 = _getMatchId(tierId, instanceId, roundNumber, 0);
                    bytes32 prevMatchId1 = _getMatchId(tierId, instanceId, roundNumber, 1);
                    (address pm0Winner, bool pm0Draw, ) = this._getMatchResult(prevMatchId0);
                    (address pm1Winner, bool pm1Draw, ) = this._getMatchResult(prevMatchId1);
                    (address pm0p1, address pm0p2) = this._getMatchPlayers(prevMatchId0);
                    (address pm1p1, address pm1p2) = this._getMatchPlayers(prevMatchId1);

                    address runnerUp = address(0);
                    if (pm0Winner == walkoverWinner && !pm0Draw) {
                        runnerUp = pm0p1 == walkoverWinner ? pm0p2 : pm0p1;
                    } else if (pm1Winner == walkoverWinner && !pm1Draw) {
                        runnerUp = pm1p1 == walkoverWinner ? pm1p2 : pm1p1;
                    }

                    if (runnerUp != address(0)) {
                        playerRanking[tierId][instanceId][runnerUp] = 2;
                    }

                    completeTournament(tierId, instanceId, walkoverWinner);
                }
            }
        }
    }

    // ============ Tournament Completion ============

    /**
     * @dev Complete tournament and distribute prizes
     * EXACT COPY from ETour.sol lines 1142-1172
     */
    function completeTournament(uint8 tierId, uint8 instanceId, address winner) public {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        // Set status to Completed before reset (will be set to Enrolling during reset)
        tournament.status = TournamentStatus.Completed;

        if (tournament.winner == address(0)) {
            tournament.winner = winner;
            playerRanking[tierId][instanceId][winner] = 1;
        }

        uint256 winnersPot = tournament.prizePool;
        address[] storage players = enrolledPlayers[tierId][instanceId];

        if (tournament.finalsWasDraw) {
            playerStats[tournament.winner].tournamentsWon++;
            playerStats[tournament.coWinner].tournamentsWon++;
        } else {
            playerStats[winner].tournamentsWon++;
        }

        for (uint256 i = 0; i < players.length; i++) {
            playerStats[players[i]].tournamentsPlayed++;
        }

        // Delegate to Prizes module for prize distribution
        (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("distributePrizes(uint8,uint8,uint256)", tierId, instanceId, winnersPot)
        );
        require(distributeSuccess, "Prize distribution failed");

        uint256 winnerPrize = playerPrizes[tierId][instanceId][winner];
        emit TournamentCompleted(tierId, instanceId, winner, winnerPrize, tournament.finalsWasDraw, tournament.coWinner);

        // Delegate to Prizes module for earnings update
        (bool earningsSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("updatePlayerEarnings(uint8,uint8,address)", tierId, instanceId, winner)
        );
        require(earningsSuccess, "Update earnings failed");

        // Delegate to Prizes module for reset
        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );
        require(resetSuccess, "Reset failed");
    }

    /**
     * @dev Complete tournament with all-draw resolution
     * EXACT COPY from ETour.sol lines 1174-1199
     */
    function completeTournamentAllDraw(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address[] memory remainingPlayers
    ) public {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        // Set status to Completed before reset (will be set to Enrolling during reset)
        tournament.status = TournamentStatus.Completed;
        tournament.allDrawResolution = true;
        tournament.allDrawRound = roundNumber;
        tournament.winner = address(0);

        uint256 winnersPot = tournament.prizePool;
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        address[] storage players = enrolledPlayers[tierId][instanceId];
        for (uint256 i = 0; i < players.length; i++) {
            playerStats[players[i]].tournamentsPlayed++;
        }

        // Delegate to Prizes module for equal prize distribution
        (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("distributeEqualPrizes(uint8,uint8,address[],uint256)", tierId, instanceId, remainingPlayers, winnersPot)
        );
        require(distributeSuccess, "Equal prize distribution failed");

        emit TournamentCompletedAllDraw(tierId, instanceId, roundNumber, uint8(remainingPlayers.length), prizePerPlayer);

        // Delegate to Prizes module for earnings update
        (bool earningsSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("updatePlayerEarnings(uint8,uint8,address)", tierId, instanceId, address(0))
        );
        require(earningsSuccess, "Update earnings failed");

        // Delegate to Prizes module for reset
        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );
        require(resetSuccess, "Reset failed");
    }

    // ============ Player Consolidation ============

    /**
     * @dev Consolidate scattered players into complete matches
     * EXACT COPY from ETour.sol lines 1527-1628
     */
    function consolidateScatteredPlayers(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) public {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (!round.initialized) {
            return;
        }

        address[] memory playersInRound = new address[](round.totalMatches * 2);
        uint8 playerCount = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);

            if (p1 != address(0)) {
                playersInRound[playerCount++] = p1;
            }
            if (p2 != address(0)) {
                playersInRound[playerCount++] = p2;
            }
        }

        if (playerCount == 0) {
            return;
        }

        bool needsConsolidation = false;
        uint8 incompleteMatches = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);

            bool hasPlayer1 = p1 != address(0);
            bool hasPlayer2 = p2 != address(0);

            if (hasPlayer1 != hasPlayer2) {
                needsConsolidation = true;
                incompleteMatches++;
            }
        }

        if (!needsConsolidation) {
            return;
        }

        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        if (playerCount == 1) {
            completeTournament(tierId, instanceId, playersInRound[0]);
            return;
        }

        // Reset all matches in the round
        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            this._resetMatchGame(matchId);
        }

        // Recalculate match count for consolidated players
        uint8 newMatchCount = playerCount / 2;
        uint8 hasWalkover = playerCount % 2;

        round.totalMatches = newMatchCount;
        round.completedMatches = 0;
        round.drawCount = 0;
        round.allMatchesDrew = false;

        emit RoundInitialized(tierId, instanceId, roundNumber, newMatchCount);

        address walkoverPlayer = address(0);
        if (hasWalkover == 1) {
            uint256 randomness = uint256(keccak256(abi.encodePacked(
                block.prevrandao,
                block.timestamp,
                tierId,
                instanceId,
                roundNumber,
                playerCount
            )));

            uint8 walkoverIndex = uint8(randomness % playerCount);
            walkoverPlayer = playersInRound[walkoverIndex];

            playersInRound[walkoverIndex] = playersInRound[playerCount - 1];
            playerCount--;

            emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
        }

        // Create new matches with consolidated players
        for (uint8 i = 0; i < newMatchCount; i++) {
            address p1 = playersInRound[i * 2];
            address p2 = playersInRound[i * 2 + 1];

            this._createMatchGame(tierId, instanceId, roundNumber, i, p1, p2);
            emit PlayersConsolidated(tierId, instanceId, roundNumber, p1, p2);
        }

        // Advance walkover player if exists
        if (walkoverPlayer != address(0)) {
            advanceWinner(tierId, instanceId, roundNumber, newMatchCount, walkoverPlayer);
        }
    }

    // ============ Orphaned Winner Handling ============

    /**
     * @dev Check if round has orphaned winners
     * EXACT COPY from ETour.sol lines 1397-1420
     */
    function hasOrphanedWinners(uint8 tierId, uint8 instanceId, uint8 roundNumber) public view returns (bool) {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId, roundNumber);

        for (uint8 i = 0; i < matchCount; i += 2) {
            if (i + 1 >= matchCount) break;

            bytes32 matchId1 = _getMatchId(tierId, instanceId, roundNumber, i);
            bytes32 matchId2 = _getMatchId(tierId, instanceId, roundNumber, i + 1);

            (address w1, bool d1, MatchStatus s1) = this._getMatchResult(matchId1);
            (address w2, bool d2, MatchStatus s2) = this._getMatchResult(matchId2);

            // Check if match 1 has a winner and match 2 has no winner (draw or double elimination)
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && (d2 || w2 == address(0))) {
                return true;
            }
            // Check if match 2 has a winner and match 1 has no winner (draw or double elimination)
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && (d1 || w1 == address(0))) {
                return true;
            }
        }

        return false;
    }

    /**
     * @dev Process orphaned winners by advancing them
     * EXACT COPY from ETour.sol lines 1422-1448
     */
    function processOrphanedWinners(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        TierConfig storage config = _tierConfigs[tierId];
        if (roundNumber >= config.totalRounds - 1) {
            return;
        }

        uint8 matchCount = getMatchCountForRound(tierId, instanceId, roundNumber);

        for (uint8 i = 0; i < matchCount; i += 2) {
            if (i + 1 >= matchCount) break;

            bytes32 matchId1 = _getMatchId(tierId, instanceId, roundNumber, i);
            bytes32 matchId2 = _getMatchId(tierId, instanceId, roundNumber, i + 1);

            (address w1, bool d1, MatchStatus s1) = this._getMatchResult(matchId1);
            (address w2, bool d2, MatchStatus s2) = this._getMatchResult(matchId2);

            // Advance winner from match 1 if match 2 has no winner (draw or double elimination)
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && (d2 || w2 == address(0))) {
                advanceWinner(tierId, instanceId, roundNumber, i, w1);
            }
            // Advance winner from match 2 if match 1 has no winner (draw or double elimination)
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && (d1 || w1 == address(0))) {
                advanceWinner(tierId, instanceId, roundNumber, i + 1, w2);
            }
        }
    }

    /**
     * @dev Get remaining players in a round
     * EXACT COPY from ETour.sol lines 1450-1471
     */
    function getRemainingPlayers(uint8 tierId, uint8 instanceId, uint8 roundNumber) public view returns (address[] memory) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        address[] memory tempPlayers = new address[](round.totalMatches * 2);
        uint8 count = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);
            if (p1 != address(0)) {
                tempPlayers[count++] = p1;
            }
            if (p2 != address(0)) {
                tempPlayers[count++] = p2;
            }
        }

        address[] memory result = new address[](count);
        for (uint8 i = 0; i < count; i++) {
            result[i] = tempPlayers[i];
        }
        return result;
    }

    /**
     * @dev Check if tournament should complete with sole winner after orphan processing
     * EXACT COPY from ETour.sol lines 1478-1525
     */
    function checkForSoleWinnerCompletion(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) public {
        TierConfig storage config = _tierConfigs[tierId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        // Only check if not already completed and not in finals
        if (tournament.status == TournamentStatus.Completed) {
            return;
        }

        if (roundNumber >= config.totalRounds - 1) {
            return;
        }

        // Check next round to see if only one player advanced
        uint8 nextRound = roundNumber + 1;
        Round storage nextRoundData = rounds[tierId][instanceId][nextRound];

        if (!nextRoundData.initialized) {
            return;
        }

        address soleWinner = address(0);
        uint8 advancedPlayerCount = 0;

        for (uint8 i = 0; i < nextRoundData.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, nextRound, i);
            (address p1, address p2) = this._getMatchPlayers(matchId);

            if (p1 != address(0)) {
                soleWinner = p1;
                advancedPlayerCount++;
            }
            if (p2 != address(0)) {
                soleWinner = p2;
                advancedPlayerCount++;
            }
        }

        // If exactly one player advanced to next round, they win by walkover
        if (advancedPlayerCount == 1) {
            completeTournament(tierId, instanceId, soleWinner);
        }
    }

    // ============ Helper Functions ============

    /**
     * @dev Get match count for a round
     * EXACT COPY from ETour.sol lines 914-930
     */
    function getMatchCountForRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public view returns (uint8) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        uint8 playerCount = tournament.enrolledCount;

        if (roundNumber == 0) {
            return playerCount / 2;
        }

        Round storage prevRound = rounds[tierId][instanceId][roundNumber - 1];
        uint8 winnersFromPrevRound = prevRound.totalMatches - prevRound.drawCount;

        return winnersFromPrevRound / 2;
    }

    // ============ Player Active Match Tracking ============

    /**
     * @dev Add match to player's active matches
     * EXACT COPY from ETour.sol lines 979-984
     */
    function addPlayerActiveMatch(address player, bytes32 matchId) public {
        playerActiveMatches[player].push(matchId);
        playerMatchIndex[player][matchId] = playerActiveMatches[player].length - 1;
    }

    /**
     * @dev Remove match from player's active matches
     * EXACT COPY from ETour.sol lines 986-997
     */
    function removePlayerActiveMatch(address player, bytes32 matchId) public {
        uint256 index = playerMatchIndex[player][matchId];
        uint256 lastIndex = playerActiveMatches[player].length - 1;

        if (index != lastIndex) {
            bytes32 lastMatchId = playerActiveMatches[player][lastIndex];
            playerActiveMatches[player][index] = lastMatchId;
            playerMatchIndex[player][lastMatchId] = index;
        }

        playerActiveMatches[player].pop();
        delete playerMatchIndex[player][matchId];
    }
}
