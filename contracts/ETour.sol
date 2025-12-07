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
     * @dev Configuration for a single tournament tier
     * Provided by implementing contract via _registerTier()
     */
    struct TierConfig {
        uint8 playerCount;          // Number of players in tournament (must be power of 2 for brackets)
        uint8 instanceCount;        // How many concurrent instances of this tier
        uint256 entryFee;           // Entry fee in wei
        Mode mode;                  // Classic or Pro mode
        uint256 enrollmentWindow;   // Time window for enrollment before escalation
        uint256 matchMoveTimeout;   // Time allowed per move before timeout escalation
        uint256 escalationInterval; // Time between escalation levels
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

    struct MatchTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        uint256 escalation3Start;
        EscalationLevel activeEscalation;
        bool timeoutActive;
        uint256 forfeitAmount;
    }

    struct EnrollmentTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        uint256 forfeitPool;
    }

    struct PrizeWinner {
        address player;
        uint8 ranking;
        uint256 prize;
    }

    struct CachedTournamentData {
        bool exists;
        uint8 tierId;
        uint8 instanceId;
        uint256 tournamentId;
        uint256 timestamp;
        Mode mode;
        TournamentCompletionType completionType;
        uint256 totalPrizePool;
        uint256 totalAwarded;
        address winner;
        uint8 participantCount;
        uint256 startTime;
        uint256 duration;
        uint8 matchCount;
        PrizeWinner[] prizeWinners;
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

    // Tournament cache
    CachedTournamentData[] public completedTournaments;
    uint256 public globalTournamentIdCounter;
    mapping(uint256 => uint256) public tournamentCompletionBlocks;

    // Forfeit tracking
    mapping(uint8 => mapping(uint8 => mapping(address => uint256))) public playerForfeitedAmounts;

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
    event TournamentCached(uint8 indexed tierId, uint8 indexed instanceId, uint256 indexed tournamentId, address winner);
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
     * @param enrollmentWindow Time before enrollment escalation starts
     * @param matchMoveTimeout Time per move before timeout
     * @param escalationInterval Time between escalation levels
     * @param prizeDistribution Array of percentages (must sum to 100, index 0 = 1st place)
     */
    function _registerTier(
        uint8 tierId,
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        Mode mode,
        uint256 enrollmentWindow,
        uint256 matchMoveTimeout,
        uint256 escalationInterval,
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
            enrollmentWindow: enrollmentWindow,
            matchMoveTimeout: matchMoveTimeout,
            escalationInterval: escalationInterval,
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
        uint8 totalRounds
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        return (config.playerCount, config.instanceCount, config.entryFee, config.totalRounds);
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

    function _setMatchTimeoutState(bytes32 matchId, MatchTimeoutState memory state) internal virtual;

    function _getMatchTimeoutState(bytes32 matchId) internal view virtual returns (MatchTimeoutState memory);

    function _setMatchTimedOut(bytes32 matchId, address claimant, EscalationLevel level) internal virtual;

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal virtual;

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal virtual;

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal virtual;

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

            tournament.enrollmentTimeout.escalation1Start = block.timestamp + config.enrollmentWindow;
            tournament.enrollmentTimeout.escalation2Start = tournament.enrollmentTimeout.escalation1Start + config.escalationInterval;
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
            playerForfeitedAmounts[tierId][instanceId][player] += config.entryFee;
            emit PlayerForfeited(tierId, instanceId, player, config.entryFee, "Enrollment abandoned");
        }

        (bool success, ) = payable(msg.sender).call{value: claimAmount}("");
        require(success, "Transfer failed");

        emit EnrollmentPoolClaimed(tierId, instanceId, msg.sender, claimAmount);

        _cacheAbandonedTournament(tierId, instanceId, msg.sender, claimAmount);
        _resetTournamentAfterCompletion(tierId, instanceId);
    }

    // ============ Tournament Management ============

    function _startTournament(uint8 tierId, uint8 instanceId) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        tournament.status = TournamentStatus.InProgress;
        tournament.startTime = block.timestamp;
        tournament.currentRound = 0;

        emit TournamentStarted(tierId, instanceId, tournament.enrolledCount);

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

            _cacheTournamentData(tierId, instanceId, soloWinner);
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

        _cacheTournamentData(tierId, instanceId, winner);
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
        _cacheTournamentData(tierId, instanceId, address(0));
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
            
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && d2) {
                return true;
            }
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && d1) {
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
            
            if (s1 == MatchStatus.Completed && w1 != address(0) && !d1 && s2 == MatchStatus.Completed && d2) {
                _advanceWinner(tierId, instanceId, roundNumber, i, w1);
            }
            if (s2 == MatchStatus.Completed && w2 != address(0) && !d2 && s1 == MatchStatus.Completed && d1) {
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
     * @dev Escalation Level 2: Advanced players can force eliminate stalled matches
     * Both players in the stalled match forfeit their entry fees
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (, , MatchStatus status) = _getMatchResult(matchId);
        MatchTimeoutState memory timeoutState = _getMatchTimeoutState(matchId);

        require(status == MatchStatus.InProgress, "Match not active");
        require(block.timestamp >= timeoutState.escalation2Start, "Tier 2 not reached");
        require(
            _isPlayerInAdvancedRound(tierId, instanceId, roundNumber, msg.sender),
            "Must be in advanced round to eliminate"
        );

        _setMatchTimedOut(matchId, msg.sender, EscalationLevel.Escalation2_AdvancedPlayers);

        (address player1, address player2) = _getMatchPlayers(matchId);
        uint256 entryFee = _tierConfigs[tierId].entryFee;
        playerForfeitedAmounts[tierId][instanceId][player1] += entryFee;
        playerForfeitedAmounts[tierId][instanceId][player2] += entryFee;

        emit PlayerForfeited(tierId, instanceId, player1, entryFee, "Tier 2: Eliminated by advanced player");
        emit PlayerForfeited(tierId, instanceId, player2, entryFee, "Tier 2: Eliminated by advanced player");

        _completeMatchDoubleElimination(tierId, instanceId, roundNumber, matchNumber);
    }

    /**
     * @dev Escalation Level 3: External players can claim a match slot by replacement
     * Both original players forfeit, claimant advances as winner
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (, , MatchStatus status) = _getMatchResult(matchId);
        MatchTimeoutState memory timeoutState = _getMatchTimeoutState(matchId);

        require(status == MatchStatus.InProgress, "Match not active");
        require(block.timestamp >= timeoutState.escalation3Start, "Tier 3 timeout not reached");

        // Prevent enrolled players from using Tier 3 if they're actively playing or won current round
        if (isEnrolled[tierId][instanceId][msg.sender]) {
            uint8 currentRound = tournaments[tierId][instanceId].currentRound;

            for (uint8 r = 0; r <= currentRound; r++) {
                for (uint8 m = 0; m < rounds[tierId][instanceId][r].totalMatches; m++) {
                    bytes32 checkMatchId = _getMatchId(tierId, instanceId, r, m);
                    (address checkWinner, , MatchStatus checkStatus) = _getMatchResult(checkMatchId);
                    (address checkP1, address checkP2) = _getMatchPlayers(checkMatchId);

                    if (checkStatus == MatchStatus.InProgress &&
                        (checkP1 == msg.sender || checkP2 == msg.sender)) {
                        revert("Cannot use Tier 3 while actively playing in this tournament");
                    }

                    if (r == currentRound &&
                        checkStatus == MatchStatus.Completed &&
                        checkWinner == msg.sender) {
                        revert("Cannot use Tier 3 after winning in current round");
                    }
                }
            }
        }

        _setMatchTimedOut(matchId, msg.sender, EscalationLevel.Escalation3_ExternalPlayers);

        (address player1, address player2) = _getMatchPlayers(matchId);
        uint256 entryFee = _tierConfigs[tierId].entryFee;
        playerForfeitedAmounts[tierId][instanceId][player1] += entryFee;
        playerForfeitedAmounts[tierId][instanceId][player2] += entryFee;

        emit PlayerForfeited(tierId, instanceId, player1, entryFee, "Tier 3: Replaced by external player");
        emit PlayerForfeited(tierId, instanceId, player2, entryFee, "Tier 3: Replaced by external player");

        _completeMatchByReplacement(tierId, instanceId, roundNumber, matchNumber, msg.sender);
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

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;

        // Add replacement player to tournament if not already enrolled
        if (!isEnrolled[tierId][instanceId][replacementPlayer]) {
            enrolledPlayers[tierId][instanceId].push(replacementPlayer);
            isEnrolled[tierId][instanceId][replacementPlayer] = true;
            TournamentInstance storage tournament = tournaments[tierId][instanceId];
            tournament.enrolledCount++;
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

    // ============ Caching Functions ============

    function _cacheTournamentData(uint8 tierId, uint8 instanceId, address winner) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];
        address[] storage players = enrolledPlayers[tierId][instanceId];

        CachedTournamentData memory cache;

        cache.exists = true;
        cache.tierId = tierId;
        cache.instanceId = instanceId;
        cache.tournamentId = globalTournamentIdCounter++;
        cache.timestamp = block.timestamp;
        cache.mode = tournament.mode;

        if (tournament.hasStartedViaTimeout) {
            cache.completionType = TournamentCompletionType.PartialStart;
        } else {
            cache.completionType = TournamentCompletionType.Regular;
        }

        cache.totalPrizePool = tournament.prizePool;
        cache.totalAwarded = 0;
        cache.winner = winner;
        cache.participantCount = uint8(players.length);
        cache.startTime = tournament.startTime;
        cache.duration = block.timestamp - tournament.startTime;

        cache.matchCount = 0;
        for (uint8 r = 0; r < config.totalRounds; r++) {
            Round storage roundData = rounds[tierId][instanceId][r];
            cache.matchCount += roundData.totalMatches;
        }

        cache.prizeWinners = new PrizeWinner[](players.length);
        for (uint8 i = 0; i < players.length; i++) {
            address player = players[i];
            uint256 prize = playerPrizes[tierId][instanceId][player];

            cache.prizeWinners[i] = PrizeWinner({
                player: player,
                ranking: playerRanking[tierId][instanceId][player],
                prize: prize
            });

            cache.totalAwarded += prize;
        }

        completedTournaments.push(cache);
        tournamentCompletionBlocks[cache.tournamentId] = block.number;

        emit TournamentCached(tierId, instanceId, cache.tournamentId, winner);
    }

    function _cacheAbandonedTournament(
        uint8 tierId,
        uint8 instanceId,
        address,
        uint256 claimAmount
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        address[] storage players = enrolledPlayers[tierId][instanceId];

        CachedTournamentData memory cache;

        cache.exists = true;
        cache.tierId = tierId;
        cache.instanceId = instanceId;
        cache.tournamentId = globalTournamentIdCounter++;
        cache.timestamp = block.timestamp;
        cache.mode = tournament.mode;
        cache.completionType = TournamentCompletionType.Abandoned;

        cache.totalPrizePool = tournament.prizePool;
        cache.totalAwarded = claimAmount;

        cache.winner = address(0);
        cache.participantCount = uint8(players.length);
        cache.startTime = 0;
        cache.duration = 0;
        cache.matchCount = 0;

        cache.prizeWinners = new PrizeWinner[](players.length);
        for (uint8 i = 0; i < players.length; i++) {
            cache.prizeWinners[i] = PrizeWinner({
                player: players[i],
                ranking: 0,
                prize: 0
            });
        }

        completedTournaments.push(cache);
        tournamentCompletionBlocks[cache.tournamentId] = block.number;

        emit TournamentCached(tierId, instanceId, cache.tournamentId, address(0));
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
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            isEnrolled[tierId][instanceId][player] = false;
            delete playerRanking[tierId][instanceId][player];
            delete playerPrizes[tierId][instanceId][player];
        }
        delete enrolledPlayers[tierId][instanceId];

        for (uint8 roundNum = 0; roundNum < config.totalRounds; roundNum++) {
            Round storage round = rounds[tierId][instanceId][roundNum];
            round.completedMatches = 0;
            round.initialized = false;
            round.drawCount = 0;
            round.allMatchesDrew = false;

            uint8 matchCount = _getMatchCountForRound(tierId, instanceId, roundNum);
            for (uint8 matchNum = 0; matchNum < matchCount; matchNum++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNum, matchNum);
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

    function getAllCompletedTournaments() external view returns (CachedTournamentData[] memory) {
        return completedTournaments;
    }

    function getCompletedTournament(uint256 index) external view returns (CachedTournamentData memory) {
        require(index < completedTournaments.length, "Index out of bounds");
        return completedTournaments[index];
    }

    function getCompletedTournamentCount() external view returns (uint256) {
        return completedTournaments.length;
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
