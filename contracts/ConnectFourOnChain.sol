// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

/**
 * @title ConnectFourOnChain
 * @dev Classic Connect Four game implementing ETour tournament protocol (Modular Architecture)
 * Strategic column-drop game where players compete to connect 4 pieces in a row.
 *
 * This contract demonstrates modular ETour integration by:
 * 1. Inheriting ETour_Storage for shared tournament state
 * 2. Delegating to specialized modules (Core, Matches, Prizes, etc.)
 * 3. Implementing IETourGame interface (8 abstract functions)
 * 4. Managing game-specific logic (gravity-based drops, win detection, time banks)
 *
 * Board optimization: 42 cells × 2 bits = 84 bits (packed in single uint256)
 * Cell encoding: 0=Empty, 1=Red (Player1), 2=Yellow (Player2)
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract ConnectFourOnChain is ETour_Storage {

    // ============ Game-Specific Constants ============

    uint8 private constant ROWS = 6;
    uint8 private constant COLS = 7;
    uint8 private constant TOTAL_CELLS = 42;
    uint8 private constant CONNECT_COUNT = 4;

    // ============ Game-Specific Structs ============

    /**
     * @dev Match storage structure for active Connect Four games
     * Board is packed: 2 bits per cell (0=empty, 1=Red, 2=Yellow)
     * Total 42 cells = 84 bits (fits in uint256 with room to spare)
     */
    struct Match {
        address player1;
        address player2;
        address winner;
        address currentTurn;
        address firstPlayer;
        MatchStatus status;
        bool isDraw;
        uint256 packedBoard;           // 42 cells, 2 bits each
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;  // Time bank with Fischer increment
        uint256 player2TimeRemaining;
    }

    /**
     * @dev Extended match data for ConnectFour including common fields and game-specific state
     * Used for view functions to return complete match information
     */
    struct ConnectFourMatchData {
        CommonMatchData common;        // Standardized tournament match data
        uint256 packedBoard;           // Game-specific: packed board state
        address currentTurn;           // Who plays next (address(0) for completed)
        address firstPlayer;           // Who started the match
        uint256 player1TimeRemaining;  // Time bank for player1
        uint256 player2TimeRemaining;  // Time bank for player2
    }

    // ============ Game-Specific Storage ============

    mapping(bytes32 => Match) public matches;  // Active matches only (matchId => Match)

    // ============ Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 column, uint8 row);
    event AllInstancesInitialized(address indexed caller, uint8 tierCount);
    event MatchCreated(uint8 indexed tierId, uint8 indexed instanceId, uint8 roundNumber, uint8 matchNumber, address player1, address player2);
    // MatchCached event now defined in ETour_Storage

    // ============ Constructor ============

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress,
        address _moduleGameCacheAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress,
        _moduleGameCacheAddress
    ) {
        // Tier registration moved to initializeAllInstances() for gas optimization
    }

    // ============ Initialization ============

    /**
     * @dev One-time initialization of all tournament instances
     *
     * Pre-allocates storage for all tier instances to avoid lazy initialization gas costs.
     * Can only be called once by anyone (typically by deployer immediately after deployment).
     */
    function initializeAllInstances() external nonReentrant {
        require(tierCount == 0, "AI");

        _registerTier0();
        _registerTier1();
        _registerTier2();

        // Set raffle thresholds: [0.4, 0.8, 1.2, 1.6, 2]
        raffleThresholds.push(0.4 ether);
        raffleThresholds.push(0.8 ether);
        raffleThresholds.push(1.2 ether);
        raffleThresholds.push(1.6 ether);
        raffleThresholds.push(2.0 ether);

        // Set final raffle threshold (used after initial thresholds exhausted)
        raffleThresholdFinal = 2.0 ether;

        emit AllInstancesInitialized(msg.sender, tierCount);
    }

    function _registerTier0() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 300,     // 5 minutes per player
            timeIncrementPerMove: 15,    // 15 seconds Fischer increment
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 300,
            enrollmentLevel2Delay: 600
        });

        uint8[] memory prizes = new uint8[](2);
        prizes[0] = 100;
        prizes[1] = 0;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                0, 2, 100, 0.002 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T0");
    }

    function _registerTier1() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 300,     // 5 minutes per player
            timeIncrementPerMove: 15,    // 15 seconds Fischer increment
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 600,
            enrollmentLevel2Delay: 1200
        });

        uint8[] memory prizes = new uint8[](4);
        prizes[0] = 75;
        prizes[1] = 25;
        prizes[2] = 0;
        prizes[3] = 0;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                1, 4, 50, 0.004 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T1");
    }

    function _registerTier2() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 300,     // 5 minutes per player
            timeIncrementPerMove: 15,    // 15 seconds Fischer increment
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 900,
            enrollmentLevel2Delay: 1800
        });

        uint8[] memory prizes = new uint8[](8);
        prizes[0] = 80;
        prizes[1] = 20;
        prizes[2] = 0;
        prizes[3] = 0;
        prizes[4] = 0;
        prizes[5] = 0;
        prizes[6] = 0;
        prizes[7] = 0;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                2, 8, 30, 0.008 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T2");
    }

    /**
     * @dev Initialize round and create matches
     * Called when tournament starts or when advancing to next round
     */
    function initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId);

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;

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
                address player1 = players[i * 2];
                address player2 = players[i * 2 + 1];
                _createMatchGame(tierId, instanceId, roundNumber, i, player1, player2);

                bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                playerActiveMatches[player1].push(matchId);
                playerMatchIndex[player1][matchId] = playerActiveMatches[player1].length - 1;
                playerActiveMatches[player2].push(matchId);
                playerMatchIndex[player2][matchId] = playerActiveMatches[player2].length - 1;
            }

            if (walkoverPlayer != address(0)) {
                (bool success, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchCount, walkoverPlayer)
                );
                require(success, "AW");
            }
        }
    }

    /**
     * @dev Get match count for round - helper function
     */
    function getMatchCountForRound(uint8 tierId, uint8 instanceId) public view returns (uint8) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return tournament.enrolledCount / 2;
    }

    // ============ Public ETour Function Wrappers (Delegatecall to Modules) ============

    /**
     * @dev Enroll in tournament - delegates to Core module
     */
    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "E");

        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }
    }

    
    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("forceStartTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "FS");

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.Completed) {
            address winner = tournament.winner;
            address[] memory singlePlayer = new address[](1);
            singlePlayer[0] = winner;

            (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
            );
            require(resetSuccess, "RT");

            _onTournamentCompleted(tierId, instanceId, singlePlayer);
        }
    }

    
    function executeProtocolRaffle(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle(uint8,uint8)", tierId, instanceId)
        );
        require(success, "ER");
    }

    
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("resetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "RW");
    }


    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external returns (bool canReset) {
        // Non-view to allow delegatecall to module with proper storage access
        (bool success, bytes memory data) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("canResetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "CRE");
        return abi.decode(data, (bool));
    }

    
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "CAE");

        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );
        require(resetSuccess, "RT");
    }

    
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "forceEliminateStalledMatch(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(success, "FE");
    }

    
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "claimMatchSlotByReplacement(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(success, "CR");

        // Hook for external player replacement
        _onExternalPlayerReplacement(tierId, instanceId, msg.sender);
    }

    // ============ Game Logic (Connect Four Specific) ============

    /**
     * @dev Make a move on the Connect Four board
     * Handles gravity (piece drops to lowest available row), time bank updates with Fischer increment
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 column
    ) external nonReentrant {
        require(column < COLS, "IC");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender == matchData.currentTurn, "NT");

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        if (matchData.currentTurn == matchData.player1) {
            matchData.player1TimeRemaining = (matchData.player1TimeRemaining > elapsed)
                ? matchData.player1TimeRemaining - elapsed
                : 0;
            matchData.player1TimeRemaining += _getTimeIncrement();
        } else {
            matchData.player2TimeRemaining = (matchData.player2TimeRemaining > elapsed)
                ? matchData.player2TimeRemaining - elapsed
                : 0;
            matchData.player2TimeRemaining += _getTimeIncrement();
        }
        matchData.lastMoveTime = block.timestamp;

        uint8 targetRow = ROWS;
        for (uint8 row = ROWS; row > 0; row--) {
            uint8 checkCell = _getCellIndex(row - 1, column);
            if (_getCell(matchData.packedBoard, checkCell) == 0) {
                targetRow = row - 1;
                break;
            }
        }

        require(targetRow < ROWS, "CF");

        uint8 piece = (msg.sender == matchData.player1) ? 1 : 2;

        uint8 cellIndex = _getCellIndex(targetRow, column);
        matchData.packedBoard = _setCell(matchData.packedBoard, cellIndex, piece);

        emit MoveMade(matchId, msg.sender, column, targetRow);

        // Check for win
        if (_checkWin(matchData.packedBoard, piece, targetRow, column)) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
            return;
        }

        // Check for draw (board full)
        if (_isBoardFull(matchData.packedBoard)) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        // Switch turn
        matchData.currentTurn = (matchData.currentTurn == matchData.player1)
            ? matchData.player2
            : matchData.player1;
    }

    /**
     * @dev Claim timeout victory when opponent runs out of time
     * This is Escalation Level 1 (player-initiated)
     */
    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender != matchData.currentTurn, "OT");

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 opponentTimeRemaining = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        require(elapsed >= opponentTimeRemaining, "TO");

        (bool markSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "markMatchStalled(bytes32,uint8,uint256)",
                matchId, tierId, block.timestamp
            )
        );
        require(markSuccess, "MS");

        address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;
        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, loser);

        // Complete match with timeout winner
        _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    /**
     * @dev Internal match completion handler
     * Coordinates with Escalation and Matches modules
     */
    function _completeMatchInternal(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) private {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        _completeMatchWithResult(tierId, instanceId, roundNumber, matchNumber, winner, isDraw);

        (bool clearSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "clearEscalationState(bytes32)",
                matchId
            )
        );
        require(clearSuccess, "CE");

        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature(
                "completeMatch(uint8,uint8,uint8,uint8,address,bool)",
                tierId, instanceId, roundNumber, matchNumber, winner, isDraw
            )
        );
        require(completeSuccess, "CM");

        if (!isDraw) {
            Match storage matchData = matches[matchId];
            address loser = (winner == matchData.player1) ? matchData.player2 : matchData.player1;
            _onPlayerEliminatedFromTournament(loser, tierId, instanceId, roundNumber);
        }

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        if (tournament.status == TournamentStatus.Completed && enrolledPlayersCopy.length > 0) {
            address tournamentWinner = tournament.winner;
            uint256 winnersPot = tournament.prizePool;

            if (tournament.allDrawResolution) {
                (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
                    abi.encodeWithSignature("distributeEqualPrizes(uint8,uint8,address[],uint256)", tierId, instanceId, enrolledPlayersCopy, winnersPot)
                );
                require(distributeSuccess, "DP");
            } else {
                (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
                    abi.encodeWithSignature("distributePrizes(uint8,uint8,uint256)", tierId, instanceId, winnersPot)
                );
                require(distributeSuccess, "DP");
            }

            (bool earningsSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("updatePlayerEarnings(uint8,uint8,address)", tierId, instanceId, tournamentWinner)
            );
            require(earningsSuccess, "UE");

            uint256 winnerPrize = playerPrizes[tierId][instanceId][tournamentWinner];
            emit TournamentCompleted(tierId, instanceId, tournamentWinner, winnerPrize, tournament.finalsWasDraw, tournament.coWinner);

            (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
            );
            require(resetSuccess, "RT");

            _onTournamentCompleted(tierId, instanceId, enrolledPlayersCopy);
        }
    }

    // ============ Board Helper Functions ============

    /**
     * @dev Get cell value from packed board
     * @param packedBoard The packed board state (2 bits per cell)
     * @param cellIndex Index 0-41
     * @return value 0=empty, 1=Red, 2=Yellow
     */
    function _getCell(uint256 packedBoard, uint8 cellIndex) private pure returns (uint8) {
        return uint8((packedBoard >> (cellIndex * 2)) & 3);
    }

    /**
     * @dev Set cell value in packed board
     * @param packedBoard Current packed board state
     * @param cellIndex Index 0-41
     * @param value 0=empty, 1=Red, 2=Yellow
     * @return Updated packed board
     */
    function _setCell(uint256 packedBoard, uint8 cellIndex, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(3) << (cellIndex * 2));
        return (packedBoard & mask) | (uint256(value) << (cellIndex * 2));
    }

    /**
     * @dev Convert 2D board coordinates to 1D cell index
     * Board uses row-major ordering: cellIndex = row * 7 + col
     */
    function _getCellIndex(uint8 row, uint8 col) private pure returns (uint8) {
        return row * COLS + col;
    }

    /**
     * @dev Check if coordinates are within board bounds
     */
    function _isValidPosition(int8 row, int8 col) private pure returns (bool) {
        return row >= 0 && row < int8(ROWS) && col >= 0 && col < int8(COLS);
    }

    /**
     * @dev Check if board is completely full (all 42 cells occupied)
     * Used for draw detection
     */
    function _isBoardFull(uint256 packedBoard) private pure returns (bool) {
        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
            if (_getCell(packedBoard, i) == 0) return false;
        }
        return true;
    }

    /**
     * @dev Count total moves made (non-empty cells)
     * Calculated on-the-fly by scanning board
     */
    function _countMoves(uint256 packedBoard) private pure returns (uint8) {
        uint8 count = 0;
        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
            if (_getCell(packedBoard, i) != 0) count++;
        }
        return count;
    }

    /**
     * @dev Check if player has won with their last move
     * Checks all 4 directions: horizontal, vertical, diagonal, anti-diagonal
     */
    function _checkWin(
        uint256 packedBoard,
        uint8 piece,
        uint8 row,
        uint8 col
    ) private pure returns (bool) {
        // Horizontal
        if (_checkLine(packedBoard, piece, row, col, 0, 1)) return true;

        // Vertical
        if (_checkLine(packedBoard, piece, row, col, 1, 0)) return true;

        // Diagonal (down-right)
        if (_checkLine(packedBoard, piece, row, col, 1, 1)) return true;

        // Anti-diagonal (down-left)
        if (_checkLine(packedBoard, piece, row, col, 1, -1)) return true;

        return false;
    }

    /**
     * @dev Check for 4-in-a-row in a specific direction (bidirectional)
     * Counts pieces in both directions from the last played position
     */
    function _checkLine(
        uint256 packedBoard,
        uint8 piece,
        uint8 row,
        uint8 col,
        int8 dRow,
        int8 dCol
    ) private pure returns (bool) {
        uint8 count = 1;

        int8 r = int8(row) + dRow;
        int8 c = int8(col) + dCol;
        while (_isValidPosition(r, c) && _getCell(packedBoard, _getCellIndex(uint8(r), uint8(c))) == piece) {
            count++;
            if (count >= CONNECT_COUNT) return true;
            r += dRow;
            c += dCol;
        }

        r = int8(row) - dRow;
        c = int8(col) - dCol;
        while (_isValidPosition(r, c) && _getCell(packedBoard, _getCellIndex(uint8(r), uint8(c))) == piece) {
            count++;
            if (count >= CONNECT_COUNT) return true;
            r -= dRow;
            c -= dCol;
        }

        return false;
    }

    // ============ IETourGame Interface Implementation ============

    /**
     * @dev Create new match - called by initializeRound
     */
    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public override {
        require(player1 != player2, "P1");
        require(player1 != address(0) && player2 != address(0), "P2");

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

        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;

        matchData.packedBoard = 0;

        emit MatchCreated(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    
    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];
        return matchData.player1 != address(0) &&
               matchData.status != MatchStatus.Completed;
    }

    
    function _completeMatchWithResult(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;

        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
    }

    
    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Encode board as bytes for generic cache storage
        bytes memory boardData = abi.encode(matchData.packedBoard);

        (bool success, ) = MODULE_GAME_CACHE.delegatecall(
            abi.encodeWithSignature(
                "addToMatchCache(bytes32,uint8,uint8,uint8,uint8,address,address,address,address,uint256,bool,bytes)",
                matchId,
                tierId,
                instanceId,
                roundNumber,
                matchNumber,
                matchData.player1,
                matchData.player2,
                matchData.firstPlayer,
                matchData.winner,
                matchData.startTime,
                matchData.isDraw,
                boardData
            )
        );
        require(success, "CF");
    }

    
    function _getTimeIncrement() public pure override returns (uint256) {
        return 15;
    }

    function _resetMatchGame(bytes32 matchId) public override {
        Match storage matchData = matches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.winner = address(0);
        matchData.currentTurn = address(0);
        matchData.firstPlayer = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.isDraw = false;
        matchData.packedBoard = 0;
        matchData.startTime = 0;
        matchData.lastMoveTime = 0;
        matchData.player1TimeRemaining = 0;
        matchData.player2TimeRemaining = 0;
    }

    
    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    
    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
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

        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.lastMoveTime = block.timestamp;
        matchData.packedBoard = 0;  // Clear board
        matchData.isDraw = false;
        matchData.winner = address(0);

        // Re-randomize starting player
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            matchData.player1,
            matchData.player2,
            matchId,
            "replay"
        )));
        matchData.currentTurn = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.firstPlayer = matchData.currentTurn;

        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;
    }

    
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];

        if (matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        return elapsed >= currentPlayerTime;
    }

    
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view override returns (CommonMatchData memory) {
        Match storage matchData = matches[matchId];

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
        (bool success, bytes memory result) = MODULE_GAME_CACHE.staticcall(
            abi.encodeWithSignature(
                "getMatchFromCacheByMatchId(bytes32,uint8,uint8,uint8,uint8)",
                matchId,
                tierId,
                instanceId,
                roundNumber,
                matchNumber
            )
        );

        if (!success) {
            return (data, false);
        }

        (data, exists) = abi.decode(result, (CommonMatchData, bool));
        return (data, exists);
    }

    // ============ View Functions ============

    /**
     * @dev Get complete match data with automatic cache fallback
     * CRITICAL: Uses staticcall for cache reads so function can be view
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (ConnectFourMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (matchData.player1 != address(0)) {
            ConnectFourMatchData memory fullData;

            address loser = address(0);
            if (!matchData.isDraw && matchData.winner != address(0)) {
                loser = (matchData.winner == matchData.player1) ? matchData.player2 : matchData.player1;
            }

            fullData.common = CommonMatchData({
                player1: matchData.player1,
                player2: matchData.player2,
                winner: matchData.winner,
                loser: loser,
                status: matchData.status,
                isDraw: matchData.isDraw,
                startTime: matchData.startTime,
                lastMoveTime: matchData.lastMoveTime,
                tierId: tierId,
                instanceId: instanceId,
                roundNumber: roundNumber,
                matchNumber: matchNumber,
                isCached: false
            });

            // Add game-specific data
            fullData.packedBoard = matchData.packedBoard;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.player1TimeRemaining = matchData.player1TimeRemaining;
            fullData.player2TimeRemaining = matchData.player2TimeRemaining;

            return fullData;
        }

        (bool success, bytes memory result) = MODULE_GAME_CACHE.staticcall(
            abi.encodeWithSignature(
                "getMatchFromCacheByMatchId(bytes32,uint8,uint8,uint8,uint8)",
                matchId,
                tierId,
                instanceId,
                roundNumber,
                matchNumber
            )
        );

        if (success) {
            (
                address player1,
                address player2,
                address firstPlayer,
                address winner,
                uint256 startTime,
                uint256 endTime,
                bool isDraw,
                bool cacheExists,
                bytes memory boardData
            ) = abi.decode(result, (address, address, address, address, uint256, uint256, bool, bool, bytes));

            if (cacheExists) {
                ConnectFourMatchData memory fullData;

                address loser = address(0);
                if (!isDraw && winner != address(0)) {
                    loser = (winner == player1) ? player2 : player1;
                }

                fullData.common = CommonMatchData({
                    player1: player1,
                    player2: player2,
                    winner: winner,
                    loser: loser,
                    status: MatchStatus.Completed,
                    isDraw: isDraw,
                    startTime: startTime,
                    lastMoveTime: endTime,
                    tierId: tierId,
                    instanceId: instanceId,
                    roundNumber: roundNumber,
                    matchNumber: matchNumber,
                    isCached: true
                });

                // Decode board data
                if (boardData.length > 0) {
                    fullData.packedBoard = abi.decode(boardData, (uint256));
                } else {
                    fullData.packedBoard = 0;
                }
                fullData.currentTurn = address(0);  // Completed matches have no current turn
                fullData.firstPlayer = firstPlayer;
                fullData.player1TimeRemaining = 0;
                fullData.player2TimeRemaining = 0;

                return fullData;
            }
        }

        revert("MNF");
    }

    /**
     * @dev Get player's total earnings across all tournaments
     */
    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    // ============ Player Tracking View Functions ============

    /**
     * @dev Get all tournaments a player is currently enrolling in
     */
    function getPlayerEnrollingTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerEnrollingTournaments[player];
    }

    /**
     * @dev Get all tournaments a player is actively competing in
     */
    function getPlayerActiveTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerActiveTournaments[player];
    }

    /**
     * @dev Get tournament information
     */
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

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (
        uint8 totalMatches,
        uint8 completedMatches,
        bool initialized
    ) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        return (
            round.totalMatches,
            round.completedMatches,
            round.initialized
        );
    }

    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        LeaderboardEntry[] memory entries = new LeaderboardEntry[](_leaderboardPlayers.length);
        for (uint256 i = 0; i < _leaderboardPlayers.length; i++) {
            entries[i] = LeaderboardEntry({
                player: _leaderboardPlayers[i],
                earnings: playerEarnings[_leaderboardPlayers[i]]
            });
        }
        return entries;
    }

    /**
     * @dev Get raffle info - calculated locally to read from contract's storage
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
        raffleIndex = currentRaffleIndex;
        currentAccumulated = accumulatedProtocolShare;

        // Calculate threshold locally (reads from this contract's storage)
        threshold = _getRaffleThreshold();
        reserve = (threshold * 10) / 100;  // 10% reserve

        isReady = currentAccumulated >= threshold;
        raffleAmount = threshold - reserve;
        ownerShare = (raffleAmount * 20) / 100;
        winnerShare = (raffleAmount * 80) / 100;

        // Get eligible player count from module
        (bool success, bytes memory data) = MODULE_RAFFLE.staticcall(
            abi.encodeWithSignature("getEligiblePlayerCount()")
        );
        eligiblePlayerCount = success ? abi.decode(data, (uint256)) : 0;
    }

    /**
     * @dev Get current raffle threshold - reads from contract's storage
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

    // ============ Player Tracking Hooks (Built-in Implementation) ============

    /**
     * @dev Hook: Called when player enrolls in tournament
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal override {
        _addPlayerTournament(player, tierId, instanceId, true);
    }

    /**
     * @dev Hook: Called when tournament starts
     */
    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal override {
        address[] storage players = enrolledPlayers[tierId][instanceId];
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerTournament(player, tierId, instanceId, true);
            _addPlayerTournament(player, tierId, instanceId, false);
        }
    }

    /**
     * @dev Hook: Called when player is eliminated from tournament
     */
    function _onPlayerEliminatedFromTournament(address player, uint8 tierId, uint8 instanceId, uint8) internal override {
        _removePlayerTournament(player, tierId, instanceId, false);
    }

    /**
     * @dev Hook: Called when external player replaces stalled player (L3 escalation)
     */
    function _onExternalPlayerReplacement(uint8 tierId, uint8 instanceId, address player) internal override {
        _addPlayerTournament(player, tierId, instanceId, false);
    }

    /**
     * @dev Hook: Called when tournament completes
     */
    function _onTournamentCompleted(uint8 tierId, uint8 instanceId, address[] memory players) public override {
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerTournament(player, tierId, instanceId, true);
            _removePlayerTournament(player, tierId, instanceId, false);
        }
    }

    // ============ Player Tracking Helper Functions ============

    function _addPlayerTournament(address player, uint8 tierId, uint8 instanceId, bool isEnrolling) private {
        if (isEnrolling) {
            if (playerEnrollingIndex[player][tierId][instanceId] != 0) return;
            playerEnrollingTournaments[player].push(TournamentRef(tierId, instanceId));
            playerEnrollingIndex[player][tierId][instanceId] = playerEnrollingTournaments[player].length;
        } else {
            if (playerActiveIndex[player][tierId][instanceId] != 0) return;
            playerActiveTournaments[player].push(TournamentRef(tierId, instanceId));
            playerActiveIndex[player][tierId][instanceId] = playerActiveTournaments[player].length;
        }
    }

    function _removePlayerTournament(address player, uint8 tierId, uint8 instanceId, bool isEnrolling) private {
        uint256 indexPlusOne;
        if (isEnrolling) {
            indexPlusOne = playerEnrollingIndex[player][tierId][instanceId];
            if (indexPlusOne == 0) return;
            uint256 lastIndex = playerEnrollingTournaments[player].length - 1;
            if (indexPlusOne - 1 != lastIndex) {
                TournamentRef memory lastRef = playerEnrollingTournaments[player][lastIndex];
                playerEnrollingTournaments[player][indexPlusOne - 1] = lastRef;
                playerEnrollingIndex[player][lastRef.tierId][lastRef.instanceId] = indexPlusOne;
            }
            playerEnrollingTournaments[player].pop();
            delete playerEnrollingIndex[player][tierId][instanceId];
        } else {
            indexPlusOne = playerActiveIndex[player][tierId][instanceId];
            if (indexPlusOne == 0) return;
            uint256 lastIndex = playerActiveTournaments[player].length - 1;
            if (indexPlusOne - 1 != lastIndex) {
                TournamentRef memory lastRef = playerActiveTournaments[player][lastIndex];
                playerActiveTournaments[player][indexPlusOne - 1] = lastRef;
                playerActiveIndex[player][lastRef.tierId][lastRef.instanceId] = indexPlusOne;
            }
            playerActiveTournaments[player].pop();
            delete playerActiveIndex[player][tierId][instanceId];
        }
    }
}
