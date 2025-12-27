// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour.sol";

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
contract ConnectFourOnChain is ETour {
    
    // ============ Game-Specific Constants ============
    
    uint8 public constant ROWS = 6;
    uint8 public constant COLS = 7;
    uint8 public constant TOTAL_CELLS = ROWS * COLS;  // 42 cells
    uint8 public constant CONNECT_COUNT = 4;  // Need 4 in a row to win
    
    uint8 public constant NO_COLUMN = 255;

    // Timeout configuration
    uint256 public constant DEFAULT_ENROLLMENT_WINDOW = 2 minutes;
    uint256 public constant DEFAULT_MATCH_MOVE_TIMEOUT = 1 minutes;
    uint256 public constant DEFAULT_ESCALATION_INTERVAL = 1 minutes;

    // ============ Game-Specific Enums ============

    enum Cell { Empty, Red, Yellow }

    // ============ Game-Specific Structs ============

    struct Match {
        address player1;
        address player2;
        address currentTurn;
        address winner;
        Cell[TOTAL_CELLS] board;  // 6 rows x 7 cols = 42 cells (row-major order)
        MatchStatus status;
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
        ETour.CommonMatchData common;     // Embedded common data
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
    uint16 public constant MATCH_CACHE_SIZE = 1000;
    CachedMatchData[MATCH_CACHE_SIZE] public matchCache;
    uint16 public nextCacheIndex;
    mapping(bytes32 => uint16) public cacheKeyToIndex;
    bytes32[MATCH_CACHE_SIZE] private cacheKeys;

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 column, uint8 row);
    event MatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);

    // ============ Constructor ============

    constructor() ETour() {
        // Register ConnectFourOnChain's tournament tiers
        _registerConnectFourTiers();
        
        // Pre-allocate all tournament instances, rounds, and matches
        _preallocateAllStructs();
    }

    /**
     * @dev Register all tournament tiers for ConnectFourOnChain
     */
    function _registerConnectFourTiers() internal {
        // 1 minute for all escalation windows
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 1 minutes,      // 60 seconds per player
            matchLevel2Delay: 1 minutes,        // L2 starts 1 min after timeout
            matchLevel3Delay: 2 minutes,        // L3 starts 2 min after timeout (cumulative)
            enrollmentWindow: 1 minutes,        // 1 min to fill tournament
            enrollmentLevel2Delay: 1 minutes    // L2 starts 1 min after L1
        });

        // ============ Tier 0: 2-Player (Entry Level) ============
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // 1st place: 100%
        tier0Prizes[1] = 0;    // 2nd place: 0%

        _registerTier(
            0,                              // tierId
            2,                              // playerCount
            12,                             // instanceCount
            0.002 ether,                    // entryFee
            Mode.Classic,                   // mode
            timeouts,                       // timeout configuration
            tier0Prizes                     // prizeDistribution
        );

        // ============ Tier 1: 4-Player ============
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 75;   // 1st place: 75%
        tier1Prizes[1] = 25;   // 2nd place: 25%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        _registerTier(
            1,                              // tierId
            4,                              // playerCount
            10,                             // instanceCount
            0.004 ether,                    // entryFee
            Mode.Classic,
            timeouts,
            tier1Prizes
        );

        // ============ Tier 2: 8-Player ============
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 60;   // 1st
        tier2Prizes[1] = 20;   // 2nd
        tier2Prizes[2] = 10;   // 3rd
        tier2Prizes[3] = 10;   // 4th
        tier2Prizes[4] = 0;    // 5th-8th
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        _registerTier(
            2,                              // tierId
            8,                              // playerCount
            8,                              // instanceCount
            0.008 ether,                    // entryFee
            Mode.Classic,
            timeouts,
            tier2Prizes
        );

        // ============ Tier 3: 16-Player ============
        uint8[] memory tier3Prizes = new uint8[](16);
        tier3Prizes[0] = 55;   // 1st
        tier3Prizes[1] = 15;   // 2nd
        tier3Prizes[2] = 10;   // 3rd
        tier3Prizes[3] = 10;   // 4th
        tier3Prizes[4] = 5;    // 5th
        tier3Prizes[5] = 5;    // 6th
        // 7th-16th: 0%
        for (uint8 i = 6; i < 16; i++) {
            tier3Prizes[i] = 0;
        }

        _registerTier(
            3,                              // tierId
            16,                             // playerCount
            6,                              // instanceCount
            0.01 ether,                     // entryFee
            Mode.Classic,
            timeouts,
            tier3Prizes
        );
    }

    // ============ Pre-allocation ============

    function _preallocateAllStructs() internal {
        for (uint8 tierId = 0; tierId < tierCount; tierId++) {
            TierConfig storage config = _tierConfigs[tierId];
            uint8 playerCount = config.playerCount;
            uint8 instanceCount = config.instanceCount;
            uint8 totalRounds = config.totalRounds;

            for (uint8 instanceId = 0; instanceId < instanceCount; instanceId++) {
                TournamentInstance storage tournament = tournaments[tierId][instanceId];
                tournament.tierId = tierId;
                tournament.instanceId = instanceId;
                tournament.status = TournamentStatus.Enrolling;
                tournament.mode = config.mode;
                tournament.currentRound = 0;
                tournament.enrolledCount = 0;
                tournament.prizePool = 0;
                tournament.startTime = 0;
                tournament.winner = address(0);
                tournament.coWinner = address(0);
                tournament.finalsWasDraw = false;
                tournament.allDrawResolution = false;
                tournament.allDrawRound = NO_ROUND;

                for (uint8 roundNum = 0; roundNum < totalRounds; roundNum++) {
                    uint8 matchCount = _getMatchCountForRoundInternal(playerCount, roundNum);

                    Round storage round = rounds[tierId][instanceId][roundNum];
                    round.totalMatches = matchCount;
                    round.completedMatches = 0;
                    round.initialized = false;
                    round.drawCount = 0;
                    round.allMatchesDrew = false;

                    for (uint8 matchNum = 0; matchNum < matchCount; matchNum++) {
                        bytes32 matchId = _getMatchId(tierId, instanceId, roundNum, matchNum);
                        Match storage matchData = matches[matchId];

                        matchData.player1 = address(0);
                        matchData.player2 = address(0);
                        matchData.currentTurn = address(0);
                        matchData.winner = address(0);
                        matchData.status = MatchStatus.NotStarted;
                        matchData.lastMoveTime = 0;
                        matchData.startTime = 0;
                        matchData.firstPlayer = address(0);
                        matchData.isDraw = false;
                        matchData.moveCount = 0;
                        matchData.lastColumn = NO_COLUMN;
                        matchData.player1TimeRemaining = 0;
                        matchData.player2TimeRemaining = 0;
                        matchData.lastMoveTimestamp = 0;

                        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
                            matchData.board[i] = Cell.Empty;
                        }
                    }
                }
            }
        }
    }

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
    ) internal override {
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

        matchData.status = MatchStatus.InProgress;
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
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;

        _addPlayerActiveMatch(player1, matchId);
        _addPlayerActiveMatch(player2, matchId);

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    function _resetMatchGame(bytes32 matchId) internal override {
        Match storage matchData = matches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = MatchStatus.NotStarted;
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

    function _getMatchResult(bytes32 matchId) internal view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal override {
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

    function _getMatchPlayers(bytes32 matchId) internal view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _getTimeIncrement() internal pure override returns (uint256) {
        return 0; // No increment per move
    }

    /**
     * @dev Check if the current player has run out of time
     * Used by escalation system to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) internal view override returns (bool) {
        Match storage matchData = matches[matchId];

        // If match is not in progress, return false
        if (matchData.status != MatchStatus.InProgress) {
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

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal override {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal override {
        Match storage matchData = matches[matchId];

        require(matchData.player1 != matchData.player2, "Cannot match player against themselves");

        matchData.status = MatchStatus.InProgress;
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
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal override {
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    function _isMatchActive(bytes32 matchId) internal view override returns (bool) {
        Match storage matchData = matches[matchId];
        // Active if player1 assigned and not completed
        return matchData.player1 != address(0) &&
               matchData.status != MatchStatus.Completed;
    }

    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal view override returns (ETour.CommonMatchData memory) {
        Match storage matchData = matches[matchId];

        // Derive loser
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = (matchData.winner == matchData.player1)
                ? matchData.player2
                : matchData.player1;
        }

        return ETour.CommonMatchData({
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
    ) internal view override returns (ETour.CommonMatchData memory data, bool exists) {
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
        data = ETour.CommonMatchData({
            player1: cached.player1,
            player2: cached.player2,
            winner: cached.winner,
            loser: loser,
            status: MatchStatus.Completed,
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

        require(matchData.status == MatchStatus.InProgress, "Match not active");
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

        _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
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

        require(matchData.status == MatchStatus.InProgress, "Match not in progress");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(column < COLS, "Invalid column");

        // Update time bank for current player
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;
        uint256 timeIncrement = _getTimeIncrement();

        if (msg.sender == matchData.player1) {
            // Deduct time used by player1
            if (timeElapsed >= matchData.player1TimeRemaining) {
                matchData.player1TimeRemaining = 0;
            } else {
                matchData.player1TimeRemaining -= timeElapsed;
                // Add increment after move
                matchData.player1TimeRemaining += timeIncrement;
            }
        } else {
            // Deduct time used by player2
            if (timeElapsed >= matchData.player2TimeRemaining) {
                matchData.player2TimeRemaining = 0;
            } else {
                matchData.player2TimeRemaining -= timeElapsed;
                // Add increment after move
                matchData.player2TimeRemaining += timeIncrement;
            }
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
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
            return;
        }

        // Check for draw (board full)
        if (matchData.moveCount == TOTAL_CELLS) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        // Switch turn
        matchData.currentTurn = (matchData.currentTurn == matchData.player1) 
            ? matchData.player2 
            : matchData.player1;
    }

    function _completeMatchInternal(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;

        // Add to match cache
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        // Update player stats
        playerStats[matchData.player1].matchesPlayed++;
        playerStats[matchData.player2].matchesPlayed++;

        if (!isDraw) {
            playerStats[winner].matchesWon++;
            _assignRankingOnElimination(tierId, instanceId, roundNumber,
                (winner == matchData.player1) ? matchData.player2 : matchData.player1);
        } else {
            // Both players are marked as eliminated with same round
            _assignRankingOnElimination(tierId, instanceId, roundNumber, matchData.player1);
            _assignRankingOnElimination(tierId, instanceId, roundNumber, matchData.player2);
        }

        // Remove from active matches
        _removePlayerActiveMatch(matchData.player1, matchId);
        _removePlayerActiveMatch(matchData.player2, matchId);

        emit MatchCompleted(matchId, winner, isDraw);

        // Handle tournament progression
        TierConfig storage config = _tierConfigs[tierId];
        if (!isDraw && roundNumber < config.totalRounds - 1) {
            _advanceWinner(tierId, instanceId, roundNumber, matchNumber, winner);
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (isDraw) {
            round.drawCount++;
        }
        round.completedMatches++;

        // Check if round is complete
        if (round.completedMatches == round.totalMatches) {
            // Check for all-draw scenario
            if (round.drawCount == round.totalMatches && round.totalMatches > 1) {
                round.allMatchesDrew = true;
                _handleAllDrawRound(tierId, instanceId, roundNumber);
            } else {
                if (_hasOrphanedWinners(tierId, instanceId, roundNumber)) {
                    _processOrphanedWinners(tierId, instanceId, roundNumber);
                }
                _completeRound(tierId, instanceId, roundNumber);
            }
        }
    }

    function _handleAllDrawRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) internal {
        address[] memory remainingPlayers = _getRemainingPlayers(tierId, instanceId, roundNumber);
        emit AllDrawRoundDetected(tierId, instanceId, roundNumber, uint8(remainingPlayers.length));
        _completeTournamentAllDraw(tierId, instanceId, roundNumber, remainingPlayers);
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
        ETour.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);

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
        ETour.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);
        if (common.status != ETour.MatchStatus.InProgress) {
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

    /**
     * @dev Override RW3 declaration for ConnectFourOnChain specifics
     */
    function declareRW3() public view override returns (string memory) {
        return string(abi.encodePacked(
            "=== RW3 COMPLIANCE DECLARATION ===\n\n",
            "PROJECT: ConnectFourOnChain (ETour Implementation)\n",
            "VERSION: 1.0 (Configuration-Driven)\n",
            "NETWORK: Arbitrum One\n",
            "VERIFIED: Block deployed\n\n",
            "RULE 1 - REAL UTILITY:\n",
            "Classic Connect Four tournament gaming with ETH stakes. Strategic column-drop competition.\n\n",
            "RULE 2 - FULLY ON-CHAIN:\n",
            "All game logic, gravity mechanics, tournament brackets, and prize distribution executed via smart contract.\n\n",
            "RULE 3 - SELF-SUSTAINING:\n",
            "Protocol fee structure covers operational costs. Contract functions autonomously without admin intervention.\n\n",
            "RULE 4 - FAIR DISTRIBUTION:\n",
            "No pre-mine, no insider allocations. All ETH in prize pools comes from player entry fees.\n\n",
            "RULE 5 - NO ALTCOINS:\n",
            "Uses only ETH for entry fees and prizes. No governance tokens, no protocol tokens.\n\n",
            "Generated: Block ",
            Strings.toString(block.number)
        ));
    }
}
