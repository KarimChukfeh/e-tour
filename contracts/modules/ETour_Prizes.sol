// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";
import "../interfaces/IETourGame.sol";

/**
 * @title ETour_Prizes
 * @dev Stateless module for prize distribution and tournament reset
 *
 * This module handles:
 * - Prize calculation based on ranking and prize distribution
 * - Prize sending with fallback to protocol pool
 * - Equal prize distribution for all-draw scenarios
 * - Player earnings tracking and leaderboard management
 * - Tournament state reset after completion
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (tournaments, playerPrizes, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 * - msg.value = value sent
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract ETour_Prizes is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
    // This is a bit of a hack - modules inherit ETour_Storage for type definitions
    // but their storage is never used (delegatecall uses game contract's storage)
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Never Called - Modules Use IETourGame Interface) ============
    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override { revert("Module: Use IETourGame"); }
    function _resetMatchGame(bytes32) public override { revert("Module: Use IETourGame"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module: Use IETourGame"); }
    function _addToMatchCacheGame(uint8, uint8, uint8, uint8) public override { revert("Module: Use IETourGame"); }
    function _getMatchPlayers(bytes32) public view override returns (address, address) { revert("Module: Use IETourGame"); }
    function _setMatchPlayer(bytes32, uint8, address) public override { revert("Module: Use IETourGame"); }
    function _initializeMatchForPlay(bytes32, uint8) public override { revert("Module: Use IETourGame"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module: Use IETourGame"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module: Use IETourGame"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _isMatchActive(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _getActiveMatchData(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory) { revert("Module: Use IETourGame"); }
    function _getMatchFromCache(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory, bool) { revert("Module: Use IETourGame"); }

    // ============ Prize Distribution Functions ============

    /**
     * @dev Attempts to send prize to a recipient with fallback to protocol pool if failed
     * EXACT COPY from ETour.sol lines 1214-1236
     */
    function sendPrizeWithFallback(
        address recipient,
        uint256 amount,
        uint8 tierId,
        uint8 instanceId
    ) public returns (bool success) {
        require(amount > 0, "Amount must be greater than 0");

        // Attempt to send the prize once
        (bool sent, ) = payable(recipient).call{value: amount}("");

        if (sent) {
            return true; // Prize sent successfully
        }

        // If send failed, add amount to accumulated protocol share
        accumulatedProtocolShare += amount;

        emit PrizeDistributionFailed(tierId, instanceId, recipient, amount, 1);
        emit PrizeFallbackToContract(recipient, amount);

        return false; // Indicate fallback occurred
    }

    /**
     * @dev Distribute prizes based on player rankings
     * EXACT COPY from ETour.sol lines 1238-1274
     */
    function distributePrizes(uint8 tierId, uint8 instanceId, uint256 winnersPot) external {
        address[] storage players = enrolledPlayers[tierId][instanceId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        uint8 enrolledCount = tournament.enrolledCount;
        uint8 maxRank = enrolledCount > 0 ? enrolledCount : _tierConfigs[tierId].playerCount;
        uint8[] memory rankCounts = new uint8[](maxRank + 1);

        for (uint256 i = 0; i < players.length; i++) {
            uint8 ranking = playerRanking[tierId][instanceId][players[i]];
            if (ranking > 0 && ranking <= maxRank) {
                rankCounts[ranking]++;
            }
        }

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            uint8 ranking = playerRanking[tierId][instanceId][player];

            if (ranking > 0 && ranking <= maxRank) {
                uint256 prizeAmount = _calculatePrizeForRank(tierId, ranking, rankCounts[ranking], winnersPot);

                if (prizeAmount > 0) {
                    playerPrizes[tierId][instanceId][player] = prizeAmount;

                    // Attempt to send prize with fallback to protocol pool if failed
                    // Call directly as internal function (no nested delegatecall needed)
                    bool sent = sendPrizeWithFallback(player, prizeAmount, tierId, instanceId);

                    // Only emit success event if prize was actually sent
                    if (sent) {
                        emit PrizeDistributed(tierId, instanceId, player, ranking, prizeAmount);
                    }
                }
            }
        }
    }

    /**
     * @dev Distribute equal prizes to all remaining players (all-draw scenario)
     * EXACT COPY from ETour.sol lines 1276-1297
     */
    function distributeEqualPrizes(
        uint8 tierId,
        uint8 instanceId,
        address[] memory remainingPlayers,
        uint256 winnersPot
    ) external {
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        for (uint256 i = 0; i < remainingPlayers.length; i++) {
            address player = remainingPlayers[i];
            playerRanking[tierId][instanceId][player] = 0;
            playerPrizes[tierId][instanceId][player] = prizePerPlayer;

            // Attempt to send prize with fallback to protocol pool if failed
            // Call directly as internal function (no nested delegatecall needed)
            bool sent = sendPrizeWithFallback(player, prizePerPlayer, tierId, instanceId);

            // Only emit success event if prize was actually sent
            if (sent) {
                emit PrizeDistributed(tierId, instanceId, player, 1, prizePerPlayer);
            }
        }
    }

    /**
     * @dev Calculate prize amount for a specific rank
     * EXACT COPY from ETour.sol lines 1299-1314
     */
    function calculatePrizeForRank(
        uint8 tierId,
        uint8 ranking,
        uint8 playersAtRank,
        uint256 winnersPot
    ) external view returns (uint256) {
        uint8 prizeIndex = ranking - 1;
        uint256 combinedPercentage = 0;

        uint8[] storage prizeDistribution = _tierPrizeDistribution[tierId];
        for (uint8 j = 0; j < playersAtRank && (prizeIndex + j) < prizeDistribution.length; j++) {
            combinedPercentage += prizeDistribution[prizeIndex + j];
        }

        return (winnersPot * combinedPercentage) / (100 * uint256(playersAtRank));
    }

    // ============ Internal Prize Calculation Helper ============

    /**
     * @dev Internal helper for prize calculation (called by distributePrizes)
     * EXACT COPY from ETour.sol lines 1299-1314
     */
    function _calculatePrizeForRank(
        uint8 tierId,
        uint8 ranking,
        uint8 playersAtRank,
        uint256 winnersPot
    ) internal view returns (uint256) {
        uint8 prizeIndex = ranking - 1;
        uint256 combinedPercentage = 0;

        uint8[] storage prizeDistribution = _tierPrizeDistribution[tierId];
        for (uint8 j = 0; j < playersAtRank && (prizeIndex + j) < prizeDistribution.length; j++) {
            combinedPercentage += prizeDistribution[prizeIndex + j];
        }

        return (winnersPot * combinedPercentage) / (100 * uint256(playersAtRank));
    }

    // ============ Earnings & Leaderboard Functions ============

    /**
     * @dev Update player earnings after tournament completion
     * EXACT COPY from ETour.sol lines 2109-2126
     */
    function updatePlayerEarnings(uint8 tierId, uint8 instanceId, address winner) external {
        address[] storage players = enrolledPlayers[tierId][instanceId];

        // Only track players who actually won prizes on the leaderboard
        for (uint8 i = 0; i < players.length; i++) {
            address player = players[i];
            uint256 prize = playerPrizes[tierId][instanceId][player];

            if (prize > 0) {
                // Player won a prize - track them and add earnings
                // Call directly as internal function (no nested delegatecall needed)
                trackOnLeaderboard(player);

                playerEarnings[player] += int256(prize);
            }
            // Players with no prize are not tracked unless already on leaderboard
        }

        emit TournamentCached(tierId, instanceId, winner);
    }

    /**
     * @dev Track player on leaderboard if not already tracked
     * EXACT COPY from ETour.sol lines 2144-2149
     */
    function trackOnLeaderboard(address player) public {
        if (!_isOnLeaderboard[player]) {
            _isOnLeaderboard[player] = true;
            _leaderboardPlayers.push(player);
        }
    }

    // ============ Tournament Reset Functions ============

    /**
     * @dev Reset tournament state after completion
     * EXACT COPY from ETour.sol lines 2186-2282
     */
    function resetTournamentAfterCompletion(uint8 tierId, uint8 instanceId) external {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];

        // CRITICAL: Reset status FIRST before any other operations
        tournament.status = TournamentStatus.Enrolling;

        // Calculate finals matchId (last round, match 0)
        uint8 finalRound = config.totalRounds - 1;
        bytes32 finalsMatchId = _getMatchId(tierId, instanceId, finalRound, 0);

        // Check if there's old finals from a previous tournament that needs caching
        // The finals is from a previous tournament if its winner doesn't match current tournament winner
        (address finalsWinner, , MatchStatus finalsStatus) = this._getMatchResult(finalsMatchId);

        if (finalsStatus == MatchStatus.Completed && finalsWinner != address(0)) {
            // Check if finals winner matches the current tournament winner
            address currentWinner = tournament.winner;

            // If winners don't match, this finals is from a previous tournament
            if (finalsWinner != currentWinner) {
                // Cache the old finals before clearing it
                this._addToMatchCacheGame(tierId, instanceId, finalRound, 0);
                this._resetMatchGame(finalsMatchId);
            }
        }

        // Continue with other resets
        tournament.currentRound = 0;
        tournament.enrolledCount = 0;
        tournament.prizePool = 0;
        tournament.startTime = 0;
        tournament.winner = address(0);
        tournament.coWinner = address(0);
        tournament.finalsWasDraw = false;
        tournament.allDrawResolution = false;
        tournament.allDrawRound = NO_ROUND;
        tournament.hasStartedViaTimeout = false;

        tournament.enrollmentTimeout.escalation1Start = 0;
        tournament.enrollmentTimeout.escalation2Start = 0;
        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
        tournament.enrollmentTimeout.forfeitPool = 0;

        address[] storage players = enrolledPlayers[tierId][instanceId];

        // Copy players array before deletion for tracking cleanup
        address[] memory playersCopy = new address[](players.length);
        for (uint256 i = 0; i < players.length; i++) {
            playersCopy[i] = players[i];
        }

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            isEnrolled[tierId][instanceId][player] = false;
            delete playerRanking[tierId][instanceId][player];
            // Note: playerPrizes is intentionally NOT deleted - it's permanent historical record
        }
        delete enrolledPlayers[tierId][instanceId];

        // Notify tracking systems of tournament completion
        _onTournamentCompleted(tierId, instanceId, playersCopy);

        for (uint8 roundNum = 0; roundNum < config.totalRounds; roundNum++) {
            Round storage round = rounds[tierId][instanceId][roundNum];

            // IMPORTANT: Calculate matchCount BEFORE resetting round metadata
            // Calculate directly instead of delegatecall (avoids nested delegatecall issue)
            uint8 matchCount;
            if (round.totalMatches > 0) {
                matchCount = round.totalMatches;
            } else {
                // Calculate match count inline (same logic as getMatchCountForRound)
                if (roundNum == 0) {
                    matchCount = tournament.enrolledCount / 2;
                } else {
                    Round storage prevRound = rounds[tierId][instanceId][roundNum - 1];
                    matchCount = (prevRound.totalMatches - prevRound.drawCount) / 2;
                }
            }

            // Now reset round metadata
            round.totalMatches = 0;
            round.completedMatches = 0;
            round.initialized = false;
            round.drawCount = 0;
            round.allMatchesDrew = false;

            for (uint8 matchNum = 0; matchNum < matchCount; matchNum++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNum, matchNum);

                // Skip resetting finals match - keep it in live storage
                if (matchId == finalsMatchId) {
                    continue;
                }

                // Clear drawParticipants for both match players
                (address p1, address p2) = this._getMatchPlayers(matchId);
                if (p1 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p1];
                }
                if (p2 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p2];
                }

                this._resetMatchGame(matchId);
            }
        }

        emit TournamentReset(tierId, instanceId);
    }

    // ============ Leaderboard Getters ============

    /**
     * @dev Leaderboard entry struct
     * EXACT COPY from ETour.sol lines 2422-2425
     */
    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    /**
     * @dev Get all leaderboard entries
     * EXACT COPY from ETour.sol lines 2427-2436
     */
    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        LeaderboardEntry[] memory entries = new LeaderboardEntry[](_leaderboardPlayers.length);
        for (uint256 i = 0; i < _leaderboardPlayers.length; i++) {
            entries[i] = LeaderboardEntry({
                player: _leaderboardPlayers[i],
                earnings: playerEarnings[_leaderboardPlayers[i]]
            });
        }
        return entries;
    }

    /**
     * @dev Get count of players on leaderboard
     * EXACT COPY from ETour.sol lines 2438-2440
     */
    function getLeaderboardCount() external view returns (uint256) {
        return _leaderboardPlayers.length;
    }
}
