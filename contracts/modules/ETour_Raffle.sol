// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";

/**
 * @title ETour_Raffle
 * @dev Stateless module for protocol raffle execution
 *
 * This module handles:
 * - Raffle threshold and reserve calculations
 * - Player eligibility checking for raffle participation
 * - Weighted random winner selection based on enrollment counts
 * - Raffle execution with owner/winner distribution (20%/80%)
 * - Raffle state information for UI display
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (accumulatedProtocolShare, tournaments, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 * - msg.value = value sent
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract ETour_Raffle is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
    // This is a bit of a hack - modules inherit ETour_Storage for type definitions
    // but their storage is never used (delegatecall uses game contract's storage)
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Never Called - Modules Use IETourGame Interface) ============
    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override { revert("Module: Use IETourGame"); }
    function _resetMatchGame(bytes32) public override { revert("Module: Use IETourGame"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module: Use IETourGame"); }
    function _getMatchPlayers(bytes32) public view override returns (address, address) { revert("Module: Use IETourGame"); }
    function _setMatchPlayer(bytes32, uint8, address) public override { revert("Module: Use IETourGame"); }
    function _initializeMatchForPlay(bytes32, uint8) public override { revert("Module: Use IETourGame"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module: Use IETourGame"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module: Use IETourGame"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _isMatchActive(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _getActiveMatchData(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory) { revert("Module: Use IETourGame"); }

    // ============ Raffle Configuration Functions ============

    /**
     * @dev Returns the raffle threshold for the current raffle index
     * EXACT COPY from ETour.sol lines 534-547
     */
    function getRaffleThreshold() external view returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise, use the final threshold
        return raffleThresholdFinal;
    }

    /**
     * @dev Internal helper for getting raffle threshold
     * EXACT COPY from ETour.sol lines 534-547
     */
    function _getRaffleThreshold() internal view returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 1 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise, use the final threshold
        return raffleThresholdFinal;
    }

    /**
     * @dev Returns the reserve amount to keep after raffle execution
     * EXACT COPY from ETour.sol lines 555-558
     */
    function getRaffleReserve() external view returns (uint256) {
        uint256 threshold = _getRaffleThreshold();
        return (threshold * 10) / 100;  // 10% of threshold
    }

    /**
     * @dev Internal helper for getting raffle reserve
     * EXACT COPY from ETour.sol lines 555-558
     */
    function _getRaffleReserve() internal view returns (uint256) {
        uint256 threshold = _getRaffleThreshold();
        return (threshold * 10) / 100;  // 10% of threshold
    }

    // ============ Player Eligibility Functions ============

    /**
     * @dev Checks if caller is enrolled in any active tournament
     * EXACT COPY from ETour.sol lines 2732-2755
     */
    function isCallerEnrolledInActiveTournament(address caller) external view returns (bool) {
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only check Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    if (isEnrolled[tierId][instanceId][caller]) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * @dev Internal helper to check if caller is enrolled in active tournament
     * EXACT COPY from ETour.sol lines 2732-2755
     */
    function _isCallerEnrolledInActiveTournament(address caller) internal view returns (bool) {
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only check Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    if (isEnrolled[tierId][instanceId][caller]) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * @dev Gets all enrolled players across active tournaments with enrollment counts
     * EXACT COPY from ETour.sol lines 2763-2840
     */
    function getAllEnrolledPlayersWithWeights()
        external
        view
        returns (
            address[] memory players,
            uint256[] memory weights,
            uint256 totalWeight
        )
    {
        // Use dynamic approach with temporary arrays (max 1000 unique players)
        address[] memory tempPlayers = new address[](1000);
        uint256 uniqueCount = 0;
        totalWeight = 0;

        // First pass: collect unique players and count total enrollments
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only count Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    address[] storage enrolled = enrolledPlayers[tierId][instanceId];

                    for (uint256 i = 0; i < enrolled.length; i++) {
                        address player = enrolled[i];
                        bool found = false;

                        // Check if player already in tempPlayers
                        for (uint256 j = 0; j < uniqueCount; j++) {
                            if (tempPlayers[j] == player) {
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            tempPlayers[uniqueCount] = player;
                            uniqueCount++;
                        }

                        totalWeight++;
                    }
                }
            }
        }

        // Allocate exact-size arrays
        players = new address[](uniqueCount);
        weights = new uint256[](uniqueCount);

        // Second pass: count weights for each unique player
        for (uint256 i = 0; i < uniqueCount; i++) {
            players[i] = tempPlayers[i];
            uint256 playerWeight = 0;

            for (uint8 tierId = 0; tierId < tierCount; tierId++) {
                TierConfig storage config = _tierConfigs[tierId];

                for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                    TournamentInstance storage tournament = tournaments[tierId][instanceId];

                    if ((tournament.status == TournamentStatus.Enrolling ||
                         tournament.status == TournamentStatus.InProgress) &&
                        isEnrolled[tierId][instanceId][players[i]]) {
                        playerWeight++;
                    }
                }
            }

            weights[i] = playerWeight;
        }

        return (players, weights, totalWeight);
    }

    /**
     * @dev Internal helper to get all enrolled players with weights
     * EXACT COPY from ETour.sol lines 2763-2840
     */
    function _getAllEnrolledPlayersWithWeights()
        internal
        view
        returns (
            address[] memory players,
            uint256[] memory weights,
            uint256 totalWeight
        )
    {
        // Use dynamic approach with temporary arrays (max 1000 unique players)
        address[] memory tempPlayers = new address[](1000);
        uint256 uniqueCount = 0;
        totalWeight = 0;

        // First pass: collect unique players and count total enrollments
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only count Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    address[] storage enrolled = enrolledPlayers[tierId][instanceId];

                    for (uint256 i = 0; i < enrolled.length; i++) {
                        address player = enrolled[i];
                        bool found = false;

                        // Check if player already in tempPlayers
                        for (uint256 j = 0; j < uniqueCount; j++) {
                            if (tempPlayers[j] == player) {
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            tempPlayers[uniqueCount] = player;
                            uniqueCount++;
                        }

                        totalWeight++;
                    }
                }
            }
        }

        // Allocate exact-size arrays
        players = new address[](uniqueCount);
        weights = new uint256[](uniqueCount);

        // Second pass: count weights for each unique player
        for (uint256 i = 0; i < uniqueCount; i++) {
            players[i] = tempPlayers[i];
            uint256 playerWeight = 0;

            for (uint8 tierId = 0; tierId < tierCount; tierId++) {
                TierConfig storage config = _tierConfigs[tierId];

                for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                    TournamentInstance storage tournament = tournaments[tierId][instanceId];

                    if ((tournament.status == TournamentStatus.Enrolling ||
                         tournament.status == TournamentStatus.InProgress) &&
                        isEnrolled[tierId][instanceId][players[i]]) {
                        playerWeight++;
                    }
                }
            }

            weights[i] = playerWeight;
        }

        return (players, weights, totalWeight);
    }

    /**
     * @dev Selects winner using weighted random selection (cumulative probability method)
     * EXACT COPY from ETour.sol lines 2850-2875
     */
    function selectWeightedWinner(
        address[] memory players,
        uint256[] memory weights,
        uint256 totalWeight,
        uint256 randomness
    ) external pure returns (address winner) {
        require(players.length > 0, "No players available");
        require(players.length == weights.length, "Array length mismatch");

        // Generate random position in [0, totalWeight)
        uint256 randomPosition = randomness % totalWeight;

        // Find winner using cumulative probability
        uint256 cumulativeWeight = 0;

        for (uint256 i = 0; i < players.length; i++) {
            cumulativeWeight += weights[i];

            if (randomPosition < cumulativeWeight) {
                return players[i];
            }
        }

        // Fallback (should never reach here)
        return players[players.length - 1];
    }

    /**
     * @dev Internal helper for weighted winner selection
     * EXACT COPY from ETour.sol lines 2850-2875
     */
    function _selectWeightedWinner(
        address[] memory players,
        uint256[] memory weights,
        uint256 totalWeight,
        uint256 randomness
    ) internal pure returns (address winner) {
        require(players.length > 0, "No players available");
        require(players.length == weights.length, "Array length mismatch");

        // Generate random position in [0, totalWeight)
        uint256 randomPosition = randomness % totalWeight;

        // Find winner using cumulative probability
        uint256 cumulativeWeight = 0;

        for (uint256 i = 0; i < players.length; i++) {
            cumulativeWeight += weights[i];

            if (randomPosition < cumulativeWeight) {
                return players[i];
            }
        }

        // Fallback (should never reach here)
        return players[players.length - 1];
    }

    // ============ Raffle Execution ============

    /**
     * @dev Executes protocol raffle when accumulated fees exceed threshold
     * EXACT COPY from ETour.sol lines 743-827
     * Note: tierId and instanceId params added for compatibility with game contract delegatecalls,
     * but not used in logic since eligibility is checked across all active tournaments
     */
    function executeProtocolRaffle(uint8, uint8)
        external
        returns (
            address winner,
            uint256 ownerAmount,
            uint256 winnerAmount
        )
    {
        // CHECK 1: Verify threshold met
        uint256 threshold = _getRaffleThreshold();
        require(
            accumulatedProtocolShare >= threshold,
            "Raffle threshold not met"
        );

        // CHECK 2: Verify caller is enrolled in active tournament
        require(
            _isCallerEnrolledInActiveTournament(msg.sender),
            "Only enrolled players can trigger raffle"
        );

        // EFFECT 1: Calculate raffle amount BEFORE incrementing index
        // (reserve must use current threshold, not next threshold)
        uint256 reserve = (threshold * 10) / 100;  // 10% of current threshold
        uint256 raffleAmount = accumulatedProtocolShare - reserve;

        // EFFECT 2: Increment raffle index
        currentRaffleIndex++;
        ownerAmount = (raffleAmount * 20) / 100;  // 20%
        winnerAmount = (raffleAmount * 80) / 100; // 80%

        // EFFECT 3: Update accumulated protocol share (keep reserve)
        accumulatedProtocolShare = reserve;

        // EFFECT 4: Get all enrolled players with weights
        (
            address[] memory players,
            uint256[] memory weights,
            uint256 totalWeight
        ) = _getAllEnrolledPlayersWithWeights();

        require(totalWeight > 0, "No eligible players for raffle");

        // EFFECT 5: Generate randomness and select winner
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            block.number,
            msg.sender,
            accumulatedProtocolShare
        )));

        winner = _selectWeightedWinner(players, weights, totalWeight, randomness);

        // Find winner's enrollment count for event
        uint256 winnerEnrollmentCount = 0;
        for (uint256 i = 0; i < players.length; i++) {
            if (players[i] == winner) {
                winnerEnrollmentCount = weights[i];
                break;
            }
        }

        // EFFECT 6: Emit event
        emit ProtocolRaffleExecuted(
            currentRaffleIndex,
            winner,
            msg.sender,
            raffleAmount,
            ownerAmount,
            winnerAmount,
            accumulatedProtocolShare,
            winnerEnrollmentCount
        );

        // EFFECT 7: Store historic raffle result
        raffleResults[currentRaffleIndex] = RaffleResult({
            executor: msg.sender,
            timestamp: block.timestamp,
            rafflePot: raffleAmount + reserve,
            participants: players,
            weights: weights,
            winner: winner,
            winnerPrize: winnerAmount,
            protocolReserve: reserve,
            ownerShare: ownerAmount
        });

        // INTERACTION 1: Send to owner
        (bool ownerSent, ) = payable(owner).call{value: ownerAmount}("");
        require(ownerSent, "Failed to send owner share");

        // INTERACTION 2: Send to winner
        (bool winnerSent, ) = payable(winner).call{value: winnerAmount}("");
        require(winnerSent, "Failed to send winner share");

        return (winner, ownerAmount, winnerAmount);
    }

    // ============ Raffle Info Getters ============

    /**
     * @dev Returns complete raffle result data for a specific raffle index
     * Needed because public mapping can't return dynamic arrays
     */
    function getRaffleResult(uint256 raffleIndex)
        external
        view
        returns (
            address executor,
            uint256 timestamp,
            uint256 rafflePot,
            address[] memory participants,
            uint256[] memory weights,
            address winner,
            uint256 winnerPrize,
            uint256 protocolReserve,
            uint256 ownerShare
        )
    {
        RaffleResult storage result = raffleResults[raffleIndex];
        return (
            result.executor,
            result.timestamp,
            result.rafflePot,
            result.participants,
            result.weights,
            result.winner,
            result.winnerPrize,
            result.protocolReserve,
            result.ownerShare
        );
    }

    /**
     * @dev Returns detailed raffle state information for client display
     * EXACT COPY from ETour.sol lines 2465-2510
     */
    function getRaffleInfo()
        external
        view
        returns (
            uint256 raffleIndex,
            bool isReady,
            uint256 currentAccumulated,
            uint256 threshold,
            uint256 reserve,
            uint256 raffleAmount,
            uint256 ownerShare,
            uint256 winnerShare,
            uint256 eligiblePlayerCount
        )
    {
        raffleIndex = currentRaffleIndex;
        currentAccumulated = accumulatedProtocolShare;

        // Use virtual functions for threshold and reserve
        threshold = _getRaffleThreshold();
        reserve = _getRaffleReserve();

        isReady = currentAccumulated >= threshold;

        // Always calculate what the distribution WILL BE at threshold
        // This allows clients to display: "When 3 ETH reached, 2 ETH distributed, 1 ETH kept"
        // even before the threshold is reached
        raffleAmount = threshold - reserve;
        ownerShare = (raffleAmount * 20) / 100;
        winnerShare = (raffleAmount * 80) / 100;

        // Count eligible players
        (address[] memory players, , ) = _getAllEnrolledPlayersWithWeights();
        eligiblePlayerCount = players.length;

        return (
            raffleIndex,
            isReady,
            currentAccumulated,
            threshold,
            reserve,
            raffleAmount,
            ownerShare,
            winnerShare,
            eligiblePlayerCount
        );
    }
}
