// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";
import "../interfaces/IETourGame.sol";

/**
 * @title ETour_Core
 * @dev Stateless module for tier management, enrollment, and tournament initialization
 *
 * This module handles:
 * - Tier registration and configuration
 * - Player enrollment with fee distribution
 * - Tournament force start and abandonment logic
 * - Tournament initialization and solo winner handling
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (tournaments, enrolledPlayers, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 * - msg.value = value sent
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract ETour_Core is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
    // This is a bit of a hack - modules inherit ETour_Storage for type definitions
    // but their storage is never used (delegatecall uses game contract's storage)
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Never Called - Modules Use IETourGame Interface) ============
    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override { revert("Module: Use IETourGame"); }
    function _resetMatchGame(bytes32) public override { revert("Module: Use IETourGame"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module: Use IETourGame"); }
    function _addToMatchCacheGame(uint8, uint8, uint8, uint8) public override { revert("Module: Use IETourGame"); }
    function _getMatchPlayers(bytes32) public view override returns (address, address) { revert("Module: Use IETourGame"); }
    function _setMatchPlayer(bytes32, uint8, address) public override { revert("Module: Use IETourGame"); }
    function _initializeMatchForPlay(bytes32, uint8) public override { revert("Module: Use IETourGame"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module: Use IETourGame"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module: Use IETourGame"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _isMatchActive(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _getActiveMatchData(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory) { revert("Module: Use IETourGame"); }
    function _getMatchFromCache(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory, bool) { revert("Module: Use IETourGame"); }

    // ============ Tier Configuration ============

    /**
     * @dev Register a tournament tier - called by implementing contract during construction
     * Simplified: No prize distribution needed - first place always gets 100%
     */
    function registerTier(
        uint8 tierId,
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        TimeoutConfig memory timeouts
    ) external {
        require(!_tierConfigs[tierId].initialized, "Tier already registered");
        require(playerCount >= 2, "Need at least 2 players");
        require(instanceCount >= 1, "Need at least 1 instance");

        _tierConfigs[tierId] = TierConfig({
            playerCount: playerCount,
            instanceCount: instanceCount,
            entryFee: entryFee,
            timeouts: timeouts,
            totalRounds: _log2(playerCount),
            initialized: true
        });

        // Update tier count if this is a new highest tier
        if (tierId >= tierCount) {
            tierCount = tierId + 1;
        }

        emit TierRegistered(tierId, playerCount, instanceCount, entryFee);
    }

    /**
     * @dev Register raffle threshold configuration
     * EXACT COPY from ETour.sol lines 307-320
     */
    function registerRaffleThresholds(
        uint256[] memory thresholds,
        uint256 finalThreshold
    ) external {
        require(raffleThresholds.length == 0, "Raffle thresholds already registered");
        require(finalThreshold > 0, "Final threshold must be greater than 0");

        for (uint256 i = 0; i < thresholds.length; i++) {
            require(thresholds[i] > 0, "Threshold must be greater than 0");
            raffleThresholds.push(thresholds[i]);
        }

        raffleThresholdFinal = finalThreshold;
    }

    // ============ Enrollment Functions ============

    /**
     * @dev Enroll in tournament with entry fee
     * EXACT COPY from ETour.sol lines 562-611
     */
    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable {
        TierConfig storage config = _tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");
        require(msg.value == config.entryFee, "Incorrect entry fee");

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        // Lazy initialization on first enrollment
        if (tournament.enrolledCount == 0 && tournament.status == TournamentStatus.Enrolling) {
            emit TournamentInitialized(tierId, instanceId);
            tournament.tierId = tierId;
            tournament.instanceId = instanceId;

            tournament.enrollmentTimeout.escalation1Start = block.timestamp + config.timeouts.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start = tournament.enrollmentTimeout.escalation1Start + config.timeouts.enrollmentLevel2Delay;
            tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
            tournament.enrollmentTimeout.forfeitPool = 0;

            
            // Check if there's an old finals match from previous tournament that needs cleanup
            uint8 finalRound = config.totalRounds - 1;
            bytes32 finalsMatchId = _getMatchId(tierId, instanceId, finalRound, 0);
            (address finalsWinner, , MatchStatus finalsStatus) = this._getMatchResult(finalsMatchId);

            if (finalsStatus == MatchStatus.Completed && finalsWinner != address(0)) {
                // Cache old finals before resetting it
                this._addToMatchCacheGame(tierId, instanceId, finalRound, 0);
                this._resetMatchGame(finalsMatchId);
            }
        }

        require(tournament.status == TournamentStatus.Enrolling, "Tournament not accepting enrollments");
        require(!isEnrolled[tierId][instanceId][msg.sender], "Already enrolled");
        require(tournament.enrolledCount < config.playerCount, "Tournament full");

        uint256 participantsShare = (msg.value * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        uint256 ownerShare = (msg.value * OWNER_SHARE_BPS) / BASIS_POINTS;
        uint256 protocolShare = (msg.value * PROTOCOL_SHARE_BPS) / BASIS_POINTS;

        tournament.enrollmentTimeout.forfeitPool += participantsShare;

        (bool ownerSuccess, ) = payable(owner).call{value: ownerShare}("");
        require(ownerSuccess, "Owner fee transfer failed");
        emit OwnerFeePaid(owner, ownerShare);

        // Add protocol share to accumulated pool for raffle system
        accumulatedProtocolShare += protocolShare;
        emit ProtocolFeePaid(address(this), protocolShare);

        enrolledPlayers[tierId][instanceId].push(msg.sender);
        isEnrolled[tierId][instanceId][msg.sender] = true;
        tournament.enrolledCount++;
        tournament.prizePool += participantsShare;

        emit PlayerEnrolled(tierId, instanceId, msg.sender, tournament.enrolledCount);
        // Note: _onPlayerEnrolled hook is called by game contract after delegatecall returns

        if (tournament.enrolledCount == config.playerCount) {
            startTournament(tierId, instanceId);
        }
    }

    /**
     * @dev Force start tournament if enrollment window expired
     * EXACT COPY from ETour.sol lines 613-631
     */
    function forceStartTournament(uint8 tierId, uint8 instanceId) external {
        TierConfig storage config = _tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(isEnrolled[tierId][instanceId][msg.sender], "Not enrolled");
        require(block.timestamp >= tournament.enrollmentTimeout.escalation1Start, "Enrollment window not expired");
        require(tournament.enrollmentTimeout.activeEscalation != EscalationLevel.Escalation3_ExternalPlayers, "Public tier already active");
        require(tournament.enrolledCount >= 1, "Need at least 1 player");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;

        emit TournamentForceStarted(tierId, instanceId, msg.sender, tournament.enrolledCount);
        startTournament(tierId, instanceId);
    }

    /**
     * @dev Claim abandoned enrollment pool
     * EXACT COPY from ETour.sol lines 633-661
     */
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external {
        TierConfig storage config = _tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(block.timestamp >= tournament.enrollmentTimeout.escalation2Start, "Public claim window not reached");
        require(tournament.enrolledCount > 0, "No enrollment pool to claim");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;

        uint256 claimAmount = tournament.enrollmentTimeout.forfeitPool;
        tournament.enrollmentTimeout.forfeitPool = 0;

        for (uint256 i = 0; i < tournament.enrolledCount; i++) {
            address player = enrolledPlayers[tierId][instanceId][i];
            emit PlayerForfeited(tierId, instanceId, player, config.entryFee, "Enrollment abandoned");
        }

        (bool success, ) = payable(msg.sender).call{value: claimAmount}("");
        require(success, "Transfer failed");

        emit EnrollmentPoolClaimed(tierId, instanceId, msg.sender, claimAmount);

        updateAbandonedEarnings(tierId, instanceId, msg.sender, claimAmount);

        // NOTE: Tournament reset is handled by game contract after this function returns
        // (nested delegatecall to MODULE_PRIZES doesn't work)
    }

    /**
     * @dev Reset enrollment window for solo enrolled player
     * EXACT COPY from ETour.sol lines 670-706
     */
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external {
        TierConfig storage config = _tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        // Must be enrolling status
        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");

        // Exactly 1 player enrolled
        require(tournament.enrolledCount == 1, "Must have exactly 1 player enrolled");

        // Caller must be that enrolled player
        require(isEnrolled[tierId][instanceId][msg.sender], "Not enrolled");

        // Enrollment window must have expired (past escalation1Start)
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation1Start,
            "Enrollment window not expired"
        );

        // Recalculate escalation windows from current timestamp
        tournament.enrollmentTimeout.escalation1Start =
            block.timestamp + config.timeouts.enrollmentWindow;
        tournament.enrollmentTimeout.escalation2Start =
            tournament.enrollmentTimeout.escalation1Start + config.timeouts.enrollmentLevel2Delay;
        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;

        emit EnrollmentWindowReset(
            tierId,
            instanceId,
            msg.sender,
            tournament.enrollmentTimeout.escalation1Start,
            tournament.enrollmentTimeout.escalation2Start
        );
    }

    /**
     * @dev Check if the connected wallet can reset the enrollment window
     * EXACT COPY from ETour.sol lines 714-734
     */
    function canResetEnrollmentWindow(
        uint8 tierId,
        uint8 instanceId
    ) external view returns (bool canReset) {
        TierConfig storage config = _tierConfigs[tierId];

        if (!config.initialized) return false;
        if (instanceId >= config.instanceCount) return false;

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        bool isEnrollingStatus = tournament.status == TournamentStatus.Enrolling;
        bool isExactlyOnePlayer = tournament.enrolledCount == 1;
        bool isPlayerEnrolled = isEnrolled[tierId][instanceId][msg.sender];
        bool hasWindowExpired = block.timestamp >= tournament.enrollmentTimeout.escalation1Start;

        return isEnrollingStatus &&
               isExactlyOnePlayer &&
               isPlayerEnrolled &&
               hasWindowExpired;
    }

    // ============ Tournament Start Logic ============

    /**
     * @dev Start tournament (handles solo winner case, delegates to Matches module for multi-player)
     * EXACT COPY from ETour.sol lines 831-867 with delegatecall to MODULE_MATCHES
     */
    function startTournament(uint8 tierId, uint8 instanceId) public {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        tournament.status = TournamentStatus.InProgress;
        tournament.startTime = block.timestamp;
        tournament.currentRound = 0;

        emit TournamentStarted(tierId, instanceId, tournament.enrolledCount);
        // Note: _onTournamentStarted hook is called by game contract after delegatecall returns

        if (tournament.enrolledCount == 1) {
            address soloWinner = enrolledPlayers[tierId][instanceId][0];
            tournament.winner = soloWinner;
            tournament.status = TournamentStatus.Completed;
            tournament.completionReason = TournamentCompletionReason.NormalWin;
            playerRanking[tierId][instanceId][soloWinner] = 1;

            uint256 winnersPot = tournament.prizePool;
            playerPrizes[tierId][instanceId][soloWinner] = winnersPot;

            // Send prize with fallback (inlined to avoid nested delegatecall)
            bool sent = false;
            if (winnersPot > 0) {
                (bool transferSuccess, ) = payable(soloWinner).call{value: winnersPot}("");
                if (transferSuccess) {
                    sent = true;
                } else {
                    // If send failed, add amount to accumulated protocol share
                    accumulatedProtocolShare += winnersPot;
                    emit PrizeDistributionFailed(tierId, instanceId, soloWinner, winnersPot, 1);
                    emit PrizeFallbackToContract(soloWinner, winnersPot);
                }
            }

            playerStats[soloWinner].tournamentsWon++;
            playerStats[soloWinner].tournamentsPlayed++;

            // Only emit success event if prize was actually sent
            if (sent) {
                emit PrizeDistributed(tierId, instanceId, soloWinner, 1, winnersPot);
            }

            // Create enrolled players array for event
            address[] memory singlePlayerArray = new address[](1);
            singlePlayerArray[0] = soloWinner;
            emit TournamentCompleted(tierId, instanceId, soloWinner, winnersPot, TournamentCompletionReason.NormalWin, singlePlayerArray);

            // Update player earnings inline (avoid nested delegatecall)
            if (winnersPot > 0) {
                if (!_isOnLeaderboard[soloWinner]) {
                    _isOnLeaderboard[soloWinner] = true;
                    _leaderboardPlayers.push(soloWinner);
                }
                playerEarnings[soloWinner] += int256(winnersPot);
            }

            // NOTE: Tournament reset is handled by game contract after this function returns
            // (nested delegatecall to MODULE_PRIZES doesn't work)
            return;
        }

        // Note: initializeRound is called by the game contract directly after this returns
        // This allows the game contract to handle match creation with its own _createMatchGame
    }

    // ============ Helper Functions ============

    /**
     * @dev Update earnings for abandoned enrollment claim
     * EXACT COPY from ETour.sol lines 2128-2142
     */
    function updateAbandonedEarnings(
        uint8 tierId,
        uint8 instanceId,
        address claimer,
        uint256 claimAmount
    ) public {
        // Only track the claimer if they receive a claim amount
        // Enrolled players who abandoned don't receive anything, so don't track them
        if (claimAmount > 0) {
            // Track on leaderboard directly
            if (!_isOnLeaderboard[claimer]) {
                _isOnLeaderboard[claimer] = true;
                _leaderboardPlayers.push(claimer);
            }

            playerEarnings[claimer] += int256(claimAmount);
        }

        emit TournamentCached(tierId, instanceId, address(0));
    }

    // ============ Configuration Getters ============

    /**
     * @dev Get all tier IDs that have been registered
     * EXACT COPY from ETour.sol lines 2519-2525
     */
    function getAllTierIds() external view returns (uint8[] memory) {
        uint8[] memory tierIds = new uint8[](tierCount);
        for (uint8 i = 0; i < tierCount; i++) {
            tierIds[i] = i;
        }
        return tierIds;
    }

    /**
     * @dev Get basic tier information
     * EXACT COPY from ETour.sol lines 2534-2546
     */
    function getTierInfo(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee
        );
    }

    /**
     * @dev Get timeout configuration for a tier
     * EXACT COPY from ETour.sol lines 2558-2576
     */
    function getTierTimeouts(uint8 tierId) external view returns (
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        uint256 matchLevel2Delay,
        uint256 matchLevel3Delay,
        uint256 enrollmentWindow,
        uint256 enrollmentLevel2Delay
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TimeoutConfig storage timeouts = _tierConfigs[tierId].timeouts;
        return (
            timeouts.matchTimePerPlayer,
            timeouts.timeIncrementPerMove,
            timeouts.matchLevel2Delay,
            timeouts.matchLevel3Delay,
            timeouts.enrollmentWindow,
            timeouts.enrollmentLevel2Delay
        );
    }

    // ============ Additional Getters (Extracted from Game Contracts) ============

    /**
     * @dev Generate unique match identifier
     */
    function getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public pure returns (bytes32) {
        return _getMatchId(tierId, instanceId, roundNumber, matchNumber);
    }

    /**
     * @dev Get full tier configuration struct
     */
    function tierConfigs(uint8 tierId) external view returns (TierConfig memory) {
        require(tierId < tierCount, "Invalid tier ID");
        return _tierConfigs[tierId];
    }

    /**
     * @dev Get tier entry fee
     */
    function ENTRY_FEES(uint8 tierId) external view returns (uint256) {
        return _tierConfigs[tierId].entryFee;
    }

    /**
     * @dev Get tier instance count
     */
    function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].instanceCount;
    }

    /**
     * @dev Get tier player count
     */
    function TIER_SIZES(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].playerCount;
    }

    /**
     * @dev Get comprehensive tournament information
     */
    function getTournamentInfo(uint8 tierId, uint8 instanceId) external view returns (
        TournamentStatus status,
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    ) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return (
            tournament.status,
            tournament.currentRound,
            tournament.enrolledCount,
            tournament.prizePool,
            tournament.winner
        );
    }

    /**
     * @dev Get total player capacity across all tiers
     */
    function getTotalCapacity() external view returns (uint256 totalPlayers) {
        for (uint8 i = 0; i < tierCount; i++) {
            if (_tierConfigs[i].initialized) {
                TierConfig storage config = _tierConfigs[i];
                totalPlayers += uint256(config.playerCount) * uint256(config.instanceCount);
            }
        }
        return totalPlayers;
    }
}
