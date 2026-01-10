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
    // REMOVED: Mode enum - not used for any logic

    enum EscalationLevel {
        None,
        Escalation1_OpponentClaim,
        Escalation2_AdvancedPlayers,
        Escalation3_ExternalPlayers
    }

    enum CompletionReason {
        NormalWin,              // 0: Normal gameplay win
        Timeout,                // 1: Win by opponent timeout (ML1)
        Draw,                   // 2: Match/finals ended in a draw
        ForceElimination,       // 3: ML2 - Advanced players force eliminated both players
        Replacement,            // 4: ML3 - External player replaced stalled players
        AllDrawScenario         // 5: All matches in a round resulted in draws (tournament only)
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
        TimeoutConfig timeouts;     // Timeout configuration for escalation windows
        uint8 totalRounds;          // Calculated: log2(playerCount)
        bool initialized;           // Whether this tier has been configured
    }

    // ============ Tournament Structs ============

    struct TournamentInstance {
        uint8 tierId;
        uint8 instanceId;
        TournamentStatus status;
        uint8 currentRound;
        uint8 enrolledCount;
        uint256 prizePool;
        uint256 startTime;
        address winner;
        bool finalsWasDraw;
        bool allDrawResolution;
        uint8 allDrawRound;
        CompletionReason completionReason;
        EnrollmentTimeoutState enrollmentTimeout;
    }

    struct Round {
        uint8 totalMatches;
        uint8 completedMatches;
        bool initialized;
        uint8 drawCount;
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

        // Tournament Context
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;

        // Data Source Indicator
        bool isCached;          // true = from cache, false = from active storage
    }

    /**
     * @dev Historic data for a single raffle execution
     * Stores complete information about each raffle for historical tracking
     */
    struct RaffleResult {
        address executor;               // Who called executeProtocolRaffle
        uint256 timestamp;              // When the raffle was executed
        uint256 rafflePot;              // Total raffle pot before distribution
        address[] participants;         // All addresses considered in the raffle
        uint256[] weights;              // Each address's weight/odds to win
        address winner;                 // The randomly selected winner
        uint256 winnerPrize;            // How much ETH the winner received
        uint256 protocolReserve;        // How much ETH the protocol kept as reserve
        uint256 ownerShare;             // How much ETH the owner received
    }

    // ============ State Variables ============

    // Tier configuration - set by implementing contract
    uint8 public tierCount;
    mapping(uint8 => TierConfig) internal _tierConfigs;
    // REMOVED: _tierPrizeDistribution - Prize distribution simplified to 100% for first place

    // Accumulated protocol share from failed prize distributions
    uint256 public accumulatedProtocolShare;

    // Raffle tracking
    uint256 public currentRaffleIndex;  // Starts at 0, increments when raffle executes
    uint256[] internal raffleThresholds;  // Configured thresholds for initial raffles
    uint256 internal raffleThresholdFinal;  // Threshold to use after initial raffles exhausted
    mapping(uint256 => RaffleResult) public raffleResults;  // Historic raffle execution data indexed by raffle index

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

    // ============ Events ============

    event MatchCompleted(bytes32 indexed matchId, address winner, bool isDraw, CompletionReason reason);
    event TournamentCompleted(uint8 indexed tierId, uint8 indexed instanceId, address winner, uint256 prizeAmount, CompletionReason reason, address[] enrolledPlayers);
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
        address _moduleEscalationAddress
    ) {
        owner = msg.sender;
        MODULE_CORE = _moduleCoreAddress;
        MODULE_MATCHES = _moduleMatchesAddress;
        MODULE_PRIZES = _modulePrizesAddress;
        MODULE_RAFFLE = _moduleRaffleAddress;
        MODULE_ESCALATION = _moduleEscalationAddress;
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
     * PUBLIC for module delegatecall access
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
     * PUBLIC for module delegatecall access
     */
    function _resetMatchGame(bytes32 matchId) public virtual;

    /**
     * @dev Get match result from game-specific storage
     * Called by Matches module to check if match is complete
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _getMatchResult(bytes32 matchId) public view virtual returns (address winner, bool isDraw, MatchStatus status);

    /**
     * @dev Get match players from game-specific storage
     * Called by modules to retrieve player addresses
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _getMatchPlayers(bytes32 matchId) public view virtual returns (address player1, address player2);

    /**
     * @dev Set player in match slot
     * Called by Escalation module when replacing players
     * PUBLIC for module delegatecall access
     */
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public virtual;

    /**
     * @dev Initialize match for play
     * Called by Matches module after players are assigned
     * PUBLIC for module delegatecall access
     */
    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public virtual;

    /**
     * @dev Complete match with result
     * Called by Matches module to mark match as complete
     * PUBLIC for module delegatecall access
     */
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public virtual;

    /**
     * @dev Get time increment per move
     * Called by Escalation module for timeout calculations
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _getTimeIncrement() public view virtual returns (uint256);

    /**
     * @dev Check if current player has timed out
     * Called by Escalation module to detect stalled matches
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view virtual returns (bool);

    /**
     * @dev Check if match is active
     * Called by modules to verify match state
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _isMatchActive(bytes32 matchId) public view virtual returns (bool);

    /**
     * @dev Get active match data
     * Called by modules to retrieve match information
     * PUBLIC for delegatecall access (view functions don't need onlyInternal)
     */
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view virtual returns (CommonMatchData memory);

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
    ) internal virtual {}
}
