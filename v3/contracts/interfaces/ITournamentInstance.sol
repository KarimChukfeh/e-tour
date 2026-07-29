// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITournamentInstance
 * @dev Minimal interface used by PlayerProfile to read concluded instance state.
 */
interface ITournamentInstance {
    enum TournamentStatus { Enrolling, InProgress, Concluded }

    /**
     * @notice Returns instance info.
     * @return tierKey The tier key.
     * @return playerCount The player count.
     * @return entryFee The entry fee.
     * @return instanceCreator The instance creator.
     * @return createdAt The created at.
     * @return startTime The start time.
     * @return status The status.
     * @return enrolledCount The enrolled count.
     * @return totalEntryFeesAccrued The total entry fees accrued.
     * @return winner The winner.
     * @return completionReason The completion reason.
     * @return completionCategory The completion category.
     * @return prizeAwarded The prize awarded.
     * @return prizeRecipient The prize recipient.
     */
    function getInstanceInfo() external view returns (
        bytes32 tierKey,
        uint8 playerCount,
        uint256 entryFee,
        address instanceCreator,
        uint256 createdAt,
        uint256 startTime,
        TournamentStatus status,
        uint8 enrolledCount,
        uint256 totalEntryFeesAccrued,
        address winner,
        uint8 completionReason,
        uint8 completionCategory,
        uint256 prizeAwarded,
        address prizeRecipient
    );

    /**
     * @notice Returns the recorded player prize.
     * @param player The player address.
     * @return The requested value.
     */
    function playerPrizes(address player) external view returns (uint256);
}
