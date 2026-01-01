// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour.sol";

/**
 * @title TicTacChain
 * @dev Classic Tic-Tac-Toe game implementing ETour tournament protocol
 * Simple, solved game used as the lowest-barrier demonstration of the ETour protocol.
 * 
 * This contract demonstrates how to implement ETour by:
 * 1. Registering custom tier configurations in the constructor
 * 2. Implementing all abstract game functions
 * 3. Providing game-specific logic (board state, win detection, etc.)
 * 
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacChain is ETour {
    
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
        MatchStatus status;
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
        ETour.CommonMatchData common;     // Embedded common data
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
    uint16 public constant MATCH_CACHE_SIZE = 1000;
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
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) private playerActiveIndex;

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
    event MatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);

    // ============ Constructor ============

    constructor() ETour() {
        // Register TicTacChain's tournament tiers
        _registerTicTacChainTiers();
        
        // Pre-allocate all tournament instances, rounds, and matches
        _preallocateAllStructs();
    }

    /**
     * @dev Register all tournament tiers for TicTacChain
     * This is where TicTacChain defines its specific tournament structure.
     * Other games implementing ETour would define their own tiers here.
     */
    function _registerTicTacChainTiers() internal {
        // ============ Tier 0: 2-Player Classic (Entry Level) ============
        // Simple head-to-head, winner takes all
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // 1st place: 100%
        tier0Prizes[1] = 0;    // 2nd place: 0%

        TimeoutConfig memory timeouts0 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 5 minutes,        // 5 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        _registerTier(
            0,                              // tierId
            2,                              // playerCount
            100,                            // instanceCount
            0.001 ether,                    // entryFee
            Mode.Classic,                   // mode (no blocking)
            timeouts0,                      // timeout configuration
            tier0Prizes                     // prizeDistribution
        );

        // ============ Tier 1: 4-Player Classic ============
        // Semi-final + Final bracket, winner takes majority
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 70;   // 1st place: 70%
        tier1Prizes[1] = 30;   // 2nd place: 30%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        TimeoutConfig memory timeouts1 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        _registerTier(
            1,                              // tierId
            4,                              // playerCount
            40,                             // instanceCount
            0.002 ether,                    // entryFee
            Mode.Classic,
            timeouts1,
            tier1Prizes
        );

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

        TimeoutConfig memory timeouts2 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 15 minutes,       // 15 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        _registerTier(
            2,                              // tierId
            8,                              // playerCount
            20,                             // instanceCount
            0.004 ether,                    // entryFee
            Mode.Classic,
            timeouts2,
            tier2Prizes
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
                tournament.mode = (tierId == 0) ? Mode.Classic : Mode.Classic;
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
                        matchData.player1TimeRemaining = 0;
                        matchData.player2TimeRemaining = 0;
                        matchData.lastMoveTimestamp = 0;

                        for (uint8 i = 0; i < 9; i++) {
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
        matchData.status = MatchStatus.InProgress;
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

        for (uint8 i = 0; i < 9; i++) {
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

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player in this match");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(cellIndex < 9, "Invalid cell index");
        require(matchData.board[cellIndex] == Cell.Empty, "Cell already occupied");

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
        ETour.CommonMatchData memory common = _getMatchCommon(tierId, instanceId, roundNumber, matchNumber);

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
     * @dev Override RW3 declaration for TicTacChain specifics
     */
    function declareRW3() public view override returns (string memory) {
        return string(abi.encodePacked(
            "=== RW3 COMPLIANCE DECLARATION ===\n\n",
            "PROJECT: TicTacChain (ETour Implementation)\n",
            "VERSION: 2.0 (Configuration-Driven)\n",
            "NETWORK: Arbitrum One\n",
            "VERIFIED: Block deployed\n\n",
            "RULE 1 - REAL UTILITY:\n",
            "Classic Tic-Tac-Toe tournament gaming with ETH stakes. Lowest barrier demonstration of ETour protocol.\n\n",
            "RULE 2 - FULLY ON-CHAIN:\n",
            "All game logic, tournament mechanics, and prize distribution executed via smart contract. No backend servers.\n\n",
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

    // ============ Player Activity Tracking Implementation ============

    /**
     * @dev Hook override: Called when player enrolls in tournament
     * Adds player to enrolling list for activity tracking
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal override {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook override: Called when tournament starts (status -> InProgress)
     * Moves ALL enrolled players from enrolling to active list atomically
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal override {
        address[] storage players = enrolledPlayers[tierId][instanceId];

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
    ) internal override {
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
    ) internal override {
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
    ) internal override {
        // Clean up all players (both enrolling and active lists)
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _removePlayerActiveTournament(player, tierId, instanceId);
        }
    }

    // ============ Raffle Configuration Overrides ============

    /**
     * @dev Progressive raffle thresholds for TicTacChain
     * Raffle 1-5: Increases by 0.2 ETH each raffle (0.2, 0.4, 0.6, 0.8, 1.0)
     * Raffle 6+: Caps at 1.0 ETH
     * Reserve is automatically calculated by ETour base (10% of threshold):
     *   - Raffle 1 (0.2 ETH): 0.02 ETH reserve (10%)
     *   - Raffle 2 (0.4 ETH): 0.04 ETH reserve (10%)
     *   - Raffle 3 (0.6 ETH): 0.06 ETH reserve (10%)
     *   - Raffle 4 (0.8 ETH): 0.08 ETH reserve (10%)
     *   - Raffle 5+ (1.0 ETH): 0.1 ETH reserve (10%)
     */
    function _getRaffleThreshold() internal view override returns (uint256) {
        uint256 nextRaffleIndex = currentRaffleIndex + 1;  // Next raffle to execute

        if (nextRaffleIndex >= 5) {
            return 1.0 ether;  // Cap at 1.0 ETH after raffle 5
        }

        // Progressive: 0.2, 0.4, 0.6, 0.8, 1.0
        return nextRaffleIndex * 0.2 ether;
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
            TierConfig storage config = _tierConfigs[tierId];
            for (uint8 r = 0; r < config.totalRounds; r++) {
                Round storage round = rounds[tierId][instanceId][r];
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
}
