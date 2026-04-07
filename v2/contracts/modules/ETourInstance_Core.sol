// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourTournamentBase.sol";

/**
 * @title ETourInstance_Core
 * @dev Stateless module for enrollment and tournament start logic.
 *
 * Adapted from ETour_Core for the new single-instance architecture:
 * - No tierId/instanceId parameters — operates on flat instance storage
 * - No registerTier() — tier config is baked in at initialize()
 * - No resetTournamentAfterCompletion() — instances are permanent records
 * - Solo player may reset the enrollment window without cycling instance state
 * - Fee routing: owner share goes to factory.owner()
 * - On enrollment, registers player on factory via factory.registerPlayer()
 *
 * DELEGATECALL SEMANTICS: All storage reads/writes target the instance contract's
 * storage (not this module's). address(this) = instance address when called via
 * delegatecall.
 */
contract ETourInstance_Core is ETourTournamentBase {

    constructor() {}

    // ============ Abstract Stubs (required for deployment, never called directly) ============

    function moduleCreateMatch(uint8, uint8, address, address) public override { revert("Module stub"); }
    function moduleResetMatch(bytes32) public override { revert("Module stub"); }
    function moduleInitializeMatchForPlay(bytes32) public override { revert("Module stub"); }
    function initializeRound(uint8) public payable override { revert("Module stub"); }

    // ============ Enrollment ============

    /**
     * @dev Enroll caller in this instance.
     * Called via delegatecall from ETourTournamentBase.enrollInTournament().
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
        // All fee buckets stay on the instance until conclusion.
        // forfeitPool holds full entry fee so EL1/EL2 can refund 100%.
        tournament.totalEntryFeesAccrued += msg.value;
        tournament.prizePool += participantsShare;
        tournament.ownerAccrued += ownerShare;
        tournament.enrollmentTimeout.forfeitPool += msg.value;

        enrolledPlayers.push(msg.sender);
        isEnrolled[msg.sender] = true;
        tournament.enrolledCount++;

        if (tournament.enrolledCount == tierConfig.playerCount) {
            _startTournament();
        }
    }

    /**
     * @dev Enroll a specific player on their behalf.
     * Called via delegatecall from ETourTournamentBase.enrollOnBehalf().
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
        // All fee buckets stay on the instance until conclusion.
        // forfeitPool holds full entry fee so EL1/EL2 can refund 100%.
        tournament.totalEntryFeesAccrued += msg.value;
        tournament.prizePool += participantsShare;
        tournament.ownerAccrued += ownerShare;
        tournament.enrollmentTimeout.forfeitPool += msg.value;

        enrolledPlayers.push(player);
        isEnrolled[player] = true;
        tournament.enrolledCount++;

        if (tournament.enrolledCount == tierConfig.playerCount) {
            _startTournament();
        }
    }

    /**
     * @dev Cancel a solo-enrolled tournament at any time while enrollment is open.
     * Called via delegatecall from ETourTournamentBase.cancelTournament().
     */
    function coreCancelTournament() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(isEnrolled[msg.sender], "Not enrolled");
        require(tournament.enrolledCount == 1, "Only solo player can cancel");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation0_SoloCancel;
        tournament.status = TournamentStatus.Concluded;
        tournament.winner = msg.sender;
        _setTournamentResolution(TournamentResolutionReason.SoloEnrollCancelled);

        _refundSoloPlayer(msg.sender);
    }

    /**
     * @dev Reset enrollment deadlines for a solo-enrolled tournament at any time.
     * Called via delegatecall from ETourTournamentBase.resetEnrollmentWindow().
     */
    function coreResetEnrollmentWindow() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(isEnrolled[msg.sender], "Not enrolled");
        require(tournament.enrolledCount == 1, "Only solo player can reset");

        tournament.enrollmentTimeout.escalation1Start =
            block.timestamp + tierConfig.timeouts.enrollmentWindow;
        tournament.enrollmentTimeout.escalation2Start =
            tournament.enrollmentTimeout.escalation1Start +
            tierConfig.timeouts.enrollmentLevel2Delay;
        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
    }

    /**
     * @dev Force start if enrollment window expired and caller is enrolled.
     * Requires at least 2 enrolled players.
     * Called via delegatecall from ETourTournamentBase.forceStartTournament().
     */
    function coreForceStart() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(isEnrolled[msg.sender], "Not enrolled");
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation1Start,
            "Enrollment window not expired"
        );
        require(tournament.enrolledCount >= 2, "Need at least 2 players");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        _startTournament();
    }

    /**
     * @dev Claim abandoned tournament resolution (EL2).
     * Anyone can call after escalation2Start if at least one player enrolled.
     * The caller becomes the tournament winner for the 95% prize pool, while
     * the deferred owner share still executes normally.
     */
    function coreClaimAbandonedPool() external payable onlyDelegateCall {
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation2Start,
            "EL2 window not reached"
        );
        require(tournament.enrolledCount > 0, "No pool to claim");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;

        tournament.status = TournamentStatus.Concluded;
        _setTournamentResolution(TournamentResolutionReason.AbandonedTournamentClaimed);
        tournament.winner = msg.sender;
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

        // Note: initializeRound(0) is called by the instance after this returns
    }

    function _refundSoloPlayer(address soloPlayer) internal {
        // Full 100% refund: prize pool + owner accrued.
        // Owner earns nothing — the tournament never ran.
        uint256 refundAmount = tournament.prizePool
            + tournament.ownerAccrued;

        // Zero out all buckets so _handleTournamentConclusion skips fee steps.
        tournament.prizePool = 0;
        tournament.ownerAccrued = 0;

        playerPrizes[soloPlayer] = refundAmount;

        if (refundAmount > 0) {
            (bool sent, ) = payable(soloPlayer).call{value: refundAmount}("");
            tournament.prizeRecipient = soloPlayer;
            tournament.prizeAwarded = sent ? refundAmount : 0;
            if (!sent) {
                // Fallback: restore prize so rescueStuckFunds can recover it
                tournament.prizePool = refundAmount;
                playerPrizes[soloPlayer] = refundAmount;
            }
        }
    }

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
               tournament.enrolledCount >= 2;
    }
}
