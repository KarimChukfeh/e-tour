// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

/**
 * @title ChessOnChain
 * @dev Professional chess game implementing ETour tournament protocol (MODULAR VERSION)
 * Chess serves as the primary revenue driver in the ETour ecosystem.
 *
 * This contract demonstrates advanced ETour implementation with:
 * 1. Complex game state management (64-square board, piece types, special moves)
 * 2. Chess-specific tier configurations optimized for competitive play
 * 3. Full chess rule enforcement (castling, en passant, promotion, check/checkmate)
 *
 * MODULAR ARCHITECTURE:
 * - Inherits ETour_Storage for storage layout
 * - Delegates tournament logic to 6 stateless modules via delegatecall
 * - Modules: Core, Matches, Prizes, Raffle, Escalation, GameCache
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract ChessOnChain is ETour_Storage {

    uint8 public constant NO_SQUARE = 255;

    enum PieceType { None, Pawn, Knight, Bishop, Rook, Queen, King }
    enum PieceColor { None, White, Black }

    struct Piece {
        PieceType pieceType;
        PieceColor color;
    }

    struct ChessMatch {
        address player1;          // White
        address player2;          // Black
        address currentTurn;
        address winner;
        Piece[64] board;
        MatchStatus status;
        uint256 startTime;
        address firstPlayer;      // Always white in chess
        bool isDraw;
        
        // Chess-specific state
        bool whiteKingMoved;
        bool blackKingMoved;
        bool whiteRookAMoved;     // Queenside rook
        bool whiteRookHMoved;     // Kingside rook
        bool blackRookAMoved;
        bool blackRookHMoved;
        uint8 enPassantSquare;    // Square where en passant capture is possible (NO_SQUARE if none)
        uint16 halfMoveClock;     // For 50-move rule
        uint16 fullMoveNumber;
        bool whiteInCheck;
        bool blackInCheck;

        // Time Bank Fields (chess clock style)
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }


    /**
     * @dev Extended match data for Chess including common fields and game-specific state
     */
    struct ChessMatchData {
        CommonMatchData common;         // Embedded common data
        Piece[64] board;                      // 8x8 chess board
        address currentTurn;
        address firstPlayer;
        bool whiteInCheck;
        bool blackInCheck;
        uint8 enPassantSquare;
        uint16 halfMoveClock;
        uint16 fullMoveNumber;
        bool whiteKingSideCastle;             // Castling rights
        bool whiteQueenSideCastle;
        bool blackKingSideCastle;
        bool blackQueenSideCastle;
        uint256 player1TimeRemaining;         // Time bank for player1
        uint256 player2TimeRemaining;         // Time bank for player2
        uint256 lastMoveTimestamp;            // Timestamp of last move
    }

    mapping(bytes32 => ChessMatch) public chessMatches;

    // One-time initialization flag
    bool public allInstancesInitialized;

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

    event ChessMoveMade(bytes32 indexed matchId, address indexed player, uint8 from, uint8 to, PieceType promotion);
    event CheckDeclared(bytes32 indexed matchId, PieceColor kingColor);
    event CheckmateDeclared(bytes32 indexed matchId, address indexed winner, address indexed loser);
    event StalemateDeclared(bytes32 indexed matchId);
    event DrawByFiftyMoveRule(bytes32 indexed matchId);
    event DrawByInsufficientMaterial(bytes32 indexed matchId);
    event CastlingPerformed(bytes32 indexed matchId, address indexed player, bool kingSide);
    event EnPassantCapture(bytes32 indexed matchId, address indexed player, uint8 capturedSquare);
    event PawnPromoted(bytes32 indexed matchId, address indexed player, uint8 square, PieceType newPiece);
    event Resignation(bytes32 indexed matchId, address indexed resigningPlayer, address indexed winner);
    event AllInstancesInitialized(address indexed caller, uint8 tierCount);

    address public immutable MODULE_CHESS_RULES;

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress,
        address _moduleGameCacheAddress,
        address _moduleChessRulesAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress,
        _moduleGameCacheAddress
    ) {
        MODULE_CHESS_RULES = _moduleChessRulesAddress;

        // Register ChessOnChain's tournament tiers via delegatecall to Core module
        _registerChessOnChainTiers();
    }

    /**
     * @dev Register all tournament tiers for ChessOnChain
     * Simplified configuration with only 2-player and 4-player tiers
     */
    function _registerChessOnChainTiers() internal {
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // Winner takes all
        tier0Prizes[1] = 0;

        TimeoutConfig memory timeouts0 = TimeoutConfig({
            matchTimePerPlayer: 10 minutes,      // 10 minutes per player
            timeIncrementPerMove: 15 seconds,    // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 3 minutes,        // L2 starts 3 min after timeout
            matchLevel3Delay: 6 minutes,        // L3 starts 6 min after timeout (cumulative)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 5 minutes    // L2 starts 5 min after enrollment window
        });

        (bool success0, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                0,                    // tierId
                2,                    // playerCount
                100,                  // instanceCount
                0.01 ether,           // entryFee
                Mode.Classic,         // mode
                timeouts0,            // timeout configuration
                tier0Prizes           // prizeDistribution
            )
        );
        require(success0, "T0 reg fail");

        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 80;   // 1st: 80%
        tier1Prizes[1] = 20;   // 2nd: 20%
        tier1Prizes[2] = 0;    // 3rd: 0%
        tier1Prizes[3] = 0;    // 4th: 0%

        TimeoutConfig memory timeouts1 = TimeoutConfig({
            matchTimePerPlayer: 10 minutes,      // 10 minutes per player
            timeIncrementPerMove: 15 seconds,    // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 3 minutes,        // L2 starts 3 min after timeout
            matchLevel3Delay: 6 minutes,        // L3 starts 6 min after timeout (cumulative)
            enrollmentWindow: 30 minutes,       // 30 min to fill tournament
            enrollmentLevel2Delay: 5 minutes    // L2 starts 5 min after enrollment window
        });

        (bool success1, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                1,                    // tierId
                4,                    // playerCount
                50,                   // instanceCount
                0.02 ether,           // entryFee
                Mode.Pro,             // mode
                timeouts1,            // timeout configuration
                tier1Prizes           // prizeDistribution
            )
        );
        require(success1, "T1 reg fail");

        // Progressive thresholds: 0.6, 1.2, 1.8, 2.4, 3.0 ETH for first 5 raffles
        // Then 1.0 ETH for all subsequent raffles
        uint256[] memory thresholds = new uint256[](5);
        thresholds[0] = 0.6 ether;
        thresholds[1] = 1.2 ether;
        thresholds[2] = 1.8 ether;
        thresholds[3] = 2.4 ether;
        thresholds[4] = 3.0 ether;

        (bool successRaffle, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerRaffleThresholds(uint256[],uint256)",
                thresholds,
                1.0 ether
            )
        );
        require(successRaffle, "Raffle reg fail");
    }

    // ChessOnChain handles match creation directly instead of delegating to modules

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
                require(success, "Advance fail");
            }
        }
    }

    /**
     * @dev Get match count for round - helper function
     */
    function getMatchCountForRound(uint8 tierId, uint8 instanceId) public view returns (uint8) {
        return tournaments[tierId][instanceId].enrolledCount / 2;
    }

    /**
     * @dev Get tier configuration (public getter for internal _tierConfigs)
     */
    function getTierConfig(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee,
        Mode mode,
        uint8 totalRounds,
        bool initialized
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee,
            config.mode,
            config.totalRounds,
            config.initialized
        );
    }

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
        require(success, "Enroll fail");

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
        require(success, "Start fail");

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
        require(success, "Raffle fail");
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
        require(success, "Elim fail");
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
        require(success, "Replace fail");
    }

    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public override {
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Bad player");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];

        // Randomly assign colors
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            player1,
            player2,
            matchId
        )));
        
        if (randomness % 2 == 0) {
            matchData.player1 = player1;  // White
            matchData.player2 = player2;  // Black
        } else {
            matchData.player1 = player2;  // White
            matchData.player2 = player1;  // Black
        }

        matchData.currentTurn = matchData.player1;  // White moves first
        matchData.firstPlayer = matchData.player1;
        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.isDraw = false;

        _resetChessState(matchId);

        // Initialize time banks for both players
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;

        // Setup initial board position
        _setupInitialPosition(matchId);

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, matchData.player1, matchData.player2);
    }

    function _setupInitialPosition(bytes32 matchId) internal {
        ChessMatch storage matchData = chessMatches[matchId];

        // Clear the board first
        for (uint8 i = 0; i < 64; i++) {
            matchData.board[i] = Piece(PieceType.None, PieceColor.None);
        }

        // White pieces (ranks 1-2, squares 0-15)
        // Rank 1 (squares 0-7): Rook, Knight, Bishop, Queen, King, Bishop, Knight, Rook
        matchData.board[0] = Piece(PieceType.Rook, PieceColor.White);
        matchData.board[1] = Piece(PieceType.Knight, PieceColor.White);
        matchData.board[2] = Piece(PieceType.Bishop, PieceColor.White);
        matchData.board[3] = Piece(PieceType.Queen, PieceColor.White);
        matchData.board[4] = Piece(PieceType.King, PieceColor.White);
        matchData.board[5] = Piece(PieceType.Bishop, PieceColor.White);
        matchData.board[6] = Piece(PieceType.Knight, PieceColor.White);
        matchData.board[7] = Piece(PieceType.Rook, PieceColor.White);

        // Rank 2 (squares 8-15): White Pawns
        for (uint8 i = 8; i < 16; i++) {
            matchData.board[i] = Piece(PieceType.Pawn, PieceColor.White);
        }

        // Black pieces (ranks 7-8, squares 48-63)
        // Rank 7 (squares 48-55): Black Pawns
        for (uint8 i = 48; i < 56; i++) {
            matchData.board[i] = Piece(PieceType.Pawn, PieceColor.Black);
        }

        // Rank 8 (squares 56-63): Rook, Knight, Bishop, Queen, King, Bishop, Knight, Rook
        matchData.board[56] = Piece(PieceType.Rook, PieceColor.Black);
        matchData.board[57] = Piece(PieceType.Knight, PieceColor.Black);
        matchData.board[58] = Piece(PieceType.Bishop, PieceColor.Black);
        matchData.board[59] = Piece(PieceType.Queen, PieceColor.Black);
        matchData.board[60] = Piece(PieceType.King, PieceColor.Black);
        matchData.board[61] = Piece(PieceType.Bishop, PieceColor.Black);
        matchData.board[62] = Piece(PieceType.Knight, PieceColor.Black);
        matchData.board[63] = Piece(PieceType.Rook, PieceColor.Black);
    }

    function _resetMatchGame(bytes32 matchId) public override {
        ChessMatch storage matchData = chessMatches[matchId];
        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.lastMoveTimestamp = 0;
        matchData.startTime = 0;
        matchData.firstPlayer = address(0);
        matchData.isDraw = false;
        _resetChessState(matchId);
        for (uint8 i = 0; i < 64; i++) {
            matchData.board[i] = Piece(PieceType.None, PieceColor.None);
        }
    }

    function _resetChessState(bytes32 matchId) private {
        ChessMatch storage m = chessMatches[matchId];
        m.whiteKingMoved = m.blackKingMoved = false;
        m.whiteRookAMoved = m.whiteRookHMoved = false;
        m.blackRookAMoved = m.blackRookHMoved = false;
        m.enPassantSquare = NO_SQUARE;
        m.halfMoveClock = 0;
        m.fullMoveNumber = 1;
        m.whiteInCheck = m.blackInCheck = false;
    }

    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        ChessMatch storage matchData = chessMatches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];

        // Encode chess-specific board data
        bytes memory boardData = abi.encode(
            matchData.board,
            matchData.fullMoveNumber,
            matchData.whiteKingMoved,
            matchData.blackKingMoved,
            matchData.whiteRookAMoved,
            matchData.whiteRookHMoved,
            matchData.blackRookAMoved,
            matchData.blackRookHMoved,
            matchData.enPassantSquare,
            matchData.halfMoveClock
        );

        // Delegate to GameCacheModule
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
        require(success, "Cache fail");
    }

    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        ChessMatch storage matchData = chessMatches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _getTimeIncrement() public pure override returns (uint256) {
        return 15;
    }

    /**
     * @dev Check if the current player has run out of time
     * Used by escalation system to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

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
        ChessMatch storage matchData = chessMatches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
        ChessMatch storage matchData = chessMatches[matchId];

        require(matchData.player1 != matchData.player2, "Same player");

        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.currentTurn = matchData.player1;  // White moves first
        matchData.firstPlayer = matchData.player1;

        _resetChessState(matchId);

        // Initialize time banks for both players BEFORE board setup
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;

        _setupInitialPosition(matchId);
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        ChessMatch storage matchData = chessMatches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
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
        require(clearSuccess, "Clear fail");

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
                require(advanceSuccess, "Advance fail");
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
            (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeRound(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(completeSuccess, "Round fail");
        }

    }

    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
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
        ChessMatch storage matchData = chessMatches[matchId];

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
            lastMoveTime: matchData.lastMoveTimestamp,
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
        // Delegate to GameCacheModule
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

        return abi.decode(result, (CommonMatchData, bool));
    }

    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not player");
        require(msg.sender != matchData.currentTurn, "Your turn");

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
        require(timeElapsed >= opponentTimeRemaining, "Time remains");

        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, loser);

        completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    /**
     * @dev Make a chess move
     * @param tierId Tournament tier
     * @param instanceId Tournament instance
     * @param roundNumber Round number
     * @param matchNumber Match number
     * @param from Source square (0-63)
     * @param to Destination square (0-63)
     * @param promotion Piece type for pawn promotion (PieceType.None if not promoting)
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 from,
        uint8 to,
        PieceType promotion
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not player");
        require(msg.sender == matchData.currentTurn, "Wrong turn");
        require(from < 64 && to < 64, "Bad square");
        require(from != to, "Same square");

        PieceColor playerColor = (msg.sender == matchData.player1) ? PieceColor.White : PieceColor.Black;

        require(matchData.board[from].color == playerColor, "Bad piece");

        // Validate move by delegating to ChessRulesModule
        (bool success, bytes memory result) = MODULE_CHESS_RULES.delegatecall(
            abi.encodeWithSignature("isValidMove(bytes32,uint8,uint8,uint8)", matchId, from, to, uint8(promotion))
        );
        require(success && abi.decode(result, (bool)), "Bad move");

        // Execute the move
        _executeMove(matchId, from, to, promotion, tierId, instanceId, roundNumber, matchNumber);
    }

    function _executeMove(
        bytes32 matchId,
        uint8 from,
        uint8 to,
        PieceType promotion,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal {
        ChessMatch storage matchData = chessMatches[matchId];
        
        Piece memory movingPiece = matchData.board[from];
        Piece memory capturedPiece = matchData.board[to];
        PieceColor playerColor = movingPiece.color;
        
        bool isCapture = capturedPiece.pieceType != PieceType.None;
        bool isPawnMove = movingPiece.pieceType == PieceType.Pawn;
        
        // Handle special moves
        
        // Castling
        if (movingPiece.pieceType == PieceType.King) {
            int8 fileDiff = int8(to % 8) - int8(from % 8);
            if (fileDiff == 2 || fileDiff == -2) {
                _executeCastling(matchId, from, to, playerColor);
            }
            
            if (playerColor == PieceColor.White) {
                matchData.whiteKingMoved = true;
            } else {
                matchData.blackKingMoved = true;
            }
        }
        
        // Track rook movement for castling rights
        if (movingPiece.pieceType == PieceType.Rook) {
            if (from == 0) matchData.whiteRookAMoved = true;
            if (from == 7) matchData.whiteRookHMoved = true;
            if (from == 56) matchData.blackRookAMoved = true;
            if (from == 63) matchData.blackRookHMoved = true;
        }
        
        // En passant capture
        if (isPawnMove && to == matchData.enPassantSquare) {
            uint8 capturedPawnSquare = (playerColor == PieceColor.White) ? to - 8 : to + 8;
            matchData.board[capturedPawnSquare] = Piece(PieceType.None, PieceColor.None);
            isCapture = true;
            emit EnPassantCapture(matchId, msg.sender, capturedPawnSquare);
        }
        
        // Set en passant square for next move
        matchData.enPassantSquare = NO_SQUARE;
        if (isPawnMove) {
            int8 rankDiff = int8(to / 8) - int8(from / 8);
            if (rankDiff == 2 || rankDiff == -2) {
                matchData.enPassantSquare = (from + to) / 2;
            }
        }
        
        // Execute the move
        matchData.board[to] = movingPiece;
        matchData.board[from] = Piece(PieceType.None, PieceColor.None);
        
        // Pawn promotion
        if (isPawnMove) {
            uint8 toRank = to / 8;
            if ((playerColor == PieceColor.White && toRank == 7) || 
                (playerColor == PieceColor.Black && toRank == 0)) {
                require(promotion != PieceType.None && promotion != PieceType.Pawn && promotion != PieceType.King, "Promo");
                matchData.board[to] = Piece(promotion, playerColor);
                emit PawnPromoted(matchId, msg.sender, to, promotion);
            }
        }
        
        // Update game state
        if (isCapture || isPawnMove) {
            matchData.halfMoveClock = 0;
        } else {
            matchData.halfMoveClock++;
        }
        
        if (playerColor == PieceColor.Black) {
            matchData.fullMoveNumber++;
        }

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

        matchData.lastMoveTimestamp = block.timestamp;

        emit ChessMoveMade(matchId, msg.sender, from, to, promotion);

        // Switch turns
        matchData.currentTurn = (matchData.currentTurn == matchData.player1) ? matchData.player2 : matchData.player1;

        // Clear moving player's check status (they made a legal move, so not in check)
        if (playerColor == PieceColor.White) {
            matchData.whiteInCheck = false;
        } else {
            matchData.blackInCheck = false;
        }

        // Check for game end conditions
        PieceColor opponentColor = (playerColor == PieceColor.White) ? PieceColor.Black : PieceColor.White;

        // Delegate check detection to ChessRulesModule
        (bool checkSuccess, bytes memory checkResult) = MODULE_CHESS_RULES.delegatecall(
            abi.encodeWithSignature("isKingInCheck(bytes32,uint8)", matchId, uint8(opponentColor))
        );
        bool opponentInCheck = checkSuccess && checkResult.length > 0 && abi.decode(checkResult, (bool));

        (bool movesSuccess, bytes memory movesResult) = MODULE_CHESS_RULES.delegatecall(
            abi.encodeWithSignature("hasLegalMoves(bytes32,uint8)", matchId, uint8(opponentColor))
        );
        // If check fails, assume player has legal moves to avoid false stalemate
        bool opponentHasLegalMoves = !movesSuccess || (movesResult.length > 0 && abi.decode(movesResult, (bool)));
        
        if (opponentColor == PieceColor.White) {
            matchData.whiteInCheck = opponentInCheck;
        } else {
            matchData.blackInCheck = opponentInCheck;
        }
        
        if (opponentInCheck) {
            emit CheckDeclared(matchId, opponentColor);
            
            if (!opponentHasLegalMoves) {
                // Checkmate!
                address loser = (opponentColor == PieceColor.White) ? matchData.player1 : matchData.player2;
                emit CheckmateDeclared(matchId, msg.sender, loser);
                completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
                return;
            }
        } else if (!opponentHasLegalMoves) {
            // Stalemate - draw
            emit StalemateDeclared(matchId);
            completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        // Check for 50-move rule
        if (matchData.halfMoveClock >= 100) {  // 50 moves = 100 half-moves
            emit DrawByFiftyMoveRule(matchId);
            completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }

        // Check for insufficient material - delegate to ChessRulesModule
        (bool materialSuccess, bytes memory materialResult) = MODULE_CHESS_RULES.delegatecall(
            abi.encodeWithSignature("isInsufficientMaterial(bytes32)", matchId)
        );
        if (materialSuccess && abi.decode(materialResult, (bool))) {
            emit DrawByInsufficientMaterial(matchId);
            completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }
    }

    function _executeCastling(bytes32 matchId, uint8 kingFrom, uint8 kingTo, PieceColor color) internal {
        ChessMatch storage matchData = chessMatches[matchId];
        
        bool kingSide = (kingTo % 8) > (kingFrom % 8);
        uint8 rookFrom;
        uint8 rookTo;
        
        if (color == PieceColor.White) {
            if (kingSide) {
                rookFrom = 7;   // h1
                rookTo = 5;     // f1
            } else {
                rookFrom = 0;   // a1
                rookTo = 3;     // d1
            }
        } else {
            if (kingSide) {
                rookFrom = 63;  // h8
                rookTo = 61;    // f8
            } else {
                rookFrom = 56;  // a8
                rookTo = 59;    // d8
            }
        }
        
        // Move the rook
        matchData.board[rookTo] = matchData.board[rookFrom];
        matchData.board[rookFrom] = Piece(PieceType.None, PieceColor.None);
        
        emit CastlingPerformed(matchId, msg.sender, kingSide);
    }

    // Note: All chess rules validation logic has been moved to ChessRulesModule

    /**
     * @dev Get complete Chess match data with automatic cache fallback
     * NEW: Unifies fragmented getChessMatch/getBoard/getCastlingRights
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (ChessMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        // Call base to get active match data
        CommonMatchData memory common = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);

        ChessMatchData memory fullData;
        fullData.common = common;

        if (common.isCached) {
            // Populate from cache - LIMITED DATA!
            // Initialize empty board (default values)
            for (uint8 i = 0; i < 64; i++) {
                fullData.board[i] = Piece({pieceType: PieceType.None, color: PieceColor.None});
            }
            fullData.currentTurn = address(0);
            fullData.firstPlayer = common.player1;  // Assume player1 was first
            fullData.whiteInCheck = false;
            fullData.blackInCheck = false;
            fullData.enPassantSquare = 0;
            fullData.halfMoveClock = 0;
            fullData.fullMoveNumber = 1;  // Default for cached matches
            fullData.whiteKingSideCastle = false;
            fullData.whiteQueenSideCastle = false;
            fullData.blackKingSideCastle = false;
            fullData.blackQueenSideCastle = false;
            fullData.player1TimeRemaining = 0;  // N/A for completed matches
            fullData.player2TimeRemaining = 0;
            fullData.lastMoveTimestamp = 0;
        } else {
            // Populate from active storage - COMPLETE DATA
            ChessMatch storage matchData = chessMatches[matchId];
            fullData.board = matchData.board;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.whiteInCheck = matchData.whiteInCheck;
            fullData.blackInCheck = matchData.blackInCheck;
            fullData.enPassantSquare = matchData.enPassantSquare;
            fullData.halfMoveClock = matchData.halfMoveClock;
            fullData.fullMoveNumber = matchData.fullMoveNumber;
            fullData.whiteKingSideCastle = !matchData.whiteKingMoved && !matchData.whiteRookHMoved;
            fullData.whiteQueenSideCastle = !matchData.whiteKingMoved && !matchData.whiteRookAMoved;
            fullData.blackKingSideCastle = !matchData.blackKingMoved && !matchData.blackRookHMoved;
            fullData.blackQueenSideCastle = !matchData.blackKingMoved && !matchData.blackRookAMoved;
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
        ChessMatch storage matchData = chessMatches[matchId];

        // For completed or not started matches, return stored values
        CommonMatchData memory common = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (common.status != MatchStatus.InProgress) {
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

    function getChessMatch(uint8 t, uint8 i, uint8 r, uint8 m) external view returns (
        address, address, address, address, MatchStatus, bool, uint256, uint256, uint16, bool, bool
    ) {
        ChessMatch storage d = chessMatches[_getMatchId(t, i, r, m)];
        return (d.player1, d.player2, d.currentTurn, d.winner, d.status, d.isDraw,
                d.startTime, d.lastMoveTimestamp, d.fullMoveNumber, d.whiteInCheck, d.blackInCheck);
    }

    function getBoard(uint8 t, uint8 i, uint8 r, uint8 m) external view returns (Piece[64] memory) {
        return chessMatches[_getMatchId(t, i, r, m)].board;
    }

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
     * @dev Check if player is in specific tournament (either enrolling or active)
     */
    function isPlayerInTournament(address player, uint8 tierId, uint8 instanceId)
        external view returns (bool isEnrolling, bool isActive)
    {
        isEnrolling = playerEnrollingIndex[player][tierId][instanceId] != 0;
        isActive = playerActiveIndex[player][tierId][instanceId] != 0;
    }

    /**
     * @dev Override to provide Chess-specific game metadata
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
            "ChessOnChain",
            "1.0.0",
            "Full chess implementation with tournaments, special moves, and draw conditions"
        );
    }

    // ============ Module Delegate Functions ============

    /**
     * @dev LeaderboardEntry struct for decoding
     */
    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    /**
     * @dev Get player's active matches
     */
    function getPlayerActiveMatches(address player) external view returns (bytes32[] memory) {
        return playerActiveMatches[player];
    }

    /**
     * @dev Get enrolled players for a tournament instance
     */
    function getEnrolledPlayers(uint8 tierId, uint8 instanceId) external view returns (address[] memory) {
        return enrolledPlayers[tierId][instanceId];
    }

    /**
     * @dev Get round information
     */
    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (
        uint8 totalMatches,
        uint8 completedMatches,
        bool initialized
    ) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        return (round.totalMatches, round.completedMatches, round.initialized);
    }

    /**
     * @dev Get player's total earnings
     */
    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    /**
     * @dev Get overview of all instances in a tier
     */
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

    /**
     * @dev Get current raffle threshold based on raffle index
     */
    function _getRaffleThreshold() internal view returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise use the final threshold for all subsequent raffles
        return raffleThresholdFinal;
    }

    /**
     * @dev Get raffle configuration
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

    /**
     * @dev Get tier information
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
     * @dev Get tier prize distribution
     */
    function getTierPrizeDistribution(uint8 tierId) external view returns (uint8[] memory percentages) {
        require(_tierConfigs[tierId].initialized, "Invalid tier");
        return _tierPrizeDistribution[tierId];
    }

    /**
     * @dev Get raffle thresholds configuration
     */
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

    /**
     * @dev Check if enrollment window can be reset
     */
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool canReset) {
        (bool success, bytes memory data) = MODULE_CORE.staticcall(
            abi.encodeWithSignature("canResetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "Check reset failed");
        return abi.decode(data, (bool));
    }

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
}
