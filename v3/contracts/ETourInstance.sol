// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourInstance_Base.sol";

/**
 * @title ETourInstance
 * @dev Abstract implementation contract for ETour tournament instances.
 *
 * This is the contract that gets deployed once per game type as the EIP-1167
 * implementation. Cheap clones point to this; each clone holds state for one
 * tournament instance.
 *
 * ETourGame inherits this contract to provide the canonical shared game
 * lifecycle. Concrete games only implement the narrow game hook surface and
 * their game-specific move/view functions.
 *
 * PERMANENT RECORD: Once status == Concluded, all write functions revert
 * (enforced by the `notConcluded` modifier on ETourInstance_Base).
 * The contract's data is readable forever via the view functions.
 */
abstract contract ETourInstance is ETourInstance_Base {

    // ============ Escalation Entry Points ============

    /**
     * @dev ML2: Advanced player force-eliminates both stalled players.
     * Delegates to Escalation module.
     * @param roundNumber The round number value.
     * @param matchNumber The match number value.
     */
    function forceEliminateStalledMatch(uint8 roundNumber, uint8 matchNumber)
        external
        notConcluded
        nonReentrant
    {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "forceEliminateStalledMatch(uint8,uint8)",
                roundNumber, matchNumber
            )
        );
        require(success, "ML2");
        _handleTournamentConclusion();
    }

    /**
     * @dev ML3: External player replaces stalled players and takes the match.
     * Delegates to Escalation module.
     * @param roundNumber The round number value.
     * @param matchNumber The match number value.
     */
    function claimMatchSlotByReplacement(uint8 roundNumber, uint8 matchNumber)
        external
        notConcluded
        nonReentrant
    {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "claimMatchSlotByReplacement(uint8,uint8)",
                roundNumber, matchNumber
            )
        );
        require(success, "ML3");
        _handleTournamentConclusion();
    }
}
