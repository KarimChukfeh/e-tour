// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPlayerProfile
 * @dev Interface for per-player profile contracts. Used by PlayerRegistry.
 */
interface IPlayerProfile {
    enum PayoutReason {
        None,
        Victory,
        EvenSplit,
        WalletRejected,
        Cancelation
    }

    struct EnrollmentRecord {
        address instance;
        uint8   gameType;
        uint64  enrolledAt;
        uint256 entryFee;
        bool    concluded;
        bool    won;
        uint256 prize;
        uint256 payout;
        uint8   payoutReason;
        uint256 rafflePool;
        bool    wonRaffle;
        uint8   tournamentResolutionReason;
        uint8   tournamentResolutionCategory;
    }

    struct PlayerMatchRecord {
        address instance;
        uint8   gameType;
        uint8   roundNumber;
        uint8   matchNumber;
        uint64  recordedAt;
        uint8   outcome;
        uint8   category;
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
        uint256 prize,
        uint256 payout,
        uint8 payoutReason,
        uint256 rafflePool,
        bool wonRaffle,
        uint8 tournamentResolutionReason,
        uint8 tournamentResolutionCategory
    ) external;

    function recordMatchOutcome(
        address instance,
        uint8 gameType,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 outcome,
        uint8 category
    ) external;

    function getStats() external view returns (PlayerStats memory);

    function getEnrollmentCount() external view returns (uint256);

    function getEnrollments(uint256 offset, uint256 limit)
        external view returns (EnrollmentRecord[] memory);

    function getMatchRecordCount() external view returns (uint256);

    function getMatchRecords(uint256 offset, uint256 limit)
        external view returns (PlayerMatchRecord[] memory);

    function owner() external view returns (address);
}
