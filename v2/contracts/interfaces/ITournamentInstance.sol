// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITournamentInstance
 * @dev Minimal interface used by PlayerProfile to read concluded instance state.
 */
interface ITournamentInstance {
    enum TournamentStatus { Enrolling, InProgress, Concluded }

    function getInstanceInfo() external view returns (
        bytes32 tierKey,
        uint8 playerCount,
        uint256 entryFee,
        address instanceCreator,
        uint256 createdAt,
        uint256 startTime,
        TournamentStatus status,
        uint8 enrolledCount,
        address winner,
        uint8 completionReason
    );

    function playerPrizes(address player) external view returns (uint256);
}
