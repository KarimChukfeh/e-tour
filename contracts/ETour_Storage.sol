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

    event MatchCompleted(bytes32 indexed matchId, address indexed player1, address indexed player2, address winner, bool isDraw, CompletionReason reason, uint256 board);
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

    /**
     * @dev Emitted when a prize is distributed to a player
     * Mimics the Transfer event for better wallet display
     * @param from The game contract address distributing the prize
     * @param to The player receiving the prize
     * @param value The prize amount in wei
     */
    event Transfer(
        address indexed from,
        address indexed to,
        uint256 value
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

    /**
     * @dev Get current raffle threshold
     * Shared helper for all game contracts - extracts duplicate logic
     * @return Current raffle threshold in wei
     */
    function _getRaffleThreshold() internal view returns (uint256) {
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }
        return raffleThresholdFinal;
    }

    /**
     * @dev Add player to enrolling tournaments tracking array
     * Shared helper - extracts duplicate logic from all game contracts
     */
    function _addPlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) internal {
        if (playerEnrollingIndex[player][tierId][instanceId] != 0) return;
        playerEnrollingTournaments[player].push(TournamentRef(tierId, instanceId));
        playerEnrollingIndex[player][tierId][instanceId] = playerEnrollingTournaments[player].length;
    }

    /**
     * @dev Remove player from enrolling tournaments tracking array
     * Uses swap-and-pop pattern for gas efficiency
     */
    function _removePlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) internal {
        uint256 indexPlusOne = playerEnrollingIndex[player][tierId][instanceId];
        if (indexPlusOne == 0) return;

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = playerEnrollingTournaments[player].length - 1;

        if (index != lastIndex) {
            TournamentRef memory lastRef = playerEnrollingTournaments[player][lastIndex];
            playerEnrollingTournaments[player][index] = lastRef;
            playerEnrollingIndex[player][lastRef.tierId][lastRef.instanceId] = indexPlusOne;
        }

        playerEnrollingTournaments[player].pop();
        delete playerEnrollingIndex[player][tierId][instanceId];
    }

    /**
     * @dev Add player to active tournaments tracking array
     * Shared helper - extracts duplicate logic from all game contracts
     */
    function _addPlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) internal {
        if (playerActiveIndex[player][tierId][instanceId] != 0) return;
        playerActiveTournaments[player].push(TournamentRef(tierId, instanceId));
        playerActiveIndex[player][tierId][instanceId] = playerActiveTournaments[player].length;
    }

    /**
     * @dev Remove player from active tournaments tracking array
     * Uses swap-and-pop pattern for gas efficiency
     */
    function _removePlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) internal {
        uint256 indexPlusOne = playerActiveIndex[player][tierId][instanceId];
        if (indexPlusOne == 0) return;

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = playerActiveTournaments[player].length - 1;

        if (index != lastIndex) {
            TournamentRef memory lastRef = playerActiveTournaments[player][lastIndex];
            playerActiveTournaments[player][index] = lastRef;
            playerActiveIndex[player][lastRef.tierId][lastRef.instanceId] = indexPlusOne;
        }

        playerActiveTournaments[player].pop();
        delete playerActiveIndex[player][tierId][instanceId];
    }

    /**
     * @dev Internal match completion handler
     * Extracted from all game contracts - coordinates match completion workflow
     * @param tierId Tournament tier ID
     * @param instanceId Tournament instance ID
     * @param roundNumber Round number
     * @param matchNumber Match number
     * @param winner Winner address (or address(0) if draw)
     * @param isDraw Whether match ended in a draw
     * @param reason Completion reason for event emission
     */
    function _completeMatchInternal(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        CompletionReason reason
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Mark match as complete in game-specific storage (calls internal game-specific function)
        _completeMatchGameSpecific(tierId, instanceId, roundNumber, matchNumber, winner, isDraw);

        // Clear any escalation state - inlined for gas efficiency
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        // Save enrolled players before delegatecall (in case tournament completes and resets)
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        // Delegate to Matches module for advancement logic
        (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature(
                "completeMatch(uint8,uint8,uint8,uint8,address,bool)",
                tierId, instanceId, roundNumber, matchNumber, winner, isDraw
            )
        );
        require(completeSuccess, "CM");

        // Call game-specific hook to emit MatchCompleted event with board data
        _emitMatchCompletedEvent(matchId, winner, isDraw, reason);

        // Call elimination hook for loser (if not a draw)
        if (!isDraw) {
            (address player1, address player2) = _getMatchPlayers(matchId);
            address loser = (winner == player1) ? player2 : player1;
            _onPlayerEliminatedFromTournament(loser, tierId, instanceId, roundNumber);
        }

        // Check if tournament completed and handle prize distribution/reset
        _handleTournamentCompletion(tierId, instanceId, enrolledPlayersCopy);
    }

    /**
     * @dev Handle tournament completion: distribute prizes, emit events, reset state
     * Extracted from all game contracts - single source of truth for tournament completion workflow
     * @param tierId Tournament tier ID
     * @param instanceId Tournament instance ID
     * @param enrolledPlayersCopy Copy of enrolled players array
     */
    function _handleTournamentCompletion(
        uint8 tierId,
        uint8 instanceId,
        address[] memory enrolledPlayersCopy
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        // Only proceed if tournament is actually completed
        if (tournament.status != TournamentStatus.Completed || enrolledPlayersCopy.length == 0) {
            return;
        }

        address tournamentWinner = tournament.winner;
        uint256 winnersPot = tournament.prizePool;

        // Distribute prizes based on completion type
        address[] memory winners;
        uint256[] memory prizes;

        if (tournament.allDrawResolution) {
            // All-draw: distribute equal prizes to all remaining players
            (bool distributeSuccess, bytes memory returnData) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributeEqualPrizes(uint8,uint8,address[],uint256,string)",
                    tierId, instanceId, enrolledPlayersCopy, winnersPot, "")
            );
            require(distributeSuccess, "DP");
            (winners, prizes) = abi.decode(returnData, (address[], uint256[]));
        } else {
            // Normal completion: distribute prizes based on ranking
            (bool distributeSuccess, bytes memory returnData) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributePrizes(uint8,uint8,uint256,string)",
                    tierId, instanceId, winnersPot, "")
            );
            require(distributeSuccess, "DP");
            (winners, prizes) = abi.decode(returnData, (address[], uint256[]));
        }

        // Emit Transfer events for each winner
        for (uint256 i = 0; i < winners.length; i++) {
            emit Transfer(address(this), winners[i], prizes[i]);
        }

        // Update earnings for the winner (if there is one)
        if (tournamentWinner != address(0)) {
            (bool earningsSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("updatePlayerEarnings(uint8,uint8,address)",
                    tierId, instanceId, tournamentWinner)
            );
            require(earningsSuccess, "UE");
        }

        // Emit TournamentCompleted event with actual prize amount
        uint256 winnerPrize = playerPrizes[tierId][instanceId][tournamentWinner];
        emit TournamentCompleted(tierId, instanceId, tournamentWinner, winnerPrize,
            tournament.completionReason, enrolledPlayersCopy);

        // Call hook BEFORE reset (for ChessOnChain elite match archival)
        _onTournamentCompletedBeforeReset(tierId, instanceId);

        // Reset tournament state
        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)",
                tierId, instanceId)
        );
        require(resetSuccess, "RT");

        // Call tournament completion hook
        _onTournamentCompleted(tierId, instanceId, enrolledPlayersCopy);
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
     * Default implementation uses _getMatchPlayers and _getMatchResult
     * Override only if game needs custom logic
     */
    function _isMatchActive(bytes32 matchId) public view virtual returns (bool) {
        (address player1, ) = _getMatchPlayers(matchId);
        (, , MatchStatus status) = _getMatchResult(matchId);
        return player1 != address(0) && status != MatchStatus.Completed;
    }

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
     * Default implementation moves players from enrolling to active tracking
     * Override only if game needs custom logic
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal virtual {
        address[] storage players = enrolledPlayers[tierId][instanceId];
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _addPlayerActiveTournament(player, tierId, instanceId);
        }
    }

    /**
     * @dev Hook called when player is eliminated from tournament
     * Default implementation removes player from active tracking
     * Override only if game needs custom logic
     */
    function _onPlayerEliminatedFromTournament(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal virtual {
        _removePlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook called when external player replaces stalled players (L3 escalation)
     * Default implementation adds player to active tracking
     * Override only if game needs custom logic
     */
    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal virtual {
        _addPlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook to mark match as complete in game-specific Match storage
     * MUST be overridden in each game contract to update game-specific Match struct
     * Default implementation reverts (modules don't use this)
     */
    function _completeMatchGameSpecific(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) internal virtual {
        revert("ETour_Storage: _completeMatchGameSpecific must be implemented by game contract");
    }

    /**
     * @dev Hook to emit MatchCompleted event with game-specific board data
     * MUST be overridden in each game contract to emit event with correct board format
     * Default implementation reverts (modules don't use this)
     */
    function _emitMatchCompletedEvent(
        bytes32 matchId,
        address winner,
        bool isDraw,
        CompletionReason reason
    ) internal virtual {
        revert("ETour_Storage: _emitMatchCompletedEvent must be implemented by game contract");
    }

    /**
     * @dev Hook called when tournament completes and resets
     * Default implementation removes players from enrolling and active tracking
     * Override only if game needs custom cleanup logic
     */
    function _onTournamentCompleted(
        uint8 tierId,
        uint8 instanceId,
        address[] memory players
    ) internal virtual {
        for (uint256 i = 0; i < players.length; i++) {
            _removePlayerEnrollingTournament(players[i], tierId, instanceId);
            _removePlayerActiveTournament(players[i], tierId, instanceId);
        }
    }

    /**
     * @dev Hook called BEFORE tournament reset (for ChessOnChain elite match archival)
     * Override in ChessOnChain to archive finals matches
     */
    function _onTournamentCompletedBeforeReset(
        uint8 tierId,
        uint8 instanceId
    ) internal virtual {}

}
