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
        uint8   tournamentResolutionReason;
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

    /**
     * @notice Initializes.
     * @param _owner The owner address.
     * @param _registry The registry address.
     */
    function initialize(address _owner, address _registry) external;

    /**
     * @notice Records enrollment.
     * @param instance The instance address.
     * @param gameType The game type value.
     * @param entryFee The entry fee value.
     */
    function recordEnrollment(
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external;

    /**
     * @notice Records result.
     * @param instance The instance address.
     * @param won Whether won.
     * @param prize The prize value.
     * @param payout The payout value.
     * @param payoutReason The payout reason value.
     * @param tournamentResolutionReason The tournament resolution reason value.
     */
    function recordResult(
        address instance,
        bool won,
        uint256 prize,
        uint256 payout,
        uint8 payoutReason,
        uint8 tournamentResolutionReason
    ) external;

    /**
     * @notice Records match outcome.
     * @param instance The instance address.
     * @param gameType The game type value.
     * @param roundNumber The round number value.
     * @param matchNumber The match number value.
     * @param outcome The outcome value.
     * @param category The category value.
     */
    function recordMatchOutcome(
        address instance,
        uint8 gameType,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 outcome,
        uint8 category
    ) external;

    /**
     * @notice Returns stats.
     * @return The requested value.
     */
    function getStats() external view returns (PlayerStats memory);

    /**
     * @notice Returns enrollment count.
     * @return The requested value.
     */
    function getEnrollmentCount() external view returns (uint256);

    /**
     * @notice Returns enrollments.
     * @param offset The offset value.
     * @param limit The limit value.
     * @return The requested value.
     */
    function getEnrollments(uint256 offset, uint256 limit)
        external view returns (EnrollmentRecord[] memory);

    /**
     * @notice Returns match record count.
     * @return The requested value.
     */
    function getMatchRecordCount() external view returns (uint256);

    /**
     * @notice Returns match records.
     * @param offset The offset value.
     * @param limit The limit value.
     * @return The requested value.
     */
    function getMatchRecords(uint256 offset, uint256 limit)
        external view returns (PlayerMatchRecord[] memory);

    /**
     * @notice Returns the primary wallet owner.
     * @return The requested value.
     */
    function owner() external view returns (address);
}
