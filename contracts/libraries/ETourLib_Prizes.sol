// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourLib_Core.sol";

/**
 * @title ETourLib_Prizes
 * @dev Prize distribution library: prizes, raffle, earnings, leaderboard
 * Part 3 of 3-library split to keep each library under 24kB
 */
library ETourLib_Prizes {

    using ETourLib_Core for ETourLib_Core.ETourStorage;

    // ============ Prize Distribution ============

    struct PrizeDistributionPlan {
        address[] recipients;
        uint256[] amounts;
        uint8[] rankings;
        uint256 totalDistributed;
    }

    function calculatePrizeDistribution(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId
    ) external view returns (PrizeDistributionPlan memory plan) {
        ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];
        uint8[] storage percentages = self.tierPrizeDistribution[tierId];

        uint256 prizePool = tournament.prizePool;
        uint8 recipientCount = uint8(percentages.length);

        plan.recipients = new address[](recipientCount);
        plan.amounts = new uint256[](recipientCount);
        plan.rankings = new uint8[](recipientCount);

        for (uint8 rank = 1; rank <= recipientCount; rank++) {
            address[] memory playersAtRank = getPlayersAtRanking(self, tierId, instanceId, rank);

            if (playersAtRank.length > 0) {
                uint256 rankPrize = (prizePool * percentages[rank - 1]) / 100;

                if (playersAtRank.length == 1) {
                    plan.recipients[rank - 1] = playersAtRank[0];
                    plan.amounts[rank - 1] = rankPrize;
                    plan.rankings[rank - 1] = rank;
                    plan.totalDistributed += rankPrize;
                } else {
                    uint256 sharedPrize = rankPrize / playersAtRank.length;
                    for (uint256 i = 0; i < playersAtRank.length; i++) {
                        // For multiple winners, we handle distribution separately
                        plan.totalDistributed += sharedPrize;
                    }
                }
            }
        }

        return plan;
    }

    function getPlayersAtRanking(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 ranking
    ) internal view returns (address[] memory) {
        address[] storage enrolled = self.enrolledPlayers[tierId][instanceId];
        uint256 count = 0;

        for (uint256 i = 0; i < enrolled.length; i++) {
            if (self.playerRanking[tierId][instanceId][enrolled[i]] == ranking) {
                count++;
            }
        }

        address[] memory players = new address[](count);
        uint256 index = 0;

        for (uint256 i = 0; i < enrolled.length; i++) {
            address player = enrolled[i];
            if (self.playerRanking[tierId][instanceId][player] == ranking) {
                players[index] = player;
                index++;
            }
        }

        return players;
    }

    // ============ Player Earnings Management ============

    function updatePlayerEarnings(
        ETourLib_Core.ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        address player
    ) external {
        ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
        uint256 prize = self.playerPrizes[tierId][instanceId][player];
        int256 entryFee = int256(config.entryFee);
        int256 netEarnings = int256(prize) - entryFee;

        self.playerEarnings[player] += netEarnings;

        if (!self.isOnLeaderboard[player]) {
            self.leaderboardPlayers.push(player);
            self.isOnLeaderboard[player] = true;
        }
    }

    function getLeaderboard(
        ETourLib_Core.ETourStorage storage self
    ) external view returns (ETourLib_Core.LeaderboardEntry[] memory) {
        uint256 count = self.leaderboardPlayers.length;
        ETourLib_Core.LeaderboardEntry[] memory entries = new ETourLib_Core.LeaderboardEntry[](count);

        for (uint256 i = 0; i < count; i++) {
            address player = self.leaderboardPlayers[i];
            entries[i] = ETourLib_Core.LeaderboardEntry({
                player: player,
                netEarnings: self.playerEarnings[player]
            });
        }

        // Bubble sort for small arrays
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (entries[j].netEarnings > entries[i].netEarnings) {
                    ETourLib_Core.LeaderboardEntry memory temp = entries[i];
                    entries[i] = entries[j];
                    entries[j] = temp;
                }
            }
        }

        return entries;
    }

    // ============ Raffle System ============

    struct RaffleResult {
        address winner;
        uint256 raffleAmount;
        uint256 ownerAmount;
        uint256 winnerAmount;
        uint256 remainingReserve;
        uint256 winnerEnrollmentCount;
    }

    function executeRaffleLogic(
        ETourLib_Core.ETourStorage storage self,
        address caller
    ) external returns (RaffleResult memory result) {
        uint256 threshold = getRaffleThreshold(self);
        require(self.accumulatedProtocolShare >= threshold, "Raffle threshold not met");
        require(isCallerEnrolledInActiveTournament(self, caller), "Only enrolled players can trigger raffle");

        self.currentRaffleIndex++;

        uint256 reserve = getRaffleReserve(self);
        result.raffleAmount = self.accumulatedProtocolShare - reserve;
        result.ownerAmount = (result.raffleAmount * 20) / 100;
        result.winnerAmount = (result.raffleAmount * 80) / 100;

        self.accumulatedProtocolShare = reserve;
        result.remainingReserve = reserve;

        (address[] memory players, uint256[] memory weights, uint256 totalWeight) =
            getAllEnrolledPlayersWithWeights(self);

        require(totalWeight > 0, "No eligible players for raffle");

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            block.number,
            caller,
            self.accumulatedProtocolShare
        )));

        result.winner = selectWeightedWinner(players, weights, totalWeight, randomness);

        for (uint256 i = 0; i < players.length; i++) {
            if (players[i] == result.winner) {
                result.winnerEnrollmentCount = weights[i];
                break;
            }
        }

        return result;
    }

    function getRaffleThreshold(ETourLib_Core.ETourStorage storage self) internal view returns (uint256) {
        uint256 index = self.currentRaffleIndex;
        if (index < self.raffleThresholds.length) {
            return self.raffleThresholds[index];
        }
        return self.raffleThresholdFinal > 0 ? self.raffleThresholdFinal : 3 ether;
    }

    function getRaffleReserve(ETourLib_Core.ETourStorage storage self) internal view returns (uint256) {
        uint256 threshold = getRaffleThreshold(self);
        return threshold / 2;
    }

    function isCallerEnrolledInActiveTournament(
        ETourLib_Core.ETourStorage storage self,
        address player
    ) internal view returns (bool) {
        for (uint8 tierId = 0; tierId < self.tierCount; tierId++) {
            ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
            if (!config.initialized) continue;

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

                if (tournament.status != ETourLib_Core.TournamentStatus.Enrolling &&
                    tournament.status != ETourLib_Core.TournamentStatus.InProgress) {
                    continue;
                }

                if (self.isEnrolled[tierId][instanceId][player]) {
                    return true;
                }
            }
        }
        return false;
    }

    function getAllEnrolledPlayersWithWeights(
        ETourLib_Core.ETourStorage storage self
    ) internal view returns (
        address[] memory players,
        uint256[] memory weights,
        uint256 totalWeight
    ) {
        uint256 maxPlayers = 1000;
        address[] memory tempPlayers = new address[](maxPlayers);
        uint256[] memory tempWeights = new uint256[](maxPlayers);
        uint256 playerCount = 0;

        for (uint8 tierId = 0; tierId < self.tierCount; tierId++) {
            ETourLib_Core.TierConfig storage config = self.tierConfigs[tierId];
            if (!config.initialized) continue;

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                ETourLib_Core.TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

                if (tournament.status != ETourLib_Core.TournamentStatus.Enrolling &&
                    tournament.status != ETourLib_Core.TournamentStatus.InProgress) {
                    continue;
                }

                address[] storage enrolled = self.enrolledPlayers[tierId][instanceId];
                for (uint256 i = 0; i < enrolled.length; i++) {
                    address player = enrolled[i];

                    bool found = false;
                    for (uint256 j = 0; j < playerCount; j++) {
                        if (tempPlayers[j] == player) {
                            tempWeights[j]++;
                            totalWeight++;
                            found = true;
                            break;
                        }
                    }

                    if (!found && playerCount < maxPlayers) {
                        tempPlayers[playerCount] = player;
                        tempWeights[playerCount] = 1;
                        totalWeight++;
                        playerCount++;
                    }
                }
            }
        }

        players = new address[](playerCount);
        weights = new uint256[](playerCount);

        for (uint256 i = 0; i < playerCount; i++) {
            players[i] = tempPlayers[i];
            weights[i] = tempWeights[i];
        }

        return (players, weights, totalWeight);
    }

    function selectWeightedWinner(
        address[] memory players,
        uint256[] memory weights,
        uint256 totalWeight,
        uint256 randomness
    ) internal pure returns (address) {
        uint256 selection = randomness % totalWeight;
        uint256 cumulativeWeight = 0;

        for (uint256 i = 0; i < players.length; i++) {
            cumulativeWeight += weights[i];
            if (selection < cumulativeWeight) {
                return players[i];
            }
        }

        return players[players.length - 1];
    }

    // ============ Prize Sending Helpers ============

    function sendPrizeWithFallback(
        address recipient,
        uint256 amount
    ) external returns (bool success) {
        if (amount == 0) return true;

        (success, ) = payable(recipient).call{value: amount, gas: 10000}("");
        return success;
    }
}
