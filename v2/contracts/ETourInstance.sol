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
 * Game-specific contracts (TicTacInstance, ChessInstance, ConnectFourInstance)
 * inherit this and implement:
 * - _createMatchGame()
 * - _resetMatchGame()
 * - _getMatchResult()
 * - _initializeMatchForPlay()
 * - _completeMatchWithResult()
 * - _completeMatchGameSpecific()
 * - _getTimeIncrement()
 * - _hasCurrentPlayerTimedOut()
 * - makeMove() (game-specific)
 * - initializeRound() (delegates to MODULE_MATCHES)
 *
 * PERMANENT RECORD: Once status == Concluded, all write functions revert
 * (enforced by the `notConcluded` modifier on ETourInstance_Base).
 * The contract's data is readable forever via the view functions.
 */
abstract contract ETourInstance is ETourInstance_Base {

    // ============ Round Initialization (delegates to Matches module) ============

    /**
     * @dev Initialize a round by delegating to the Matches module.
     * Called internally after tournament starts or a round completes.
     */
    function initializeRound(uint8 roundNumber) public override {
        (bool success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("initializeRound(uint8)", roundNumber)
        );
        require(success, "IR");
    }

    // ============ Escalation Entry Points ============

    /**
     * @dev ML2: Advanced player force-eliminates both stalled players.
     * Delegates to Escalation module.
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
