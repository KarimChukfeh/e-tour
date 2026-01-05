// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ETour_Storage
 * @dev Abstract contract defining ALL storage layout for ETour protocol
 *
 * CRITICAL: Storage layout must remain IDENTICAL to original ETour.sol
 * - Game contracts inherit this to define their storage
 * - Modules execute via delegatecall and access this storage
 * - NEVER reorder variables or add variables between existing ones
 *
 * Part of the modular ETour architecture where:
 * - This contract: Defines storage layout (no logic)
 * - Module contracts: Pure logic (no storage)
 * - Game contracts: Own storage + delegate to modules
 */
abstract contract ETour_Storage is ReentrancyGuard {

    // ============ Module Addresses (Immutable) ============

    address public immutable MODULE_CORE;
    address public immutable MODULE_MATCHES;
    address public immutable MODULE_PRIZES;
    address public immutable MODULE_RAFFLE;
    address public immutable MODULE_ESCALATION;
    address public immutable MODULE_GAME_CACHE;

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
     * @dev Minimal tournament reference for player tracking
     * Gas-optimized: 2 bytes total (tierId + instanceId)
     */
    struct TournamentRef {
        uint8 tierId;
        uint8 instanceId;
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
    uint256[] internal raffleThresholds;  // Configured thresholds for initial raffles
    uint256 internal raffleThresholdFinal;  // Threshold to use after initial raffles exhausted

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

    // ============ Player Tracking Module Storage ============

    // Track tournaments where player is enrolled but not yet started
    mapping(address => TournamentRef[]) public playerEnrollingTournaments;
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) internal playerEnrollingIndex;

    // Track tournaments where player is actively competing
    mapping(address => TournamentRef[]) public playerActiveTournaments;
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) internal playerActiveIndex;

    // ============ Game Cache Module Storage ============

    /**
     * @dev Shared cache size constant for all games
     */
    uint16 public constant MATCH_CACHE_SIZE = 1000;

    /**
     * @dev Generic cached match data for completed matches
     * Stores board state as bytes to support any game type
     */
    struct CachedMatch {
        address player1;
        address player2;
        address firstPlayer;
        address winner;
        uint256 startTime;
        uint256 endTime;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isDraw;
        bool exists;
        bytes boardData;  // Generic board storage (game-specific encoding)
    }

    // Circular cache with overflow handling
    CachedMatch[1000] public sharedMatchCache;
    uint16 public sharedNextCacheIndex;

    // Lookup indexes for fast retrieval
    mapping(bytes32 => uint16) public sharedCacheKeyToIndex;      // player pair hash => cache index
    bytes32[1000] public sharedCacheKeys;                          // cache index => player pair hash
    mapping(bytes32 => uint16) public sharedMatchIdToCacheIndex;  // matchId => cache index
    bytes32[1000] public sharedCacheMatchIds;                      // cache index => matchId

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
    event MatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);
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

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress,
        address _moduleGameCacheAddress
    ) {
        owner = msg.sender;
        MODULE_CORE = _moduleCoreAddress;
        MODULE_MATCHES = _moduleMatchesAddress;
        MODULE_PRIZES = _modulePrizesAddress;
        MODULE_RAFFLE = _moduleRaffleAddress;
        MODULE_ESCALATION = _moduleEscalationAddress;
        MODULE_GAME_CACHE = _moduleGameCacheAddress;
    }

    // ============ Helper Functions (Shared across modules) ============

    /**
     * @dev Generate unique match identifier
     * @param tierId Tournament tier
     * @param instanceId Instance within tier
     * @param roundNumber Round number
     * @param matchNumber Match number within round
     * @return Unique match ID
     */
    function _getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tierId, instanceId, roundNumber, matchNumber));
    }

    /**
     * @dev Calculate log2 of a number (for bracket math)
     * @param x Input number
     * @return Log2 of x
     */
    function _log2(uint8 x) internal pure returns (uint8) {
        uint8 result = 0;
        while (x > 1) {
            x /= 2;
            result++;
        }
        return result;
    }

    // ============ Abstract Functions (Implemented by Game Contracts) ============

    /**
     * @dev Create a new match in game-specific storage
     * Called by Matches module when initializing matches
     */
    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public virtual;

    /**
     * @dev Reset match game state
     * Called when match needs to be reset
     */
    function _resetMatchGame(bytes32 matchId) public virtual;

    /**
     * @dev Get match result from game-specific storage
     * Called by Matches module to check if match is complete
     */
    function _getMatchResult(bytes32 matchId) public view virtual returns (address winner, bool isDraw, MatchStatus status);

    /**
     * @dev Add match to game-specific cache
     * Called by Prizes module after match completion for historical preservation
     */
    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public virtual;

    /**
     * @dev Get match players from game-specific storage
     * Called by modules to retrieve player addresses
     */
    function _getMatchPlayers(bytes32 matchId) public view virtual returns (address player1, address player2);

    /**
     * @dev Set player in match slot
     * Called by Escalation module when replacing players
     */
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public virtual;

    /**
     * @dev Initialize match for play
     * Called by Matches module after players are assigned
     */
    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public virtual;

    /**
     * @dev Complete match with result
     * Called by Matches module to mark match as complete
     */
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public virtual;

    /**
     * @dev Get time increment per move
     * Called by Escalation module for timeout calculations
     */
    function _getTimeIncrement() public view virtual returns (uint256);

    /**
     * @dev Check if current player has timed out
     * Called by Escalation module to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view virtual returns (bool);

    /**
     * @dev Check if match is active
     * Called by modules to verify match state
     */
    function _isMatchActive(bytes32 matchId) public view virtual returns (bool);

    /**
     * @dev Get active match data
     * Called by modules to retrieve match information
     */
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view virtual returns (CommonMatchData memory);

    /**
     * @dev Get match data from cache
     * Called by modules to retrieve historical match data
     */
    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view virtual returns (CommonMatchData memory data, bool exists);

    // ============ Hooks (Optional overrides by Game Contracts) ============

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
    ) public virtual {}
}
