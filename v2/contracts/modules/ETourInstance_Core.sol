// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourInstance_Base.sol";

/**
 * @title ETourInstance_Core
 * @dev Stateless module for enrollment and tournament start logic.
 *
 * Adapted from ETour_Core for the new single-instance architecture:
 * - No tierId/instanceId parameters — operates on flat instance storage
 * - No registerTier() — tier config is baked in at initialize()
 * - No resetTournamentAfterCompletion() — instances are permanent records
 * - No resetEnrollmentWindow() — instances don't cycle
 * - Fee routing: owner share goes to factory.owner(), protocol share to factory
 * - On enrollment, registers player on factory via factory.registerPlayer()
 *
 * DELEGATECALL SEMANTICS: All storage reads/writes target the instance contract's
 * storage (not this module's). address(this) = instance address when called via
 * delegatecall.
 */
contract ETourInstance_Core is ETourInstance_Base {

    constructor() {}

    // ============ Abstract Stubs (required for deployment, never called directly) ============

    function _createMatchGame(uint8, uint8, address, address) public override { revert("Module stub"); }
    function _resetMatchGame(bytes32) public override { revert("Module stub"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module stub"); }
    function _initializeMatchForPlay(bytes32) public override { revert("Module stub"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module stub"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module stub"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module stub"); }
    function initializeRound(uint8) public payable override { revert("Module stub"); }

    // ============ Enrollment ============

    /**
     * @dev Enroll caller in this instance.
     * Called via delegatecall from ETourInstance_Base.enrollInTournament().
     * msg.sender = original caller, msg.value = entry fee.
     */
    function coreEnroll() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(!isEnrolled[msg.sender], "Already enrolled");
        require(tournament.enrolledCount < tierConfig.playerCount, "Instance full");
        require(msg.value == tierConfig.entryFee, "Incorrect entry fee");

        // Lazy-initialize enrollment timeout on first enrollment
        if (tournament.enrolledCount == 0) {
            tournament.enrollmentTimeout.escalation1Start =
                block.timestamp + tierConfig.timeouts.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start =
                tournament.enrollmentTimeout.escalation1Start +
                tierConfig.timeouts.enrollmentLevel2Delay;
            tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
            tournament.enrollmentTimeout.forfeitPool = 0;
        }

        uint256 participantsShare = (msg.value * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        uint256 ownerShare = (msg.value * OWNER_SHARE_BPS) / BASIS_POINTS;
        uint256 protocolShare = (msg.value * PROTOCOL_SHARE_BPS) / BASIS_POINTS;

        tournament.enrollmentTimeout.forfeitPool += participantsShare;
        tournament.prizePool += participantsShare;

        // Owner share → factory (factory forwards to its owner)
        (bool ownerOk, ) = payable(factory).call{value: ownerShare}(
            abi.encodeWithSignature("receiveOwnerShare()")
        );
        require(ownerOk, "Owner fee transfer failed");

        // Protocol share → factory (for raffle accumulation)
        (bool protocolOk, ) = payable(factory).call{value: protocolShare}(
            abi.encodeWithSignature("receiveProtocolShare()")
        );
        require(protocolOk, "Protocol fee transfer failed");

        enrolledPlayers.push(msg.sender);
        isEnrolled[msg.sender] = true;
        tournament.enrolledCount++;

        if (tournament.enrolledCount == tierConfig.playerCount) {
            _startTournament();
        }
    }

    /**
     * @dev Enroll a specific player on their behalf.
     * Called via delegatecall from ETourInstance_Base.enrollOnBehalf().
     * Identical to coreEnroll() but uses the provided player address instead of msg.sender.
     */
    function coreEnrollOnBehalf(address player) external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(!isEnrolled[player], "Already enrolled");
        require(tournament.enrolledCount < tierConfig.playerCount, "Instance full");
        require(msg.value == tierConfig.entryFee, "Incorrect entry fee");

        // Lazy-initialize enrollment timeout on first enrollment
        if (tournament.enrolledCount == 0) {
            tournament.enrollmentTimeout.escalation1Start =
                block.timestamp + tierConfig.timeouts.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start =
                tournament.enrollmentTimeout.escalation1Start +
                tierConfig.timeouts.enrollmentLevel2Delay;
            tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
            tournament.enrollmentTimeout.forfeitPool = 0;
        }

        uint256 participantsShare = (msg.value * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        uint256 ownerShare = (msg.value * OWNER_SHARE_BPS) / BASIS_POINTS;
        uint256 protocolShare = (msg.value * PROTOCOL_SHARE_BPS) / BASIS_POINTS;

        tournament.enrollmentTimeout.forfeitPool += participantsShare;
        tournament.prizePool += participantsShare;

        (bool ownerOk, ) = payable(factory).call{value: ownerShare}(
            abi.encodeWithSignature("receiveOwnerShare()")
        );
        require(ownerOk, "Owner fee transfer failed");

        (bool protocolOk, ) = payable(factory).call{value: protocolShare}(
            abi.encodeWithSignature("receiveProtocolShare()")
        );
        require(protocolOk, "Protocol fee transfer failed");

        enrolledPlayers.push(player);
        isEnrolled[player] = true;
        tournament.enrolledCount++;

        if (tournament.enrolledCount == tierConfig.playerCount) {
            _startTournament();
        }
    }

    /**
     * @dev Force start if enrollment window expired and caller is enrolled.
     * Called via delegatecall from ETourInstance_Base.forceStartTournament().
     */
    function coreForceStart() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(isEnrolled[msg.sender], "Not enrolled");
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation1Start,
            "Enrollment window not expired"
        );
        require(tournament.enrolledCount >= 1, "Need at least 1 player");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        _startTournament();
    }

    /**
     * @dev Claim abandoned enrollment pool (EL2).
     * Anyone can call after escalation2Start if pool is non-empty.
     */
    function coreClaimAbandonedPool() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation2Start,
            "EL2 window not reached"
        );
        require(tournament.enrolledCount > 0, "No pool to claim");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;

        uint256 claimAmount = tournament.enrollmentTimeout.forfeitPool;
        tournament.enrollmentTimeout.forfeitPool = 0;

        tournament.status = TournamentStatus.Concluded;
        tournament.completionReason = CompletionReason.AbandonedTournamentClaimed;
        tournament.winner = msg.sender;

        (bool ok, ) = payable(msg.sender).call{value: claimAmount}("");
        require(ok, "Transfer failed");
    }

    // ============ Tournament Start ============

    function _startTournament() internal {
        tournament.status = TournamentStatus.InProgress;
        tournament.startTime = block.timestamp;
        tournament.currentRound = 0;

        uint8 playerCount = tournament.enrolledCount;
        if (playerCount <= 1) {
            tournament.actualTotalRounds = 0;
        } else {
            uint8 log2Floor = _log2(playerCount);
            bool isPow2 = (playerCount & (playerCount - 1)) == 0;
            tournament.actualTotalRounds = isPow2 ? log2Floor : log2Floor + 1;
        }

        if (tournament.enrolledCount == 1) {
            address soloWinner = enrolledPlayers[0];
            tournament.winner = soloWinner;
            tournament.status = TournamentStatus.Concluded;
            tournament.completionReason = CompletionReason.SoloEnrollForceStart;

            uint256 winnersPot = tournament.prizePool;
            playerPrizes[soloWinner] = winnersPot;

            if (winnersPot > 0) {
                (bool sent, ) = payable(soloWinner).call{value: winnersPot}("");
                if (!sent) {
                    // Fallback: send to factory protocol accumulator
                    (bool fallbackOk, ) = payable(factory).call{value: winnersPot}(
                        abi.encodeWithSignature("receiveProtocolShare()")
                    );
                    // Ignore fallback result — funds stay in contract if factory also fails
                    fallbackOk;
                }
            }
            // Note: TournamentConcluded event is emitted by the instance after forceStartTournament returns
        }
        // Note: initializeRound(0) is called by the instance after this returns
    }

    // ============ Enrollment Window Reset ============
    // NOTE: resetEnrollmentWindow is INTENTIONALLY OMITTED.
    // Instances are single-use. If you want a fresh enrollment window, deploy a new instance.

    // ============ View Helpers ============

    function canClaimAbandonedPool() external view returns (bool) {
        return tournament.status == TournamentStatus.Enrolling &&
               block.timestamp >= tournament.enrollmentTimeout.escalation2Start &&
               tournament.enrolledCount > 0;
    }

    function canForceStart() external view returns (bool) {
        return tournament.status == TournamentStatus.Enrolling &&
               isEnrolled[msg.sender] &&
               block.timestamp >= tournament.enrollmentTimeout.escalation1Start &&
               tournament.enrolledCount >= 1;
    }
}
