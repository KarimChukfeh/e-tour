// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ETour
 * @dev Configuration-driven, game-agnostic perpetual tournament protocol
 * 
 * Provides bracket management, matchmaking, anti-stalling mechanisms,
 * timeout escalation, and prize distribution for any competitive game.
 * 
 * The implementing game contract provides:
 * - Tier structure (how many tiers, player counts, instances per tier)
 * - Entry fees for each tier
 * - Prize distributions for each tier
 * - Timeout configurations
 * 
 * ETour handles the tournament mechanics; the game handles the rules.
 * 
 * Part of the RW3 (Reclaim Web3) movement - building truly decentralized competition.
 */
abstract contract ETour is ReentrancyGuard {
    
    // ============ Constants & Immutables ============
    
    address public immutable owner;

    // Fee distribution constants (in basis points, 10000 = 100%)
    uint256 public constant PARTICIPANTS_SHARE_BPS = 9000;  // 90% to prize pool
    uint256 public constant OWNER_SHARE_BPS = 750;          // 7.5% to owner
    uint256 public constant PROTOCOL_SHARE_BPS = 250;       // 2.5% to protocol
    uint256 public constant BASIS_POINTS = 10000;           // 100%

    // Sentinel values
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

    // ============ Configuration Structs ============

    /**
     * @dev Timeout configuration for escalation windows
     * All values in seconds
     */
    struct TimeoutConfig {
        uint256 matchTimePerPlayer;           // Time each player gets for entire match (e.g., 60 = 1 minute)
        uint256 timeIncrementPerMove;         // Fischer increment: bonus time added after each move
        uint256 matchLevel2Delay;             // Delay after player timeout before L2 (advanced players) active
        uint256 matchLevel3Delay;             // Delay after player timeout before L3 (anyone) active
        uint256 enrollmentWindow;             // Time to wait for tournament to fill before L1
        uint256 enrollmentLevel2Delay;        // Delay after L1 before L2 (external claim) active
    }

    /**
     * @dev Configuration for a single tournament tier
     * Provided by implementing contract via _registerTier()
     */
    struct TierConfig {
        uint8 playerCount;          // Number of players in tournament (must be power of 2 for brackets)
        uint8 instanceCount;        // How many concurrent instances of this tier
        uint256 entryFee;           // Entry fee in wei
        Mode mode;                  // Classic or Pro mode
        TimeoutConfig timeouts;     // Timeout configuration for escalation windows
        uint8 totalRounds;          // Calculated: log2(playerCount)
        bool initialized;           // Whether this tier has been configured
    }

    // ============ Tournament Structs ============
    
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

    struct EnrollmentTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        uint256 forfeitPool;
    }

    /**
     * @dev Match-level timeout state for anti-stalling escalation
     * Tracks when a match becomes stalled and enables progressive intervention
     */
    struct MatchTimeoutState {
        uint256 escalation1Start;      // When Level 2 (advanced players) can act
        uint256 escalation2Start;      // When Level 3 (external players) can act
        EscalationLevel activeEscalation;
        bool isStalled;                // Set to true when a player runs out of time
    }

    /**
     * @dev Common match data shared across all game implementations
     * Used by standardized getMatch() function with automatic cache fallback
     */
    struct CommonMatchData {
        // Player Information
        address player1;
        address player2;
        address winner;
        address loser;          // Derived: (winner == player1) ? player2 : player1

        // Match State
        MatchStatus status;
        bool isDraw;

        // Timing
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 endTime;        // Only populated for cached matches

        // Tournament Context
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;

        // Data Source Indicator
        bool isCached;          // true = from cache, false = from active storage
    }

    // ============ State Variables ============

    // Tier configuration - set by implementing contract
    uint8 public tierCount;
    mapping(uint8 => TierConfig) internal _tierConfigs;
    mapping(uint8 => uint8[]) internal _tierPrizeDistribution; // tierId => percentages array

    // Accumulated protocol share from failed prize distributions
    uint256 public accumulatedProtocolShare;

    // Raffle tracking
    uint256 public currentRaffleIndex;  // Starts at 0, increments when raffle executes
    uint256[] private raffleThresholds;  // Configured thresholds for initial raffles
    uint256 private raffleThresholdFinal;  // Threshold to use after initial raffles exhausted

    // Tournament state
    mapping(uint8 => mapping(uint8 => TournamentInstance)) public tournaments;
    mapping(uint8 => mapping(uint8 => address[])) public enrolledPlayers;
    mapping(uint8 => mapping(uint8 => mapping(address => bool))) public isEnrolled;
    mapping(uint8 => mapping(uint8 => mapping(uint8 => Round))) public rounds;
    
    // Player data
    mapping(address => PlayerStats) public playerStats;
    mapping(address => bytes32[]) public playerActiveMatches;
    mapping(address => mapping(bytes32 => uint256)) public playerMatchIndex;
    mapping(uint8 => mapping(uint8 => mapping(address => uint8))) public playerRanking;
    mapping(uint8 => mapping(uint8 => mapping(address => uint256))) public playerPrizes;
    mapping(uint8 => mapping(uint8 => mapping(uint8 => mapping(uint8 => mapping(address => bool))))) public drawParticipants;

    // Player earnings tracking (total winnings from prizes)
    mapping(address => int256) public playerEarnings;
    address[] internal _leaderboardPlayers;
    mapping(address => bool) internal _isOnLeaderboard;

    // Match-level timeout tracking for anti-stalling escalation
    mapping(bytes32 => MatchTimeoutState) public matchTimeouts;

    // ============ Events ============
    
    event TierRegistered(uint8 indexed tierId, uint8 playerCount, uint8 instanceCount, uint256 entryFee);
    event TournamentInitialized(uint8 indexed tierId, uint8 indexed instanceId);
    event PlayerEnrolled(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint8 enrolledCount);
    event TournamentStarted(uint8 indexed tierId, uint8 indexed instanceId, uint8 playerCount);
    event PlayerAutoAdvancedWalkover(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, address indexed player);
    event RoundInitialized(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, uint8 matchCount);
    event MatchStarted(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, uint8 matchNumber, address player1, address player2);
    event PlayersConsolidated(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, address player1, address player2);
    event MatchCompleted(bytes32 indexed matchId, address winner, bool isDraw);
    event RoundCompleted(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber);
    event TournamentCompleted(uint8 indexed tierId, uint8 indexed instanceId, address winner, uint256 prizeAmount, bool finalsWasDraw, address coWinner);
    event AllDrawRoundDetected(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, uint8 remainingPlayers);
    event TournamentCompletedAllDraw(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, uint8 sharedWinnerCount, uint256 prizePerWinner);
    event TournamentReset(uint8 indexed tierId, uint8 indexed instanceId);
    event OwnerFeePaid(address indexed owner, uint256 amount);
    event ProtocolFeePaid(address indexed recipient, uint256 amount);
    event PrizeDistributed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint8 rank, uint256 amount);
    event PrizeDistributionFailed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount, uint8 attemptsMade);
    event PrizeFallbackToContract(address indexed player, uint256 amount);
    event TournamentCached(uint8 indexed tierId, uint8 indexed instanceId, address winner);
    event TournamentForceStarted(uint8 indexed tierId, uint8 indexed instanceId, address indexed starter, uint8 playerCount);
    event EnrollmentPoolClaimed(uint8 indexed tierId, uint8 indexed instanceId, address indexed claimant, uint256 amount);
    event EnrollmentWindowReset(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 newEscalation1Start, uint256 newEscalation2Start);
    event TimeoutVictoryClaimed(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNum, uint8 matchNum, address indexed winner, address loser);
    event PlayerForfeited(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount, string reason);
    event ProtocolRaffleExecuted(
        uint256 indexed raffleIndex,
        address indexed winner,
        address indexed caller,
        uint256 raffleAmount,
        uint256 ownerShare,
        uint256 winnerShare,
        uint256 remainingReserve,
        uint256 winnerEnrollmentCount
    );

    // ============ Constructor ============

    constructor() {
        owner = msg.sender;
    }

    // ============ Tier Configuration ============

    /**
     * @dev Register a tournament tier - called by implementing contract
     * @param tierId Unique tier identifier (0, 1, 2, etc.)
     * @param playerCount Number of players (should be power of 2 for clean brackets)
     * @param instanceCount How many concurrent tournament instances
     * @param entryFee Entry fee in wei
     * @param mode Classic or Pro mode
     * @param timeouts Timeout configuration for escalation windows
     * @param prizeDistribution Array of percentages (must sum to 100, index 0 = 1st place)
     */
    function _registerTier(
        uint8 tierId,
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        Mode mode,
        TimeoutConfig memory timeouts,
        uint8[] memory prizeDistribution
    ) internal {
        require(!_tierConfigs[tierId].initialized, "Tier already registered");
        require(playerCount >= 2, "Need at least 2 players");
        require(instanceCount >= 1, "Need at least 1 instance");
        require(prizeDistribution.length == playerCount, "Prize distribution length must match player count");
        
        // Validate prize distribution sums to 100
        uint256 totalPercent = 0;
        for (uint8 i = 0; i < prizeDistribution.length; i++) {
            totalPercent += prizeDistribution[i];
        }
        require(totalPercent == 100, "Prize distribution must sum to 100");

        _tierConfigs[tierId] = TierConfig({
            playerCount: playerCount,
            instanceCount: instanceCount,
            entryFee: entryFee,
            mode: mode,
            timeouts: timeouts,
            totalRounds: _log2(playerCount),
            initialized: true
        });

        // Store prize distribution
        _tierPrizeDistribution[tierId] = prizeDistribution;

        // Update tier count if this is a new highest tier
        if (tierId >= tierCount) {
            tierCount = tierId + 1;
        }

        emit TierRegistered(tierId, playerCount, instanceCount, entryFee);
    }

    /**
     * @dev Register raffle threshold configuration
     * @param thresholds Array of threshold values for initial raffles (e.g., [0.2, 0.4, 0.6, 0.8, 1.0])
     * @param finalThreshold Threshold to use after initial thresholds are exhausted
     * @notice Should be called once in constructor to configure raffle progression
     *         Example for TicTacToe: thresholds = [0.2, 0.4, 0.6, 0.8, 1.0 ether], finalThreshold = 1.0 ether
     *         This means raffles 0-4 use the array values, raffle 5+ use 1.0 ether
     */
    function _registerRaffleThresholds(
        uint256[] memory thresholds,
        uint256 finalThreshold
    ) internal {
        require(raffleThresholds.length == 0, "Raffle thresholds already registered");
        require(finalThreshold > 0, "Final threshold must be greater than 0");

        for (uint256 i = 0; i < thresholds.length; i++) {
            require(thresholds[i] > 0, "Threshold must be greater than 0");
            raffleThresholds.push(thresholds[i]);
        }

        raffleThresholdFinal = finalThreshold;
    }

    /**
     * @dev Get tier configuration (public view function for ABI compatibility)
     */
    function tierConfigs(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        uint8 totalRounds,
        TimeoutConfig memory timeouts
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            config.totalRounds,
            config.timeouts
        );
    }

    /**
     * @dev Get timeout configuration for a tier
     * Provides all escalation timing information to clients
     */
    function getTimeoutConfig(uint8 tierId) external view returns (TimeoutConfig memory) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        return _tierConfigs[tierId].timeouts;
    }

    /**
     * @dev Get entry fee for a tier (ABI compatibility helper)
     */
    function ENTRY_FEES(uint8 tierId) external view returns (uint256) {
        return _tierConfigs[tierId].entryFee;
    }

    /**
     * @dev Get instance count for a tier (ABI compatibility helper)
     */
    function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].instanceCount;
    }

    /**
     * @dev Get tier sizes (ABI compatibility helper)
     */
    function TIER_SIZES(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].playerCount;
    }

    // ============ Abstract Functions (Game-Specific) ============
    
    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) internal virtual;

    function _resetMatchGame(bytes32 matchId) internal virtual;

    function _getMatchResult(bytes32 matchId) internal view virtual returns (address winner, bool isDraw, MatchStatus status);

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal virtual;

    function _getMatchPlayers(bytes32 matchId) internal view virtual returns (address player1, address player2);

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal virtual;

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal virtual;

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal virtual;

    /**
     * @dev Get the time increment (in seconds) added after each move
     * Implementing contracts should return 0 for no increment, or a value like 3 for Fischer increment
     * @return Time increment in seconds
     */
    function _getTimeIncrement() internal view virtual returns (uint256);

    /**
     * @dev Check if the current player in a match has run out of time
     * This is used by escalation logic to detect stalled matches
     * @param matchId The match identifier
     * @return true if current player has run out of time (timeout is claimable)
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) internal view virtual returns (bool);

    /**
     * @dev Public getter for match time per player
     * Exposes the time control setting to clients
     * @param tierId The tier to get match time for
     * @return Time in seconds that each player gets for the entire match
     */
    function getMatchTimePerPlayer(uint8 tierId) public view returns (uint256) {
        return _tierConfigs[tierId].timeouts.matchTimePerPlayer;
    }

    /**
     * @dev Public getter for time increment per move
     * Exposes the time increment setting to clients
     * @return Time in seconds added after each move (0 for no increment)
     */
    function getTimeIncrement() public view returns (uint256) {
        return _getTimeIncrement();
    }

    /**
     * @dev Check if match is active in game-specific storage
     * @param matchId The match identifier
     * @return true if match exists and is not completed/cancelled
     */
    function _isMatchActive(bytes32 matchId) internal view virtual returns (bool);

    /**
     * @dev Get active match data from game-specific storage
     * Must populate CommonMatchData from active match and derive loser
     * @param matchId The match identifier
     * @param tierId Tournament tier ID
     * @param instanceId Instance ID within tier
     * @param roundNumber Round number (0-based)
     * @param matchNumber Match number within round (0-based)
     * @return Common match data with isCached = false
     */
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view virtual returns (CommonMatchData memory);

    /**
     * @dev Get match data from game-specific cache
     * Must: Get player addresses, lookup cache, verify context, derive loser
     * @param matchId The match identifier
     * @param tierId Tournament tier ID
     * @param instanceId Instance ID within tier
     * @param roundNumber Round number (0-based)
     * @param matchNumber Match number within round (0-based)
     * @return data Common match data with isCached = true
     * @return exists false if not in cache or context doesn't match
     */
    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view virtual returns (CommonMatchData memory data, bool exists);

    // ============ Player Activity Tracking Hooks ============

    /**
     * @dev Hook called when player enrolls in tournament
     * Override in game contracts to track player activity
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal virtual {}

    /**
     * @dev Hook called when tournament transitions from Enrolling to InProgress
     * Override in game contracts to track status changes for all enrolled players
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal virtual {}

    /**
     * @dev Hook called when player is eliminated from tournament
     * Override in game contracts to track player elimination
     */
    function _onPlayerEliminatedFromTournament(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal virtual {}

    /**
     * @dev Hook called when external player replaces stalled players (L3 escalation)
     * Override in game contracts to track mid-tournament player additions
     */
    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal virtual {}

    /**
     * @dev Hook called when tournament completes and resets
     * Override in game contracts to clean up player tracking
     */
    function _onTournamentCompleted(
        uint8 tierId,
        uint8 instanceId,
        address[] memory players
    ) internal virtual {}

    // ============ Raffle Configuration Functions ============

    /**
     * @dev Returns the raffle threshold for the current raffle index
     * @return Minimum accumulatedProtocolShare required to trigger raffle
     * @notice Uses configured thresholds from raffleThresholds array for initial raffles,
     *         then switches to raffleThresholdFinal for subsequent raffles
     *         If no thresholds configured, defaults to 3 ether
     */
    function _getRaffleThreshold() internal view virtual returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise, use the final threshold
        return raffleThresholdFinal;
    }

    /**
     * @dev Returns the reserve amount to keep after raffle execution
     * @return Amount to keep in accumulatedProtocolShare after raffle
     * @notice Reserve is always 10% of threshold
     *         This ensures protocol always maintains proportional reserve
     */
    function _getRaffleReserve() internal view virtual returns (uint256) {
        uint256 threshold = _getRaffleThreshold();
        return (threshold * 10) / 100;  // 10% of threshold
    }

    // ============ Enrollment Functions ============
    
    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        TierConfig storage config = _tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");
        require(msg.value == config.entryFee, "Incorrect entry fee");
        
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        if (tournament.enrolledCount == 0 && tournament.status == TournamentStatus.Enrolling) {
            emit TournamentInitialized(tierId, instanceId);
            tournament.tierId = tierId;
            tournament.instanceId = instanceId;
            tournament.mode = config.mode;

            tournament.enrollmentTimeout.escalation1Start = block.timestamp + config.timeouts.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start = tournament.enrollmentTimeout.escalation1Start + config.timeouts.enrollmentLevel2Delay;
            tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
            tournament.enrollmentTimeout.forfeitPool = 0;
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
        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        if (tournament.enrolledCount == config.playerCount) {
            _startTournament(tierId, instanceId);
        }
    }

    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
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
        tournament.hasStartedViaTimeout = true;

        emit TournamentForceStarted(tierId, instanceId, msg.sender, tournament.enrolledCount);
        _startTournament(tierId, instanceId);
    }

    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
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

        _updateAbandonedEarnings(tierId, instanceId, msg.sender, claimAmount);
        _resetTournamentAfterCompletion(tierId, instanceId);
    }

    /**
     * @dev Reset enrollment window for solo enrolled player
     * Allows the single enrolled player to extend the enrollment period
     * if they want to wait for more players to join rather than force start
     * @param tierId Tournament tier ID
     * @param instanceId Tournament instance ID
     */
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
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
     * @param tierId Tournament tier ID
     * @param instanceId Tournament instance ID
     * @return canReset true if caller can reset, false otherwise
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

    /**
     * @dev Executes protocol raffle when accumulated fees exceed 3 ETH
     * @notice Only callable by players enrolled in active tournaments
     * @return winner Address of the randomly selected winner
     * @return ownerAmount Amount sent to owner (20%)
     * @return winnerAmount Amount sent to winner (80%)
     */
    function executeProtocolRaffle()
        external
        nonReentrant
        returns (
            address winner,
            uint256 ownerAmount,
            uint256 winnerAmount
        )
    {
        // CHECK 1: Verify threshold met
        uint256 threshold = _getRaffleThreshold();
        require(
            accumulatedProtocolShare >= threshold,
            "Raffle threshold not met"
        );

        // CHECK 2: Verify caller is enrolled in active tournament
        require(
            _isCallerEnrolledInActiveTournament(msg.sender),
            "Only enrolled players can trigger raffle"
        );

        // EFFECT 1: Increment raffle index
        currentRaffleIndex++;

        // EFFECT 2: Calculate raffle amount (use configured reserve)
        uint256 reserve = _getRaffleReserve();
        uint256 raffleAmount = accumulatedProtocolShare - reserve;
        ownerAmount = (raffleAmount * 20) / 100;  // 20%
        winnerAmount = (raffleAmount * 80) / 100; // 80%

        // EFFECT 3: Update accumulated protocol share (keep reserve)
        accumulatedProtocolShare = reserve;

        // EFFECT 4: Get all enrolled players with weights
        (
            address[] memory players,
            uint256[] memory weights,
            uint256 totalWeight
        ) = _getAllEnrolledPlayersWithWeights();

        require(totalWeight > 0, "No eligible players for raffle");

        // EFFECT 5: Generate randomness and select winner
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            block.number,
            msg.sender,
            accumulatedProtocolShare
        )));

        winner = _selectWeightedWinner(players, weights, totalWeight, randomness);

        // Find winner's enrollment count for event
        uint256 winnerEnrollmentCount = 0;
        for (uint256 i = 0; i < players.length; i++) {
            if (players[i] == winner) {
                winnerEnrollmentCount = weights[i];
                break;
            }
        }

        // EFFECT 6: Emit event
        emit ProtocolRaffleExecuted(
            currentRaffleIndex,
            winner,
            msg.sender,
            raffleAmount,
            ownerAmount,
            winnerAmount,
            accumulatedProtocolShare,
            winnerEnrollmentCount
        );

        // INTERACTION 1: Send to owner
        (bool ownerSent, ) = payable(owner).call{value: ownerAmount}("");
        require(ownerSent, "Failed to send owner share");

        // INTERACTION 2: Send to winner
        (bool winnerSent, ) = payable(winner).call{value: winnerAmount}("");
        require(winnerSent, "Failed to send winner share");

        return (winner, ownerAmount, winnerAmount);
    }

    // ============ Tournament Management ============

    function _startTournament(uint8 tierId, uint8 instanceId) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        tournament.status = TournamentStatus.InProgress;
        tournament.startTime = block.timestamp;
        tournament.currentRound = 0;

        emit TournamentStarted(tierId, instanceId, tournament.enrolledCount);
        _onTournamentStarted(tierId, instanceId);

        if (tournament.enrolledCount == 1) {
            address soloWinner = enrolledPlayers[tierId][instanceId][0];
            tournament.winner = soloWinner;
            tournament.status = TournamentStatus.Completed;
            playerRanking[tierId][instanceId][soloWinner] = 1;

            uint256 winnersPot = tournament.prizePool;
            playerPrizes[tierId][instanceId][soloWinner] = winnersPot;

            // Attempt to send prize with fallback to owner fees if failed
            bool sent = _sendPrizeWithFallback(soloWinner, winnersPot, tierId, instanceId);

            playerStats[soloWinner].tournamentsWon++;
            playerStats[soloWinner].tournamentsPlayed++;

            // Only emit success event if prize was actually sent
            if (sent) {
                emit PrizeDistributed(tierId, instanceId, soloWinner, 1, winnersPot);
            }
            emit TournamentCompleted(tierId, instanceId, soloWinner, winnersPot, false, address(0));

            _updatePlayerEarnings(tierId, instanceId, soloWinner);
            _resetTournamentAfterCompletion(tierId, instanceId);
            return;
        }

        _initializeRound(tierId, instanceId, 0);
    }

    function _initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        uint8 matchCount = _getMatchCountForRound(tierId, instanceId, roundNumber);
        
        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.allMatchesDrew = false;
        
        emit RoundInitialized(tierId, instanceId, roundNumber, matchCount);
        
        if (roundNumber == 0) {
            address[] storage players = enrolledPlayers[tierId][instanceId];
            TournamentInstance storage tournament = tournaments[tierId][instanceId];

            address walkoverPlayer = address(0);
            if (tournament.enrolledCount % 2 == 1) {
                uint256 randomness = uint256(keccak256(abi.encodePacked(
                    block.prevrandao,
                    block.timestamp,
                    tierId,
                    instanceId,
                    tournament.enrolledCount
                )));
                uint8 walkoverIndex = uint8(randomness % tournament.enrolledCount);
                walkoverPlayer = players[walkoverIndex];

                address lastPlayer = players[tournament.enrolledCount - 1];
                players[walkoverIndex] = lastPlayer;
                players[tournament.enrolledCount - 1] = walkoverPlayer;

                emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
            }

            for (uint8 i = 0; i < matchCount; i++) {
                _createMatchGame(tierId, instanceId, roundNumber, i, players[i * 2], players[i * 2 + 1]);
            }

            if (walkoverPlayer != address(0)) {
                _advanceWinner(tierId, instanceId, roundNumber, matchCount, walkoverPlayer);
            }
        }
    }

    function _getMatchCountForRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal view virtual returns (uint8) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];
        
        uint8 playerCount = tournament.enrolledCount > 0
            ? tournament.enrolledCount
            : config.playerCount;

        if (roundNumber == 0) {
            return playerCount / 2;
        } else {
            Round storage prevRound = rounds[tierId][instanceId][roundNumber - 1];
            uint8 winnersFromPrevRound = prevRound.totalMatches;
            uint8 playersInCurrentRound = winnersFromPrevRound;

            if (roundNumber == 1 && playerCount % 2 == 1) {
                playersInCurrentRound++;
            }

            return playersInCurrentRound / 2;
        }
    }

    function _advanceWinner(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner
    ) internal {
        uint8 nextRound = roundNumber + 1;
        uint8 nextMatchNumber = matchNumber / 2;
        
        Round storage nextRoundData = rounds[tierId][instanceId][nextRound];
        if (!nextRoundData.initialized) {
            _initializeRound(tierId, instanceId, nextRound);
        }
        
        bytes32 nextMatchId = _getMatchId(tierId, instanceId, nextRound, nextMatchNumber);
        
        if (matchNumber % 2 == 0) {
            _setMatchPlayer(nextMatchId, 0, winner);
        } else {
            _setMatchPlayer(nextMatchId, 1, winner);
        }

        (address p1, address p2) = _getMatchPlayers(nextMatchId);
        (, , MatchStatus status) = _getMatchResult(nextMatchId);
        
        if (p1 != address(0) && p2 != address(0) && status == MatchStatus.NotStarted) {
            require(p1 != p2, "Cannot match player against themselves");
            _initializeMatchForPlay(nextMatchId, tierId);
            
            _addPlayerActiveMatch(p1, nextMatchId);
            _addPlayerActiveMatch(p2, nextMatchId);

            emit MatchStarted(tierId, instanceId, nextRound, nextMatchNumber, p1, p2);
        }
    }

    function _completeMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (address player1, address player2) = _getMatchPlayers(matchId);

        _completeMatchWithResult(matchId, winner, isDraw);
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        if (isDraw) {
            drawParticipants[tierId][instanceId][roundNumber][matchNumber][player1] = true;
            drawParticipants[tierId][instanceId][roundNumber][matchNumber][player2] = true;
            _assignRankingOnElimination(tierId, instanceId, roundNumber, player1);
            _assignRankingOnElimination(tierId, instanceId, roundNumber, player2);
        } else {
            address loser = (player1 == winner) ? player2 : player1;
            _assignRankingOnElimination(tierId, instanceId, roundNumber, loser);
        }

        _removePlayerActiveMatch(player1, matchId);
        _removePlayerActiveMatch(player2, matchId);

        // For draws, both players are eliminated - check both immediately
        // For wins, only check loser for elimination (winner stays until next match completes)
        if (isDraw) {
            _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
            _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);
        } else {
            address loser = (player1 == winner) ? player2 : player1;
            _onPlayerEliminatedFromTournament(loser, tierId, instanceId, roundNumber);
        }

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            playerStats[winner].matchesWon++;
        }

        // Clear escalation state when match completes
        _clearEscalationState(matchId);

        emit MatchCompleted(matchId, winner, isDraw);

        if (!isDraw) {
            TierConfig storage config = _tierConfigs[tierId];
            if (roundNumber < config.totalRounds - 1) {
                _advanceWinner(tierId, instanceId, roundNumber, matchNumber, winner);
            }
            // Note: Winner elimination check happens when their next match completes (or tournament ends)
            // This keeps winners in the active tournament list even while waiting for next round to start
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
                // After processing orphaned winners, check if tournament can complete
                // This handles the case where only one winner remains after force elimination
                _checkForSoleWinnerCompletion(tierId, instanceId, roundNumber);
            }
            _completeRound(tierId, instanceId, roundNumber);
        }
    }

    function _completeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];

        emit RoundCompleted(tierId, instanceId, roundNumber);

        bool isActualFinals = (roundNumber == config.totalRounds - 1) ||
                             (roundNumber > 0 && round.totalMatches == 1 && round.completedMatches == 1);

        if (isActualFinals) {
            bytes32 finalMatchId = _getMatchId(tierId, instanceId, roundNumber, 0);
            (address finalWinner, bool finalIsDraw, ) = _getMatchResult(finalMatchId);
            (address finalPlayer1, address finalPlayer2) = _getMatchPlayers(finalMatchId);

            if (finalIsDraw) {
                tournament.finalsWasDraw = true;
                tournament.winner = finalPlayer1;
                tournament.coWinner = finalPlayer2;
                playerRanking[tierId][instanceId][finalPlayer1] = 1;
                playerRanking[tierId][instanceId][finalPlayer2] = 1;
                _completeTournament(tierId, instanceId, finalPlayer1);
            } else {
                _completeTournament(tierId, instanceId, finalWinner);
            }
        } else if (round.drawCount == round.totalMatches && round.totalMatches > 0) {
            round.allMatchesDrew = true;
            address[] memory remainingPlayers = _getRemainingPlayers(tierId, instanceId, roundNumber);
            emit AllDrawRoundDetected(tierId, instanceId, roundNumber, uint8(remainingPlayers.length));
            _completeTournamentAllDraw(tierId, instanceId, roundNumber, remainingPlayers);
        } else {
            tournament.currentRound = roundNumber + 1;
            _consolidateScatteredPlayers(tierId, instanceId, roundNumber + 1);

            if (tournament.status == TournamentStatus.Completed) {
                return;
            }

            Round storage nextRoundData = rounds[tierId][instanceId][roundNumber + 1];
            if (nextRoundData.initialized && nextRoundData.totalMatches == 0) {
                address soleWinner = address(0);
                uint8 winnerCount = 0;

                for (uint8 i = 0; i < round.totalMatches; i++) {
                    bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                    (address matchWinner, bool matchIsDraw, MatchStatus matchStatus) = _getMatchResult(matchId);
                    if (matchStatus == MatchStatus.Completed && matchWinner != address(0) && !matchIsDraw) {
                        soleWinner = matchWinner;
                        winnerCount++;
                    }
                }

                if (winnerCount == 1) {
                    _completeTournament(tierId, instanceId, soleWinner);
                    return;
                }
            }

            uint8 nextRound = roundNumber + 1;
            if (nextRound == config.totalRounds - 1) {
                bytes32 finalsMatchId = _getMatchId(tierId, instanceId, nextRound, 0);
                (address fp1, address fp2) = _getMatchPlayers(finalsMatchId);

                bool onlyPlayer1 = fp1 != address(0) && fp2 == address(0);
                bool onlyPlayer2 = fp2 != address(0) && fp1 == address(0);

                if (onlyPlayer1 || onlyPlayer2) {
                    address walkoverWinner = onlyPlayer1 ? fp1 : fp2;

                    bytes32 prevMatchId0 = _getMatchId(tierId, instanceId, roundNumber, 0);
                    bytes32 prevMatchId1 = _getMatchId(tierId, instanceId, roundNumber, 1);
                    (address pm0Winner, bool pm0Draw, ) = _getMatchResult(prevMatchId0);
                    (address pm1Winner, bool pm1Draw, ) = _getMatchResult(prevMatchId1);
                    (address pm0p1, address pm0p2) = _getMatchPlayers(prevMatchId0);
                    (address pm1p1, address pm1p2) = _getMatchPlayers(prevMatchId1);

                    address runnerUp = address(0);
                    if (pm0Winner == walkoverWinner && !pm0Draw) {
                        runnerUp = pm0p1 == walkoverWinner ? pm0p2 : pm0p1;
                    } else if (pm1Winner == walkoverWinner && !pm1Draw) {
                        runnerUp = pm1p1 == walkoverWinner ? pm1p2 : pm1p1;
                    }

                    if (runnerUp != address(0)) {
                        playerRanking[tierId][instanceId][runnerUp] = 2;
                    }

                    _completeTournament(tierId, instanceId, walkoverWinner);
                }
            }
        }
    }

    function _completeTournament(uint8 tierId, uint8 instanceId, address winner) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        tournament.status = TournamentStatus.Completed;

        if (tournament.winner == address(0)) {
            tournament.winner = winner;
            playerRanking[tierId][instanceId][winner] = 1;
        }

        uint256 winnersPot = tournament.prizePool;
        address[] storage players = enrolledPlayers[tierId][instanceId];

        if (tournament.finalsWasDraw) {
            playerStats[tournament.winner].tournamentsWon++;
            playerStats[tournament.coWinner].tournamentsWon++;
        } else {
            playerStats[winner].tournamentsWon++;
        }

        for (uint256 i = 0; i < players.length; i++) {
            playerStats[players[i]].tournamentsPlayed++;
        }

        _distributePrizes(tierId, instanceId, winnersPot);

        uint256 winnerPrize = playerPrizes[tierId][instanceId][winner];
        emit TournamentCompleted(tierId, instanceId, winner, winnerPrize, tournament.finalsWasDraw, tournament.coWinner);

        _updatePlayerEarnings(tierId, instanceId, winner);
        _resetTournamentAfterCompletion(tierId, instanceId);
    }

    function _completeTournamentAllDraw(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address[] memory remainingPlayers
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        tournament.status = TournamentStatus.Completed;
        tournament.allDrawResolution = true;
        tournament.allDrawRound = roundNumber;
        tournament.winner = address(0);

        uint256 winnersPot = tournament.prizePool;
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        address[] storage players = enrolledPlayers[tierId][instanceId];
        for (uint256 i = 0; i < players.length; i++) {
            playerStats[players[i]].tournamentsPlayed++;
        }

        _distributeEqualPrizes(tierId, instanceId, remainingPlayers, winnersPot);

        emit TournamentCompletedAllDraw(tierId, instanceId, roundNumber, uint8(remainingPlayers.length), prizePerPlayer);
        _updatePlayerEarnings(tierId, instanceId, address(0));
        _resetTournamentAfterCompletion(tierId, instanceId);
    }

    // ============ Prize Distribution ============

    /**
     * @dev Attempts to send prize to a recipient with fallback to protocol pool if failed
     * @param recipient Address to receive the prize
     * @param amount Amount to send in wei
     * @param tierId Tournament tier ID (for event logging)
     * @param instanceId Tournament instance ID (for event logging)
     * @return success True if prize was sent successfully, false if fell back to protocol pool
     *
     * If the send attempt fails, the amount is added to accumulatedProtocolShare
     * to prevent tournament stalling while ensuring funds are not lost.
     */
    function _sendPrizeWithFallback(
        address recipient,
        uint256 amount,
        uint8 tierId,
        uint8 instanceId
    ) internal returns (bool success) {
        require(amount > 0, "Amount must be greater than 0");

        // Attempt to send the prize once
        (bool sent, ) = payable(recipient).call{value: amount}("");

        if (sent) {
            return true; // Prize sent successfully
        }

        // If send failed, add amount to accumulated protocol share
        accumulatedProtocolShare += amount;

        emit PrizeDistributionFailed(tierId, instanceId, recipient, amount, 1);
        emit PrizeFallbackToContract(recipient, amount);

        return false; // Indicate fallback occurred
    }

    function _distributePrizes(uint8 tierId, uint8 instanceId, uint256 winnersPot) internal {
        address[] storage players = enrolledPlayers[tierId][instanceId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        uint8 enrolledCount = tournament.enrolledCount;
        uint8 maxRank = enrolledCount > 0 ? enrolledCount : _tierConfigs[tierId].playerCount;
        uint8[] memory rankCounts = new uint8[](maxRank + 1);

        for (uint256 i = 0; i < players.length; i++) {
            uint8 ranking = playerRanking[tierId][instanceId][players[i]];
            if (ranking > 0 && ranking <= maxRank) {
                rankCounts[ranking]++;
            }
        }

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            uint8 ranking = playerRanking[tierId][instanceId][player];

            if (ranking > 0 && ranking <= maxRank) {
                uint256 prizeAmount = _calculatePrizeForRank(tierId, ranking, rankCounts[ranking], winnersPot);

                if (prizeAmount > 0) {
                    playerPrizes[tierId][instanceId][player] = prizeAmount;

                    // Attempt to send prize with fallback to owner fees if failed
                    bool sent = _sendPrizeWithFallback(player, prizeAmount, tierId, instanceId);

                    // Only emit success event if prize was actually sent
                    // (Failed attempts already emit PrizeDistributionFailed and PrizeFallbackToOwnerFees)
                    if (sent) {
                        emit PrizeDistributed(tierId, instanceId, player, ranking, prizeAmount);
                    }
                }
            }
        }
    }

    function _distributeEqualPrizes(
        uint8 tierId,
        uint8 instanceId,
        address[] memory remainingPlayers,
        uint256 winnersPot
    ) internal {
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        for (uint256 i = 0; i < remainingPlayers.length; i++) {
            address player = remainingPlayers[i];
            playerRanking[tierId][instanceId][player] = 0;
            playerPrizes[tierId][instanceId][player] = prizePerPlayer;

            // Attempt to send prize with fallback to owner fees if failed
            bool sent = _sendPrizeWithFallback(player, prizePerPlayer, tierId, instanceId);

            // Only emit success event if prize was actually sent
            if (sent) {
                emit PrizeDistributed(tierId, instanceId, player, 1, prizePerPlayer);
            }
        }
    }

    function _calculatePrizeForRank(
        uint8 tierId,
        uint8 ranking,
        uint8 playersAtRank,
        uint256 winnersPot
    ) internal view returns (uint256) {
        uint8 prizeIndex = ranking - 1;
        uint256 combinedPercentage = 0;

        uint8[] storage prizeDistribution = _tierPrizeDistribution[tierId];
        for (uint8 j = 0; j < playersAtRank && (prizeIndex + j) < prizeDistribution.length; j++) {
            combinedPercentage += prizeDistribution[prizeIndex + j];
        }

        return (winnersPot * combinedPercentage) / (100 * uint256(playersAtRank));
    }

    // ============ Helper Functions ============

    function _getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tierId, instanceId, roundNumber, matchNumber));
    }

    /**
     * @dev Public wrapper for _getMatchId to allow external queries
     * Useful for off-chain tools and testing
     */
    function getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public pure returns (bytes32) {
        return _getMatchId(tierId, instanceId, roundNumber, matchNumber);
    }

    function _addPlayerActiveMatch(address player, bytes32 matchId) internal {
        playerActiveMatches[player].push(matchId);
        playerMatchIndex[player][matchId] = playerActiveMatches[player].length - 1;
    }

    function _removePlayerActiveMatch(address player, bytes32 matchId) internal {
        if (playerActiveMatches[player].length == 0) {
            return;
        }

        uint256 index = playerMatchIndex[player][matchId];
        uint256 lastIndex = playerActiveMatches[player].length - 1;

        if (index > lastIndex) {
            return;
        }

        if (index != lastIndex) {
            bytes32 lastMatchId = playerActiveMatches[player][lastIndex];
            playerActiveMatches[player][index] = lastMatchId;
            playerMatchIndex[player][lastMatchId] = index;
        }

        playerActiveMatches[player].pop();
        delete playerMatchIndex[player][matchId];
    }

    function _assignRankingOnElimination(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address player
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];
        uint8 playerCount = tournament.enrolledCount;

        uint8 baseRank;
        if (roundNumber == config.totalRounds - 1) {
            baseRank = 2;
        } else {
            uint8 remainingAfterRound = playerCount / uint8(2 ** (roundNumber + 1));
            baseRank = remainingAfterRound + 1;
        }

        playerRanking[tierId][instanceId][player] = baseRank;
    }

    function _log2(uint8 x) internal pure returns (uint8) {
        uint8 result = 0;
        while (x > 1) {
            x /= 2;
            result++;
        }
        return result;
    }

    function _hasOrphanedWinners(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal view returns (bool) {
        uint8 matchCount = _getMatchCountForRound(tierId, instanceId, roundNumber);

        for (uint8 i = 0; i < matchCount; i += 2) {
            if (i + 1 >= matchCount) break;

            bytes32 matchId1 = _getMatchId(tierId, instanceId, roundNumber, i);
            bytes32 matchId2 = _getMatchId(tierId, instanceId, roundNumber, i + 1);

            (address w1, bool d1, MatchStatus s1) = _getMatchResult(matchId1);
            (address w2, bool d2, MatchStatus s2) = _getMatchResult(matchId2);

            // Check if match 1 has a winner and match 2 has no winner (draw or double elimination)
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && (d2 || w2 == address(0))) {
                return true;
            }
            // Check if match 2 has a winner and match 1 has no winner (draw or double elimination)
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && (d1 || w1 == address(0))) {
                return true;
            }
        }

        return false;
    }

    function _processOrphanedWinners(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        TierConfig storage config = _tierConfigs[tierId];
        if (roundNumber >= config.totalRounds - 1) {
            return;
        }

        uint8 matchCount = _getMatchCountForRound(tierId, instanceId, roundNumber);

        for (uint8 i = 0; i < matchCount; i += 2) {
            if (i + 1 >= matchCount) break;

            bytes32 matchId1 = _getMatchId(tierId, instanceId, roundNumber, i);
            bytes32 matchId2 = _getMatchId(tierId, instanceId, roundNumber, i + 1);

            (address w1, bool d1, MatchStatus s1) = _getMatchResult(matchId1);
            (address w2, bool d2, MatchStatus s2) = _getMatchResult(matchId2);

            // Advance winner from match 1 if match 2 has no winner (draw or double elimination)
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && (d2 || w2 == address(0))) {
                _advanceWinner(tierId, instanceId, roundNumber, i, w1);
            }
            // Advance winner from match 2 if match 1 has no winner (draw or double elimination)
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && (d1 || w1 == address(0))) {
                _advanceWinner(tierId, instanceId, roundNumber, i + 1, w2);
            }
        }
    }

    function _getRemainingPlayers(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal view returns (address[] memory) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        address[] memory tempPlayers = new address[](round.totalMatches * 2);
        uint8 count = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = _getMatchPlayers(matchId);
            if (p1 != address(0)) {
                tempPlayers[count++] = p1;
            }
            if (p2 != address(0)) {
                tempPlayers[count++] = p2;
            }
        }

        address[] memory result = new address[](count);
        for (uint8 i = 0; i < count; i++) {
            result[i] = tempPlayers[i];
        }
        return result;
    }

    /**
     * @dev After processing orphaned winners, checks if tournament should complete
     * with a sole winner. This handles edge cases where force elimination leaves
     * only one remaining player who gets advanced to next round alone.
     */
    function _checkForSoleWinnerCompletion(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal {
        TierConfig storage config = _tierConfigs[tierId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        // Only check if not already completed and not in finals
        if (tournament.status == TournamentStatus.Completed) {
            return;
        }

        uint8 nextRound = roundNumber + 1;
        if (nextRound >= config.totalRounds) {
            return;
        }

        // Check if next round has only one player across all matches
        Round storage nextRoundData = rounds[tierId][instanceId][nextRound];
        if (!nextRoundData.initialized) {
            return;
        }

        address solePlayer = address(0);
        uint8 playerCount = 0;

        for (uint8 i = 0; i < nextRoundData.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, nextRound, i);
            (address p1, address p2) = _getMatchPlayers(matchId);

            if (p1 != address(0)) {
                solePlayer = p1;
                playerCount++;
            }
            if (p2 != address(0)) {
                if (solePlayer == address(0)) {
                    solePlayer = p2;
                }
                playerCount++;
            }
        }

        // If exactly one player in next round, they win by default
        if (playerCount == 1 && solePlayer != address(0)) {
            _completeTournament(tierId, instanceId, solePlayer);
        }
    }

    function _consolidateScatteredPlayers(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (!round.initialized) {
            return;
        }

        address[] memory playersInRound = new address[](round.totalMatches * 2);
        uint8 playerCount = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = _getMatchPlayers(matchId);

            if (p1 != address(0)) {
                playersInRound[playerCount++] = p1;
            }
            if (p2 != address(0)) {
                playersInRound[playerCount++] = p2;
            }
        }

        if (playerCount == 0) {
            return;
        }

        bool needsConsolidation = false;
        uint8 incompleteMatches = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = _getMatchPlayers(matchId);

            bool hasPlayer1 = p1 != address(0);
            bool hasPlayer2 = p2 != address(0);

            if (hasPlayer1 != hasPlayer2) {
                needsConsolidation = true;
                incompleteMatches++;
            }
        }

        if (!needsConsolidation) {
            return;
        }

        if (playerCount == 1) {
            _completeTournament(tierId, instanceId, playersInRound[0]);
            return;
        }

        if (playerCount == 2 && incompleteMatches >= 2) {
            for (uint8 i = 0; i < round.totalMatches; i++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                (address p1, address p2) = _getMatchPlayers(matchId);

                if (p1 != address(0) && playerActiveMatches[p1].length > 0) {
                    _removePlayerActiveMatch(p1, matchId);
                }
                if (p2 != address(0) && playerActiveMatches[p2].length > 0) {
                    _removePlayerActiveMatch(p2, matchId);
                }

                _setMatchPlayer(matchId, 0, address(0));
                _setMatchPlayer(matchId, 1, address(0));
                _resetMatchGame(matchId);
            }

            bytes32 match0Id = _getMatchId(tierId, instanceId, roundNumber, 0);
            _setMatchPlayer(match0Id, 0, playersInRound[0]);
            _setMatchPlayer(match0Id, 1, playersInRound[1]);

            _addPlayerActiveMatch(playersInRound[0], match0Id);
            _addPlayerActiveMatch(playersInRound[1], match0Id);

            _initializeMatchForPlay(match0Id, tierId);
            round.totalMatches = 1;

            emit MatchStarted(tierId, instanceId, roundNumber, 0, playersInRound[0], playersInRound[1]);
            emit PlayersConsolidated(tierId, instanceId, roundNumber, playersInRound[0], playersInRound[1]);
            return;
        }

        // General case: 3+ players scattered
        uint8 currentMatchIndex = 0;
        uint8 nextPlayerIndex = 0;

        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            (address p1, address p2) = _getMatchPlayers(matchId);

            if (p1 != address(0) && playerActiveMatches[p1].length > 0) {
                _removePlayerActiveMatch(p1, matchId);
            }
            if (p2 != address(0) && playerActiveMatches[p2].length > 0) {
                _removePlayerActiveMatch(p2, matchId);
            }

            _setMatchPlayer(matchId, 0, address(0));
            _setMatchPlayer(matchId, 1, address(0));
            _resetMatchGame(matchId);
        }

        while (nextPlayerIndex < playerCount) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, currentMatchIndex);

            if (nextPlayerIndex < playerCount) {
                _setMatchPlayer(matchId, 0, playersInRound[nextPlayerIndex++]);
                _addPlayerActiveMatch(playersInRound[nextPlayerIndex - 1], matchId);
            }

            if (nextPlayerIndex < playerCount) {
                _setMatchPlayer(matchId, 1, playersInRound[nextPlayerIndex++]);
                _addPlayerActiveMatch(playersInRound[nextPlayerIndex - 1], matchId);

                _initializeMatchForPlay(matchId, tierId);
                (address mp1, address mp2) = _getMatchPlayers(matchId);
                emit MatchStarted(tierId, instanceId, roundNumber, currentMatchIndex, mp1, mp2);
            } else {
                (address mp1, ) = _getMatchPlayers(matchId);
                _advanceWinner(tierId, instanceId, roundNumber, currentMatchIndex, mp1);
            }

            currentMatchIndex++;
        }

        round.totalMatches = currentMatchIndex;
    }

    // ============ Escalation Level 2 & 3 (Tournament-Level Timeout) ============

    /**
     * @dev Internal function to mark a match as stalled when timeout is claimable
     * Sets escalation timers to enable progressive intervention
     * Called by game contracts when a player runs out of time
     * @param matchId The match identifier
     * @param tierId The tier ID (for config)
     * @param timeoutOccurredAt When the timeout actually happened (0 = use current time)
     */
    function _markMatchStalled(bytes32 matchId, uint8 tierId, uint256 timeoutOccurredAt) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            timeout.isStalled = true;
            TierConfig storage config = _tierConfigs[tierId];

            // If timeoutOccurredAt is 0, use current time
            uint256 baseTime = timeoutOccurredAt == 0 ? block.timestamp : timeoutOccurredAt;

            // Use tier-specific timeout configuration
            timeout.escalation1Start = baseTime + config.timeouts.matchLevel2Delay;
            timeout.escalation2Start = baseTime + config.timeouts.matchLevel3Delay;
            timeout.activeEscalation = EscalationLevel.None;
        }
    }

    /**
     * @dev Convenience overload that uses current time as timeout timestamp
     */
    function _markMatchStalled(bytes32 matchId, uint8 tierId) internal {
        _markMatchStalled(matchId, tierId, 0);
    }

    /**
     * @dev Clears escalation state for a match after it completes
     * @param matchId The match identifier
     */
    function _clearEscalationState(bytes32 matchId) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    /**
     * @dev Check if a match should be marked as stalled and mark it if needed
     * A match is stalled if it's in progress and a player's time has run out
     * Returns true if match is stalled (was already or just marked)
     */
    function _checkAndMarkStalled(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal returns (bool) {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If already marked as stalled, return true
        if (timeout.isStalled) {
            return true;
        }

        // Check if match is active
        if (!_isMatchActive(matchId)) {
            return false;
        }

        // Get match common data to check status
        CommonMatchData memory matchData = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has run out of time (using game-specific time bank logic)
        if (_hasCurrentPlayerTimedOut(matchId)) {
            TierConfig storage config = _tierConfigs[tierId];

            // Calculate when the timeout occurred for accurate escalation timing
            // Timeout occurs at: lastMoveTime + currentPlayer's timeRemaining
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;

            // Mark as stalled with escalation timers starting from timeout occurrence
            _markMatchStalled(matchId, tierId, timeoutOccurredAt);
            return true;
        }

        return false;
    }

    /**
     * @dev Level 2 Escalation: Advanced player forces elimination of stalled match
     * Callable by any player who has advanced past this round
     * Both stalled players are eliminated, match completes with no winner
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check and mark match as stalled if it qualifies
        _checkAndMarkStalled(matchId, tierId, instanceId, roundNumber, matchNumber);

        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // Require match is stalled and Level 2 is active
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation1Start, "Level 2 not active yet");

        // Require caller is an advanced player
        require(_isPlayerInAdvancedRound(tierId, instanceId, roundNumber, msg.sender),
                "Not an advanced player");

        // Mark escalation level and double eliminate both players
        timeout.activeEscalation = EscalationLevel.Escalation2_AdvancedPlayers;
        _completeMatchDoubleElimination(tierId, instanceId, roundNumber, matchNumber);
    }

    /**
     * @dev Level 3 Escalation: External player replaces stalled players
     * Callable by non-advanced players and external players
     * NOT callable by advanced players (prevents tournament position paradox)
     * Replacement player wins the match and advances in tournament
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check and mark match as stalled if it qualifies
        _checkAndMarkStalled(matchId, tierId, instanceId, roundNumber, matchNumber);

        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // Require match is stalled and Level 3 window is active
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation2Start, "Level 3 not active yet");

        // Prevent advanced players from claiming (they should use L2 instead)
        // This prevents paradoxical tournament states where a player is in multiple rounds
        require(!_isPlayerInAdvancedRound(tierId, instanceId, roundNumber, msg.sender),
                "Advanced players cannot claim L3");

        // Mark escalation level and complete match with replacement winner
        timeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;
        _completeMatchByReplacement(tierId, instanceId, roundNumber, matchNumber, msg.sender);
    }

    /**
     * @dev Check if a player has advanced in the tournament
     * Used for Escalation Level 2 - allows advanced players to force eliminate stalled matches
     *
     * A player is considered "advanced" if:
     * 1. They won a match in any round up to the stalled round, OR
     * 2. They were placed in a round AFTER the stalled round (walkover/auto-advance)
     */
    function _isPlayerInAdvancedRound(
        uint8 tierId,
        uint8 instanceId,
        uint8 stalledRoundNumber,
        address player
    ) internal view returns (bool) {
        if (!isEnrolled[tierId][instanceId][player]) {
            return false;
        }

        // Check 1: Has player won a match in any round up to and including the stalled round?
        for (uint8 r = 0; r <= stalledRoundNumber; r++) {
            Round storage round = rounds[tierId][instanceId][r];

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                (address winner, bool isDraw, MatchStatus status) = _getMatchResult(matchId);

                if (status == MatchStatus.Completed &&
                    winner == player &&
                    !isDraw) {
                    return true;
                }
            }
        }

        // Check 2: Is player assigned to a match in a round AFTER the stalled round?
        // This catches walkover/auto-advanced players
        TierConfig storage config = _tierConfigs[tierId];
        for (uint8 r = stalledRoundNumber + 1; r < config.totalRounds; r++) {
            Round storage round = rounds[tierId][instanceId][r];
            if (!round.initialized) continue;

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                (address p1, address p2) = _getMatchPlayers(matchId);

                if (p1 == player || p2 == player) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @dev Complete a match by double elimination (both players eliminated, no winner)
     */
    function _completeMatchDoubleElimination(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (address player1, address player2) = _getMatchPlayers(matchId);

        _completeMatchWithResult(matchId, address(0), false);
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        _assignRankingOnElimination(tierId, instanceId, roundNumber, player1);
        _assignRankingOnElimination(tierId, instanceId, roundNumber, player2);

        _removePlayerActiveMatch(player1, matchId);
        _removePlayerActiveMatch(player2, matchId);
        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;

        emit MatchCompleted(matchId, address(0), false);

        // Clear escalation state
        _clearEscalationState(matchId);

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
                // After processing orphaned winners, check if tournament can complete
                _checkForSoleWinnerCompletion(tierId, instanceId, roundNumber);
            }
            _completeRound(tierId, instanceId, roundNumber);
        }
    }

    /**
     * @dev Complete a match by replacement (external player takes over as winner)
     */
    function _completeMatchByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address replacementPlayer
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (address player1, address player2) = _getMatchPlayers(matchId);

        _completeMatchWithResult(matchId, replacementPlayer, false);
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        _assignRankingOnElimination(tierId, instanceId, roundNumber, player1);
        _assignRankingOnElimination(tierId, instanceId, roundNumber, player2);

        _removePlayerActiveMatch(player1, matchId);
        _removePlayerActiveMatch(player2, matchId);
        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;

        // Add replacement player to tournament if not already enrolled
        if (!isEnrolled[tierId][instanceId][replacementPlayer]) {
            enrolledPlayers[tierId][instanceId].push(replacementPlayer);
            isEnrolled[tierId][instanceId][replacementPlayer] = true;
            TournamentInstance storage tournament = tournaments[tierId][instanceId];
            tournament.enrolledCount++;
            _onExternalPlayerReplacement(tierId, instanceId, replacementPlayer);
        }

        playerStats[replacementPlayer].matchesPlayed++;
        playerStats[replacementPlayer].matchesWon++;

        emit MatchCompleted(matchId, replacementPlayer, false);

        // Clear escalation state
        _clearEscalationState(matchId);

        TierConfig storage config = _tierConfigs[tierId];
        if (roundNumber < config.totalRounds - 1) {
            _advanceWinner(tierId, instanceId, roundNumber, matchNumber, replacementPlayer);
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
                // After processing orphaned winners, check if tournament can complete
                _checkForSoleWinnerCompletion(tierId, instanceId, roundNumber);
            }
            _completeRound(tierId, instanceId, roundNumber);
        }
    }

    // ============ Escalation Availability Helpers (Public View) ============

    /**
     * @dev Check if Level 1 escalation (opponent timeout claim) is available
     * @return available True if opponent can claim timeout victory
     */
    function isMatchEscL1Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!_isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        return _hasCurrentPlayerTimedOut(matchId);
    }

    /**
     * @dev Check if Level 2 escalation (advanced player force eliminate) is available
     * @return available True if L2 time window is active
     */
    function isMatchEscL2Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!_isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        if (!_hasCurrentPlayerTimedOut(matchId)) {
            return false;
        }

        // Check timeout state
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If not marked as stalled yet, calculate when L2 would start
        if (!timeout.isStalled) {
            TierConfig storage config = _tierConfigs[tierId];
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;
            uint256 l2Start = timeoutOccurredAt + config.timeouts.matchLevel2Delay;
            return block.timestamp >= l2Start;
        }

        // If already marked as stalled, check if L2 window is active
        return block.timestamp >= timeout.escalation1Start;
    }

    /**
     * @dev Check if Level 3 escalation (external player replacement) is available
     * @return available True if L3 time window is active
     */
    function isMatchEscL3Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!_isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        if (!_hasCurrentPlayerTimedOut(matchId)) {
            return false;
        }

        // Check timeout state
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If not marked as stalled yet, calculate when L3 would start
        if (!timeout.isStalled) {
            TierConfig storage config = _tierConfigs[tierId];
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;
            uint256 l3Start = timeoutOccurredAt + config.timeouts.matchLevel3Delay;
            return block.timestamp >= l3Start;
        }

        // If already marked as stalled, check if L3 window is active
        return block.timestamp >= timeout.escalation2Start;
    }

    /**
     * @notice Check if a specific address is an advanced player in the tournament
     * @dev Returns true if the player has won a match and advanced past the specified round
     * @param player The address to check
     * @param tierId The tier ID
     * @param instanceId The instance ID
     * @param roundNumber The round number being queried
     * @return isAdvanced True if the player has advanced past the given round
     */
    function isPlayerInAdvancedRound(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) external view returns (bool isAdvanced) {
        return _isPlayerInAdvancedRound(tierId, instanceId, roundNumber, player);
    }

    // ============ Caching Functions ============

    function _updatePlayerEarnings(uint8 tierId, uint8 instanceId, address winner) internal {
        address[] storage players = enrolledPlayers[tierId][instanceId];

        // Only track players who actually won prizes on the leaderboard
        for (uint8 i = 0; i < players.length; i++) {
            address player = players[i];
            uint256 prize = playerPrizes[tierId][instanceId][player];

            if (prize > 0) {
                // Player won a prize - track them and add earnings
                _trackOnLeaderboard(player);
                playerEarnings[player] += int256(prize);
            }
            // Players with no prize are not tracked unless already on leaderboard
        }

        emit TournamentCached(tierId, instanceId, winner);
    }

    function _updateAbandonedEarnings(
        uint8 tierId,
        uint8 instanceId,
        address claimer,
        uint256 claimAmount
    ) internal {
        // Only track the claimer if they receive a claim amount
        // Enrolled players who abandoned don't receive anything, so don't track them
        if (claimAmount > 0) {
            _trackOnLeaderboard(claimer);
            playerEarnings[claimer] += int256(claimAmount);
        }

        emit TournamentCached(tierId, instanceId, address(0));
    }

    function _trackOnLeaderboard(address player) internal {
        if (!_isOnLeaderboard[player]) {
            _isOnLeaderboard[player] = true;
            _leaderboardPlayers.push(player);
        }
    }

    /**
     * @dev Cache old finals match before new finals replaces it (instance-specific eviction)
     * @param tierId Tournament tier
     * @param instanceId Tournament instance
     * @param currentFinalsMatchId The new finals matchId that's being preserved
     */
    function _cacheOldFinalsIfExists(
        uint8 tierId,
        uint8 instanceId,
        bytes32 currentFinalsMatchId
    ) internal {
        // Get the old finals data from live storage
        (address p1, address p2) = _getMatchPlayers(currentFinalsMatchId);

        // Check if match has been played (both players exist)
        if (p1 == address(0) || p2 == address(0)) {
            return;  // No old finals to cache
        }

        // Check match status - only cache if completed
        (, , MatchStatus status) = _getMatchResult(currentFinalsMatchId);
        if (status != MatchStatus.Completed) {
            return;  // Match not completed, don't cache
        }

        // Old finals exists and is completed - cache it before it gets cleared
        TierConfig storage config = _tierConfigs[tierId];
        uint8 finalRound = config.totalRounds - 1;

        _addToMatchCacheGame(tierId, instanceId, finalRound, 0);

        // Now reset the old finals match to make room for new one
        _resetMatchGame(currentFinalsMatchId);
    }

    function _resetTournamentAfterCompletion(uint8 tierId, uint8 instanceId) internal virtual {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];

        // Calculate finals matchId (last round, match 0)
        uint8 finalRound = config.totalRounds - 1;
        bytes32 finalsMatchId = _getMatchId(tierId, instanceId, finalRound, 0);

        // Check if there's old finals from a previous tournament that needs caching
        // The finals is from a previous tournament if its winner doesn't match current tournament winner
        (address finalsWinner, , MatchStatus finalsStatus) = _getMatchResult(finalsMatchId);

        if (finalsStatus == MatchStatus.Completed && finalsWinner != address(0)) {
            // Check if finals winner matches the current tournament winner
            address currentWinner = tournament.winner;

            // If winners don't match, this finals is from a previous tournament
            if (finalsWinner != currentWinner) {
                // Cache the old finals before clearing it
                _addToMatchCacheGame(tierId, instanceId, finalRound, 0);
                _resetMatchGame(finalsMatchId);
            }
        }

        tournament.status = TournamentStatus.Enrolling;
        tournament.currentRound = 0;
        tournament.enrolledCount = 0;
        tournament.prizePool = 0;
        tournament.startTime = 0;
        tournament.winner = address(0);
        tournament.coWinner = address(0);
        tournament.finalsWasDraw = false;
        tournament.allDrawResolution = false;
        tournament.allDrawRound = NO_ROUND;
        tournament.hasStartedViaTimeout = false;

        tournament.enrollmentTimeout.escalation1Start = 0;
        tournament.enrollmentTimeout.escalation2Start = 0;
        tournament.enrollmentTimeout.activeEscalation = EscalationLevel.None;
        tournament.enrollmentTimeout.forfeitPool = 0;

        address[] storage players = enrolledPlayers[tierId][instanceId];

        // Copy players array before deletion for tracking cleanup
        address[] memory playersCopy = new address[](players.length);
        for (uint256 i = 0; i < players.length; i++) {
            playersCopy[i] = players[i];
        }

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            isEnrolled[tierId][instanceId][player] = false;
            delete playerRanking[tierId][instanceId][player];
            // Note: playerPrizes is intentionally NOT deleted - it's permanent historical record
        }
        delete enrolledPlayers[tierId][instanceId];

        // Notify tracking systems of tournament completion
        _onTournamentCompleted(tierId, instanceId, playersCopy);

        for (uint8 roundNum = 0; roundNum < config.totalRounds; roundNum++) {
            Round storage round = rounds[tierId][instanceId][roundNum];

            // IMPORTANT: Calculate matchCount BEFORE resetting round metadata
            // because _getMatchCountForRound() relies on previous round's totalMatches
            uint8 matchCount = round.totalMatches > 0 ? round.totalMatches : _getMatchCountForRound(tierId, instanceId, roundNum);

            // Now reset round metadata
            round.totalMatches = 0;
            round.completedMatches = 0;
            round.initialized = false;
            round.drawCount = 0;
            round.allMatchesDrew = false;

            for (uint8 matchNum = 0; matchNum < matchCount; matchNum++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNum, matchNum);

                // Skip resetting finals match - keep it in live storage
                if (matchId == finalsMatchId) {
                    continue;
                }

                // Clear drawParticipants for both match players
                (address p1, address p2) = _getMatchPlayers(matchId);
                if (p1 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p1];
                }
                if (p2 != address(0)) {
                    delete drawParticipants[tierId][instanceId][roundNum][matchNum][p2];
                }

                _resetMatchGame(matchId);
            }
        }

        emit TournamentReset(tierId, instanceId);
    }

    // ============ View Functions ============

    function getTournamentInfo(uint8 tierId, uint8 instanceId) external view returns (
        TournamentStatus status,
        Mode mode,
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    ) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return (
            tournament.status,
            tournament.mode,
            tournament.currentRound,
            tournament.enrolledCount,
            tournament.prizePool,
            tournament.winner
        );
    }

    function getPlayerActiveMatches(address player) external view returns (bytes32[] memory) {
        return playerActiveMatches[player];
    }

    function getEnrolledPlayers(uint8 tierId, uint8 instanceId) external view returns (address[] memory) {
        return enrolledPlayers[tierId][instanceId];
    }

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (
        uint8 totalMatches,
        uint8 completedMatches,
        bool initialized
    ) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        return (round.totalMatches, round.completedMatches, round.initialized);
    }

    /**
     * @dev Get common match data with automatic cache fallback
     * Internal helper used by game-specific getMatch() functions
     *
     * Flow:
     * 1. Check active match storage via _isMatchActive()
     * 2. If active, return live data via _getActiveMatchData()
     * 3. If not active, check cache via _getMatchFromCache()
     * 4. If in cache, return cached data
     * 5. If neither, revert with "Match not found"
     *
     * @param tierId Tournament tier ID
     * @param instanceId Instance ID within tier
     * @param roundNumber Round number (0-based)
     * @param matchNumber Match number within round (0-based)
     * @return commonData Common match data with automatic cache fallback
     */
    function _getMatchCommon(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view returns (CommonMatchData memory commonData) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Try active match first
        if (_isMatchActive(matchId)) {
            return _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        }

        // Check if round is initialized first
        Round storage round = rounds[tierId][instanceId][roundNumber];

        if (round.initialized) {
            // Round is initialized - this is part of current tournament
            // Return active match data (even if empty/cleared)
            return _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        }

        // Round not initialized - check if this is a preserved finals from previous tournament
        TierConfig storage config = _tierConfigs[tierId];
        uint8 finalRound = config.totalRounds - 1;

        if (roundNumber == finalRound && matchNumber == 0) {
            // This is a finals match - check if it's preserved in live storage
            (address p1, address p2) = _getMatchPlayers(matchId);

            if (p1 != address(0) && p2 != address(0)) {
                // Finals data exists and round not initialized - must be from previous tournament
                // Return the preserved finals data
                return _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
            }
        }

        // Round not initialized - fallback to cache for historical data lookup
        (CommonMatchData memory cachedData, bool exists) = _getMatchFromCache(
            matchId, tierId, instanceId, roundNumber, matchNumber
        );

        require(exists, "Match not found in active storage or cache");
        return cachedData;
    }

    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    function getTierOverview(uint8 tierId) external view returns (
        TournamentStatus[] memory statuses,
        uint8[] memory enrolledCounts,
        uint256[] memory prizePools
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        uint8 instanceCount = config.instanceCount;
        statuses = new TournamentStatus[](instanceCount);
        enrolledCounts = new uint8[](instanceCount);
        prizePools = new uint256[](instanceCount);

        for (uint8 i = 0; i < instanceCount; i++) {
            TournamentInstance storage tournament = tournaments[tierId][i];
            statuses[i] = tournament.status;
            enrolledCounts[i] = tournament.enrolledCount;
            prizePools[i] = tournament.prizePool;
        }

        return (statuses, enrolledCounts, prizePools);
    }

    function getPrizePercentage(uint8 tierId, uint8 ranking) public view returns (uint8 percentage) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        uint8[] storage dist = _tierPrizeDistribution[tierId];
        require(ranking < dist.length, "Invalid ranking");
        return dist[ranking];
    }

    function getTierPrizeDistribution(uint8 tierId) external view returns (uint8[] memory percentages) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        return _tierPrizeDistribution[tierId];
    }

    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        LeaderboardEntry[] memory entries = new LeaderboardEntry[](_leaderboardPlayers.length);
        for (uint256 i = 0; i < _leaderboardPlayers.length; i++) {
            entries[i] = LeaderboardEntry({
                player: _leaderboardPlayers[i],
                earnings: playerEarnings[_leaderboardPlayers[i]]
            });
        }
        return entries;
    }

    function getLeaderboardCount() external view returns (uint256) {
        return _leaderboardPlayers.length;
    }

    /**
     * @dev Returns detailed raffle state information for client display
     *
     * This function provides all information needed to explain the raffle to users:
     * - Current progress: how much has accumulated vs the target
     * - Target breakdown: how much will be distributed vs kept as reserve (10%)
     * - Distribution split: owner (20%) vs winner (80%) shares
     *
     * Example for 3 ETH threshold:
     *   "Target: 3 ETH. When reached, 2.7 ETH distributed (0.3 ETH kept as reserve)"
     *   "Current: 0.5 ETH. Need 2.5 ETH more to trigger raffle"
     *   "Distribution: 0.54 ETH to owner (20%), 2.16 ETH to winner (80%)"
     *
     * @return raffleIndex Current raffle number (0 before first, increments after each execution)
     * @return isReady True if threshold reached and raffle can be executed
     * @return currentAccumulated Current protocol share accumulated
     * @return threshold Target amount needed to trigger raffle
     * @return reserve Amount that will be kept in protocol after raffle executes (10% of threshold)
     * @return raffleAmount Amount that will be distributed when threshold is reached (threshold - reserve = 90%)
     * @return ownerShare Owner's portion of raffleAmount (20%)
     * @return winnerShare Winner's portion of raffleAmount (80%)
     * @return eligiblePlayerCount Number of unique players who can trigger/win the raffle
     */
    function getRaffleInfo()
        external
        view
        returns (
            uint256 raffleIndex,
            bool isReady,
            uint256 currentAccumulated,
            uint256 threshold,
            uint256 reserve,
            uint256 raffleAmount,
            uint256 ownerShare,
            uint256 winnerShare,
            uint256 eligiblePlayerCount
        )
    {
        raffleIndex = currentRaffleIndex;
        currentAccumulated = accumulatedProtocolShare;

        // Use virtual functions for threshold and reserve
        threshold = _getRaffleThreshold();
        reserve = _getRaffleReserve();

        isReady = currentAccumulated >= threshold;

        // Always calculate what the distribution WILL BE at threshold
        // This allows clients to display: "When 3 ETH reached, 2 ETH distributed, 1 ETH kept"
        // even before the threshold is reached
        raffleAmount = threshold - reserve;
        ownerShare = (raffleAmount * 20) / 100;
        winnerShare = (raffleAmount * 80) / 100;

        // Count eligible players
        (address[] memory players, , ) = _getAllEnrolledPlayersWithWeights();
        eligiblePlayerCount = players.length;

        return (
            raffleIndex,
            isReady,
            currentAccumulated,
            threshold,
            reserve,
            raffleAmount,
            ownerShare,
            winnerShare,
            eligiblePlayerCount
        );
    }

    // ============ Configuration Getter Functions ============

    /**
     * @dev Get all tier IDs that have been registered
     * @return Array of tier IDs (0 to tierCount-1)
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
     * @param tierId The tier ID to query
     * @return playerCount Number of players in this tier's tournaments
     * @return instanceCount Number of concurrent tournament instances
     * @return entryFee Entry fee in wei
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
     * @param tierId The tier ID to query
     * @return matchTimePerPlayer Time each player gets for entire match (seconds)
     * @return timeIncrementPerMove Fischer increment bonus per move (seconds)
     * @return matchLevel2Delay Delay after timeout before L2 escalation (seconds)
     * @return matchLevel3Delay Delay after timeout before L3 escalation (seconds)
     * @return enrollmentWindow Time to wait before force-start allowed (seconds)
     * @return enrollmentLevel2Delay Delay before L2 enrollment escalation (seconds)
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

    /**
     * @dev Get complete tier configuration in one call
     * @param tierId The tier ID to query
     * @return playerCount Number of players in tournament
     * @return instanceCount Number of concurrent instances
     * @return entryFee Entry fee in wei
     * @return matchTimePerPlayer Time per player (seconds)
     * @return timeIncrementPerMove Fischer increment (seconds)
     * @return matchLevel2Delay L2 escalation delay (seconds)
     * @return matchLevel3Delay L3 escalation delay (seconds)
     * @return enrollmentWindow Enrollment timeout window (seconds)
     * @return enrollmentLevel2Delay Enrollment L2 delay (seconds)
     * @return prizeDistribution Prize percentages array
     */
    function getTierConfiguration(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        uint256 matchLevel2Delay,
        uint256 matchLevel3Delay,
        uint256 enrollmentWindow,
        uint256 enrollmentLevel2Delay,
        uint8[] memory prizeDistribution
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        TimeoutConfig storage timeouts = config.timeouts;

        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            timeouts.matchTimePerPlayer,
            timeouts.timeIncrementPerMove,
            timeouts.matchLevel2Delay,
            timeouts.matchLevel3Delay,
            timeouts.enrollmentWindow,
            timeouts.enrollmentLevel2Delay,
            _tierPrizeDistribution[tierId]
        );
    }

    /**
     * @dev Get total capacity across all tiers
     * @return totalPlayers Maximum number of concurrent players across all tiers
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

    /**
     * @dev Get maximum concurrent players for a specific tier
     * @param tierId The tier ID to query
     * @return capacity Maximum concurrent players (playerCount * instanceCount)
     */
    function getTierCapacity(uint8 tierId) external view returns (uint256) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        return uint256(config.playerCount) * uint256(config.instanceCount);
    }

    /**
     * @dev Get protocol fee distribution percentages
     * @return prizePoolPercentage Percentage to prize pool (9000 = 90%)
     * @return ownerFeePercentage Percentage to owner (750 = 7.5%)
     * @return protocolFeePercentage Percentage to protocol (250 = 2.5%)
     * @return basisPoints Total basis points (10000 = 100%)
     */
    function getFeeDistribution() external pure returns (
        uint256 prizePoolPercentage,
        uint256 ownerFeePercentage,
        uint256 protocolFeePercentage,
        uint256 basisPoints
    ) {
        return (
            PARTICIPANTS_SHARE_BPS,
            OWNER_SHARE_BPS,
            PROTOCOL_SHARE_BPS,
            BASIS_POINTS
        );
    }

    /**
     * @dev Get raffle configuration for current raffle
     * @return threshold Amount needed to trigger current raffle (e.g., 3 ether)
     * @return reserve Amount kept as reserve after raffle (10% of threshold)
     * @return ownerSharePercentage Owner's share of distributed amount (20%)
     * @return winnerSharePercentage Winner's share of distributed amount (80%)
     */
    function getRaffleConfiguration() external view returns (
        uint256 threshold,
        uint256 reserve,
        uint256 ownerSharePercentage,
        uint256 winnerSharePercentage
    ) {
        threshold = _getRaffleThreshold();
        reserve = _getRaffleReserve();
        return (
            threshold,
            reserve,
            20,  // 20% to owner
            80   // 80% to winner
        );
    }

    /**
     * @dev Get complete raffle threshold configuration
     * @return thresholds Array of configured thresholds for initial raffles
     * @return finalThreshold Threshold used after initial thresholds exhausted
     * @return currentThreshold Current raffle threshold (based on currentRaffleIndex)
     * @notice Returns the raffle threshold progression configured at deployment
     *         Example: thresholds=[0.2, 0.4, 0.6, 0.8, 1.0], finalThreshold=1.0
     *         means raffles 0-4 use array values, raffle 5+ use 1.0 ether
     */
    function getRaffleThresholds() external view returns (
        uint256[] memory thresholds,
        uint256 finalThreshold,
        uint256 currentThreshold
    ) {
        thresholds = raffleThresholds;
        finalThreshold = raffleThresholdFinal;
        currentThreshold = _getRaffleThreshold();
        return (thresholds, finalThreshold, currentThreshold);
    }

    /**
     * @dev Get game metadata - to be overridden by implementing contracts
     * @return gameName Name of the game
     * @return gameVersion Version string
     * @return gameDescription Short description
     */
    function getGameMetadata() external view virtual returns (
        string memory gameName,
        string memory gameVersion,
        string memory gameDescription
    ) {
        return ("ETour Base", "1.0.0", "Universal tournament protocol");
    }

    // ============ Protocol Raffle System ============

    /**
     * @dev Checks if caller is enrolled in any active tournament
     * @param caller Address to check
     * @return true if caller is enrolled in at least one active tournament (Enrolling or InProgress)
     */
    function _isCallerEnrolledInActiveTournament(address caller)
        internal
        view
        returns (bool)
    {
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only check Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    if (isEnrolled[tierId][instanceId][caller]) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * @dev Gets all enrolled players across active tournaments with enrollment counts
     * @return players Array of unique player addresses
     * @return weights Array of enrollment counts per player
     * @return totalWeight Sum of all weights
     */
    function _getAllEnrolledPlayersWithWeights()
        internal
        view
        returns (
            address[] memory players,
            uint256[] memory weights,
            uint256 totalWeight
        )
    {
        // Use dynamic approach with temporary arrays (max 1000 unique players)
        address[] memory tempPlayers = new address[](1000);
        uint256 uniqueCount = 0;
        totalWeight = 0;

        // First pass: collect unique players and count total enrollments
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];

                // Only count Enrolling and InProgress tournaments
                if (tournament.status == TournamentStatus.Enrolling ||
                    tournament.status == TournamentStatus.InProgress) {

                    address[] storage enrolled = enrolledPlayers[tierId][instanceId];

                    for (uint256 i = 0; i < enrolled.length; i++) {
                        address player = enrolled[i];
                        bool found = false;

                        // Check if player already in tempPlayers
                        for (uint256 j = 0; j < uniqueCount; j++) {
                            if (tempPlayers[j] == player) {
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            tempPlayers[uniqueCount] = player;
                            uniqueCount++;
                        }

                        totalWeight++;
                    }
                }
            }
        }

        // Allocate exact-size arrays
        players = new address[](uniqueCount);
        weights = new uint256[](uniqueCount);

        // Second pass: count weights for each unique player
        for (uint256 i = 0; i < uniqueCount; i++) {
            players[i] = tempPlayers[i];
            uint256 playerWeight = 0;

            for (uint8 tierId = 0; tierId < tierCount; tierId++) {
                TierConfig storage config = _tierConfigs[tierId];

                for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                    TournamentInstance storage tournament = tournaments[tierId][instanceId];

                    if ((tournament.status == TournamentStatus.Enrolling ||
                         tournament.status == TournamentStatus.InProgress) &&
                        isEnrolled[tierId][instanceId][players[i]]) {
                        playerWeight++;
                    }
                }
            }

            weights[i] = playerWeight;
        }

        return (players, weights, totalWeight);
    }

    /**
     * @dev Selects winner using weighted random selection (cumulative probability method)
     * @param players Array of player addresses
     * @param weights Array of weights (enrollment counts)
     * @param totalWeight Sum of all weights
     * @param randomness Random seed
     * @return winner Selected player address
     */
    function _selectWeightedWinner(
        address[] memory players,
        uint256[] memory weights,
        uint256 totalWeight,
        uint256 randomness
    ) internal pure returns (address winner) {
        require(players.length > 0, "No players available");
        require(players.length == weights.length, "Array length mismatch");

        // Generate random position in [0, totalWeight)
        uint256 randomPosition = randomness % totalWeight;

        // Find winner using cumulative probability
        uint256 cumulativeWeight = 0;

        for (uint256 i = 0; i < players.length; i++) {
            cumulativeWeight += weights[i];

            if (randomPosition < cumulativeWeight) {
                return players[i];
            }
        }

        // Fallback (should never reach here)
        return players[players.length - 1];
    }

    /**
     * @dev Returns RW3 compliance declaration
     */
    function declareRW3() public view virtual returns (string memory) {
        return string(abi.encodePacked(
            "=== RW3 COMPLIANCE DECLARATION ===\n\n",
            "PROJECT: ETour Protocol\n",
            "VERSION: 2.0 (Configuration-Driven)\n",
            "NETWORK: Arbitrum One\n",
            "VERIFIED: Block deployed\n\n",
            "RULE 1 - REAL UTILITY:\n",
            "Game-agnostic tournament infrastructure. Any competitive game can implement ETour with custom tier structures.\n\n",
            "RULE 2 - FULLY ON-CHAIN:\n",
            "All tournament logic, bracket management, and prize distribution executed via smart contract.\n\n",
            "RULE 3 - SELF-SUSTAINING:\n",
            "Protocol fee structure covers operational costs. Contract functions autonomously.\n\n",
            "RULE 4 - FAIR DISTRIBUTION:\n",
            "No pre-mine, no insider allocations. All ETH in prize pools comes from player entry fees.\n\n",
            "RULE 5 - NO ALTCOINS:\n",
            "Uses only ETH for entry fees and prizes.\n\n",
            "Generated: Block ",
            Strings.toString(block.number)
        ));
    }
}
