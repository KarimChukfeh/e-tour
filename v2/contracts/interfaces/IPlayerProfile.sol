// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPlayerProfile
 * @dev Interface for per-player profile contracts. Used by PlayerRegistry.
 */
interface IPlayerProfile {
    struct EnrollmentRecord {
        address instance;
        uint8   gameType;
        uint64  enrolledAt;
        uint256 entryFee;
        bool    concluded;
        bool    won;
        uint256 prize;
    }

    struct PlayerStats {
        uint32 totalPlayed;
        uint32 totalWins;
        uint32 totalLosses;
        int256 totalNetEarnings;
    }

    function initialize(address _owner, address _registry) external;

    function recordEnrollment(
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external;

    function recordResult(
        address instance,
        bool won,
        uint256 prize
    ) external;

    function getStats() external view returns (PlayerStats memory);

    function getEnrollmentCount() external view returns (uint256);

    function getEnrollments(uint256 offset, uint256 limit)
        external view returns (EnrollmentRecord[] memory);

    function owner() external view returns (address);
}
