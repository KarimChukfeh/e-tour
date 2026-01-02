// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./libraries/ETourLib_Core.sol";
import "./libraries/ETourLib_Matches.sol";
import "./libraries/ETourLib_Prizes.sol";

/**
 * @title ConnectFourOnChain
 * @dev Classic Connect Four game implementing ETour tournament protocol
 * Strategic column-drop game where players compete to connect 4 pieces in a row.
 *
 * This contract demonstrates ETour implementation with:
 * 1. Custom tier configurations for various tournament sizes
 * 2. Full game logic for Connect Four mechanics
 * 3. Gravity-based piece dropping (pieces fall to lowest available position)
 * 4. Win detection for horizontal, vertical, and diagonal connections
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract ConnectFourOnChain is ReentrancyGuard {

    address public immutable owner;
    ETourLib_Core.ETourStorage internal _etourStorage;
    
    // ============ Game-Specific Constants ============
    
    uint8 public constant ROWS = 6;
    uint8 public constant COLS = 7;
    uint8 public constant TOTAL_CELLS = ROWS * COLS;  // 42 cells
    uint8 public constant CONNECT_COUNT = 4;  // Need 4 in a row to win
    
    uint8 public constant NO_COLUMN = 255;

    // ============ Game-Specific Enums ============

    enum Cell { Empty, Red, Yellow }

    // ============ Game-Specific Structs ============

    struct Match {
        address player1;
        address player2;
        address currentTurn;
        address winner;
        Cell[TOTAL_CELLS] board;  // 6 rows x 7 cols = 42 cells (row-major order)
        ETourLib_Core.MatchStatus status;
        uint256 lastMoveTime;
        uint256 startTime;
        address firstPlayer;
        bool isDraw;
        uint8 moveCount;
        uint8 lastColumn;  // Last column played
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
        Cell[TOTAL_CELLS] board;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isDraw;
        bool exists;
        uint8 moveCount;
    }

    /**
     * @dev Extended match data for ConnectFour including common fields and game-specific state
     */
    struct ConnectFourMatchData {
        ETourLib_Core.CommonMatchData common;     // Embedded common data
        Cell[TOTAL_CELLS] board;          // 6x7 board (42 cells)
        address currentTurn;
        address firstPlayer;
        uint8 moveCount;
        uint8 lastColumn;
        uint256 player1TimeRemaining;     // Time bank for player1
        uint256 player2TimeRemaining;     // Time bank for player2
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
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) private playerActiveIndex;

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 column, uint8 row);
    event MatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);
    event TimeoutVictoryClaimed(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, uint8 matchNumber, address claimer, address loser);
    event AllDrawRoundDetected(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, uint8 remainingPlayers);

    // ============ ETour Events ============

    event TierRegistered(uint8 indexed tierId, uint8 playerCount, uint8 instanceCount, uint256 entryFee);
    event TournamentInitialized(uint8 indexed tierId, uint8 indexed instanceId);
    event PlayerEnrolled(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint8 enrolledCount);
    event TournamentStarted(uint8 indexed tierId, uint8 indexed instanceId, uint8 playerCount);
    event RoundInitialized(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, uint8 matchCount);
    event MatchStarted(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, uint8 matchNumber, address player1, address player2);
    event MatchCompleted(bytes32 indexed matchId, address indexed winner, bool isDraw);
    event RoundCompleted(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber);
    event PlayerEliminated(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, address player);
    event PlayerAutoAdvancedWalkover(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, address player);
    event TournamentCompleted(uint8 indexed tierId, uint8 indexed instanceId, address indexed winner, uint256 prize, bool raffleTriggered, address raffleWinner);
    event PrizeDistributed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint8 rank, uint256 amount);
    event OwnerFeePaid(address indexed owner, uint256 amount);
    event ProtocolFeePaid(address indexed protocol, uint256 amount);
    event UnclaimedPrizeReclaimed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount);
    event PrizeClaimed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount);
    event PrizeClaimFailed(uint8 indexed tierId, uint8 indexed instanceId, address indexed player, uint256 amount);
    event ProtocolRaffleTriggered(uint8 indexed tierId, uint8 indexed instanceId, uint256 poolAmount, address indexed winner, uint256 prizeAmount);
    event RaffleThresholdsRegistered(uint8 indexed tierId);
    event EnrollmentPoolAbandoned(uint8 indexed tierId, uint8 indexed instanceId, uint256 poolAmount, uint256 reclaimTime);
    event AbandonedPoolClaimed(uint8 indexed tierId, uint8 indexed instanceId, address indexed claimer, uint256 amount);
    event TournamentForceStarted(uint8 indexed tierId, uint8 indexed instanceId, address indexed initiator, uint8 enrolledCount);
    event MatchTimeoutDetected(bytes32 indexed matchId, address indexed currentPlayer, uint256 timeoutAt);
    event MatchEscalationLevel2(bytes32 indexed matchId, address indexed advancedPlayer, uint256 escalationTime);
    event PlayerReplacedByExternal(uint8 indexed tierId, uint8 indexed instanceId, uint8 indexed roundNumber, uint8 matchNumber, address oldPlayer, address newPlayer);
    event ExternalPlayerForfeit(bytes32 indexed matchId, address indexed externalPlayer, address indexed opponent);
    event MatchEscalationLevel3(bytes32 indexed matchId, address indexed stalledPlayer, uint256 escalationTime);
    event TournamentReset(uint8 indexed tierId, uint8 indexed instanceId, uint8 oldEnrolledCount);

    // ============ Constructor ============

    constructor() {
        owner = msg.sender;
        _registerConnectFourTiers();
    }

    /**
     * @dev Register all tournament tiers for ConnectFourOnChain
     */
    function _registerConnectFourTiers() internal {
        // ============ Tier 0: 2-Player (Entry Level) ============
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // 1st place: 100%
        tier0Prizes[1] = 0;    // 2nd place: 0%

        // 5 minutes per player with 15-second Fischer increment
        ETourLib_Core.TimeoutConfig memory timeouts0 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 5 minutes,        // 5 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });


        ETourLib_Core.registerTier(
            _etourStorage,
            0,                              // tierId
            2,                              // playerCount
            100,                             // instanceCount
            0.002 ether,                    // entryFee
            ETourLib_Core.Mode.Classic,     // mode
            timeouts0,                       // timeout configuration
            tier0Prizes                     // prizeDistribution
        );
        emit TierRegistered(0, 2, 100, 0.002 ether);

        // ============ Tier 1: 4-Player ============
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 75;   // 1st place: 75%
        tier1Prizes[1] = 25;   // 2nd place: 25%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        ETourLib_Core.TimeoutConfig memory timeouts1 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            1,                              // tierId
            4,                              // playerCount
            50,                             // instanceCount
            0.004 ether,                    // entryFee
            ETourLib_Core.Mode.Classic,
            timeouts1,
            tier1Prizes
        );
        emit TierRegistered(1, 4, 50, 0.004 ether);

        // ============ Tier 2: 8-Player ============
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 80;   // 1st
        tier2Prizes[1] = 20;   // 2nd
        tier2Prizes[2] = 0;   // 3rd
        tier2Prizes[3] = 0;   // 4th
        tier2Prizes[4] = 0;    // 5th-8th
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        ETourLib_Core.TimeoutConfig memory timeouts2 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 15 minutes,       // 15 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            2,                              // tierId
            8,                              // playerCount
            30,                              // instanceCount
            0.008 ether,                    // entryFee
            ETourLib_Core.Mode.Classic,
            timeouts2,
            tier2Prizes
        );
        emit TierRegistered(2, 8, 30, 0.008 ether);

        // ============ Tier 3: 16-Player ============
        uint8[] memory tier3Prizes = new uint8[](16);
        tier3Prizes[0] = 75;   // 1st
        tier3Prizes[1] = 25;   // 2nd
        tier3Prizes[2] = 0;   // 3rd
        tier3Prizes[3] = 0;   // 4th
        tier3Prizes[4] = 0;    // 5th
        tier3Prizes[5] = 0;    // 6th
        // 7th-16th: 0%
        for (uint8 i = 6; i < 16; i++) {
            tier3Prizes[i] = 0;
        }

        ETourLib_Core.TimeoutConfig memory timeouts3 = ETourLib_Core.TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 20 minutes,       // 20 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        ETourLib_Core.registerTier(
            _etourStorage,
            3,                              // tierId
            16,                             // playerCount
            20,                              // instanceCount
            0.01 ether,                     // entryFee
            ETourLib_Core.Mode.Classic,
            timeouts3,
            tier3Prizes
        );
        emit TierRegistered(3, 16, 20, 0.01 ether);

        // ============ Configure Raffle Thresholds ============
        // Progressive thresholds: 0.2, 0.4, 0.6, 0.8, 1.0 ETH for first 5 raffles
        // Then 1.0 ETH for all subsequent raffles
        uint256[] memory thresholds = new uint256[](5);
        thresholds[0] = 0.2 ether;
        thresholds[1] = 0.4 ether;
        thresholds[2] = 0.6 ether;
        thresholds[3] = 0.8 ether;
        thresholds[4] = 1.0 ether;

        ETourLib_Core.registerRaffleThresholds(_etourStorage, thresholds, 1.0 ether);
        emit RaffleThresholdsRegistered(0);  // tierId not specific to raffle
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

        // Create matches
        for (uint8 i = 0; i < matchCount; i++) {
            address p1 = playerPairs[i * 2];
            address p2 = playerPairs[i * 2 + 1];
            _createMatchGame(tierId, instanceId, roundNumber, i, p1, p2);
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

    function _removePlayerActiveMatch(address player, bytes32 matchId) internal {
        // Remove active match from player tracking (game-specific implementation)
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
            endTime: 0,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
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

        if (result.roundCompleted) {
            _completeRound(tierId, instanceId, roundNumber);
        }
    }

    function _completeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        ETourLib_Matches.RoundCompletionResult memory result =
            ETourLib_Matches.completeRoundLogic(_etourStorage, tierId, instanceId, roundNumber);

        emit RoundCompleted(tierId, instanceId, roundNumber);

        if (result.shouldDistributePrizes) {
            _distributePrizes(tierId, instanceId);
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

    // ============ Internal Helper Functions ============

    function _getMatchCountForRoundInternal(uint8 playerCount, uint8 roundNumber) internal pure returns (uint8) {
        if (roundNumber == 0) {
            return playerCount / 2;
        } else {
            uint8 playersInRound = playerCount;
            for (uint8 i = 0; i < roundNumber; i++) {
                playersInRound = playersInRound / 2;
            }
            return playersInRound / 2;
        }
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

        matchData.status = ETourLib_Core.MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.lastMoveTime = block.timestamp;
        matchData.winner = address(0);
        matchData.isDraw = false;
        matchData.moveCount = 0;
        matchData.lastColumn = NO_COLUMN;

        // Initialize empty board
        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
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
        matchData.moveCount = 0;
        matchData.lastColumn = NO_COLUMN;

        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
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

        bytes32 oldKey = cacheKeys[cacheIndex];
        if (oldKey != bytes32(0)) {
            delete cacheKeyToIndex[oldKey];
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
            exists: true,
            moveCount: matchData.moveCount
        });

        cacheKeys[cacheIndex] = matchKey;
        cacheKeyToIndex[matchKey] = cacheIndex;

        nextCacheIndex = uint16((cacheIndex + 1) % MATCH_CACHE_SIZE);

        emit MatchCached(matchKey, cacheIndex, matchData.player1, matchData.player2);
    }

    function _getMatchPlayers(bytes32 matchId) internal view returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _getTimeIncrement() internal view returns (uint256) {
        // Note: This function is called during match, so we get config from the match's tier
        // In practice, all tiers in ConnectFourOnChain use 15 seconds
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
        matchData.moveCount = 0;
        matchData.lastColumn = NO_COLUMN;

        // Random starting player
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            matchData.player1,
            matchData.player2,
            matchId
        )));
        matchData.firstPlayer = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.currentTurn = matchData.firstPlayer;

        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
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
        // Get player addresses from matchId
        (address player1, address player2) = _getMatchPlayers(matchId);

        // Check if players exist
        if (player1 == address(0) && player2 == address(0)) {
            return (data, false);
        }

        // Compute cache key
        bytes32 matchKey = keccak256(abi.encodePacked(player1, player2));
        uint16 index = cacheKeyToIndex[matchKey];

        // Verify cache entry exists
        if (!matchCache[index].exists || cacheKeys[index] != matchKey) {
            return (data, false);
        }

        CachedMatchData storage cached = matchCache[index];

        // CRITICAL: Verify context matches (players may have played multiple times)
        if (cached.tierId != tierId ||
            cached.instanceId != instanceId ||
            cached.roundNumber != roundNumber ||
            cached.matchNumber != matchNumber) {
            return (data, false);
        }

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

    // ============ Player Actions ============

    /**
     * @dev Make a move by dropping a piece in a column
     * Pieces fall to the lowest available row in that column
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 column
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == ETourLib_Core.MatchStatus.InProgress, "Match not in progress");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(column < COLS, "Invalid column");

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

        // Find the lowest available row in this column
        uint8 targetRow = ROWS; // Start with invalid row
        for (uint8 row = ROWS; row > 0; row--) {
            uint8 checkCell = _getCellIndex(row - 1, column);
            if (matchData.board[checkCell] == Cell.Empty) {
                targetRow = row - 1;
                break;
            }
        }

        require(targetRow < ROWS, "Column is full");

        // Determine piece color based on player
        Cell piece = (msg.sender == matchData.player1) ? Cell.Red : Cell.Yellow;

        // Place the piece
        uint8 cellIndex = _getCellIndex(targetRow, column);
        matchData.board[cellIndex] = piece;
        matchData.moveCount++;
        matchData.lastColumn = column;
        matchData.lastMoveTime = block.timestamp;
        matchData.lastMoveTimestamp = block.timestamp;

        emit MoveMade(matchId, msg.sender, column, targetRow);

        // Check for win
        if (_checkWin(matchData.board, piece, targetRow, column)) {
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
            return;
        }

        // Check for draw (board full)
        if (matchData.moveCount == TOTAL_CELLS) {
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        // Switch turn
        matchData.currentTurn = (matchData.currentTurn == matchData.player1) 
            ? matchData.player2 
            : matchData.player1;
    }

    // ============ Game Logic ============

    /**
     * @dev Convert row and column to cell index (row-major order)
     */
    function _getCellIndex(uint8 row, uint8 col) internal pure returns (uint8) {
        return row * COLS + col;
    }

    /**
     * @dev Check if the last move created a win (4 in a row)
     * Only checks lines passing through the last placed piece for efficiency
     */
    function _checkWin(
        Cell[TOTAL_CELLS] memory board,
        Cell piece,
        uint8 row,
        uint8 col
    ) internal pure returns (bool) {
        // Check horizontal
        if (_checkLine(board, piece, row, col, 0, 1)) return true;
        
        // Check vertical
        if (_checkLine(board, piece, row, col, 1, 0)) return true;
        
        // Check diagonal (top-left to bottom-right)
        if (_checkLine(board, piece, row, col, 1, 1)) return true;
        
        // Check anti-diagonal (top-right to bottom-left)
        if (_checkLine(board, piece, row, col, 1, -1)) return true;
        
        return false;
    }

    /**
     * @dev Check if there are 4 in a row along a specific direction
     * Starting from the given position, check in both directions
     */
    function _checkLine(
        Cell[TOTAL_CELLS] memory board,
        Cell piece,
        uint8 row,
        uint8 col,
        int8 dRow,
        int8 dCol
    ) internal pure returns (bool) {
        uint8 count = 1; // Count the placed piece itself
        
        // Check in positive direction
        int8 r = int8(row) + dRow;
        int8 c = int8(col) + dCol;
        while (_isValidPosition(r, c) && board[_getCellIndex(uint8(r), uint8(c))] == piece) {
            count++;
            if (count >= CONNECT_COUNT) return true;
            r += dRow;
            c += dCol;
        }
        
        // Check in negative direction
        r = int8(row) - dRow;
        c = int8(col) - dCol;
        while (_isValidPosition(r, c) && board[_getCellIndex(uint8(r), uint8(c))] == piece) {
            count++;
            if (count >= CONNECT_COUNT) return true;
            r -= dRow;
            c -= dCol;
        }
        
        return false;
    }

    /**
     * @dev Check if a position is within the board bounds
     */
    function _isValidPosition(int8 row, int8 col) internal pure returns (bool) {
        return row >= 0 && row < int8(ROWS) && col >= 0 && col < int8(COLS);
    }

    // ============ View Functions ============

    /**
     * @dev Get complete ConnectFour match data with automatic cache fallback
     * Replaces legacy tuple return with structured data
     * BREAKING CHANGE: Returns struct instead of tuple
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (ConnectFourMatchData memory) {
        // Call base to get common data with cache fallback
        ETourLib_Core.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);

        ConnectFourMatchData memory fullData;
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
            fullData.moveCount = cached.moveCount;
            fullData.lastColumn = 0;
            fullData.player1TimeRemaining = 0;  // N/A for completed matches
            fullData.player2TimeRemaining = 0;
            fullData.lastMoveTimestamp = 0;
        } else {
            // Populate from active storage
            Match storage matchData = matches[matchId];
            fullData.board = matchData.board;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.moveCount = matchData.moveCount;
            fullData.lastColumn = matchData.lastColumn;
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

    /**
     * @dev Check if a column has space for another piece
     */
    function isColumnAvailable(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 column
    ) external view returns (bool) {
        require(column < COLS, "Invalid column");
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        
        // Check top row of the column
        uint8 topCellIndex = _getCellIndex(0, column);
        return matchData.board[topCellIndex] == Cell.Empty;
    }

    // ============ Player Activity Tracking Implementation ============

    /**
     * @dev Hook called when player enrolls in tournament
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook called when tournament starts
     * Atomically moves ALL enrolled players from enrolling → active
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal {
        address[] storage players = _etourStorage.enrolledPlayers[tierId][instanceId];

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _addPlayerActiveTournament(player, tierId, instanceId);
        }
    }

    /**
     * @dev Hook called when player is eliminated from tournament
     * Only removes from active list if player has no remaining active matches
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
     * @dev Hook called when external player joins via L3 replacement
     * Adds directly to active list (skips enrolling)
     */
    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal {
        _addPlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook called when tournament completes
     * Cleans up all player tracking for this tournament
     */
    function _onTournamentCompleted(
        uint8 tierId,
        uint8 instanceId,
        address[] memory players
    ) internal {
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _removePlayerActiveTournament(player, tierId, instanceId);
        }
    }

    // ============ Helper Functions ============

    function _addPlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) private {
        if (playerEnrollingIndex[player][tierId][instanceId] != 0) return;

        playerEnrollingTournaments[player].push(TournamentRef(tierId, instanceId));
        playerEnrollingIndex[player][tierId][instanceId] = playerEnrollingTournaments[player].length;
    }

    function _removePlayerEnrollingTournament(address player, uint8 tierId, uint8 instanceId) private {
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

    function _addPlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) private {
        if (playerActiveIndex[player][tierId][instanceId] != 0) return;

        playerActiveTournaments[player].push(TournamentRef(tierId, instanceId));
        playerActiveIndex[player][tierId][instanceId] = playerActiveTournaments[player].length;
    }

    function _removePlayerActiveTournament(address player, uint8 tierId, uint8 instanceId) private {
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

    function _playerHasActiveMatchInTournament(
        address player,
        uint8 tierId,
        uint8 instanceId
    ) private view returns (bool) {
        bytes32[] storage matches = _etourStorage.playerActiveMatches[player];

        ETourLib_Core.TierConfig storage config = _etourStorage.tierConfigs[tierId];
        for (uint8 r = 0; r < config.totalRounds; r++) {
            ETourLib_Core.Round storage round = _etourStorage.rounds[tierId][instanceId][r];
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);

                for (uint256 i = 0; i < matches.length; i++) {
                    if (matches[i] == matchId) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // ============ View Functions ============

    /**
     * @dev Get all tournaments where player is enrolled but not yet started
     */
    function getPlayerEnrollingTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerEnrollingTournaments[player];
    }

    /**
     * @dev Get all tournaments where player is actively competing
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
     * @dev Override to provide ConnectFour-specific game metadata
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
            "ConnectFourOnChain",
            "1.0.0",
            "On-chain Connect Four with tournament brackets and prize distribution"
        );
    }
}
