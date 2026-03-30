// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPlayerRegistry
 * @dev Interface for the singleton PlayerRegistry. Used by game factories and instances.
 */
interface IPlayerRegistry {
    /**
     * @dev Called by a factory's registerPlayer() on enrollment.
     * Deploys a PlayerProfile clone for the player if they don't have one yet,
     * then records the enrollment on their profile.
     * Only callable by authorized factories.
     */
    function recordEnrollment(
        address player,
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external;

    /**
     * @dev Called by an instance inside _handleTournamentConclusion() for each enrolled player.
     * Records the outcome on the player's profile (best-effort — callers should not revert on failure).
     * Only callable by instances whose parent factory is authorized.
     */
    function recordResult(
        address player,
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

    /**
     * @dev Called by an instance whenever a match resolves.
     * Records the player-specific outcome for that match, including
     * advanced/replacement actors who were not one of the scheduled players.
     */
    function recordMatchOutcome(
        address player,
        address instance,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 outcome,
        uint8 category
    ) external;

    /**
     * @dev Returns the profile contract address for a player in a specific game,
     * or address(0) if none exists for that player/game pair.
     */
    function getProfile(address player, uint8 gameType) external view returns (address);
}
