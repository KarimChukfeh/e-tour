// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./libraries/ETourLib_Core.sol";
import "./libraries/ETourLib_Matches.sol";
import "./libraries/ETourLib_Prizes.sol";

/**
 * @title TicTacChain
 * @dev Classic Tic-Tac-Toe game using ETour library architecture
 * Refactored to use 3 separate libraries to meet 24kB Arbitrum limit
 *
 * This contract demonstrates library-based ETour implementation:
 * 1. Uses ETourLib_Core for enrollment & tiers
 * 2. Uses ETourLib_Matches for match lifecycle
 * 3. Uses ETourLib_Prizes for prize distribution
 * 4. Keeps game-specific logic (board state, moves, win detection)
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacChain is ReentrancyGuard {

    // ============ ETour Integration ============

    address public immutable owner;
    ETourLib_Core.ETourStorage internal _etourStorage;

    // Type aliases for readability
    using ETourLib_Core for ETourLib_Core.ETourStorage;

    // Import enums and structs from library
    ETourLib_Core.TournamentStatus constant ENROLLING = ETourLib_Core.TournamentStatus.Enrolling;
    ETourLib_Core.TournamentStatus constant IN_PROGRESS = ETourLib_Core.TournamentStatus.InProgress;
    ETourLib_Core.TournamentStatus constant COMPLETED = ETourLib_Core.TournamentStatus.Completed;

    ETourLib_Core.MatchStatus constant NOT_STARTED = ETourLib_Core.MatchStatus.NotStarted;
    ETourLib_Core.MatchStatus constant MATCH_IN_PROGRESS = ETourLib_Core.MatchStatus.InProgress;
    ETourLib_Core.MatchStatus constant MATCH_COMPLETED = ETourLib_Core.MatchStatus.Completed;
    
    // ============ Game-Specific Constants ============

    // ============ Game-Specific Enums ============

    enum Cell { Empty, X, O }

    // ============ Game-Specific Structs ============

    struct Match {
        address player1;
        address player2;
        address currentTurn;
        address winner;
        Cell[9] board;
        ETourLib_Core.MatchStatus status;
        uint256 lastMoveTime;
        uint256 startTime;
        address firstPlayer;
        bool isDraw;
        // Time Bank Fields (chess clock style)
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }

    struct CachedMatchData {
        address player1;
        address player2;
        address firstPlayer;
        address winner;
        uint256 startTime;
        uint256 endTime;
        Cell[9] board;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isDraw;
        bool exists;
    }

    /**
     * @dev Extended match data for TicTacToe including common fields and game-specific state
     */
    struct TicTacToeMatchData {
        ETourLib_Core.CommonMatchData common;     // Embedded common data
        Cell[9] board;                    // 3x3 board
        address currentTurn;
        address firstPlayer;
        uint256 player1TimeRemaining;     // Time bank for player1 (seconds)
        uint256 player2TimeRemaining;     // Time bank for player2 (seconds)
        uint256 lastMoveTimestamp;        // Timestamp of last move
    }

    // ============ Game-Specific State ============

    mapping(bytes32 => Match) public matches;

    // Match cache
    uint16 public constant MATCH_CACHE_SIZE = 200;
    CachedMatchData[MATCH_CACHE_SIZE] public matchCache;
    uint16 public nextCacheIndex;
    mapping(bytes32 => uint16) public cacheKeyToIndex;
    bytes32[MATCH_CACHE_SIZE] private cacheKeys;
    mapping(bytes32 => uint16) private matchIdToCacheIndex; // Direct matchId lookup
    bytes32[MATCH_CACHE_SIZE] private cacheMatchIds; // Track which matchId is at each index

    // ============ Player Activity Tracking ============

    /**
     * @dev Minimal tournament reference for player tracking
     * Gas-optimized: 2 bytes total (tierId + instanceId)
     */
    struct TournamentRef {
        uint8 tierId;
        uint8 instanceId;
    }

    // Track tournaments where player is enrolled but not yet started
    mapping(address => TournamentRef[]) public playerEnrollingTournaments;
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) private playerEnrollingIndex;

    // Track tournaments where player is actively competing
    mapping(address => TournamentRef[]) public playerActiveTournaments;

    // Track active matches per player
    mapping(address => bytes32[]) public playerActiveMatches;
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) private playerActiveIndex;

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
    event MatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);

    // ============ ETour Events ============
    // All tournament events must be defined in game contract for proper event sourcing

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
    event EnrollmentRefunded(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount);
    event AbandonedPoolClaimed(uint8 indexed tierId, uint8 indexed instanceId, uint256 totalAmount);

    // ============ Constructor ============

    constructor() {
        owner = msg.sender;
        _registerTicTacChainTiers();
    }

    /**
     * @dev Register all tournament tiers for TicTacChain
     * This is where TicTacChain defines its specific tournament structure.
     * Other games implementing ETour would define their own tiers here.
     */
    function _registerTicTacChainTiers() internal {
        // ============ Tier 0: 2-Player Classic (Entry Level) ============
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;
        tier0Prizes[1] = 0;

        ETourLib_Core.TimeoutConfig memory timeouts0 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 2 minutes,
            timeIncrementPerMove: 15 seconds,
            matchLevel2Delay: 2 minutes,
            matchLevel3Delay: 4 minutes,
            enrollmentWindow: 5 minutes,
            enrollmentLevel2Delay: 2 minutes
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            0,
            2,
            100,
            0.001 ether,
            ETourLib_Core.Mode.Classic,
            timeouts0,
            tier0Prizes
        );
        emit TierRegistered(0, 2, 100, 0.001 ether);

        // ============ Tier 1: 4-Player Classic ============
        // Semi-final + Final bracket, winner takes majority
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 70;   // 1st place: 70%
        tier1Prizes[1] = 30;   // 2nd place: 30%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        ETourLib_Core.TimeoutConfig memory timeouts1 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            1,                              // tierId
            4,                              // playerCount
            40,                             // instanceCount
            0.002 ether,                    // entryFee
            ETourLib_Core.Mode.Classic,
            timeouts1,
            tier1Prizes
        );
        emit TierRegistered(1, 4, 40, 0.002 ether);

        // ============ Tier 2: 8-Player Classic ============
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 70;   // 1st
        tier2Prizes[1] = 20;   // 2nd
        tier2Prizes[2] = 5;    // 3rd
        tier2Prizes[3] = 5;    // 4th
        tier2Prizes[4] = 0;    // 5th-8th
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        ETourLib_Core.TimeoutConfig memory timeouts2 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 15 minutes,       // 15 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            2,                              // tierId
            8,                              // playerCount
            20,                             // instanceCount
            0.004 ether,                    // entryFee
            ETourLib_Core.Mode.Classic,
            timeouts2,
            tier2Prizes
        );
        emit TierRegistered(2, 8, 20, 0.004 ether);

        // ============ Configure Raffle Thresholds ============
        // Progressive thresholds: 0.1, 0.2, 0.3, 0.3, 0.5 ETH for first 5 raffles
        // Then 1.0 ETH for all subsequent raffles
        uint256[] memory thresholds = new uint256[](5);
        thresholds[0] = 0.1 ether;
        thresholds[1] = 0.2 ether;
        thresholds[2] = 0.3 ether;
        thresholds[3] = 0.3 ether;
        thresholds[4] = 0.5 ether;

        ETourLib_Core.registerRaffleThresholds(_etourStorage, thresholds, 1.0 ether);
    }

    // ============ Enrollment Functions ============

    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        (bool shouldEmitInit, bool shouldStart, uint256 ownerShare,
         uint256 protocolShare, uint256 participantsShare) =
            ETourLib_Core.enrollInTournamentLogic(
                _etourStorage, tierId, instanceId, msg.sender, msg.value
            );

        if (shouldEmitInit) {
            emit TournamentInitialized(tierId, instanceId);
        }

        // Send owner share
        (bool success, ) = payable(owner).call{value: ownerShare}("");
        require(success, "Owner fee transfer failed");
        emit OwnerFeePaid(owner, ownerShare);
        emit ProtocolFeePaid(address(this), protocolShare);

        emit PlayerEnrolled(tierId, instanceId, msg.sender,
            _etourStorage.tournaments[tierId][instanceId].enrolledCount);

        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        if (shouldStart) {
            _startTournament(tierId, instanceId);
        }
    }

    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
        ETourLib_Core.forceStartTournamentLogic(_etourStorage, tierId, instanceId, msg.sender);
        _startTournament(tierId, instanceId);
    }

    // TODO: Implement claimAbandonedEnrollmentPool once library function is available
    // function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
    //     (address[] memory refundPlayers, uint256 refundAmount) =
    //         ETourLib_Core.claimAbandonedEnrollmentPoolLogic(_etourStorage, tierId, instanceId);
    //
    //     for (uint256 i = 0; i < refundPlayers.length; i++) {
    //         (bool success, ) = payable(refundPlayers[i]).call{value: refundAmount}("");
    //         require(success, "Refund failed");
    //         emit EnrollmentRefunded(tierId, instanceId, refundPlayers[i], refundAmount);
    //     }
    //
    //     emit AbandonedPoolClaimed(tierId, instanceId, refundAmount * refundPlayers.length);
    // }

    // ============ View Functions ============

    function getTournament(uint8 tierId, uint8 instanceId)
        external view returns (ETourLib_Core.TournamentInstance memory) {
        return ETourLib_Core.getTournament(_etourStorage, tierId, instanceId);
    }

    function getTournamentInfo(uint8 tierId, uint8 instanceId)
        external view returns (
            ETourLib_Core.TournamentStatus status,
            uint8 enrolledCount,
            uint8 currentRound,
            address winner,
            uint256 prizePool
        ) {
        ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];
        return (
            tournament.status,
            tournament.enrolledCount,
            tournament.currentRound,
            tournament.winner,
            tournament.prizePool
        );
    }

    function getPlayerStats(address player)
        external view returns (ETourLib_Core.PlayerStats memory) {
        return ETourLib_Core.getPlayerStats(_etourStorage, player);
    }

    function getLeaderboard(uint256 startIndex, uint256 count)
        external view returns (ETourLib_Core.LeaderboardEntry[] memory) {
        return ETourLib_Prizes.getLeaderboard(_etourStorage);
    }

    function tierConfigs(uint8 tierId)
        external view returns (ETourLib_Core.TierConfig memory) {
        return ETourLib_Core.getTierConfig(_etourStorage, tierId);
    }

    function getTimeoutConfig(uint8 tierId)
        external view returns (ETourLib_Core.TimeoutConfig memory) {
        return _etourStorage.tierConfigs[tierId].timeouts;
    }

    function getAllTierIds() external view returns (uint8[] memory) {
        return ETourLib_Core.getAllTierIds(_etourStorage);
    }

    function isEnrolled(uint8 tierId, uint8 instanceId, address player)
        external view returns (bool) {
        return _etourStorage.isEnrolled[tierId][instanceId][player];
    }

    function getEnrolledPlayers(uint8 tierId, uint8 instanceId)
        external view returns (address[] memory) {
        return ETourLib_Core.getEnrolledPlayers(_etourStorage, tierId, instanceId);
    }

    function getRound(uint8 tierId, uint8 instanceId, uint8 roundNumber)
        external view returns (ETourLib_Core.Round memory) {
        return _etourStorage.rounds[tierId][instanceId][roundNumber];
    }

    // ============ Tournament Management (Internal) ============

    function _startTournament(uint8 tierId, uint8 instanceId) internal {
        (bool isSolo, address soloWinner, uint256 prize) =
            ETourLib_Matches.startTournamentLogic(_etourStorage, tierId, instanceId);

        emit TournamentStarted(tierId, instanceId,
            _etourStorage.tournaments[tierId][instanceId].enrolledCount);
        _onTournamentStarted(tierId, instanceId);

        if (isSolo) {
            // Handle solo winner
            bool sent = _sendPrize(soloWinner, prize);
            if (sent) {
                emit PrizeDistributed(tierId, instanceId, soloWinner, 1, prize);
            }
            emit TournamentCompleted(tierId, instanceId, soloWinner, prize, false, address(0));
            ETourLib_Prizes.updatePlayerEarnings(_etourStorage, tierId, instanceId, soloWinner);
            _resetTournament(tierId, instanceId);
            return;
        }

        _initializeRound(tierId, instanceId, 0);
    }

    function _initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        (uint8 matchCount, bool hasWalkover, address walkoverPlayer, address[] memory playerPairs) =
            ETourLib_Matches.initializeRoundLogic(_etourStorage, tierId, instanceId, roundNumber);

        emit RoundInitialized(tierId, instanceId, roundNumber, matchCount);

        if (hasWalkover) {
            emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
        }

        // Only create matches for round 0 (first round)
        // For subsequent rounds, matches are created as winners advance via _advanceWinner
        if (roundNumber == 0) {
            for (uint8 i = 0; i < matchCount; i++) {
                address p1 = playerPairs[i * 2];
                address p2 = playerPairs[i * 2 + 1];
                _createMatchGame(tierId, instanceId, roundNumber, i, p1, p2);
            }

            // If there was a walkover, advance that player to the next round
            if (hasWalkover) {
                // Walkover player gets a bye to the next round
                // The match number for the walkover player in the next round is matchCount (after all real matches)
                uint8 nextRound = roundNumber + 1;
                uint8 nextMatchNumber = matchCount / 2; // Position in next round
                _advanceWinner(tierId, instanceId, nextRound, nextMatchNumber, walkoverPlayer);
            }
        }
    }

    function _resetTournament(uint8 tierId, uint8 instanceId) internal {
        // Copy players to memory before reset clears the storage
        address[] storage playersStorage = _etourStorage.enrolledPlayers[tierId][instanceId];
        address[] memory players = new address[](playersStorage.length);
        for (uint256 i = 0; i < playersStorage.length; i++) {
            players[i] = playersStorage[i];
        }

        ETourLib_Matches.resetTournamentLogic(_etourStorage, tierId, instanceId);
        _onTournamentCompleted(tierId, instanceId, players);
    }

    function _sendPrize(address recipient, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool success, ) = payable(recipient).call{value: amount}("");
        return success;
    }

    // ============ Helper Functions ============

    function _getMatchId(uint8 tierId, uint8 instanceId, uint8 roundNum, uint8 matchNum)
        internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tierId, instanceId, roundNum, matchNum));
    }

    function _addPlayerActiveMatch(address player, bytes32 matchId) internal {
        // Track active match for player (game-specific implementation)
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
        Match storage matchData = matches[matchId];

        ETourLib_Matches.MatchCompletionResult memory result =
            ETourLib_Matches.completeMatchLogic(
                _etourStorage,
                tierId,
                instanceId,
                roundNumber,
                matchNumber,
                winner,
                isDraw,
                matchData.player1,
                matchData.player2
            );

        emit MatchCompleted(matchId, winner, isDraw);

        // Notify about loser elimination if there is one
        if (result.loser != address(0)) {
            _onPlayerEliminatedFromTournament(result.loser, tierId, instanceId, roundNumber);
        }

        _resetMatchGame(matchId);
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        // Advance winner to next round if applicable
        if (result.shouldAdvanceWinner) {
            _advanceWinner(tierId, instanceId, result.nextRound, result.nextMatchNumber, winner);
        }

        if (result.roundCompleted) {
            _completeRound(tierId, instanceId, roundNumber);
        }
    }

    function _advanceWinner(
        uint8 tierId,
        uint8 instanceId,
        uint8 nextRound,
        uint8 nextMatchNumber,
        address winner
    ) internal {
        ETourLib_Core.Round storage nextRoundData = _etourStorage.rounds[tierId][instanceId][nextRound];
        if (!nextRoundData.initialized) {
            _initializeRound(tierId, instanceId, nextRound);
        }

        bytes32 nextMatchId = _getMatchId(tierId, instanceId, nextRound, nextMatchNumber);
        Match storage nextMatch = matches[nextMatchId];

        // Set winner as player1 or player2 based on whether the current match number is even or odd
        if (nextMatch.player1 == address(0)) {
            nextMatch.player1 = winner;
        } else if (nextMatch.player2 == address(0)) {
            nextMatch.player2 = winner;
        }

        // If both players are now set, initialize the match for play
        if (nextMatch.player1 != address(0) && nextMatch.player2 != address(0) &&
            nextMatch.status == ETourLib_Core.MatchStatus.NotStarted) {
            require(nextMatch.player1 != nextMatch.player2, "Cannot match player against themselves");
            _initializeMatchForPlay(nextMatchId, tierId);
        }
    }

    function _completeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        ETourLib_Matches.RoundCompletionResult memory result =
            ETourLib_Matches.completeRoundLogic(_etourStorage, tierId, instanceId, roundNumber);

        emit RoundCompleted(tierId, instanceId, roundNumber);

        if (result.shouldDistributePrizes) {
            _distributePrizes(tierId, instanceId);
        } else if (result.isAllDrawRound) {
            emit AllDrawRoundDetected(tierId, instanceId, roundNumber, uint8(result.remainingPlayers.length));
            _initializeRound(tierId, instanceId, roundNumber + 1);
        } else if (result.shouldAdvanceToNextRound) {
            _initializeRound(tierId, instanceId, roundNumber + 1);
        }
    }

    function _distributePrizes(uint8 tierId, uint8 instanceId) internal {
        ETourLib_Prizes.PrizeDistributionPlan memory plan =
            ETourLib_Prizes.calculatePrizeDistribution(_etourStorage, tierId, instanceId);

        ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];

        for (uint256 i = 0; i < plan.recipients.length; i++) {
            if (plan.amounts[i] > 0) {
                // Store prize amount before distribution
                _etourStorage.playerPrizes[tierId][instanceId][plan.recipients[i]] = plan.amounts[i];

                bool sent = _sendPrize(plan.recipients[i], plan.amounts[i]);
                if (sent) {
                    emit PrizeDistributed(tierId, instanceId, plan.recipients[i], uint8(i + 1), plan.amounts[i]);
                }
                ETourLib_Prizes.updatePlayerEarnings(_etourStorage, tierId, instanceId, plan.recipients[i]);
            }
        }

        emit TournamentCompleted(
            tierId,
            instanceId,
            tournament.winner,
            plan.amounts.length > 0 ? plan.amounts[0] : 0,
            tournament.finalsWasDraw,
            tournament.coWinner
        );

        _resetTournament(tierId, instanceId);
    }

    function _markMatchStalled(bytes32 matchId, uint8 tierId) internal {
        // Mark match as stalled (placeholder for now)
    }

    function _getMatchCommon(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view returns (ETourLib_Core.CommonMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        address loser = address(0);
        if (matchData.winner != address(0) && !matchData.isDraw) {
            loser = (matchData.winner == matchData.player1) ? matchData.player2 : matchData.player1;
        }

        return ETourLib_Core.CommonMatchData({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            loser: loser,
            status: matchData.status,
            isDraw: matchData.isDraw,
            startTime: matchData.startTime,
            lastMoveTime: matchData.lastMoveTime,
            endTime: 0, // Could track this if needed
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false // Could check cache if needed
        });
    }

    // ============ ETour Abstract Implementation ============

    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) internal {
        require(player1 != player2, "Cannot match player against themselves");
        require(player1 != address(0) && player2 != address(0), "Invalid player address");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.player1 = player1;
        matchData.player2 = player2;
        matchData.status = ETourLib_Core.MatchStatus.InProgress;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;
        matchData.isDraw = false;

        // Random starting player
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            player1,
            player2,
            matchId
        )));
        matchData.currentTurn = (randomness % 2 == 0) ? player1 : player2;
        matchData.firstPlayer = matchData.currentTurn;

        for (uint8 i = 0; i < 9; i++) {
            matchData.board[i] = Cell.Empty;
        }

        // Initialize time banks for both players
        uint256 timePerPlayer = _etourStorage.tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;

        _addPlayerActiveMatch(player1, matchId);
        _addPlayerActiveMatch(player2, matchId);

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    function _resetMatchGame(bytes32 matchId) internal {
        Match storage matchData = matches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = ETourLib_Core.MatchStatus.NotStarted;
        matchData.lastMoveTime = 0;
        matchData.startTime = 0;
        matchData.firstPlayer = address(0);
        matchData.isDraw = false;

        for (uint8 i = 0; i < 9; i++) {
            matchData.board[i] = Cell.Empty;
        }
    }

    function _getMatchResult(bytes32 matchId) internal view returns (address winner, bool isDraw, ETourLib_Core.MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        bytes32 matchKey = keccak256(abi.encodePacked(matchData.player1, matchData.player2));
        uint16 cacheIndex = nextCacheIndex;

        // Clean up old mappings for the entry being overwritten
        bytes32 oldKey = cacheKeys[cacheIndex];
        if (oldKey != bytes32(0)) {
            delete cacheKeyToIndex[oldKey];
        }

        bytes32 oldMatchId = cacheMatchIds[cacheIndex];
        if (oldMatchId != bytes32(0)) {
            delete matchIdToCacheIndex[oldMatchId]; // CRITICAL: Clean up old matchId mapping
        }

        matchCache[cacheIndex] = CachedMatchData({
            player1: matchData.player1,
            player2: matchData.player2,
            firstPlayer: matchData.firstPlayer,
            winner: matchData.winner,
            startTime: matchData.startTime,
            endTime: block.timestamp,
            board: matchData.board,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isDraw: matchData.isDraw,
            exists: true
        });

        cacheKeys[cacheIndex] = matchKey;
        cacheKeyToIndex[matchKey] = cacheIndex;
        matchIdToCacheIndex[matchId] = cacheIndex;
        cacheMatchIds[cacheIndex] = matchId; // Track which matchId is at this index

        nextCacheIndex = uint16((cacheIndex + 1) % MATCH_CACHE_SIZE);

        emit MatchCached(matchKey, cacheIndex, matchData.player1, matchData.player2);
    }

    function _getMatchPlayers(bytes32 matchId) internal view returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _getTimeIncrement() internal view returns (uint256) {
        // Note: This function is called during match, so we get config from the match's tier
        // In practice, all tiers in TicTacChain use 15 seconds
        return 15 seconds; // Fischer increment: 15 seconds per move
    }

    /**
     * @dev Check if the current player has run out of time
     * Used by escalation system to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) internal view returns (bool) {
        Match storage matchData = matches[matchId];

        // If match is not in progress, return false
        if (matchData.status != ETourLib_Core.MatchStatus.InProgress) {
            return false;
        }

        // Calculate time elapsed since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Get current player's remaining time
        uint256 currentPlayerTimeRemaining;
        if (matchData.currentTurn == matchData.player1) {
            currentPlayerTimeRemaining = matchData.player1TimeRemaining;
        } else {
            currentPlayerTimeRemaining = matchData.player2TimeRemaining;
        }

        // Current player has timed out if elapsed time >= their remaining time
        return timeElapsed >= currentPlayerTimeRemaining;
    }

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal {
        Match storage matchData = matches[matchId];

        require(matchData.player1 != matchData.player2, "Cannot match player against themselves");

        matchData.status = ETourLib_Core.MatchStatus.InProgress;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            matchData.player1,
            matchData.player2,
            matchId
        )));
        matchData.firstPlayer = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.currentTurn = matchData.firstPlayer;

        for (uint8 i = 0; i < 9; i++) {
            matchData.board[i] = Cell.Empty;
        }

        // Initialize time banks for both players
        uint256 timePerPlayer = _etourStorage.tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal {
        Match storage matchData = matches[matchId];
        matchData.status = ETourLib_Core.MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    function _isMatchActive(bytes32 matchId) internal view returns (bool) {
        Match storage matchData = matches[matchId];
        // Active if player1 assigned and not completed
        return matchData.player1 != address(0) &&
               matchData.status != ETourLib_Core.MatchStatus.Completed;
    }

    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view returns (ETourLib_Core.CommonMatchData memory) {
        Match storage matchData = matches[matchId];

        // Derive loser
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = (matchData.winner == matchData.player1)
                ? matchData.player2
                : matchData.player1;
        }

        return ETourLib_Core.CommonMatchData({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            loser: loser,
            status: matchData.status,
            isDraw: matchData.isDraw,
            startTime: matchData.startTime,
            lastMoveTime: matchData.lastMoveTime,
            endTime: 0,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
    }

    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view returns (ETourLib_Core.CommonMatchData memory data, bool exists) {
        // Try direct matchId lookup first (works even after match reset)
        uint16 index = matchIdToCacheIndex[matchId];

        // Verify cache entry exists and context matches
        if (matchCache[index].exists &&
            matchCache[index].tierId == tierId &&
            matchCache[index].instanceId == instanceId &&
            matchCache[index].roundNumber == roundNumber &&
            matchCache[index].matchNumber == matchNumber) {

            CachedMatchData storage cached = matchCache[index];

            // Derive loser
            address loser = address(0);
            if (!cached.isDraw && cached.winner != address(0)) {
                loser = (cached.winner == cached.player1)
                    ? cached.player2
                    : cached.player1;
            }

            // Populate CommonMatchData
            data = ETourLib_Core.CommonMatchData({
                player1: cached.player1,
                player2: cached.player2,
                winner: cached.winner,
                loser: loser,
                status: ETourLib_Core.MatchStatus.Completed,
                isDraw: cached.isDraw,
                startTime: cached.startTime,
                lastMoveTime: cached.endTime,
                endTime: cached.endTime,
                tierId: cached.tierId,
                instanceId: cached.instanceId,
                roundNumber: cached.roundNumber,
                matchNumber: cached.matchNumber,
                isCached: true
            });

            return (data, true);
        }

        // Fallback: Try player-based lookup (for backwards compatibility)
        (address player1, address player2) = _getMatchPlayers(matchId);
        if (player1 != address(0) || player2 != address(0)) {
            bytes32 matchKey = keccak256(abi.encodePacked(player1, player2));
            uint16 altIndex = cacheKeyToIndex[matchKey];

            if (matchCache[altIndex].exists &&
                cacheKeys[altIndex] == matchKey &&
                matchCache[altIndex].tierId == tierId &&
                matchCache[altIndex].instanceId == instanceId &&
                matchCache[altIndex].roundNumber == roundNumber &&
                matchCache[altIndex].matchNumber == matchNumber) {

                CachedMatchData storage cached = matchCache[altIndex];
                address loser = address(0);
                if (!cached.isDraw && cached.winner != address(0)) {
                    loser = (cached.winner == cached.player1)
                        ? cached.player2
                        : cached.player1;
                }

                data = ETourLib_Core.CommonMatchData({
                    player1: cached.player1,
                    player2: cached.player2,
                    winner: cached.winner,
                    loser: loser,
                    status: ETourLib_Core.MatchStatus.Completed,
                    isDraw: cached.isDraw,
                    startTime: cached.startTime,
                    lastMoveTime: cached.endTime,
                    endTime: cached.endTime,
                    tierId: cached.tierId,
                    instanceId: cached.instanceId,
                    roundNumber: cached.roundNumber,
                    matchNumber: cached.matchNumber,
                    isCached: true
                });

                return (data, true);
            }
        }

        return (data, false);
    }

    // ============ Gameplay Functions ============

    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == ETourLib_Core.MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player in this match");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(cellIndex < 9, "Invalid cell index");
        require(matchData.board[cellIndex] == Cell.Empty, "Cell already occupied");

        // Update time bank for current player (Fischer increment)
        // Note: Players can make moves even if out of time - opponent must claim timeout victory
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;
        uint256 timeIncrement = _getTimeIncrement();

        if (msg.sender == matchData.player1) {
            // Deduct elapsed time (or set to 0 if insufficient), then add Fischer increment
            if (matchData.player1TimeRemaining >= timeElapsed) {
                matchData.player1TimeRemaining -= timeElapsed;
            } else {
                matchData.player1TimeRemaining = 0;
            }
            matchData.player1TimeRemaining += timeIncrement;
        } else {
            // Deduct elapsed time (or set to 0 if insufficient), then add Fischer increment
            if (matchData.player2TimeRemaining >= timeElapsed) {
                matchData.player2TimeRemaining -= timeElapsed;
            } else {
                matchData.player2TimeRemaining = 0;
            }
            matchData.player2TimeRemaining += timeIncrement;
        }

        matchData.board[cellIndex] = (msg.sender == matchData.player1) ? Cell.X : Cell.O;
        matchData.lastMoveTime = block.timestamp;
        matchData.lastMoveTimestamp = block.timestamp;

        emit MoveMade(matchId, msg.sender, cellIndex);

        if (_checkWin(matchData.board)) {
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
            return;
        }

        if (_checkDraw(matchData.board)) {
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        matchData.currentTurn = (matchData.currentTurn == matchData.player1) ? matchData.player2 : matchData.player1;
    }

    // ============ Timeout Functions ============

    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == ETourLib_Core.MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender != matchData.currentTurn, "Cannot claim timeout on your own turn");

        // Calculate time elapsed since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Determine opponent's remaining time
        uint256 opponentTimeRemaining;
        address loser = matchData.currentTurn;

        if (matchData.currentTurn == matchData.player1) {
            opponentTimeRemaining = matchData.player1TimeRemaining;
        } else {
            opponentTimeRemaining = matchData.player2TimeRemaining;
        }

        // Check if opponent has run out of time
        require(timeElapsed >= opponentTimeRemaining, "Opponent has not run out of time");

        // Mark match as stalled to enable escalation if this claim isn't executed
        // This starts escalation timers for advanced players and external replacements
        _markMatchStalled(matchId, tierId);

        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, loser);

        _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    // ============ Game Logic ============

    function _checkWin(Cell[9] memory board) internal pure returns (bool) {
        uint8[3][8] memory lines = [
            [uint8(0),1,2], [3,4,5], [6,7,8],
            [uint8(0),3,6], [1,4,7], [2,5,8],
            [uint8(0),4,8], [2,4,6]
        ];
        
        for (uint256 i = 0; i < 8; i++) {
            uint8 a = lines[i][0];
            uint8 b = lines[i][1];
            uint8 c = lines[i][2];
            
            if (board[a] != Cell.Empty && board[a] == board[b] && board[b] == board[c]) {
                return true;
            }
        }
        return false;
    }

    function _checkDraw(Cell[9] memory board) internal pure returns (bool) {
        for (uint256 i = 0; i < 9; i++) {
            if (board[i] == Cell.Empty) return false;
        }
        return true;
    }

    // ============ View Functions ============

    /**
     * @dev Get complete TicTacToe match data with automatic cache fallback
     * Replaces legacy tuple return with structured data
     * BREAKING CHANGE: Returns struct instead of tuple
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (TicTacToeMatchData memory) {
        // Call base to get common data with cache fallback
        ETourLib_Core.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);

        TicTacToeMatchData memory fullData;
        fullData.common = common;

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        if (common.isCached) {
            // Populate from cache
            bytes32 matchKey = keccak256(abi.encodePacked(common.player1, common.player2));
            uint16 index = cacheKeyToIndex[matchKey];
            CachedMatchData storage cached = matchCache[index];

            fullData.board = cached.board;
            fullData.firstPlayer = cached.firstPlayer;
            fullData.currentTurn = address(0);  // N/A for completed matches
            fullData.player1TimeRemaining = 0;  // N/A for completed matches
            fullData.player2TimeRemaining = 0;
            fullData.lastMoveTimestamp = 0;
        } else {
            // Populate from active storage
            Match storage matchData = matches[matchId];
            fullData.board = matchData.board;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.player1TimeRemaining = matchData.player1TimeRemaining;
            fullData.player2TimeRemaining = matchData.player2TimeRemaining;
            fullData.lastMoveTimestamp = matchData.lastMoveTimestamp;
        }

        return fullData;
    }

    /**
     * @dev Get real-time remaining time for both players
     * Calculates current player's time by subtracting elapsed time since last move
     * Returns stored time for waiting player
     */
    function getCurrentTimeRemaining(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (uint256 player1Time, uint256 player2Time) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // For completed or not started matches, return stored values
        ETourLib_Core.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);
        if (common.status != ETourLib_Core.MatchStatus.InProgress) {
            return (matchData.player1TimeRemaining, matchData.player2TimeRemaining);
        }

        // Calculate elapsed time since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Calculate real-time remaining for current player
        if (matchData.currentTurn == common.player1) {
            // Player 1's turn - deduct elapsed time
            player1Time = matchData.player1TimeRemaining > timeElapsed
                ? matchData.player1TimeRemaining - timeElapsed
                : 0;
            player2Time = matchData.player2TimeRemaining;
        } else {
            // Player 2's turn - deduct elapsed time
            player1Time = matchData.player1TimeRemaining;
            player2Time = matchData.player2TimeRemaining > timeElapsed
                ? matchData.player2TimeRemaining - timeElapsed
                : 0;
        }

        return (player1Time, player2Time);
    }

    function getCachedMatch(address player1, address player2) external view returns (CachedMatchData memory) {
        bytes32 matchKey = keccak256(abi.encodePacked(player1, player2));
        uint16 index = cacheKeyToIndex[matchKey];
        require(matchCache[index].exists && cacheKeys[index] == matchKey, "Match not in cache");
        return matchCache[index];
    }

    function getCachedMatchByIndex(uint16 index) external view returns (CachedMatchData memory) {
        require(index < MATCH_CACHE_SIZE, "Index out of bounds");
        require(matchCache[index].exists, "No match at this index");
        return matchCache[index];
    }

    function getAllCachedMatches() external view returns (CachedMatchData[] memory cachedMatches) {
        cachedMatches = new CachedMatchData[](MATCH_CACHE_SIZE);
        for (uint16 i = 0; i < MATCH_CACHE_SIZE; i++) {
            cachedMatches[i] = matchCache[i];
        }
        return cachedMatches;
    }

    function getRecentCachedMatches(uint16 count) external view returns (CachedMatchData[] memory recentMatches) {
        if (count > MATCH_CACHE_SIZE) {
            count = MATCH_CACHE_SIZE;
        }

        recentMatches = new CachedMatchData[](count);
        uint16 currentIndex = nextCacheIndex;

        for (uint16 i = 0; i < count; i++) {
            if (currentIndex == 0) {
                currentIndex = MATCH_CACHE_SIZE - 1;
            } else {
                currentIndex--;
            }

            if (matchCache[currentIndex].exists) {
                recentMatches[i] = matchCache[currentIndex];
            }
        }

        return recentMatches;
    }

    function isMatchCached(address player1, address player2) external view returns (bool) {
        bytes32 matchKey = keccak256(abi.encodePacked(player1, player2));
        uint16 index = cacheKeyToIndex[matchKey];
        return matchCache[index].exists && cacheKeys[index] == matchKey;
    }

    // ============ Backward Compatibility Functions ============
    // Functions from old ETour that need to exist for client compatibility

    // Constants
    function ENTRY_FEES(uint8 tierId) external view returns (uint256) {
        return _etourStorage.tierConfigs[tierId].entryFee;
    }

    function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8) {
        return _etourStorage.tierConfigs[tierId].instanceCount;
    }

    function TIER_SIZES(uint8 tierId) external view returns (uint8) {
        return _etourStorage.tierConfigs[tierId].playerCount;
    }

    function BASIS_POINTS() external pure returns (uint256) {
        return 10000;
    }

    function OWNER_SHARE_BPS() external pure returns (uint256) {
        return 500; // 5%
    }

    function PROTOCOL_SHARE_BPS() external pure returns (uint256) {
        return 500; // 5%
    }

    function PARTICIPANTS_SHARE_BPS() external pure returns (uint256) {
        return 9000; // 90%
    }

    function NO_ROUND() external pure returns (uint8) {
        return 255;
    }

    function declareRW3() external pure returns (string memory) {
        return "This contract is part of the Reclaim Web3 (RW3) movement";
    }

    // Raffle state getters
    function currentRaffleIndex() external view returns (uint256) {
        return _etourStorage.currentRaffleIndex;
    }

    function accumulatedProtocolShare() external view returns (uint256) {
        return _etourStorage.accumulatedProtocolShare;
    }

    // ============ Direct Storage Accessors (for backwards compatibility) ============

    /**
     * @dev Returns the number of tiers configured
     */
    function tierCount() external view returns (uint8) {
        return _etourStorage.tierCount;
    }

    /**
     * @dev Direct accessor for tournament instance
     */
    function tournaments(uint8 tierId, uint8 instanceId) external view returns (ETourLib_Core.TournamentInstance memory) {
        return _etourStorage.tournaments[tierId][instanceId];
    }

    /**
     * @dev Direct accessor for round data
     */
    function rounds(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (ETourLib_Core.Round memory) {
        return _etourStorage.rounds[tierId][instanceId][roundNumber];
    }

    // ============ Tier Info Helpers ============

    // Tier info helpers
    function getTierInfo(uint8 tierId) external view returns (uint8 playerCount, uint8 instanceCount, uint256 entryFee) {
        ETourLib_Core.TierConfig memory config = _etourStorage.tierConfigs[tierId];
        return (config.playerCount, config.instanceCount, config.entryFee);
    }

    function getTierConfiguration(uint8 tierId)
        external view
        returns (
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
        )
    {
        ETourLib_Core.TierConfig memory config = _etourStorage.tierConfigs[tierId];
        uint8[] memory prizes = _etourStorage.tierPrizeDistribution[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            config.timeouts.matchTimePerPlayer,
            config.timeouts.timeIncrementPerMove,
            config.timeouts.matchLevel2Delay,
            config.timeouts.matchLevel3Delay,
            config.timeouts.enrollmentWindow,
            config.timeouts.enrollmentLevel2Delay,
            prizes
        );
    }

    function getTierTimeouts(uint8 tierId)
        external view
        returns (
            uint256 matchTimePerPlayer,
            uint256 timeIncrementPerMove,
            uint256 matchLevel2Delay,
            uint256 matchLevel3Delay,
            uint256 enrollmentWindow,
            uint256 enrollmentLevel2Delay
        )
    {
        ETourLib_Core.TimeoutConfig memory timeouts = _etourStorage.tierConfigs[tierId].timeouts;
        return (
            timeouts.matchTimePerPlayer,
            timeouts.timeIncrementPerMove,
            timeouts.matchLevel2Delay,
            timeouts.matchLevel3Delay,
            timeouts.enrollmentWindow,
            timeouts.enrollmentLevel2Delay
        );
    }

    function getTierOverview(uint8 tierId)
        external view
        returns (
            ETourLib_Core.TournamentStatus[] memory statuses,
            uint8[] memory enrolledCounts,
            uint256[] memory prizePools
        )
    {
        uint8 instanceCount = _etourStorage.tierConfigs[tierId].instanceCount;
        statuses = new ETourLib_Core.TournamentStatus[](instanceCount);
        enrolledCounts = new uint8[](instanceCount);
        prizePools = new uint256[](instanceCount);

        for (uint8 i = 0; i < instanceCount; i++) {
            ETourLib_Core.TournamentInstance storage t = _etourStorage.tournaments[tierId][i];
            statuses[i] = t.status;
            enrolledCounts[i] = t.enrolledCount;
            prizePools[i] = t.prizePool;
        }

        return (statuses, enrolledCounts, prizePools);
    }

    function getTierPrizeDistribution(uint8 tierId) external view returns (uint8[] memory) {
        return _etourStorage.tierPrizeDistribution[tierId];
    }

    function getPrizePercentage(uint8 tierId, uint8 ranking) external view returns (uint8) {
        uint8[] storage prizes = _etourStorage.tierPrizeDistribution[tierId];
        require(ranking < prizes.length, "Invalid ranking");
        return prizes[ranking];
    }

    function getFeeDistribution()
        external pure
        returns (
            uint256 prizePoolPercentage,
            uint256 ownerFeePercentage,
            uint256 protocolFeePercentage,
            uint256 basisPoints
        )
    {
        return (9000, 500, 500, 10000);
    }

    function getTierCapacity(uint8 tierId) external view returns (uint256) {
        ETourLib_Core.TierConfig memory config = _etourStorage.tierConfigs[tierId];
        return uint256(config.playerCount) * uint256(config.instanceCount);
    }

    function getTotalCapacity() external view returns (uint256 totalPlayers) {
        totalPlayers = 0;
        for (uint8 tierId = 0; tierId < _etourStorage.tierCount; tierId++) {
            ETourLib_Core.TierConfig memory config = _etourStorage.tierConfigs[tierId];
            if (config.initialized) {
                totalPlayers += uint256(config.playerCount) * uint256(config.instanceCount);
            }
        }
        return totalPlayers;
    }

    function getMatchTimePerPlayer(uint8 tierId) external view returns (uint256) {
        return _etourStorage.tierConfigs[tierId].timeouts.matchTimePerPlayer;
    }

    function getTimeIncrement() external pure returns (uint256) {
        return 0;
    }

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber)
        external view
        returns (uint8 totalMatches, uint8 completedMatches, bool initialized)
    {
        ETourLib_Core.Round memory r = _etourStorage.rounds[tierId][instanceId][roundNumber];
        return (r.totalMatches, r.completedMatches, r.initialized);
    }

    function getLeaderboardCount() external view returns (uint256) {
        return _etourStorage.leaderboardPlayers.length;
    }

    // Legacy getPlayerStats - no address param
    function getPlayerStats() external view returns (int256) {
        return _etourStorage.playerEarnings[msg.sender];
    }

    // Legacy getLeaderboard - no pagination
    function getLeaderboard() external view returns (ETourLib_Core.LeaderboardEntry[] memory) {
        return ETourLib_Prizes.getLeaderboard(_etourStorage);
    }

    // Escalation check functions
    function isMatchEscL1Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber)
        external view returns (bool)
    {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ETourLib_Core.MatchTimeoutState storage timeout = _etourStorage.matchTimeouts[matchId];

        if (!timeout.isStalled) return false;
        return block.timestamp >= timeout.escalation1Start;
    }

    function isMatchEscL2Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber)
        external view returns (bool)
    {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ETourLib_Core.MatchTimeoutState storage timeout = _etourStorage.matchTimeouts[matchId];

        if (!timeout.isStalled) return false;
        return block.timestamp >= timeout.escalation1Start;
    }

    function isMatchEscL3Available(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber)
        external view returns (bool)
    {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ETourLib_Core.MatchTimeoutState storage timeout = _etourStorage.matchTimeouts[matchId];

        if (!timeout.isStalled) return false;
        return block.timestamp >= timeout.escalation2Start;
    }

    // Player advanced check
    function isPlayerInAdvancedRound(address player, uint8 tierId, uint8 instanceId, uint8 roundNumber)
        external view returns (bool)
    {
        if (!_etourStorage.isEnrolled[tierId][instanceId][player]) {
            return false;
        }

        // Check if player won a match in any round up to and including this round
        for (uint8 r = 0; r <= roundNumber; r++) {
            ETourLib_Core.Round storage round = _etourStorage.rounds[tierId][instanceId][r];

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                Match storage matchData = matches[matchId];

                if (matchData.status == ETourLib_Core.MatchStatus.Completed &&
                    matchData.winner == player &&
                    !matchData.isDraw) {
                    return true;
                }
            }
        }

        return false;
    }

    // Enrollment management
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId)
        external view returns (bool)
    {
        ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];

        if (!config.initialized) return false;
        if (instanceId >= config.instanceCount) return false;

        ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];

        bool isEnrollingStatus = tournament.status == ETourLib_Core.TournamentStatus.Enrolling;
        bool isExactlyOnePlayer = tournament.enrolledCount == 1;
        bool isPlayerEnrolled = _etourStorage.isEnrolled[tierId][instanceId][msg.sender];
        bool hasWindowExpired = block.timestamp >= tournament.enrollmentTimeout.escalation1Start;

        return isEnrollingStatus &&
               isExactlyOnePlayer &&
               isPlayerEnrolled &&
               hasWindowExpired;
    }

    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];

        require(tournament.status == ETourLib_Core.TournamentStatus.Enrolling, "Not enrolling");
        require(tournament.enrolledCount == 1, "Must have exactly 1 player enrolled");
        require(_etourStorage.isEnrolled[tierId][instanceId][msg.sender], "Not enrolled");
        require(
            block.timestamp >= tournament.enrollmentTimeout.escalation1Start,
            "Enrollment window not expired"
        );

        tournament.enrollmentTimeout.escalation1Start =
            block.timestamp + config.timeouts.enrollmentWindow;
        tournament.enrollmentTimeout.escalation2Start =
            tournament.enrollmentTimeout.escalation1Start + config.timeouts.enrollmentLevel2Delay;
        tournament.enrollmentTimeout.activeEscalation = ETourLib_Core.EscalationLevel.None;

        emit EnrollmentWindowReset(
            tierId,
            instanceId,
            msg.sender,
            tournament.enrollmentTimeout.escalation1Start,
            tournament.enrollmentTimeout.escalation2Start
        );
    }

    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];
        require(config.initialized, "Invalid tier");
        require(instanceId < config.instanceCount, "Invalid instance");

        ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];

        require(tournament.status == ETourLib_Core.TournamentStatus.Enrolling, "Not enrolling");
        require(block.timestamp >= tournament.enrollmentTimeout.escalation2Start, "Public claim window not reached");
        require(tournament.enrolledCount > 0, "No enrollment pool to claim");

        tournament.enrollmentTimeout.activeEscalation = ETourLib_Core.EscalationLevel.Escalation3_ExternalPlayers;

        uint256 claimAmount = tournament.enrollmentTimeout.forfeitPool;
        tournament.enrollmentTimeout.forfeitPool = 0;

        for (uint256 i = 0; i < tournament.enrolledCount; i++) {
            address player = _etourStorage.enrolledPlayers[tierId][instanceId][i];
            emit PlayerForfeited(tierId, instanceId, player, config.entryFee, "Enrollment abandoned");
        }

        (bool success, ) = payable(msg.sender).call{value: claimAmount}("");
        require(success, "Transfer failed");

        emit AbandonedPoolClaimed(tierId, instanceId, claimAmount);

        // Update earnings
        _etourStorage.playerEarnings[msg.sender] += int256(claimAmount);
        // TODO: Implement updateLeaderboard in ETourLib_Prizes or handle inline
        // ETourLib_Prizes.updateLeaderboard(_etourStorage, msg.sender);

        _resetTournament(tierId, instanceId);
    }

    // Match escalation functions
    function forceEliminateStalledMatch(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber)
        external nonReentrant
    {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check and mark stalled
        // TODO: Implement checkAndMarkStalled in ETourLib_Matches or handle inline
        // ETourLib_Matches.checkAndMarkStalled(_etourStorage, matchId, tierId, instanceId, roundNumber, matchNumber);

        ETourLib_Core.MatchTimeoutState storage timeout = _etourStorage.matchTimeouts[matchId];

        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation1Start, "Level 2 not active yet");

        // Require caller is an advanced player
        bool isAdvanced = false;
        for (uint8 r = 0; r <= roundNumber; r++) {
            ETourLib_Core.Round storage round = _etourStorage.rounds[tierId][instanceId][r];
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId2 = _getMatchId(tierId, instanceId, r, m);
                Match storage matchData2 = matches[matchId2];
                if (matchData2.status == ETourLib_Core.MatchStatus.Completed &&
                    matchData2.winner == msg.sender &&
                    !matchData2.isDraw) {
                    isAdvanced = true;
                    break;
                }
            }
            if (isAdvanced) break;
        }
        require(isAdvanced, "Not an advanced player");

        timeout.activeEscalation = ETourLib_Core.EscalationLevel.Escalation2_AdvancedPlayers;

        // Double eliminate - both players lose
        Match storage matchData = matches[matchId];
        matchData.winner = address(0);
        matchData.isDraw = false;
        matchData.status = ETourLib_Core.MatchStatus.Completed;

        emit MatchCompleted(matchId, address(0), false);

        // Continue tournament
        _completeRound(tierId, instanceId, roundNumber);
    }

    function claimMatchSlotByReplacement(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber)
        external nonReentrant
    {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // TODO: Implement checkAndMarkStalled in ETourLib_Matches or handle inline
        // ETourLib_Matches.checkAndMarkStalled(_etourStorage, matchId, tierId, instanceId, roundNumber, matchNumber);

        ETourLib_Core.MatchTimeoutState storage timeout = _etourStorage.matchTimeouts[matchId];

        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation2Start, "Level 3 not active yet");

        // Prevent advanced players from claiming
        bool isAdvanced = false;
        for (uint8 r = 0; r <= roundNumber; r++) {
            ETourLib_Core.Round storage round = _etourStorage.rounds[tierId][instanceId][r];
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId2 = _getMatchId(tierId, instanceId, r, m);
                Match storage matchData2 = matches[matchId2];
                if (matchData2.status == ETourLib_Core.MatchStatus.Completed &&
                    matchData2.winner == msg.sender &&
                    !matchData2.isDraw) {
                    isAdvanced = true;
                    break;
                }
            }
            if (isAdvanced) break;
        }
        require(!isAdvanced, "Advanced players cannot claim L3");

        timeout.activeEscalation = ETourLib_Core.EscalationLevel.Escalation3_ExternalPlayers;

        // Replacement wins
        Match storage matchData = matches[matchId];
        matchData.winner = msg.sender;
        matchData.isDraw = false;
        matchData.status = ETourLib_Core.MatchStatus.Completed;

        emit MatchCompleted(matchId, msg.sender, false);

        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        _completeRound(tierId, instanceId, roundNumber);
    }

    // Raffle functions
    // TODO: Implement raffle functions in ETourLib_Prizes
    /*
    function executeProtocolRaffle()
        external
        nonReentrant
        returns (
            address winner,
            uint256 ownerAmount,
            uint256 winnerAmount
        )
    {
        return ETourLib_Prizes.executeProtocolRaffle(_etourStorage, owner);
    }
    */

    function getRaffleInfo()
        external view
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
        raffleIndex = _etourStorage.currentRaffleIndex;
        currentAccumulated = _etourStorage.accumulatedProtocolShare;
        threshold = ETourLib_Prizes.getRaffleThreshold(_etourStorage);
        reserve = ETourLib_Prizes.getRaffleReserve(_etourStorage);

        isReady = currentAccumulated >= threshold;

        if (isReady) {
            raffleAmount = currentAccumulated - reserve;
            ownerShare = raffleAmount / 2;
            winnerShare = raffleAmount - ownerShare;
        } else {
            raffleAmount = 0;
            ownerShare = 0;
            winnerShare = 0;
        }

        // Count eligible players (in active tournaments)
        eligiblePlayerCount = 0;
        for (uint8 tierId = 0; tierId < _etourStorage.tierCount; tierId++) {
            ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];
            if (!config.initialized) continue;

            for (uint8 instanceId = 0; instanceId < config.instanceCount; instanceId++) {
                ETourLib_Core.TournamentInstance storage tournament = _etourStorage.tournaments[tierId][instanceId];
                if (tournament.status == ETourLib_Core.TournamentStatus.InProgress) {
                    eligiblePlayerCount += tournament.enrolledCount;
                }
            }
        }
    }

    function getRaffleConfiguration()
        external view
        returns (
            uint256 threshold,
            uint256 reserve,
            uint256 ownerSharePercentage,
            uint256 winnerSharePercentage
        )
    {
        threshold = ETourLib_Prizes.getRaffleThreshold(_etourStorage);
        reserve = ETourLib_Prizes.getRaffleReserve(_etourStorage);
        ownerSharePercentage = 50; // 50% to owner
        winnerSharePercentage = 50; // 50% to winner
    }

    function getRaffleThresholds()
        external view
        returns (
            uint256[] memory thresholds,
            uint256 finalThreshold,
            uint256 currentThreshold
        )
    {
        thresholds = _etourStorage.raffleThresholds;
        finalThreshold = _etourStorage.raffleThresholdFinal;
        currentThreshold = ETourLib_Prizes.getRaffleThreshold(_etourStorage);
    }

    // ============ Player Activity Tracking Implementation ============

    /**
     * @dev Hook override: Called when player enrolls in tournament
     * Adds player to enrolling list for activity tracking
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook override: Called when tournament starts (status -> InProgress)
     * Moves ALL enrolled players from enrolling to active list atomically
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal {
        address[] storage players = _etourStorage.enrolledPlayers[tierId][instanceId];

        // Iterate all enrolled players (max 8 for TicTacChain) and move atomically
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _addPlayerActiveTournament(player, tierId, instanceId);
        }
    }

    /**
     * @dev Hook override: Called when player is eliminated from tournament
     * Removes player from active list if they have no remaining matches in this tournament
     */
    function _onPlayerEliminatedFromTournament(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 /* roundNumber */
    ) internal {
        // Check if player has any remaining active matches in this tournament
        bool hasActiveMatch = _playerHasActiveMatchInTournament(player, tierId, instanceId);

        if (!hasActiveMatch) {
            _removePlayerActiveTournament(player, tierId, instanceId);
        }
    }

    /**
     * @dev Hook override: Called when external player replaces stalled players (L3 escalation)
     * Adds replacement player directly to active list (skips enrolling)
     */
    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal {
        // External replacement joins mid-tournament (already InProgress)
        // Skip enrolling list, add directly to active list
        _addPlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook override: Called when tournament completes and resets
     * Cleans up all player tracking for this tournament
     */
    function _onTournamentCompleted(
        uint8 tierId,
        uint8 instanceId,
        address[] memory players
    ) internal {
        // Clean up all players (both enrolling and active lists)
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _removePlayerActiveTournament(player, tierId, instanceId);
        }
    }

    // ============ Helper Functions ============

    /**
     * @dev Add player to enrolling tournament list
     */
    function _addPlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) private {
        if (playerEnrollingIndex[player][tierId][instanceId] != 0) return; // Already tracked

        playerEnrollingTournaments[player].push(TournamentRef(tierId, instanceId));
        playerEnrollingIndex[player][tierId][instanceId] = playerEnrollingTournaments[player].length;
    }

    /**
     * @dev Remove player from enrolling tournament list using swap-and-pop
     */
    function _removePlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) private {
        uint256 indexPlusOne = playerEnrollingIndex[player][tierId][instanceId];
        if (indexPlusOne == 0) return; // Not in list

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
     * @dev Add player to active tournament list
     */
    function _addPlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) private {
        if (playerActiveIndex[player][tierId][instanceId] != 0) return; // Already tracked

        playerActiveTournaments[player].push(TournamentRef(tierId, instanceId));
        playerActiveIndex[player][tierId][instanceId] = playerActiveTournaments[player].length;
    }

    /**
     * @dev Remove player from active tournament list using swap-and-pop
     */
    function _removePlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) private {
        uint256 indexPlusOne = playerActiveIndex[player][tierId][instanceId];
        if (indexPlusOne == 0) return; // Not in list

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
     * @dev Check if player has any active matches in specified tournament
     * Iterates player's active matches to find matches belonging to this tournament
     */
    function _playerHasActiveMatchInTournament(
        address player,
        uint8 tierId,
        uint8 instanceId
    ) private view returns (bool) {
        bytes32[] storage activeMatches = playerActiveMatches[player];

        // Check if player has any matches remaining in this tournament
        for (uint256 i = 0; i < activeMatches.length; i++) {
            bytes32 matchId = activeMatches[i];

            // Check all possible rounds and matches in this tournament
            ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];
            for (uint8 r = 0; r < config.totalRounds; r++) {
                ETourLib_Core.Round storage round = _etourStorage.rounds[tierId][instanceId][r];
                for (uint8 m = 0; m < round.totalMatches; m++) {
                    if (_getMatchId(tierId, instanceId, r, m) == matchId) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // ============ Player Activity View Functions ============

    /**
     * @dev Get all tournaments where player is enrolled but not yet started
     * Returns array of (tierId, instanceId) pairs
     */
    function getPlayerEnrollingTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerEnrollingTournaments[player];
    }

    /**
     * @dev Get all tournaments where player is actively competing
     * Returns array of (tierId, instanceId) pairs
     */
    function getPlayerActiveTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerActiveTournaments[player];
    }

    /**
     * @dev Get counts (gas-efficient for checking if player has any activity)
     */
    function getPlayerActivityCounts(address player) external view returns (
        uint256 enrollingCount,
        uint256 activeCount
    ) {
        return (
            playerEnrollingTournaments[player].length,
            playerActiveTournaments[player].length
        );
    }

    /**
     * @dev Check if player is in specific tournament (either enrolling or active)
     */
    function isPlayerInTournament(address player, uint8 tierId, uint8 instanceId)
        external view returns (bool isEnrolling, bool isActive)
    {
        isEnrolling = playerEnrollingIndex[player][tierId][instanceId] != 0;
        isActive = playerActiveIndex[player][tierId][instanceId] != 0;
    }

    /**
     * @dev Override to provide TicTacToe-specific game metadata
     * @return gameName Name of the game
     * @return gameVersion Version string
     * @return gameDescription Short description
     */
    function getGameMetadata() external pure returns (
        string memory gameName,
        string memory gameVersion,
        string memory gameDescription
    ) {
        return (
            "TicTacChain",
            "1.0.0",
            "Classic TicTacToe with tournament brackets and escalation mechanisms"
        );
    }
}
