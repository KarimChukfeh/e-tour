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
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Never Called - Modules Use IETourGame Interface) ============
    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override { revert("Module: Use IETourGame"); }
    function _resetMatchGame(bytes32) public override { revert("Module: Use IETourGame"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module: Use IETourGame"); }
    function _initializeMatchForPlay(bytes32, uint8) public override { revert("Module: Use IETourGame"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module: Use IETourGame"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module: Use IETourGame"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function initializeRound(uint8, uint8, uint8) public override { revert("Module: Use IETourGame"); }

    // ============ Prize Distribution Functions ============

    /**
     * @dev Attempts to send prize to a recipient with fallback to protocol pool if failed
     * EXACT COPY from ETour.sol lines 1214-1236
     */
    function sendPrizeWithFallback(
        address recipient,
        uint256 amount,
        uint8 tierId,
        uint8 instanceId,
        string memory gameName
    ) public returns (bool success) {
        require(amount > 0, "Amount must be greater than 0");

        // Attempt to send the prize once
        (bool sent, ) = payable(recipient).call{value: amount}("");

        if (sent) {
            return true; // Prize sent successfully
        }

        // If send failed, add amount to accumulated protocol share
        accumulatedProtocolShare += amount;

        return false; // Indicate fallback occurred
    }

    /**
     * @dev Distribute prizes based on player rankings
     * EXACT COPY from ETour.sol lines 1238-1274
     * @return winners Array of addresses that received prizes
     * @return prizes Array of prize amounts corresponding to each winner
     */
    function distributePrizes(uint8 tierId, uint8 instanceId, uint256 winnersPot, string memory gameName)
        external
        returns (address[] memory winners, uint256[] memory prizes)
    {
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

        // Use temporary arrays with max possible size
        address[] memory tempWinners = new address[](players.length);
        uint256[] memory tempPrizes = new uint256[](players.length);
        uint256 successCount = 0;

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            uint8 ranking = playerRanking[tierId][instanceId][player];

            if (ranking > 0 && ranking <= maxRank) {
                uint256 prizeAmount = _calculatePrizeForRank(tierId, ranking, rankCounts[ranking], winnersPot);

                if (prizeAmount > 0) {
                    playerPrizes[tierId][instanceId][player] = prizeAmount;

                    // Attempt to send prize with fallback to protocol pool if failed
                    // Call directly as internal function (no nested delegatecall needed)
                    bool sent = sendPrizeWithFallback(player, prizeAmount, tierId, instanceId, gameName);

                    // Only add to return arrays if prize was successfully sent
                    if (sent) {
                        tempWinners[successCount] = player;
                        tempPrizes[successCount] = prizeAmount;
                        successCount++;
                    }
                }
            }
        }

        // Create properly sized return arrays
        winners = new address[](successCount);
        prizes = new uint256[](successCount);
        for (uint256 i = 0; i < successCount; i++) {
            winners[i] = tempWinners[i];
            prizes[i] = tempPrizes[i];
        }
    }

    /**
     * @dev Distribute equal prizes to all remaining players (all-draw scenario)
     * EXACT COPY from ETour.sol lines 1276-1297
     * @return winners Array of addresses that received prizes
     * @return prizes Array of prize amounts corresponding to each winner
     */
    function distributeEqualPrizes(
        uint8 tierId,
        uint8 instanceId,
        address[] memory remainingPlayers,
        uint256 winnersPot,
        string memory gameName
    ) external returns (address[] memory winners, uint256[] memory prizes) {
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        // Use temporary arrays with max possible size
        address[] memory tempWinners = new address[](remainingPlayers.length);
        uint256[] memory tempPrizes = new uint256[](remainingPlayers.length);
        uint256 successCount = 0;

        for (uint256 i = 0; i < remainingPlayers.length; i++) {
            address player = remainingPlayers[i];
            playerRanking[tierId][instanceId][player] = 0;
            playerPrizes[tierId][instanceId][player] = prizePerPlayer;

            // Attempt to send prize with fallback to protocol pool if failed
            // Call directly as internal function (no nested delegatecall needed)
            bool sent = sendPrizeWithFallback(player, prizePerPlayer, tierId, instanceId, gameName);

            // Only add to return arrays if prize was successfully sent
            if (sent) {
                tempWinners[successCount] = player;
                tempPrizes[successCount] = prizePerPlayer;
                successCount++;
            }
        }

        // Create properly sized return arrays
        winners = new address[](successCount);
        prizes = new uint256[](successCount);
        for (uint256 i = 0; i < successCount; i++) {
            winners[i] = tempWinners[i];
            prizes[i] = tempPrizes[i];
        }
    }

    /**
     * @dev Calculate prize amount for a specific rank
     * Simplified: First place gets 100%, everyone else gets 0%
     */
    function calculatePrizeForRank(
        uint8 tierId,
        uint8 ranking,
        uint8 playersAtRank,
        uint256 winnersPot
    ) external pure returns (uint256) {
        if (ranking == 1) {
            return winnersPot / uint256(playersAtRank);
        }
        return 0;
    }

    // ============ Internal Prize Calculation Helper ============

    /**
     * @dev Internal helper for prize calculation (called by distributePrizes)
     * Simplified: First place gets 100%, everyone else gets 0%
     */
    function _calculatePrizeForRank(
        uint8 tierId,
        uint8 ranking,
        uint8 playersAtRank,
        uint256 winnersPot
    ) internal pure returns (uint256) {
        if (ranking == 1) {
            return winnersPot / uint256(playersAtRank);
        }
        return 0;
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

        // Continue with other resets
        tournament.currentRound = 0;
        tournament.enrolledCount = 0;
        tournament.prizePool = 0;
        tournament.startTime = 0;
        tournament.winner = address(0);
        tournament.finalsWasDraw = false;
        tournament.allDrawResolution = false;
        tournament.allDrawRound = NO_ROUND;
        tournament.completionReason = CompletionReason.NormalWin;

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

        // ARCHITECTURE: Finals are treated like any other match - no special preservation
        // Historical data is available via events (MatchCreated, MatchCompleted)
        // This prevents stale data persistence issues and simplifies the codebase

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

            for (uint8 matchNum = 0; matchNum < matchCount; matchNum++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNum, matchNum);

                // Clear drawParticipants for both match players
                (address p1, address p2) = this._getMatchPlayers(matchId);
                if (p1 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p1];
                }
                if (p2 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p2];
                }

                // Reset ALL matches including finals - no special treatment
                this._resetMatchGame(matchId);
            }
        }
    }

    // ============ Leaderboard Getters ============

    // Note: LeaderboardEntry struct and getLeaderboard() function
    // are now inherited from ETour_Storage

    /**
     * @dev Get count of players on leaderboard
     * EXACT COPY from ETour.sol lines 2438-2440
     */
    function getLeaderboardCount() external view returns (uint256) {
        return _leaderboardPlayers.length;
    }
}
