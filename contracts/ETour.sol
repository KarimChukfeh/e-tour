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

    enum TournamentCompletionType {
        Regular,
        PartialStart,
        Abandoned
    }

    // ============ Configuration Structs ============

    /**
     * @dev Timeout configuration for escalation windows
     * All values in seconds
     */
    struct TimeoutConfig {
        uint256 matchTimePerPlayer;           // Time each player gets for entire match (e.g., 60 = 1 minute)
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
        address firstEnroller;
        uint256 firstEnrollmentTimestamp;
        address forceStarter;
        uint256 forceStartTimestamp;
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
    event TournamentCached(uint8 indexed tierId, uint8 indexed instanceId, address winner);
    event TournamentForceStarted(uint8 indexed tierId, uint8 indexed instanceId, address indexed starter, uint8 playerCount);
    event EnrollmentPoolClaimed(uint8 indexed tierId, uint8 indexed instanceId, address indexed claimant, uint256 amount);
    event TimeoutVictoryClaimed(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNum, uint8 matchNum, address indexed winner, address loser);
    event PlayerForfeited(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount, string reason);

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
            tournament.firstEnroller = msg.sender;
            tournament.firstEnrollmentTimestamp = block.timestamp;

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

        (bool protocolSuccess, ) = payable(owner).call{value: protocolShare}("");
        require(protocolSuccess, "Protocol fee transfer failed");
        emit ProtocolFeePaid(owner, protocolShare);

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
        tournament.forceStarter = msg.sender;
        tournament.forceStartTimestamp = block.timestamp;

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

            (bool success, ) = payable(soloWinner).call{value: winnersPot}("");
            require(success, "Prize payout failed");

            playerStats[soloWinner].tournamentsWon++;
            playerStats[soloWinner].tournamentsPlayed++;

            emit PrizeDistributed(tierId, instanceId, soloWinner, 1, winnersPot);
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
        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            playerStats[winner].matchesWon++;
        }

        emit MatchCompleted(matchId, winner, isDraw);

        if (!isDraw) {
            TierConfig storage config = _tierConfigs[tierId];
            if (roundNumber < config.totalRounds - 1) {
                _advanceWinner(tierId, instanceId, roundNumber, matchNumber, winner);
            }
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
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
                    (bool success, ) = payable(player).call{value: prizeAmount}("");
                    require(success, "Prize payout failed");
                    emit PrizeDistributed(tierId, instanceId, player, ranking, prizeAmount);
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

            (bool success, ) = payable(player).call{value: prizePerPlayer}("");
            require(success, "Prize payout failed");
            emit PrizeDistributed(tierId, instanceId, player, 1, prizePerPlayer);
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

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
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

        TierConfig storage config = _tierConfigs[tierId];
        if (roundNumber < config.totalRounds - 1) {
            _advanceWinner(tierId, instanceId, roundNumber, matchNumber, replacementPlayer);
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                _processOrphanedWinners(tierId, instanceId, roundNumber);
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

        // Add prize winnings to players who earned
        for (uint8 i = 0; i < players.length; i++) {
            address player = players[i];
            _trackOnLeaderboard(player);

            uint256 prize = playerPrizes[tierId][instanceId][player];
            if (prize > 0) {
                playerEarnings[player] += int256(prize);
            }
        }

        emit TournamentCached(tierId, instanceId, winner);
    }

    function _updateAbandonedEarnings(
        uint8 tierId,
        uint8 instanceId,
        address claimer,
        uint256 claimAmount
    ) internal {
        address[] storage players = enrolledPlayers[tierId][instanceId];

        // Track all enrolled players on leaderboard (no earnings changes for them)
        for (uint8 i = 0; i < players.length; i++) {
            _trackOnLeaderboard(players[i]);
        }

        // Credit the claimer with the claim amount
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

    function _resetTournamentAfterCompletion(uint8 tierId, uint8 instanceId) internal virtual {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];

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

        tournament.firstEnroller = address(0);
        tournament.firstEnrollmentTimestamp = 0;
        tournament.forceStarter = address(0);
        tournament.forceStartTimestamp = 0;

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

        // Check if this round has been initialized in current tournament
        // If round is initialized, match storage exists (even if cleared) and we should NOT fallback to cache
        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (round.initialized) {
            // Round is initialized, so match belongs to current tournament
            // Return cleared storage instead of cached data from previous tournament
            return _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        }

        // Round not initialized - fallback to cache for historical data lookup
        (CommonMatchData memory cachedData, bool exists) = _getMatchFromCache(
            matchId, tierId, instanceId, roundNumber, matchNumber
        );

        require(exists, "Match not found in active storage or cache");
        return cachedData;
    }

    function getPlayerStats(address player) external view returns (
        uint256 tournamentsWon,
        uint256 tournamentsPlayed,
        uint256 matchesWon,
        uint256 matchesPlayed
    ) {
        PlayerStats storage stats = playerStats[player];
        return (
            stats.tournamentsWon,
            stats.tournamentsPlayed,
            stats.matchesWon,
            stats.matchesPlayed
        );
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
