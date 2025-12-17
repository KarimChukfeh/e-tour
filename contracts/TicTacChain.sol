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
    
    uint8 public constant NO_CELL = 255;

    // Timeout configuration (can be adjusted per deployment)
    uint256 public constant DEMO_ENROLLMENT_WINDOW = 2 minutes;
    uint256 public constant DEFAULT_ENROLLMENT_WINDOW = 30 minutes;
    uint256 public constant DEMO_MATCH_MOVE_TIMEOUT = 1 minutes;
    uint256 public constant DEFAULT_MATCH_MOVE_TIMEOUT = 1 minutes;
    uint256 public constant DEMO_ESCALATION_INTERVAL = 1 minutes;
    uint256 public constant DEFAULT_ESCALATION_INTERVAL = 1 minutes;

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
        // Legacy block mechanic fields (kept for ABI compatibility, but unused in classic mode)
        uint8 lastMovedCell;
        address blockedPlayer;
        uint8 blockedCell;
        bool player1UsedBlock;
        bool player2UsedBlock;
        // Timeout Fields
        MatchTimeoutState timeoutState;
        bool isTimedOut;
        address timeoutClaimant;
        uint256 timeoutClaimReward;
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
        bool player1UsedBlock;
        bool player2UsedBlock;
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

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
    event MoveBlocked(bytes32 indexed matchId, address indexed blocker, uint8 blockedCell, address blockedPlayer);
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
        
        _registerTier(
            0,                              // tierId
            2,                              // playerCount
            64,                             // instanceCount
            0.001 ether,                    // entryFee
            Mode.Classic,                   // mode (no blocking)
            DEMO_ENROLLMENT_WINDOW,      // enrollmentWindow
            DEMO_MATCH_MOVE_TIMEOUT,     // matchMoveTimeout
            DEMO_ESCALATION_INTERVAL,    // escalationInterval
            tier0Prizes                     // prizeDistribution
        );

        // ============ Tier 1: 4-Player Classic ============
        // Semi-final + Final bracket, winner takes majority
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 60;   // 1st place: 60%
        tier1Prizes[1] = 30;   // 2nd place: 30%
        tier1Prizes[2] = 10;   // 3rd place: 10%
        tier1Prizes[3] = 0;    // 4th place: 0%

        _registerTier(
            1,                              // tierId
            4,                              // playerCount
            10,                             // instanceCount
            0.002 ether,                    // entryFee
            Mode.Classic,
            DEMO_ENROLLMENT_WINDOW,
            DEMO_MATCH_MOVE_TIMEOUT,
            DEMO_ESCALATION_INTERVAL,
            tier1Prizes
        );

        // ============ Tier 2: 8-Player Classic ============
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 50;   // 1st
        tier2Prizes[1] = 25;   // 2nd
        tier2Prizes[2] = 15;   // 3rd
        tier2Prizes[3] = 10;   // 4th
        tier2Prizes[4] = 0;    // 5th-8th
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        _registerTier(
            2,                              // tierId
            8,                              // playerCount
            16,                             // instanceCount
            0.004 ether,                    // entryFee
            Mode.Classic,
            DEMO_ENROLLMENT_WINDOW,
            DEMO_MATCH_MOVE_TIMEOUT,
            DEMO_ESCALATION_INTERVAL,
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
                        matchData.lastMovedCell = NO_CELL;
                        matchData.blockedPlayer = address(0);
                        matchData.blockedCell = NO_CELL;
                        matchData.player1UsedBlock = false;
                        matchData.player2UsedBlock = false;

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

        matchData.lastMovedCell = NO_CELL;
        matchData.blockedPlayer = address(0);
        matchData.blockedCell = NO_CELL;
        matchData.player1UsedBlock = false;
        matchData.player2UsedBlock = false;

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

        _addPlayerActiveMatch(player1, matchId);
        _addPlayerActiveMatch(player2, matchId);

        _initializeMatchTimeoutState(matchId, tierId);

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
        matchData.lastMovedCell = NO_CELL;
        matchData.blockedPlayer = address(0);
        matchData.blockedCell = NO_CELL;
        matchData.player1UsedBlock = false;
        matchData.player2UsedBlock = false;

        matchData.isTimedOut = false;
        matchData.timeoutClaimant = address(0);
        matchData.timeoutClaimReward = 0;
        matchData.timeoutState.escalation1Start = 0;
        matchData.timeoutState.escalation2Start = 0;
        matchData.timeoutState.escalation3Start = 0;
        matchData.timeoutState.activeEscalation = EscalationLevel.None;
        matchData.timeoutState.timeoutActive = false;
        matchData.timeoutState.forfeitAmount = 0;

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
            player1UsedBlock: matchData.player1UsedBlock,
            player2UsedBlock: matchData.player2UsedBlock
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

    function _setMatchTimeoutState(bytes32 matchId, MatchTimeoutState memory state) internal override {
        Match storage matchData = matches[matchId];
        matchData.timeoutState = state;
    }

    function _getMatchTimeoutState(bytes32 matchId) internal view override returns (MatchTimeoutState memory) {
        return matches[matchId].timeoutState;
    }

    function _setMatchTimedOut(bytes32 matchId, address claimant, EscalationLevel level) internal override {
        Match storage matchData = matches[matchId];
        matchData.isTimedOut = true;
        matchData.timeoutClaimant = claimant;
        matchData.timeoutState.activeEscalation = level;
        matchData.timeoutState.timeoutActive = true;
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

        matchData.lastMovedCell = NO_CELL;
        matchData.blockedPlayer = address(0);
        matchData.blockedCell = NO_CELL;
        matchData.player1UsedBlock = false;
        matchData.player2UsedBlock = false;

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

        _initializeMatchTimeoutState(matchId, tierId);
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal override {
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
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

        // Legacy block check (kept for ABI compatibility)
        require(
            matchData.blockedPlayer != msg.sender || matchData.blockedCell != cellIndex,
            "Cell is blocked for you this turn"
        );

        if (matchData.blockedPlayer == msg.sender) {
            matchData.blockedPlayer = address(0);
            matchData.blockedCell = NO_CELL;
        }

        matchData.board[cellIndex] = (msg.sender == matchData.player1) ? Cell.X : Cell.O;
        matchData.lastMoveTime = block.timestamp;
        matchData.lastMovedCell = cellIndex;

        _initializeMatchTimeoutState(matchId, tierId);

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

    function _initializeMatchTimeoutState(bytes32 matchId, uint8 tierId) internal {
        Match storage matchData = matches[matchId];
        uint256 baseTime = matchData.lastMoveTime;

        // Use tier-specific timeout configuration
        TierConfig storage config = _tierConfigs[tierId];
        
        matchData.timeoutState.escalation1Start = baseTime + config.matchMoveTimeout;
        matchData.timeoutState.escalation2Start = matchData.timeoutState.escalation1Start + config.escalationInterval;
        matchData.timeoutState.escalation3Start = matchData.timeoutState.escalation2Start + config.escalationInterval;

        matchData.timeoutState.activeEscalation = EscalationLevel.None;
        matchData.timeoutState.timeoutActive = false;
        matchData.timeoutState.forfeitAmount = config.entryFee;
    }

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
        require(block.timestamp >= matchData.timeoutState.escalation1Start, "Tier 1 timeout not reached");

        matchData.isTimedOut = true;
        matchData.timeoutClaimant = msg.sender;
        matchData.timeoutState.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        matchData.timeoutState.timeoutActive = true;

        address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;

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

    function _hasWinningMove(Cell[9] memory board, Cell playerCell) internal pure returns (bool) {
        for (uint8 i = 0; i < 9; i++) {
            if (board[i] == Cell.Empty) {
                board[i] = playerCell;
                if (_checkWin(board)) {
                    board[i] = Cell.Empty;
                    return true;
                }
                board[i] = Cell.Empty;
            }
        }
        return false;
    }

    // ============ View Functions ============

    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (
        address player1,
        address player2,
        address currentTurn,
        address winner,
        Cell[9] memory board,
        MatchStatus status,
        bool isDraw,
        uint256 startTime,
        uint256 lastMoveTime,
        address firstPlayer,
        uint8 lastMovedCell,
        address blockedPlayer,
        uint8 blockedCell,
        bool player1UsedBlock,
        bool player2UsedBlock
    ) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        return (
            matchData.player1,
            matchData.player2,
            matchData.currentTurn,
            matchData.winner,
            matchData.board,
            matchData.status,
            matchData.isDraw,
            matchData.startTime,
            matchData.lastMoveTime,
            matchData.firstPlayer,
            matchData.lastMovedCell,
            matchData.blockedPlayer,
            matchData.blockedCell,
            matchData.player1UsedBlock,
            matchData.player2UsedBlock
        );
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
}
