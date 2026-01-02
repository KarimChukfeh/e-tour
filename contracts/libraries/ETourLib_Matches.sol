// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourLib_Core.sol";

/**
 * @title ETourLib_Matches
 * @dev Match lifecycle library: tournament start, rounds, match completion, brackets
 * Part 2 of 3-library split to keep each library under 24kB
 */
library ETourLib_Matches {

    using ETourLib_Core for ETourLib_Core.ETourStorage;

    // ============ Tournament Start Logic ============

    function startTournamentLogic(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId
    ) external returns (
        bool isSoloWinner,
        address soloWinnerAddress,
        uint256 soloWinnerPrize
    ) {
        ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];
        tournament.status = ETourLib_Core.TournamentStatus.InProgress;
        tournament.startTime = block.timestamp;
        tournament.currentRound = 0;

        if (tournament.enrolledCount == 1) {
            soloWinnerAddress = self.enrolledPlayers[tierId][instanceId][0];
            tournament.winner = soloWinnerAddress;
            tournament.status = ETourLib_Core.TournamentStatus.Completed;
            self.playerRanking[tierId][instanceId][soloWinnerAddress] = 1;

            soloWinnerPrize = tournament.prizePool;
            self.playerPrizes[tierId][instanceId][soloWinnerAddress] = soloWinnerPrize;

            self.playerStats[soloWinnerAddress].tournamentsWon++;
            self.playerStats[soloWinnerAddress].tournamentsPlayed++;

            return (true, soloWinnerAddress, soloWinnerPrize);
        }

        return (false, address(0), 0);
    }

    // ============ Round Logic ============

    function initializeRoundLogic(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) external returns (
        uint8 matchCount,
        bool hasWalkover,
        address walkoverPlayer,
        address[] memory playerPairs
    ) {
        ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
        ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

        // For round 0, use actual enrolled count (may be less than config if force started)
        // For subsequent rounds, calculate based on previous round winners
        uint8 playerCount = (roundNumber == 0) ? tournament.enrolledCount : config.playerCount;
        matchCount = ETourLib_Core.getMatchCountForRound(playerCount, roundNumber);

        ETourLib_Core.Round storage round = self.rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.allMatchesDrew = false;

        if (roundNumber == 0) {
            address[] storage players = self.enrolledPlayers[tierId][instanceId];

            if (tournament.enrolledCount % 2 == 1) {
                hasWalkover = true;
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

                tournament.enrolledCount--;
            }

            uint256 pairCount = tournament.enrolledCount;
            playerPairs = new address[](pairCount);
            for (uint256 i = 0; i < pairCount; i++) {
                playerPairs[i] = players[i];
            }
        }

        return (matchCount, hasWalkover, walkoverPlayer, playerPairs);
    }

    // ============ Match Completion Logic ============

    struct MatchCompletionResult {
        bool isDraw;
        address player1;
        address player2;
        address winner;
        address loser;
        bool shouldAdvanceWinner;
        uint8 nextRound;
        uint8 nextMatchNumber;
        bool roundCompleted;
        bool isDrawRound;
    }

    function completeMatchLogic(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        address player1,
        address player2
    ) external returns (MatchCompletionResult memory result) {
        result.isDraw = isDraw;
        result.player1 = player1;
        result.player2 = player2;
        result.winner = winner;

        // Mark participants in draw if applicable
        if (isDraw) {
            self.drawParticipants[tierId][instanceId][roundNumber][matchNumber][player1] = true;
            self.drawParticipants[tierId][instanceId][roundNumber][matchNumber][player2] = true;
            result.loser = address(0);
        } else {
            result.loser = (player1 == winner) ? player2 : player1;
        }

        // Update player stats
        self.playerStats[player1].matchesPlayed++;
        self.playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            self.playerStats[winner].matchesWon++;
        }

        // Update round progress
        ETourLib_Core.Round storage round = self.rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        // Check if round is complete
        result.roundCompleted = (round.completedMatches == round.totalMatches);
        result.isDrawRound = (result.roundCompleted && round.drawCount == round.totalMatches && round.totalMatches > 0);

        // Determine if winner should advance
        ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
        result.shouldAdvanceWinner = (!isDraw && roundNumber < config.totalRounds - 1);

        if (result.shouldAdvanceWinner) {
            result.nextRound = roundNumber + 1;
            result.nextMatchNumber = matchNumber / 2;
        }

        return result;
    }

    // ============ Round Completion Logic ============

    struct RoundCompletionResult {
        bool isFinals;
        bool finalsWasDraw;
        address finalWinner;
        address finalCoWinner;
        bool shouldDistributePrizes;
        bool isAllDrawRound;
        address[] remainingPlayers;
        bool shouldAdvanceToNextRound;
    }

    function completeRoundLogic(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) external returns (RoundCompletionResult memory result) {
        ETourLib_Core.Round storage round = self.rounds[tierId][instanceId][roundNumber];
        ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];
        ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];

        // Check if this is finals
        result.isFinals = (roundNumber == config.totalRounds - 1) ||
                          (roundNumber > 0 && round.totalMatches == 1 && round.completedMatches == 1);

        if (result.isFinals) {
            // Set winner ranking for prize distribution
            // Winner must be determined from the finals match
            bytes32 finalMatchId = ETourLib_Core.getMatchId(tierId, instanceId, roundNumber, 0);

            // Find the winner from enrolled players who hasn't been eliminated
            address[] storage enrolled = self.enrolledPlayers[tierId][instanceId];
            for (uint256 i = 0; i < enrolled.length; i++) {
                address player = enrolled[i];
                // Winner is the player with no ranking yet (hasn't been eliminated)
                if (self.playerRanking[tierId][instanceId][player] == 0) {
                    tournament.winner = player;
                    self.playerRanking[tierId][instanceId][player] = 1;
                    // Note: playerPrizes will be set during prize distribution
                    self.playerStats[player].tournamentsWon++;
                    break;
                }
            }

            result.shouldDistributePrizes = true;
            return result;
        }

        // Check for all-draw round
        if (round.drawCount == round.totalMatches && round.totalMatches > 0) {
            result.isAllDrawRound = true;
            result.shouldDistributePrizes = true;
            return result;
        }

        // Normal progression to next round
        result.shouldAdvanceToNextRound = true;
        tournament.currentRound = roundNumber + 1;

        return result;
    }

    // ============ Player Active Match Management ============

    function addPlayerActiveMatch(
        ETourLib_Core.ETourStorage storage self,
        address player,
        bytes32 matchId
    ) external {
        self.playerActiveMatches[player].push(matchId);
        self.playerMatchIndex[player][matchId] = self.playerActiveMatches[player].length - 1;
    }

    function removePlayerActiveMatch(
        ETourLib_Core.ETourStorage storage self,
        address player,
        bytes32 matchId
    ) external {
        uint256 index = self.playerMatchIndex[player][matchId];
        uint256 lastIndex = self.playerActiveMatches[player].length - 1;

        if (index != lastIndex) {
            bytes32 lastMatchId = self.playerActiveMatches[player][lastIndex];
            self.playerActiveMatches[player][index] = lastMatchId;
            self.playerMatchIndex[player][lastMatchId] = index;
        }

        self.playerActiveMatches[player].pop();
        delete self.playerMatchIndex[player][matchId];
    }

    // ============ Tournament Reset Logic ============

    function resetTournamentLogic(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId
    ) external {
        ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

        tournament.status = ETourLib_Core.TournamentStatus.Enrolling;
        tournament.enrolledCount = 0;
        tournament.prizePool = 0;
        tournament.startTime = 0;
        tournament.currentRound = 0;
        tournament.winner = address(0);
        tournament.coWinner = address(0);
        tournament.finalsWasDraw = false;
        tournament.allDrawResolution = false;
        tournament.allDrawRound = ETourLib_Core.NO_ROUND;
        tournament.hasStartedViaTimeout = false;

        tournament.enrollmentTimeout.escalation1Start = 0;
        tournament.enrollmentTimeout.escalation2Start = 0;
        tournament.enrollmentTimeout.activeEscalation = ETourLib_Core.EscalationLevel.None;
        tournament.enrollmentTimeout.forfeitPool = 0;

        address[] storage players = self.enrolledPlayers[tierId][instanceId];
        uint256 playerCount = players.length;

        for (uint256 i = 0; i < playerCount; i++) {
            address player = players[i];
            self.isEnrolled[tierId][instanceId][player] = false;
        }

        delete self.enrolledPlayers[tierId][instanceId];
    }

    // ============ Ranking Assignment ============

    function assignRankingOnElimination(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address player
    ) external {
        if (self.playerRanking[tierId][instanceId][player] != 0) {
            return;
        }

        ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
        uint8 totalRounds = config.totalRounds;
        uint8 remainingRounds = totalRounds - roundNumber;
        uint8 ranking = uint8(2 ** remainingRounds);

        self.playerRanking[tierId][instanceId][player] = ranking;
    }

    // ============ Escalation State Management ============

    function clearEscalationState(
        ETourLib_Core.ETourStorage storage self,
        bytes32 matchId
    ) external {
        delete self.matchTimeouts[matchId];
    }

    function markMatchStalled(
        ETourLib_Core.ETourStorage storage self,
        bytes32 matchId,
        uint256 matchTimePerPlayer,
        uint256 matchLevel2Delay
    ) external {
        ETourLib_Core.MatchTimeoutState storage timeout = self.matchTimeouts[matchId];

        if (!timeout.isStalled) {
            timeout.isStalled = true;
            timeout.escalation1Start = block.timestamp;
            timeout.escalation2Start = block.timestamp + matchLevel2Delay;
            timeout.activeEscalation = ETourLib_Core.EscalationLevel.Escalation1_OpponentClaim;
        }
    }
}
