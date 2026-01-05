// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

/**
 * @title TicTacChain
 * @dev Classic Tic-Tac-Toe game implementing ETour tournament protocol (Modular Architecture)
 * Simple, solved game used as the lowest-barrier demonstration of the ETour protocol.
 *
 * This contract demonstrates modular ETour integration by:
 * 1. Inheriting ETour_Storage for shared tournament state
 * 2. Delegating to specialized modules (Core, Matches, Prizes, etc.)
 * 3. Implementing IETourGame interface (8 abstract functions)
 * 4. Managing game-specific logic (board state, win detection, time banks)
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacChain is ETour_Storage {

    // ============ Game-Specific Structs ============

    /**
     * @dev Match storage structure for active Tic-Tac-Toe games
     * Board is packed: 2 bits per cell (0=empty, 1=player1, 2=player2)
     * Total 9 cells = 18 bits (fits in uint256 with room to spare)
     */
    struct Match {
        address player1;
        address player2;
        address winner;
        address currentTurn;
        address firstPlayer;
        MatchStatus status;
        bool isDraw;
        uint256 packedBoard;           // 9 cells, 2 bits each
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;  // Time bank with Fischer increment
        uint256 player2TimeRemaining;
    }

    /**
     * @dev Extended match data for TicTacToe including common fields and game-specific state
     * Used for view functions to return complete match information
     */
    struct TicTacToeMatchData {
        CommonMatchData common;        // Standardized tournament match data
        uint256 packedBoard;           // Game-specific: packed board state
        address currentTurn;           // Who plays next (address(0) for completed)
        address firstPlayer;           // Who started the match
        uint256 player1TimeRemaining;  // Time bank for player1
        uint256 player2TimeRemaining;  // Time bank for player2
        uint256 lastMoveTimestamp;     // When last move was made
    }

    // ============ Game-Specific Storage ============

    mapping(bytes32 => Match) public matches;  // Active matches only (matchId => Match)

    // ============ Module Addresses ============
    // (All ETour modules inherited from ETour_Storage, game logic is built-in)

    // ============ Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
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
     *
     * Gas cost estimate:
     * - Tier 0: 100 instances × ~20k gas = ~2M gas
     * - Tier 1: 50 instances × ~20k gas = ~1M gas
     * - Tier 2: 25 instances × ~20k gas = ~500k gas
     * Total: ~3.5M gas (fits in 4M block gas limit with room for execution)
     *
     * Note: Registration is separate from storage allocation. Modules store configuration,
     * but tournaments[] mapping needs explicit initialization per instance.
     */
    function initializeAllInstances() external nonReentrant {
        require(tierCount == 0, "Already initialized");

        _registerTier0();
        _registerTier1();
        _registerTier2();

        // Set final raffle threshold (used after initial thresholds exhausted)
        raffleThresholdFinal = 0.05 ether;

        emit AllInstancesInitialized(msg.sender, tierCount);
    }

    function _registerTier0() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 60,
            timeIncrementPerMove: 15,
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
                0, 2, 100, 0.001 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T0");

        raffleThresholds.push(0.01 ether);
    }

    function _registerTier1() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 60,
            timeIncrementPerMove: 15,
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 300,
            enrollmentLevel2Delay: 600
        });

        uint8[] memory prizes = new uint8[](4);
        prizes[0] = 70;
        prizes[1] = 30;
        prizes[2] = 0;
        prizes[3] = 0;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                1, 4, 50, 0.002 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T1");
        raffleThresholds.push(0.02 ether);
    }

    function _registerTier2() private {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 60,
            timeIncrementPerMove: 15,
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 300,
            enrollmentLevel2Delay: 600
        });

        uint8[] memory prizes = new uint8[](8);
        prizes[0] = 70;
        prizes[1] = 20;
        prizes[2] = 5;
        prizes[3] = 5;
        prizes[4] = 0;
        prizes[5] = 0;
        prizes[6] = 0;
        prizes[7] = 0;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                2, 8, 25, 0.004 ether, Mode.Classic, timeouts, prizes
            )
        );
        require(success, "T2");
        raffleThresholds.push(0.04 ether);
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
                address player1 = players[i * 2];
                address player2 = players[i * 2 + 1];
                _createMatchGame(tierId, instanceId, roundNumber, i, player1, player2);

                // Add players to active match tracking
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                playerActiveMatches[player1].push(matchId);
                playerMatchIndex[player1][matchId] = playerActiveMatches[player1].length - 1;
                playerActiveMatches[player2].push(matchId);
                playerMatchIndex[player2][matchId] = playerActiveMatches[player2].length - 1;
            }

            if (walkoverPlayer != address(0)) {
                // Delegate winner advancement to Matches module
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
        TierConfig storage config = _tierConfigs[tierId];
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

        // MODULE_CORE handles enrollment logic via delegatecall
        // Note: MODULE_CORE calls _onPlayerEnrolled/_onTournamentStarted internally,
        // but those are empty stubs in the module's bytecode.
        // We must call the real hooks here after the delegatecall.
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "E");

        // Call player enrolled hook (always call, module checks if already enrolled)
        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        // If tournament auto-started, call hooks and initialize round
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
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
        require(success, "FS");

        // If tournament started, call hooks
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }
    }

    /**
     * @dev Execute protocol raffle - delegates to Raffle module
     */
    function executeProtocolRaffle(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle(uint8,uint8)", tierId, instanceId)
        );
        require(success, "ER");
    }

    /**
     * @dev Claim abandoned enrollment pool - delegates to Core module
     */
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "CAE");
    }

    /**
     * @dev Escalation Level 2: Advanced players force eliminate both stalled players
     */
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

    /**
     * @dev Escalation Level 3: External player claims stalled match slot
     */
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

    // ============ Game Logic (Tic-Tac-Toe Specific) ============

    /**
     * @dev Make a move on the Tic-Tac-Toe board
     * Handles time bank updates with Fischer increment
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external nonReentrant {
        require(cellIndex < 9, "Invalid cell");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(_getCell(matchData.packedBoard, cellIndex) == 0, "Cell occupied");

        // Update time bank for current player
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

        // Make move: Set cell to player's symbol (1 or 2)
        uint8 symbol = (msg.sender == matchData.player1) ? 1 : 2;
        matchData.packedBoard = _setCell(matchData.packedBoard, cellIndex, symbol);

        emit MoveMade(matchId, msg.sender, cellIndex);

        // Check for win
        if (_checkWin(matchData.packedBoard, symbol)) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
            return;
        }

        // Check for draw
        if (_checkDraw(matchData.packedBoard)) {
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

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender != matchData.currentTurn, "Cannot claim on your own turn");

        // Check if current player has timed out
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 opponentTimeRemaining = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        require(elapsed >= opponentTimeRemaining, "Opponent has not timed out");

        // Mark match as stalled (enables L2/L3 escalation later if needed)
        (bool markSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "markMatchStalled(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(markSuccess, "MS");

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

        // Mark match as complete in game-specific storage and cache it
        _completeMatchWithResult(tierId, instanceId, roundNumber, matchNumber, winner, isDraw);

        // Clear any escalation state
        (bool clearSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "clearEscalationState(bytes32)",
                matchId
            )
        );
        require(clearSuccess, "CE");

        // Save enrolled players before delegatecall (in case tournament completes and resets)
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        // Delegate to Matches module for advancement logic
        // Note: MODULE_MATCHES calls _onPlayerEliminatedFromTournament internally,
        // but it's an empty stub in the module's bytecode.
        // We must call the real hook here after the delegatecall.
        (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature(
                "completeMatch(uint8,uint8,uint8,uint8,address,bool)",
                tierId, instanceId, roundNumber, matchNumber, winner, isDraw
            )
        );
        require(completeSuccess, "CM");

        // Call elimination hook for loser (if not a draw)
        if (!isDraw) {
            Match storage matchData = matches[matchId];
            address loser = (winner == matchData.player1) ? matchData.player2 : matchData.player1;
            _onPlayerEliminatedFromTournament(loser, tierId, instanceId, roundNumber);
        }

        // Check if tournament completed by looking at status change
        // MODULE_MATCHES.completeMatch() sets status to Completed and calls prize distribution
        // But nested delegatecall to MODULE_PRIZES.resetTournamentAfterCompletion() doesn't work
        // So we call it directly from TicTacChain and trigger the hook
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        if (tournament.status == TournamentStatus.Completed && enrolledPlayersCopy.length > 0) {
            // Tournament just completed - call reset and hook directly
            // (prizes already distributed by MODULE_MATCHES.completeTournament)

            (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
            );
            require(resetSuccess, "RT");

            // Call tournament completion hook
            _onTournamentCompleted(tierId, instanceId, enrolledPlayersCopy);
        }
    }

    // ============ Board Helper Functions ============

    /**
     * @dev Get cell value from packed board
     * @param packedBoard The packed board state (2 bits per cell)
     * @param cellIndex Index 0-8
     * @return value 0=empty, 1=player1, 2=player2
     */
    function _getCell(uint256 packedBoard, uint8 cellIndex) private pure returns (uint8) {
        return uint8((packedBoard >> (cellIndex * 2)) & 3);
    }

    /**
     * @dev Set cell value in packed board
     * @param packedBoard Current packed board state
     * @param cellIndex Index 0-8
     * @param value 0=empty, 1=player1, 2=player2
     * @return Updated packed board
     */
    function _setCell(uint256 packedBoard, uint8 cellIndex, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(3) << (cellIndex * 2));
        return (packedBoard & mask) | (uint256(value) << (cellIndex * 2));
    }

    /**
     * @dev Check if player has won
     * Checks all 8 winning lines: 3 rows, 3 columns, 2 diagonals
     */
    function _checkWin(uint256 board, uint8 player) private pure returns (bool) {
        // Rows
        if (_getCell(board, 0) == player && _getCell(board, 1) == player && _getCell(board, 2) == player) return true;
        if (_getCell(board, 3) == player && _getCell(board, 4) == player && _getCell(board, 5) == player) return true;
        if (_getCell(board, 6) == player && _getCell(board, 7) == player && _getCell(board, 8) == player) return true;

        // Columns
        if (_getCell(board, 0) == player && _getCell(board, 3) == player && _getCell(board, 6) == player) return true;
        if (_getCell(board, 1) == player && _getCell(board, 4) == player && _getCell(board, 7) == player) return true;
        if (_getCell(board, 2) == player && _getCell(board, 5) == player && _getCell(board, 8) == player) return true;

        // Diagonals
        if (_getCell(board, 0) == player && _getCell(board, 4) == player && _getCell(board, 8) == player) return true;
        if (_getCell(board, 2) == player && _getCell(board, 4) == player && _getCell(board, 6) == player) return true;

        return false;
    }

    /**
     * @dev Check if board is full (draw)
     */
    function _checkDraw(uint256 board) private pure returns (bool) {
        for (uint8 i = 0; i < 9; i++) {
            if (_getCell(board, i) == 0) return false;
        }
        return true;
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

        // Initialize time banks: 60 seconds base
        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;

        // Clear board
        matchData.packedBoard = 0;

        emit MatchCreated(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    /**
     * @dev Reset match for reuse
     */
    function _resetMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
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

    /**
     * @dev Get match result
     */
    function _getMatchResult(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (address winner, bool isDraw, MatchStatus status) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    /**
     * @dev Get match players
     */
    function _getMatchPlayers(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (address player1, address player2) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    /**
     * @dev Check if match is active (exists and not completed)
     */
    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];
        // Active if player1 assigned and not completed
        return matchData.player1 != address(0) &&
               matchData.status != MatchStatus.Completed;
    }

    /**
     * @dev Set match player (for replacement scenarios)
     */
    function _setMatchPlayer(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 playerSlot,
        address newPlayer
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (playerSlot == 1) {
            matchData.player1 = newPlayer;
        } else {
            matchData.player2 = newPlayer;
        }
    }

    /**
     * @dev Initialize match for play (set starting player, reset timers)
     */
    function _initializeMatchForPlay(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

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

        // Reset time banks
        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.lastMoveTime = block.timestamp;
    }

    /**
     * @dev Complete match with result
     */
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

        // Cache match before clearing
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
    }

    /**
     * @dev Add match to cache - delegates to GameCacheModule
     */
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
        require(success, "Cache failed");
    }

    /**
     * @dev Check if current player has timed out
     */
    function _hasCurrentPlayerTimedOut(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (bool) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        return elapsed >= currentPlayerTime;
    }

    /**
     * @dev Get time increment per move (Fischer increment)
     */
    function _getTimeIncrement() public view override returns (uint256) {
        return 15; // 15 seconds Fischer increment
    }

    // ============ Wrapper Functions (bytes32 matchId variants for module compatibility) ============

    /**
     * @dev Reset match - wrapper for modules expecting bytes32 matchId
     */
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

    /**
     * @dev Get match result - wrapper for modules
     */
    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    /**
     * @dev Get match players - wrapper for modules
     */
    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    /**
     * @dev Set match player - wrapper for modules
     */
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public override {
        Match storage matchData = matches[matchId];

        if (slot == 1) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    /**
     * @dev Initialize match for play - wrapper for modules
     */
    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
        Match storage matchData = matches[matchId];

        // Set match status and times
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

        // Reset time banks
        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;
    }

    /**
     * @dev Complete match with result - wrapper for modules
     */
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;

        // Note: Caching is handled by _completeMatchInternal which calls the other overload
        // This override is just for module interface compliance
    }

    /**
     * @dev Check if current player timed out - wrapper for modules
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];

        if (matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        return elapsed >= currentPlayerTime;
    }

    /**
     * @dev Get active match data - for modules that need CommonMatchData
     */
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
            endTime: 0,  // endTime set when match cached
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
    }

    /**
     * @dev Get match from cache - delegates to GameCacheModule
     */
    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view override returns (CommonMatchData memory data, bool exists) {
        // Static call to GameCacheModule (read-only)
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

        // Decode result
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
    ) public view returns (TicTacToeMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Check if match exists in active storage (even if completed)
        if (matchData.player1 != address(0)) {
            TicTacToeMatchData memory fullData;

            // Build CommonMatchData
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
                endTime: 0,
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
            fullData.lastMoveTimestamp = matchData.lastMoveTime;

            return fullData;
        }

        // Try cache (use staticcall to keep function view)
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
                bool exists,
                bytes memory boardData
            ) = abi.decode(result, (address, address, address, address, uint256, uint256, bool, bool, bytes));

            if (exists) {
                TicTacToeMatchData memory fullData;

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
                    endTime: endTime,
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
                fullData.lastMoveTimestamp = 0;

                return fullData;
            }
        }

        revert("Match not found");
    }

    /**
     * @dev Get tier configuration
     * Public getter for tier config data
     */
    function tierConfigs(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        uint8 totalRounds,
        TimeoutConfig memory timeouts
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            config.totalRounds,
            config.timeouts
        );
    }

    /**
     * @dev Get player's total earnings across all tournaments
     */
    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    /**
     * @dev Get real-time time remaining for both players
     */
    function getCurrentTimeRemaining(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (uint256 player1Time, uint256 player2Time) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (matchData.status != MatchStatus.InProgress) {
            return (matchData.player1TimeRemaining, matchData.player2TimeRemaining);
        }

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;

        player1Time = matchData.player1TimeRemaining;
        player2Time = matchData.player2TimeRemaining;

        // Deduct elapsed time from current player
        if (matchData.currentTurn == matchData.player1) {
            player1Time = (player1Time > elapsed) ? player1Time - elapsed : 0;
        } else {
            player2Time = (player2Time > elapsed) ? player2Time - elapsed : 0;
        }
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
     * @dev Check if player is in a specific tournament (enrolling or active)
     */
    function isPlayerInTournament(
        address player,
        uint8 tierId,
        uint8 instanceId
    ) external view returns (bool isEnrolling, bool isActive) {
        uint256 enrollingIdx = playerEnrollingIndex[player][tierId][instanceId];
        uint256 activeIdx = playerActiveIndex[player][tierId][instanceId];

        isEnrolling = enrollingIdx > 0 &&
                      enrollingIdx <= playerEnrollingTournaments[player].length &&
                      playerEnrollingTournaments[player][enrollingIdx - 1].tierId == tierId &&
                      playerEnrollingTournaments[player][enrollingIdx - 1].instanceId == instanceId;

        isActive = activeIdx > 0 &&
                   activeIdx <= playerActiveTournaments[player].length &&
                   playerActiveTournaments[player][activeIdx - 1].tierId == tierId &&
                   playerActiveTournaments[player][activeIdx - 1].instanceId == instanceId;
    }

    /**
     * @dev Tier configuration - access via inherited getTierConfig() from ETour_Storage
     */

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
        (bool success, bytes memory data) = MODULE_PRIZES.staticcall(
            abi.encodeWithSignature("getLeaderboard()")
        );
        require(success, "LB");
        return abi.decode(data, (LeaderboardEntry[]));
    }

    // ============ Player Tracking Hooks (Built-in Implementation) ============

    /**
     * @dev Hook: Called when player enrolls in tournament
     */
    function _onPlayerEnrolled(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal override {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook: Called when tournament starts
     * Atomic transition: Move ALL enrolled players from enrolling → active
     */
    function _onTournamentStarted(
        uint8 tierId,
        uint8 instanceId
    ) internal override {
        address[] storage players = enrolledPlayers[tierId][instanceId];

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            _removePlayerEnrollingTournament(player, tierId, instanceId);
            _addPlayerActiveTournament(player, tierId, instanceId);
        }
    }

    /**
     * @dev Hook: Called when player is eliminated from tournament
     * Only removes if player has NO remaining active matches
     */
    function _onPlayerEliminatedFromTournament(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal override {
        // Always remove from active tournaments after losing (player is eliminated)
        _removePlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook: Called when external player replaces stalled player (L3 escalation)
     */
    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal override {
        // External player joins mid-tournament, goes directly to active (skip enrolling)
        _addPlayerActiveTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook: Called when tournament completes
     * Clean up ALL player tracking for this tournament
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

    // ============ Player Tracking Helper Functions ============

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

    /**
     * @dev Check if player has any active matches in tournament
     */
    function _playerHasActiveMatchInTournament(
        address player,
        uint8 tierId,
        uint8 instanceId
    ) private view returns (bool) {
        bytes32[] storage activeMatches = playerActiveMatches[player];

        for (uint256 i = 0; i < activeMatches.length; i++) {
            bytes32 matchId = activeMatches[i];
            Match storage matchData = matches[matchId];

            // Check if this match belongs to the tournament
            // We need to decode tierId/instanceId from matchId
            // For now, iterate through rounds
            TournamentInstance storage tournament = tournaments[tierId][instanceId];
            for (uint8 round = 0; round <= tournament.currentRound; round++) {
                Round storage roundData = rounds[tierId][instanceId][round];
                for (uint8 matchNum = 0; matchNum < roundData.totalMatches; matchNum++) {
                    bytes32 checkId = _getMatchId(tierId, instanceId, round, matchNum);
                    if (checkId == matchId) {
                        return true;
                    }
                }
            }
        }

        return false;
    }
}
