// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ETourLib_Core
 * @dev Core tournament library: structs, storage, enrollment, tier management
 * Part 1 of 3-library split to keep each library under 24kB
 */
library ETourLib_Core {

    // ============ Constants ============

    uint256 public constant PARTICIPANTS_SHARE_BPS = 9000;  // 90%
    uint256 public constant OWNER_SHARE_BPS = 750;          // 7.5%
    uint256 public constant PROTOCOL_SHARE_BPS = 250;       // 2.5%
    uint256 public constant BASIS_POINTS = 10000;
    uint8 public constant NO_ROUND = 255;

    // ============ Enums ============

    enum TournamentStatus { Enrolling, InProgress, Completed }
    enum MatchStatus { NotStarted, InProgress, Completed }
    enum Mode { Classic, Pro }
    enum EscalationLevel {
        None,
        Escalation1_OpponentClaim,
        Escalation2_AdvancedPlayers,
        Escalation3_ExternalPlayers
    }

    // ============ Structs ============

    struct TimeoutConfig {
        uint256 matchTimePerPlayer;
        uint256 timeIncrementPerMove;
        uint256 matchLevel2Delay;
        uint256 matchLevel3Delay;
        uint256 enrollmentWindow;
        uint256 enrollmentLevel2Delay;
    }

    struct TierConfig {
        uint8 playerCount;
        uint8 instanceCount;
        uint256 entryFee;
        Mode mode;
        TimeoutConfig timeouts;
        uint8 totalRounds;
        bool initialized;
    }

    struct EnrollmentTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        uint256 forfeitPool;
    }

    struct TournamentInstance {
        uint8 tierId;
        uint8 instanceId;
        TournamentStatus status;
        Mode mode;
        uint8 currentRound;
        uint8 enrolledCount;
        uint256 prizePool;
        uint256 startTime;
        address winner;
        address coWinner;
        bool finalsWasDraw;
        bool allDrawResolution;
        uint8 allDrawRound;
        EnrollmentTimeoutState enrollmentTimeout;
        bool hasStartedViaTimeout;
    }

    struct Round {
        uint8 totalMatches;
        uint8 completedMatches;
        bool initialized;
        uint8 drawCount;
        bool allMatchesDrew;
    }

    struct PlayerStats {
        uint256 tournamentsWon;
        uint256 tournamentsPlayed;
        uint256 matchesWon;
        uint256 matchesPlayed;
    }

    struct MatchTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        bool isStalled;
    }

    struct CommonMatchData {
        address player1;
        address player2;
        address winner;
        address loser;
        MatchStatus status;
        bool isDraw;
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 endTime;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isCached;
    }

    struct LeaderboardEntry {
        address player;
        int256 netEarnings;
    }

    // ============ Storage Structure ============

    struct ETourStorage {
        uint8 tierCount;
        mapping(uint8 => TierConfig) tierConfigs;
        mapping(uint8 => uint8[]) tierPrizeDistribution;

        uint256 accumulatedProtocolShare;
        uint256 currentRaffleIndex;
        uint256[] raffleThresholds;
        uint256 raffleThresholdFinal;

        mapping(uint8 => mapping(uint8 => TournamentInstance)) tournaments;
        mapping(uint8 => mapping(uint8 => address[])) enrolledPlayers;
        mapping(uint8 => mapping(uint8 => mapping(address => bool))) isEnrolled;
        mapping(uint8 => mapping(uint8 => mapping(uint8 => Round))) rounds;

        mapping(address => PlayerStats) playerStats;
        mapping(address => bytes32[]) playerActiveMatches;
        mapping(address => mapping(bytes32 => uint256)) playerMatchIndex;
        mapping(uint8 => mapping(uint8 => mapping(address => uint8))) playerRanking;
        mapping(uint8 => mapping(uint8 => mapping(address => uint256))) playerPrizes;
        mapping(uint8 => mapping(uint8 => mapping(uint8 => mapping(uint8 => mapping(address => bool))))) drawParticipants;

        mapping(address => int256) playerEarnings;
        address[] leaderboardPlayers;
        mapping(address => bool) isOnLeaderboard;

        mapping(bytes32 => MatchTimeoutState) matchTimeouts;
    }

    // ============ Tier Registration ============

    function registerTier(
        ETourStorage storage self,
        uint8 tierId,
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        Mode mode,
        TimeoutConfig memory timeouts,
        uint8[] memory prizeDistribution
    ) external {
        require(!self.tierConfigs[tierId].initialized, "Tier already registered");
        require(playerCount > 1 && (playerCount & (playerCount - 1)) == 0, "Player count must be power of 2");
        require(instanceCount > 0, "Must have at least one instance");

        uint8 totalRounds = 0;
        uint8 temp = playerCount;
        while (temp > 1) {
            temp = temp / 2;
            totalRounds++;
        }

        self.tierConfigs[tierId] = TierConfig({
            playerCount: playerCount,
            instanceCount: instanceCount,
            entryFee: entryFee,
            mode: mode,
            timeouts: timeouts,
            totalRounds: totalRounds,
            initialized: true
        });

        uint256 totalPercentage = 0;
        for (uint256 i = 0; i < prizeDistribution.length; i++) {
            self.tierPrizeDistribution[tierId].push(prizeDistribution[i]);
            totalPercentage += prizeDistribution[i];
        }
        require(totalPercentage == 100, "Prize distribution must sum to 100%");

        if (tierId >= self.tierCount) {
            self.tierCount = tierId + 1;
        }
    }

    function registerRaffleThresholds(
        ETourStorage storage self,
        uint256[] memory thresholds,
        uint256 finalThreshold
    ) external {
        require(self.raffleThresholds.length == 0, "Raffle thresholds already set");
        require(finalThreshold > 0, "Final threshold must be positive");

        for (uint256 i = 0; i < thresholds.length; i++) {
            self.raffleThresholds.push(thresholds[i]);
        }
        self.raffleThresholdFinal = finalThreshold;
    }

    // ============ Enrollment Logic ============

    function enrollInTournamentLogic(
        ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        address player,
        uint256 msgValue
    ) external returns (
        bool shouldEmitInitialized,
        bool shouldStart,
        uint256 ownerShare,
        uint256 protocolShare,
        uint256 participantsShare
    ) {
        TierConfig storage config = self.tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");
        require(msgValue == config.entryFee, "Incorrect entry fee");

        TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

        if (tournament.enrolledCount == 0 && tournament.status == TournamentStatus.Enrolling) {
            shouldEmitInitialized = true;
            tournament.tierId = tierId;
            tournament.instanceId = instanceId;
            tournament.mode = config.mode;
            tournament.enrollmentTimeout.escalation1Start = block.timestamp + config.timeouts.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start = tournament.enrollmentTimeout.escalation1Start + config.timeouts.enrollmentLevel2Delay;
            tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
            tournament.enrollmentTimeout.forfeitPool = 0;
        }

        require(tournament.status == TournamentStatus.Enrolling, "Tournament not accepting enrollments");
        require(!self.isEnrolled[tierId][instanceId][player], "Already enrolled");
        require(tournament.enrolledCount < config.playerCount, "Tournament full");

        participantsShare = (msgValue * PARTICIPANTS_SHARE_BPS) / BASIS_POINTS;
        ownerShare = (msgValue * OWNER_SHARE_BPS) / BASIS_POINTS;
        protocolShare = (msgValue * PROTOCOL_SHARE_BPS) / BASIS_POINTS;

        tournament.enrollmentTimeout.forfeitPool += participantsShare;
        self.accumulatedProtocolShare += protocolShare;

        self.enrolledPlayers[tierId][instanceId].push(player);
        self.isEnrolled[tierId][instanceId][player] = true;
        tournament.enrolledCount++;
        tournament.prizePool += participantsShare;

        shouldStart = (tournament.enrolledCount == config.playerCount);

        return (shouldEmitInitialized, shouldStart, ownerShare, protocolShare, participantsShare);
    }

    function forceStartTournamentLogic(
        ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        address caller
    ) external returns (bool canStart) {
        TierConfig storage config = self.tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        TournamentInstance storage tournament = self.tournaments[tierId][instanceId];

        require(tournament.status == TournamentStatus.Enrolling, "Not enrolling");
        require(self.isEnrolled[tierId][instanceId][caller], "Not enrolled");
        require(block.timestamp >= tournament.enrollmentTimeout.escalation1Start, "Enrollment window not expired");
        require(tournament.enrollmentTimeout.activeEscalation != EscalationLevel.Escalation3_ExternalPlayers, "Public tier already active");
        require(tournament.enrolledCount >= 1, "Need at least 1 player");

        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        tournament.hasStartedViaTimeout = true;

        return true;
    }

    // ============ View Functions ============

    function getTierConfig(
        ETourStorage storage self,
        uint8 tierId
    ) external view returns (TierConfig memory) {
        return self.tierConfigs[tierId];
    }

    function getTournament(
        ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId
    ) external view returns (TournamentInstance memory) {
        return self.tournaments[tierId][instanceId];
    }

    function getRound(
        ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) external view returns (Round memory) {
        return self.rounds[tierId][instanceId][roundNumber];
    }

    function getEnrolledPlayers(
        ETourStorage storage self,
        uint8 tierId,
        uint8 instanceId
    ) external view returns (address[] memory) {
        return self.enrolledPlayers[tierId][instanceId];
    }

    function getPlayerStats(
        ETourStorage storage self,
        address player
    ) external view returns (PlayerStats memory) {
        return self.playerStats[player];
    }

    function getPrizeDistribution(
        ETourStorage storage self,
        uint8 tierId
    ) external view returns (uint8[] memory) {
        return self.tierPrizeDistribution[tierId];
    }

    function getAllTierIds(
        ETourStorage storage self
    ) external view returns (uint8[] memory) {
        uint8[] memory tierIds = new uint8[](self.tierCount);
        for (uint8 i = 0; i < self.tierCount; i++) {
            tierIds[i] = i;
        }
        return tierIds;
    }

    // ============ Helper Functions ============

    function getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(tierId, instanceId, roundNumber, matchNumber));
    }

    function getMatchCountForRound(uint8 playerCount, uint8 roundNumber) external pure returns (uint8) {
        uint8 playersInRound = playerCount;
        for (uint8 i = 0; i < roundNumber; i++) {
            playersInRound = playersInRound / 2;
        }
        return playersInRound / 2;
    }
}
