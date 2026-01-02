// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ConnectFourOnChain
 * @dev Classic Connect Four game implementing ETour tournament protocol (MODULAR VERSION)
 * Strategic column-drop game where players compete to connect 4 pieces in a row.
 *
 * This contract demonstrates ETour implementation with:
 * 1. Custom tier configurations for various tournament sizes
 * 2. Full game logic for Connect Four mechanics
 * 3. Gravity-based piece dropping (pieces fall to lowest available position)
 * 4. Win detection for horizontal, vertical, and diagonal connections
 *
 * MODULAR ARCHITECTURE:
 * - Inherits ETour_Storage for storage layout
 * - Delegates tournament logic to 5 stateless modules via delegatecall
 * - Modules: Core, Matches, Prizes, Raffle, Escalation
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract ConnectFourOnChain is ETour_Storage {
    
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
        CommonMatchData common;           // Embedded common data
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

    // ============ Constructor ============

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress
    ) {
        // Register ConnectFourOnChain's tournament tiers
        _registerConnectFourTiers();

        // Pre-allocate all tournament instances, rounds, and matches
        _preallocateAllStructs();
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
        TimeoutConfig memory timeouts0 = TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 5 minutes,        // 5 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        (bool success0, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                0,                    // tierId
                2,                    // playerCount
                100,                  // instanceCount
                0.002 ether,          // entryFee
                Mode.Classic,         // mode
                timeouts0,            // timeout configuration
                tier0Prizes           // prizeDistribution
            )
        );
        require(success0, "Tier 0 registration failed");

        // ============ Tier 1: 4-Player ============
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 75;   // 1st place: 75%
        tier1Prizes[1] = 25;   // 2nd place: 25%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        TimeoutConfig memory timeouts1 = TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        (bool success1, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                1,                    // tierId
                4,                    // playerCount
                50,                   // instanceCount
                0.004 ether,          // entryFee
                Mode.Classic,
                timeouts1,
                tier1Prizes
            )
        );
        require(success1, "Tier 1 registration failed");

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

        TimeoutConfig memory timeouts2 = TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 15 minutes,       // 15 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        (bool success2, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                2,                    // tierId
                8,                    // playerCount
                30,                   // instanceCount
                0.008 ether,          // entryFee
                Mode.Classic,
                timeouts2,
                tier2Prizes
            )
        );
        require(success2, "Tier 2 registration failed");

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

        TimeoutConfig memory timeouts3 = TimeoutConfig({
            matchTimePerPlayer: 5 minutes,      // 300 seconds per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (2 min after L2)
            enrollmentWindow: 20 minutes,       // 20 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after L1
        });

        (bool success3, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                3,                    // tierId
                16,                   // playerCount
                20,                   // instanceCount
                0.01 ether,           // entryFee
                Mode.Classic,
                timeouts3,
                tier3Prizes
            )
        );
        require(success3, "Tier 3 registration failed");

        // ============ Configure Raffle Thresholds ============
        // Progressive thresholds: 0.2, 0.4, 0.6, 0.8, 1.0 ETH for first 5 raffles
        // Then 1.0 ETH for all subsequent raffles
        uint256[] memory thresholds = new uint256[](5);
        thresholds[0] = 0.2 ether;
        thresholds[1] = 0.4 ether;
        thresholds[2] = 0.6 ether;
        thresholds[3] = 0.8 ether;
        thresholds[4] = 1.0 ether;

        (bool successRaffle, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("registerRaffleThresholds(uint256[],uint256)", thresholds, 1.0 ether)
        );
        require(successRaffle, "Raffle threshold registration failed");
    }

    // ============ Match Creation Override ============
    // ConnectFourOnChain handles match creation directly instead of delegating to modules

    /**
     * @dev Initialize round and create matches
     * Overrides module implementation to call _createMatchGame directly
     */
    function initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId);

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

            // Create matches directly - this is the key fix!
            for (uint8 i = 0; i < matchCount; i++) {
                _createMatchGame(tierId, instanceId, roundNumber, i, players[i * 2], players[i * 2 + 1]);
            }

            if (walkoverPlayer != address(0)) {
                // Delegate winner advancement to Matches module
                (bool success, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchCount, walkoverPlayer)
                );
                require(success, "Advance winner failed");
            }
        }
    }

    /**
     * @dev Get match count for round - helper function
     */
    function getMatchCountForRound(uint8 tierId, uint8 instanceId) public view returns (uint8) {
        TierConfig storage config = _tierConfigs[tierId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return tournament.enrolledCount / 2;
    }

    // ============ Public ETour Function Wrappers (Delegatecall to Modules) ============

    /**
     * @dev Enroll in tournament - delegates to Core module
     */
    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        // Check if player was already enrolled before delegatecall
        bool wasEnrolled = isEnrolled[tierId][instanceId][msg.sender];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Enrollment failed");

        // If player wasn't enrolled before but is now, call tracking hook
        if (!wasEnrolled && isEnrolled[tierId][instanceId][msg.sender]) {
            _onPlayerEnrolled(tierId, instanceId, msg.sender);
        }

        // If tournament auto-started (enrollment filled up), initialize round and call hooks
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            initializeRound(tierId, instanceId, 0);
            _onTournamentStarted(tierId, instanceId);
        }
    }

    /**
     * @dev Force start tournament - delegates to Core module
     */
    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("forceStartTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Force start failed");

        // If tournament status changed to InProgress, initialize round and call hook
        if (oldStatus != TournamentStatus.InProgress && tournament.status == TournamentStatus.InProgress) {
            initializeRound(tierId, instanceId, 0);
            _onTournamentStarted(tierId, instanceId);
        }
    }

    /**
     * @dev Claim abandoned enrollment pool - delegates to Core module
     */
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Claim failed");
    }

    /**
     * @dev Reset enrollment window - delegates to Core module
     */
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("resetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Reset failed");
    }

    /**
     * @dev Execute protocol raffle - delegates to Raffle module
     */
    function executeProtocolRaffle() external nonReentrant returns (
        address winner,
        uint256 ownerAmount,
        uint256 winnerAmount
    ) {
        (bool success, bytes memory data) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle()")
        );
        require(success, "Raffle execution failed");
        return abi.decode(data, (address, uint256, uint256));
    }

    /**
     * @dev Force eliminate stalled match - delegates to Escalation module
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("forceEliminateStalledMatch(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "Force elimination failed");
    }

    /**
     * @dev Claim match slot by replacement - delegates to Escalation module
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("claimMatchSlotByReplacement(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "Replacement claim failed");
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
    ) public override {
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

        // Add match to both players' active match lists - DIRECT storage access
        playerActiveMatches[player1].push(matchId);
        playerMatchIndex[player1][matchId] = playerActiveMatches[player1].length - 1;

        playerActiveMatches[player2].push(matchId);
        playerMatchIndex[player2][matchId] = playerActiveMatches[player2].length - 1;

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    function _resetMatchGame(bytes32 matchId) public override {
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

    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public override {
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

    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _getTimeIncrement() public view override returns (uint256) {
        // Note: This function is called during match, so we get config from the match's tier
        // In practice, all tiers in ConnectFourOnChain use 15 seconds
        return 15 seconds; // Fischer increment: 15 seconds per move
    }

    /**
     * @dev Check if the current player has run out of time
     * Used by escalation system to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
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

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public override {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
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

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
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
    ) public view override returns (CommonMatchData memory) {
        Match storage matchData = matches[matchId];

        // Derive loser
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = (matchData.winner == matchData.player1)
                ? matchData.player2
                : matchData.player1;
        }

        return CommonMatchData({
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
    ) public view override returns (CommonMatchData memory data, bool exists) {
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
        data = CommonMatchData({
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
        (bool stallSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("markMatchStalled(bytes32,uint8,uint256)", matchId, tierId, uint256(0))
        );
        require(stallSuccess, "Mark stalled failed");

        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, loser);

        // Call completeMatch directly (handles storage access without delegatecall issues)
        completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);

        // Cache the completed match
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
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
            // Call completeMatch directly (handles storage access without delegatecall issues)
            completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);

            // Cache the completed match
            _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
            return;
        }

        // Check for draw (board full)
        if (matchData.moveCount == TOTAL_CELLS) {
            // Call completeMatch directly (handles storage access without delegatecall issues)
            completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);

            // Cache the completed match
            _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
            return;
        }

        // Switch turn
        matchData.currentTurn = (matchData.currentTurn == matchData.player1)
            ? matchData.player2
            : matchData.player1;
    }

    /**
     * @dev Override completeMatch to handle storage access directly
     * This avoids delegatecall issues with removePlayerActiveMatch
     */
    function completeMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Mark match as completed with result
        _completeMatchWithResult(matchId, winner, isDraw);

        // Get players
        (address player1, address player2) = _getMatchPlayers(matchId);

        // Remove match from player1's active matches - DIRECT storage access
        uint256 index1 = playerMatchIndex[player1][matchId];
        uint256 lastIndex1 = playerActiveMatches[player1].length - 1;
        if (index1 != lastIndex1) {
            bytes32 lastMatchId1 = playerActiveMatches[player1][lastIndex1];
            playerActiveMatches[player1][index1] = lastMatchId1;
            playerMatchIndex[player1][lastMatchId1] = index1;
        }
        playerActiveMatches[player1].pop();
        delete playerMatchIndex[player1][matchId];

        // Remove match from player2's active matches - DIRECT storage access
        uint256 index2 = playerMatchIndex[player2][matchId];
        uint256 lastIndex2 = playerActiveMatches[player2].length - 1;
        if (index2 != lastIndex2) {
            bytes32 lastMatchId2 = playerActiveMatches[player2][lastIndex2];
            playerActiveMatches[player2][index2] = lastMatchId2;
            playerMatchIndex[player2][lastMatchId2] = index2;
        }
        playerActiveMatches[player2].pop();
        delete playerMatchIndex[player2][matchId];

        // Update player stats - DIRECT storage access
        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            playerStats[winner].matchesWon++;
        }

        // Clear escalation state - delegate to Escalation module
        (bool clearSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("clearEscalationState(bytes32)", matchId)
        );
        require(clearSuccess, "Clear escalation failed");

        emit MatchCompleted(matchId, winner, isDraw);

        // Handle winner advancement if not a draw and not final round
        if (!isDraw) {
            TierConfig storage config = _tierConfigs[tierId];
            if (roundNumber < config.totalRounds - 1) {
                // Delegate to Matches module for advanceWinner
                (bool advanceSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)",
                        tierId, instanceId, roundNumber, matchNumber, winner)
                );
                require(advanceSuccess, "Advance winner failed");
            }
        }

        // Update round completion tracking
        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        // Check if round is complete
        if (round.completedMatches == round.totalMatches) {
            // Complete the round - this handles orphaned winners, tournament completion, etc.
            // Note: completeRound in MODULE_MATCHES calls hasOrphanedWinners, processOrphanedWinners,
            // and checkForSoleWinnerCompletion internally, so we don't need to call them explicitly
            (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeRound(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(completeSuccess, "Complete round failed");
        }
    }

    /**
     * @dev Override consolidateScatteredPlayers to handle _createMatchGame directly
     * This avoids delegatecall resolution issues when creating secondary matches
     */
    function consolidateScatteredPlayers(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) public {
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

        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        if (playerCount == 1) {
            // Delegate to Matches module for completeTournament
            (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeTournament(uint8,uint8,address)", tierId, instanceId, playersInRound[0])
            );
            require(completeSuccess, "Complete tournament failed");
            return;
        }

        // Reset all matches in the round
        for (uint8 i = 0; i < round.totalMatches; i++) {
            bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
            _resetMatchGame(matchId);
        }

        // Recalculate match count for consolidated players
        uint8 newMatchCount = playerCount / 2;
        uint8 hasWalkover = playerCount % 2;

        round.totalMatches = newMatchCount;
        round.completedMatches = 0;
        round.drawCount = 0;
        round.allMatchesDrew = false;

        emit RoundInitialized(tierId, instanceId, roundNumber, newMatchCount);

        address walkoverPlayer = address(0);
        if (hasWalkover == 1) {
            uint256 randomness = uint256(keccak256(abi.encodePacked(
                block.prevrandao,
                block.timestamp,
                tierId,
                instanceId,
                roundNumber,
                playerCount
            )));

            uint8 walkoverIndex = uint8(randomness % playerCount);
            walkoverPlayer = playersInRound[walkoverIndex];

            playersInRound[walkoverIndex] = playersInRound[playerCount - 1];
            playerCount--;

            emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
        }

        // Create new matches with consolidated players - DIRECT call to _createMatchGame
        for (uint8 i = 0; i < newMatchCount; i++) {
            address p1 = playersInRound[i * 2];
            address p2 = playersInRound[i * 2 + 1];

            _createMatchGame(tierId, instanceId, roundNumber, i, p1, p2);
            emit PlayersConsolidated(tierId, instanceId, roundNumber, p1, p2);
        }

        // Advance walkover player if exists
        if (walkoverPlayer != address(0)) {
            // Delegate to Matches module for advanceWinner
            (bool advanceSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)",
                    tierId, instanceId, roundNumber, newMatchCount, walkoverPlayer)
            );
            require(advanceSuccess, "Advance walkover winner failed");
        }
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
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        ConnectFourMatchData memory fullData;

        // Try active match first
        if (_isMatchActive(matchId)) {
            CommonMatchData memory common = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
            fullData.common = common;

            Match storage matchData = matches[matchId];
            fullData.board = matchData.board;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.moveCount = matchData.moveCount;
            fullData.lastColumn = matchData.lastColumn;
            fullData.player1TimeRemaining = matchData.player1TimeRemaining;
            fullData.player2TimeRemaining = matchData.player2TimeRemaining;
            fullData.lastMoveTimestamp = matchData.lastMoveTimestamp;

            return fullData;
        }

        // Try cache
        (CommonMatchData memory cachedCommon, bool exists) = _getMatchFromCache(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (exists) {
            fullData.common = cachedCommon;

            // Populate from cache
            bytes32 matchKey = keccak256(abi.encodePacked(cachedCommon.player1, cachedCommon.player2));
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

            return fullData;
        }

        revert("Match not found");
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
        if (matchData.status != MatchStatus.InProgress) {
            return (matchData.player1TimeRemaining, matchData.player2TimeRemaining);
        }

        // Calculate elapsed time since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Calculate real-time remaining for current player
        if (matchData.currentTurn == matchData.player1) {
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

    // ============ Missing Getter Functions ============

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

    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
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

    function getLeaderboardCount() external view returns (uint256) {
        return _leaderboardPlayers.length;
    }

    function getTotalCapacity() external view returns (uint256 totalPlayers) {
        for (uint8 i = 0; i < tierCount; i++) {
            if (_tierConfigs[i].initialized) {
                TierConfig storage config = _tierConfigs[i];
                totalPlayers += uint256(config.playerCount) * uint256(config.instanceCount);
            }
        }
        return totalPlayers;
    }

    function _getRaffleThreshold() internal view returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise, use the final threshold
        return raffleThresholdFinal;
    }

    function getRaffleThresholds() external view returns (
        uint256[] memory thresholds,
        uint256 finalThreshold,
        uint256 currentThreshold
    ) {
        thresholds = raffleThresholds;
        finalThreshold = raffleThresholdFinal;
        currentThreshold = _getRaffleThreshold();
        return (thresholds, finalThreshold, currentThreshold);
    }

    function getMatchId(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public pure returns (bytes32) {
        return _getMatchId(tierId, instanceId, roundNumber, matchNumber);
    }

    function ENTRY_FEES(uint8 tierId) external view returns (uint256) {
        return _tierConfigs[tierId].entryFee;
    }

    function INSTANCE_COUNTS(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].instanceCount;
    }

    function TIER_SIZES(uint8 tierId) external view returns (uint8) {
        return _tierConfigs[tierId].playerCount;
    }

    function tierConfigs(uint8 tierId) external view returns (TierConfig memory) {
        require(tierId < tierCount, "Invalid tier ID");
        return _tierConfigs[tierId];
    }

    // ============ Player Activity Tracking Implementation ============

    /**
     * @dev Hook called when player enrolls in tournament
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal override {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook called when tournament starts
     * Atomically moves ALL enrolled players from enrolling → active
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal override {
        address[] storage players = enrolledPlayers[tierId][instanceId];

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
    ) internal override {
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
    ) internal override {
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
    ) public override {
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
        bytes32[] storage matches = playerActiveMatches[player];

        TierConfig storage config = _tierConfigs[tierId];
        for (uint8 r = 0; r < config.totalRounds; r++) {
            Round storage round = rounds[tierId][instanceId][r];
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

    /**
     * @dev Get protocol fee distribution percentages
     */
    function getFeeDistribution() external pure returns (
        uint256 prizePoolPercentage,
        uint256 ownerFeePercentage,
        uint256 protocolFeePercentage,
        uint256 basisPoints
    ) {
        return (
            PARTICIPANTS_SHARE_BPS,
            OWNER_SHARE_BPS,
            PROTOCOL_SHARE_BPS,
            BASIS_POINTS
        );
    }

    /**
     * @dev Get raffle configuration - delegates to Raffle module
     */
    function getRaffleConfiguration() external view returns (
        uint256 threshold,
        uint256 reserve,
        uint256 ownerSharePercentage,
        uint256 winnerSharePercentage
    ) {
        threshold = _getRaffleThreshold();
        (bool success, bytes memory data) = MODULE_RAFFLE.staticcall(
            abi.encodeWithSignature("getRaffleReserve()")
        );
        require(success, "Get raffle reserve failed");
        reserve = abi.decode(data, (uint256));
        return (
            threshold,
            reserve,
            20,  // 20% to owner
            80   // 80% to winner
        );
    }

    // ============ View Function Wrappers (Delegatecall to Modules) ============

    /**
     * @dev Get all tier IDs - delegates to Core module
     */
    function getAllTierIds() external view returns (uint8[] memory) {
        (bool success, bytes memory data) = MODULE_CORE.staticcall(
            abi.encodeWithSignature("getAllTierIds()")
        );
        require(success, "Get all tier IDs failed");
        return abi.decode(data, (uint8[]));
    }

    /**
     * @dev Get tier info - delegates to Core module
     */
    function getTierInfo(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee
        );
    }

    /**
     * @dev Get timeout configuration for a tier
     */
    function getTierTimeouts(uint8 tierId) external view returns (
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        uint256 matchLevel2Delay,
        uint256 matchLevel3Delay,
        uint256 enrollmentWindow,
        uint256 enrollmentLevel2Delay
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TimeoutConfig storage timeouts = _tierConfigs[tierId].timeouts;
        return (
            timeouts.matchTimePerPlayer,
            timeouts.timeIncrementPerMove,
            timeouts.matchLevel2Delay,
            timeouts.matchLevel3Delay,
            timeouts.enrollmentWindow,
            timeouts.enrollmentLevel2Delay
        );
    }

    /**
     * @dev Get complete tier configuration in one call
     */
    function getTierConfiguration(uint8 tierId) external view returns (
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
    ) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        TimeoutConfig storage timeouts = config.timeouts;

        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            timeouts.matchTimePerPlayer,
            timeouts.timeIncrementPerMove,
            timeouts.matchLevel2Delay,
            timeouts.matchLevel3Delay,
            timeouts.enrollmentWindow,
            timeouts.enrollmentLevel2Delay,
            _tierPrizeDistribution[tierId]
        );
    }

    /**
     * @dev Get maximum concurrent players for a specific tier
     */
    function getTierCapacity(uint8 tierId) external view returns (uint256) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        TierConfig storage config = _tierConfigs[tierId];
        return uint256(config.playerCount) * uint256(config.instanceCount);
    }

    /**
     * @dev Can reset enrollment window - delegates to Core module
     */
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool canReset) {
        (bool success, bytes memory data) = MODULE_CORE.staticcall(
            abi.encodeWithSignature("canResetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Check reset failed");
        return abi.decode(data, (bool));
    }

    /**
     * @dev Get raffle info - delegates to Raffle module
     */
    function getRaffleInfo() external view returns (
        uint256 raffleIndex,
        bool isReady,
        uint256 currentAccumulated,
        uint256 threshold,
        uint256 reserve,
        uint256 raffleAmount,
        uint256 ownerShare,
        uint256 winnerShare,
        uint256 eligiblePlayerCount
    ) {
        (bool success, bytes memory data) = MODULE_RAFFLE.staticcall(
            abi.encodeWithSignature("getRaffleInfo()")
        );
        require(success, "Get raffle info failed");
        return abi.decode(data, (uint256, bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    /**
     * @dev Get leaderboard - delegates to Prizes module
     */
    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        (bool success, bytes memory data) = MODULE_PRIZES.staticcall(
            abi.encodeWithSignature("getLeaderboard()")
        );
        require(success, "Get leaderboard failed");
        return abi.decode(data, (LeaderboardEntry[]));
    }

    /**
     * @dev LeaderboardEntry struct for decoding
     */
    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    /**
     * @dev Check escalation L1 availability - delegates to Escalation module
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

    /**
     * @dev Internal helper to check if player has advanced past a round
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
}
