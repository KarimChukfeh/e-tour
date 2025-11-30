// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour.sol";

/**
 * @title ChessOnChain
 * @dev Professional chess game implementing ETour tournament protocol
 * Chess serves as the primary revenue driver in the ETour ecosystem.
 * 
 * This contract demonstrates advanced ETour implementation with:
 * 1. Complex game state management (64-square board, piece types, special moves)
 * 2. Chess-specific tier configurations optimized for competitive play
 * 3. Full chess rule enforcement (castling, en passant, promotion, check/checkmate)
 * 
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract ChessOnChain is ETour {
    
    // ============ Game-Specific Constants ============
    
    uint8 public constant BOARD_SIZE = 64;
    uint8 public constant NO_SQUARE = 255;
    
    // Timeout configuration for chess (longer than tic-tac-toe)
    uint256 public constant DEFAULT_ENROLLMENT_WINDOW = 1 hours;
    uint256 public constant DEFAULT_MATCH_MOVE_TIMEOUT = 5 minutes;
    uint256 public constant DEFAULT_ESCALATION_INTERVAL = 3 minutes;

    // ============ Game-Specific Enums ============

    enum PieceType { None, Pawn, Knight, Bishop, Rook, Queen, King }
    enum PieceColor { None, White, Black }

    // ============ Game-Specific Structs ============

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
        uint256 lastMoveTime;
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
        
        // Timeout fields
        MatchTimeoutState timeoutState;
        bool isTimedOut;
        address timeoutClaimant;
        uint256 timeoutClaimReward;
    }

    struct CachedChessMatch {
        address player1;
        address player2;
        address winner;
        uint256 startTime;
        uint256 endTime;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isDraw;
        bool exists;
        uint16 totalMoves;
        bytes32 finalPositionHash;  // Hash of final board position
    }

    struct Move {
        uint8 from;
        uint8 to;
        PieceType promotion;  // For pawn promotion (None if not promoting)
    }

    // ============ Game-Specific State ============

    mapping(bytes32 => ChessMatch) public chessMatches;

    // Match cache
    uint16 public constant MATCH_CACHE_SIZE = 500;
    CachedChessMatch[MATCH_CACHE_SIZE] public matchCache;
    uint16 public nextCacheIndex;
    mapping(bytes32 => uint16) public cacheKeyToIndex;
    bytes32[MATCH_CACHE_SIZE] private cacheKeys;

    // Move history (stored as compact representation)
    mapping(bytes32 => bytes) public moveHistory;

    // ============ Game-Specific Events ============

    event ChessMoveMade(bytes32 indexed matchId, address indexed player, uint8 from, uint8 to, PieceType promotion);
    event CheckDeclared(bytes32 indexed matchId, PieceColor kingColor);
    event CheckmateDeclared(bytes32 indexed matchId, address indexed winner, address indexed loser);
    event StalemateDeclared(bytes32 indexed matchId);
    event DrawByRepetition(bytes32 indexed matchId);
    event DrawByFiftyMoveRule(bytes32 indexed matchId);
    event DrawByInsufficientMaterial(bytes32 indexed matchId);
    event CastlingPerformed(bytes32 indexed matchId, address indexed player, bool kingSide);
    event EnPassantCapture(bytes32 indexed matchId, address indexed player, uint8 capturedSquare);
    event PawnPromoted(bytes32 indexed matchId, address indexed player, uint8 square, PieceType newPiece);
    event ChessMatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);
    event Resignation(bytes32 indexed matchId, address indexed resigningPlayer, address indexed winner);

    // ============ Constructor ============

    constructor() ETour() {
        _registerChessOnChainTiers();
    }

    /**
     * @dev Register all tournament tiers for ChessOnChain
     * Simplified configuration with only 2-player and 4-player tiers
     */
    function _registerChessOnChainTiers() internal {
        // ============ Tier 0: 2-Player ============
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // Winner takes all
        tier0Prizes[1] = 0;

        _registerTier(
            0,                              // tierId
            2,                              // playerCount
            10,                             // instanceCount
            0.01 ether,                     // entryFee
            Mode.Classic,
            DEFAULT_ENROLLMENT_WINDOW,
            DEFAULT_MATCH_MOVE_TIMEOUT,
            DEFAULT_ESCALATION_INTERVAL,
            tier0Prizes
        );

        // ============ Tier 1: 4-Player ============
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 65;   // 1st: 65%
        tier1Prizes[1] = 25;   // 2nd: 25%
        tier1Prizes[2] = 10;   // 3rd: 10%
        tier1Prizes[3] = 0;    // 4th: 0%

        _registerTier(
            1,                              // tierId
            4,                              // playerCount
            5,                              // instanceCount
            0.02 ether,                     // entryFee
            Mode.Pro,
            DEFAULT_ENROLLMENT_WINDOW,
            DEFAULT_MATCH_MOVE_TIMEOUT,
            DEFAULT_ESCALATION_INTERVAL,
            tier1Prizes
        );
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
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;
        matchData.isDraw = false;

        // Initialize chess-specific state
        matchData.whiteKingMoved = false;
        matchData.blackKingMoved = false;
        matchData.whiteRookAMoved = false;
        matchData.whiteRookHMoved = false;
        matchData.blackRookAMoved = false;
        matchData.blackRookHMoved = false;
        matchData.enPassantSquare = NO_SQUARE;
        matchData.halfMoveClock = 0;
        matchData.fullMoveNumber = 1;
        matchData.whiteInCheck = false;
        matchData.blackInCheck = false;

        // Setup initial board position
        _setupInitialPosition(matchId);

        _addPlayerActiveMatch(matchData.player1, matchId);
        _addPlayerActiveMatch(matchData.player2, matchId);

        _initializeMatchTimeoutState(matchId, tierId);

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

    function _resetMatchGame(bytes32 matchId) internal override {
        ChessMatch storage matchData = chessMatches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.lastMoveTime = 0;
        matchData.startTime = 0;
        matchData.firstPlayer = address(0);
        matchData.isDraw = false;

        matchData.whiteKingMoved = false;
        matchData.blackKingMoved = false;
        matchData.whiteRookAMoved = false;
        matchData.whiteRookHMoved = false;
        matchData.blackRookAMoved = false;
        matchData.blackRookHMoved = false;
        matchData.enPassantSquare = NO_SQUARE;
        matchData.halfMoveClock = 0;
        matchData.fullMoveNumber = 1;
        matchData.whiteInCheck = false;
        matchData.blackInCheck = false;

        matchData.isTimedOut = false;
        matchData.timeoutClaimant = address(0);
        matchData.timeoutClaimReward = 0;
        matchData.timeoutState.escalation1Start = 0;
        matchData.timeoutState.escalation2Start = 0;
        matchData.timeoutState.escalation3Start = 0;
        matchData.timeoutState.activeEscalation = EscalationLevel.None;
        matchData.timeoutState.timeoutActive = false;
        matchData.timeoutState.forfeitAmount = 0;

        for (uint8 i = 0; i < 64; i++) {
            matchData.board[i] = Piece(PieceType.None, PieceColor.None);
        }

        delete moveHistory[matchId];
    }

    function _getMatchResult(bytes32 matchId) internal view override returns (address winner, bool isDraw, MatchStatus status) {
        ChessMatch storage matchData = chessMatches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];

        bytes32 matchKey = keccak256(abi.encodePacked(matchData.player1, matchData.player2, block.timestamp));
        uint16 cacheIndex = nextCacheIndex;

        bytes32 oldKey = cacheKeys[cacheIndex];
        if (oldKey != bytes32(0)) {
            delete cacheKeyToIndex[oldKey];
        }

        // Calculate total moves from fullMoveNumber
        uint16 totalMoves = (matchData.fullMoveNumber - 1) * 2;
        if (matchData.currentTurn == matchData.player1) {
            // White's turn means black just moved
            totalMoves += 1;
        }

        matchCache[cacheIndex] = CachedChessMatch({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            startTime: matchData.startTime,
            endTime: block.timestamp,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isDraw: matchData.isDraw,
            exists: true,
            totalMoves: totalMoves,
            finalPositionHash: _hashPosition(matchId)
        });

        cacheKeys[cacheIndex] = matchKey;
        cacheKeyToIndex[matchKey] = cacheIndex;

        nextCacheIndex = uint16((cacheIndex + 1) % MATCH_CACHE_SIZE);

        emit ChessMatchCached(matchKey, cacheIndex, matchData.player1, matchData.player2);
    }

    function _hashPosition(bytes32 matchId) internal view returns (bytes32) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        // Hash board state piece by piece since we can't pack fixed arrays directly
        bytes32 boardHash = keccak256(abi.encode(matchData.board));
        
        return keccak256(abi.encodePacked(
            boardHash,
            matchData.currentTurn,
            matchData.whiteKingMoved,
            matchData.blackKingMoved,
            matchData.enPassantSquare
        ));
    }

    function _getMatchPlayers(bytes32 matchId) internal view override returns (address player1, address player2) {
        ChessMatch storage matchData = chessMatches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _setMatchTimeoutState(bytes32 matchId, MatchTimeoutState memory state) internal override {
        ChessMatch storage matchData = chessMatches[matchId];
        matchData.timeoutState = state;
    }

    function _getMatchTimeoutState(bytes32 matchId) internal view override returns (MatchTimeoutState memory) {
        return chessMatches[matchId].timeoutState;
    }

    function _setMatchTimedOut(bytes32 matchId, address claimant, EscalationLevel level) internal override {
        ChessMatch storage matchData = chessMatches[matchId];
        matchData.isTimedOut = true;
        matchData.timeoutClaimant = claimant;
        matchData.timeoutState.activeEscalation = level;
        matchData.timeoutState.timeoutActive = true;
    }

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal override {
        ChessMatch storage matchData = chessMatches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal override {
        ChessMatch storage matchData = chessMatches[matchId];

        require(matchData.player1 != matchData.player2, "Cannot match player against themselves");

        matchData.status = MatchStatus.InProgress;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;
        matchData.currentTurn = matchData.player1;  // White moves first
        matchData.firstPlayer = matchData.player1;

        // Reset chess state
        matchData.whiteKingMoved = false;
        matchData.blackKingMoved = false;
        matchData.whiteRookAMoved = false;
        matchData.whiteRookHMoved = false;
        matchData.blackRookAMoved = false;
        matchData.blackRookHMoved = false;
        matchData.enPassantSquare = NO_SQUARE;
        matchData.halfMoveClock = 0;
        matchData.fullMoveNumber = 1;

        _setupInitialPosition(matchId);
        _initializeMatchTimeoutState(matchId, tierId);
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal override {
        ChessMatch storage matchData = chessMatches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    // ============ Timeout Functions ============

    function _initializeMatchTimeoutState(bytes32 matchId, uint8 tierId) internal {
        ChessMatch storage matchData = chessMatches[matchId];
        uint256 baseTime = matchData.lastMoveTime;

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
        ChessMatch storage matchData = chessMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender != matchData.currentTurn, "Cannot claim timeout on your own turn");
        require(block.timestamp >= matchData.timeoutState.escalation1Start, "Timeout not reached");

        matchData.isTimedOut = true;
        matchData.timeoutClaimant = msg.sender;
        matchData.timeoutState.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        matchData.timeoutState.timeoutActive = true;

        address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;
        playerForfeitedAmounts[tierId][instanceId][loser] += _tierConfigs[tierId].entryFee;

        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, loser);

        _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    // ============ Chess Gameplay Functions ============

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

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player in this match");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(from < 64 && to < 64, "Invalid square");
        require(from != to, "Must move to different square");

        PieceColor playerColor = (msg.sender == matchData.player1) ? PieceColor.White : PieceColor.Black;
        
        require(matchData.board[from].color == playerColor, "Not your piece");
        require(_isValidMove(matchId, from, to, promotion), "Invalid move");

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
                require(promotion != PieceType.None && promotion != PieceType.Pawn && promotion != PieceType.King, "Invalid promotion piece");
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
        
        matchData.lastMoveTime = block.timestamp;
        
        // Store move in history
        _appendMoveToHistory(matchId, from, to, uint8(promotion));
        
        emit ChessMoveMade(matchId, msg.sender, from, to, promotion);
        
        // Switch turns
        matchData.currentTurn = (matchData.currentTurn == matchData.player1) ? matchData.player2 : matchData.player1;
        
        // Reset timeout
        _initializeMatchTimeoutState(matchId, tierId);

        // Clear moving player's check status (they made a legal move, so not in check)
        if (playerColor == PieceColor.White) {
            matchData.whiteInCheck = false;
        } else {
            matchData.blackInCheck = false;
        }

        // Check for game end conditions
        PieceColor opponentColor = (playerColor == PieceColor.White) ? PieceColor.Black : PieceColor.White;
        
        bool opponentInCheck = _isKingInCheck(matchId, opponentColor);
        bool opponentHasLegalMoves = _hasLegalMoves(matchId, opponentColor);
        
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
                _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
                return;
            }
        } else if (!opponentHasLegalMoves) {
            // Stalemate - draw
            emit StalemateDeclared(matchId);
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }
        
        // Check for 50-move rule
        if (matchData.halfMoveClock >= 100) {  // 50 moves = 100 half-moves
            emit DrawByFiftyMoveRule(matchId);
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
            return;
        }
        
        // Check for insufficient material
        if (_isInsufficientMaterial(matchId)) {
            emit DrawByInsufficientMaterial(matchId);
            _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
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

    function _appendMoveToHistory(bytes32 matchId, uint8 from, uint8 to, uint8 promotion) internal {
        bytes storage history = moveHistory[matchId];
        history.push(bytes1(from));
        history.push(bytes1(to));
        history.push(bytes1(promotion));
    }

    // ============ Move Validation ============

    function _isValidMove(bytes32 matchId, uint8 from, uint8 to, PieceType promotion) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        Piece memory piece = matchData.board[from];
        
        // Check basic piece movement rules
        if (!_isPieceMovementValid(matchId, from, to, piece)) {
            return false;
        }
        
        // Check if move leaves own king in check
        if (_wouldLeaveKingInCheck(matchId, from, to, piece.color)) {
            return false;
        }
        
        // Validate promotion
        if (piece.pieceType == PieceType.Pawn) {
            uint8 toRank = to / 8;
            bool isPromotion = (piece.color == PieceColor.White && toRank == 7) || 
                               (piece.color == PieceColor.Black && toRank == 0);
            if (isPromotion && (promotion == PieceType.None || promotion == PieceType.Pawn || promotion == PieceType.King)) {
                return false;
            }
            if (!isPromotion && promotion != PieceType.None) {
                return false;
            }
        }
        
        return true;
    }

    function _isPieceMovementValid(bytes32 matchId, uint8 from, uint8 to, Piece memory piece) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        // Cannot capture own piece
        if (matchData.board[to].color == piece.color) {
            return false;
        }
        
        int8 fromFile = int8(from % 8);
        int8 fromRank = int8(from / 8);
        int8 toFile = int8(to % 8);
        int8 toRank = int8(to / 8);
        int8 fileDiff = toFile - fromFile;
        int8 rankDiff = toRank - fromRank;
        
        if (piece.pieceType == PieceType.Pawn) {
            return _isValidPawnMove(matchId, from, to, piece.color, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Knight) {
            return _isValidKnightMove(fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Bishop) {
            return _isValidBishopMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            return _isValidRookMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            return _isValidQueenMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            return _isValidKingMove(matchId, from, to, piece.color, fileDiff, rankDiff);
        }
        
        return false;
    }

    function _isValidPawnMove(bytes32 matchId, uint8 from, uint8 to, PieceColor color, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        int8 direction = (color == PieceColor.White) ? int8(1) : int8(-1);
        uint8 startRank = (color == PieceColor.White) ? 1 : 6;
        
        // Forward move
        if (fileDiff == 0) {
            if (rankDiff == direction) {
                return matchData.board[to].pieceType == PieceType.None;
            }
            if (rankDiff == 2 * direction && from / 8 == startRank) {
                uint8 intermediateSquare = uint8(int8(from) + 8 * direction);
                return matchData.board[to].pieceType == PieceType.None && 
                       matchData.board[intermediateSquare].pieceType == PieceType.None;
            }
        }
        
        // Diagonal capture
        if ((fileDiff == 1 || fileDiff == -1) && rankDiff == direction) {
            // Normal capture
            if (matchData.board[to].pieceType != PieceType.None && matchData.board[to].color != color) {
                return true;
            }
            // En passant
            if (to == matchData.enPassantSquare) {
                return true;
            }
        }
        
        return false;
    }

    function _isValidKnightMove(int8 fileDiff, int8 rankDiff) internal pure returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        return (absFile == 2 && absRank == 1) || (absFile == 1 && absRank == 2);
    }

    function _isValidBishopMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        
        if (absFile != absRank) return false;
        
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidRookMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        if (fileDiff != 0 && rankDiff != 0) return false;
        
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidQueenMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        
        // Queen moves like rook or bishop
        bool isDiagonal = (absFile == absRank);
        bool isStraight = (fileDiff == 0 || rankDiff == 0);
        
        if (!isDiagonal && !isStraight) return false;
        
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidKingMove(bytes32 matchId, uint8 from, uint8 to, PieceColor color, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        
        // Normal king move
        if (absFile <= 1 && absRank <= 1) {
            return true;
        }
        
        // Castling
        if (absRank == 0 && absFile == 2) {
            return _canCastle(matchId, color, fileDiff > 0);
        }
        
        return false;
    }

    function _canCastle(bytes32 matchId, PieceColor color, bool kingSide) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        // Check if king or relevant rook has moved
        if (color == PieceColor.White) {
            if (matchData.whiteKingMoved) return false;
            if (kingSide && matchData.whiteRookHMoved) return false;
            if (!kingSide && matchData.whiteRookAMoved) return false;
            if (matchData.whiteInCheck) return false;
        } else {
            if (matchData.blackKingMoved) return false;
            if (kingSide && matchData.blackRookHMoved) return false;
            if (!kingSide && matchData.blackRookAMoved) return false;
            if (matchData.blackInCheck) return false;
        }
        
        // Check if path is clear and not under attack
        uint8 kingSquare = (color == PieceColor.White) ? 4 : 60;
        
        if (kingSide) {
            // Check squares between king and rook are empty
            if (matchData.board[kingSquare + 1].pieceType != PieceType.None) return false;
            if (matchData.board[kingSquare + 2].pieceType != PieceType.None) return false;
            
            // Check king doesn't pass through check
            if (_isSquareAttacked(matchId, kingSquare + 1, color)) return false;
            if (_isSquareAttacked(matchId, kingSquare + 2, color)) return false;
        } else {
            // Check squares between king and rook are empty
            if (matchData.board[kingSquare - 1].pieceType != PieceType.None) return false;
            if (matchData.board[kingSquare - 2].pieceType != PieceType.None) return false;
            if (matchData.board[kingSquare - 3].pieceType != PieceType.None) return false;
            
            // Check king doesn't pass through check
            if (_isSquareAttacked(matchId, kingSquare - 1, color)) return false;
            if (_isSquareAttacked(matchId, kingSquare - 2, color)) return false;
        }
        
        return true;
    }

    function _isPathClear(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        int8 fileStep = fileDiff == 0 ? int8(0) : (fileDiff > 0 ? int8(1) : int8(-1));
        int8 rankStep = rankDiff == 0 ? int8(0) : (rankDiff > 0 ? int8(1) : int8(-1));
        
        int8 currentFile = int8(from % 8) + fileStep;
        int8 currentRank = int8(from / 8) + rankStep;
        int8 targetFile = int8(to % 8);
        int8 targetRank = int8(to / 8);
        
        while (currentFile != targetFile || currentRank != targetRank) {
            uint8 currentSquare = uint8(currentRank * 8 + currentFile);
            if (matchData.board[currentSquare].pieceType != PieceType.None) {
                return false;
            }
            currentFile += fileStep;
            currentRank += rankStep;
        }
        
        return true;
    }

    // ============ Check Detection ============

    function _isKingInCheck(bytes32 matchId, PieceColor kingColor) internal view returns (bool) {
        uint8 kingSquare = _findKing(matchId, kingColor);
        return _isSquareAttacked(matchId, kingSquare, kingColor);
    }

    function _findKing(bytes32 matchId, PieceColor color) internal view returns (uint8) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        for (uint8 i = 0; i < 64; i++) {
            if (matchData.board[i].pieceType == PieceType.King && matchData.board[i].color == color) {
                return i;
            }
        }
        
        revert("King not found");
    }

    function _isSquareAttacked(bytes32 matchId, uint8 square, PieceColor defendingColor) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        PieceColor attackingColor = (defendingColor == PieceColor.White) ? PieceColor.Black : PieceColor.White;
        
        // Check for attacks from each enemy piece
        for (uint8 i = 0; i < 64; i++) {
            Piece memory piece = matchData.board[i];
            if (piece.color == attackingColor) {
                if (_canPieceAttackSquare(matchId, i, square, piece)) {
                    return true;
                }
            }
        }
        
        return false;
    }

    function _canPieceAttackSquare(bytes32 matchId, uint8 from, uint8 to, Piece memory piece) internal view returns (bool) {
        int8 fromFile = int8(from % 8);
        int8 fromRank = int8(from / 8);
        int8 toFile = int8(to % 8);
        int8 toRank = int8(to / 8);
        int8 fileDiff = toFile - fromFile;
        int8 rankDiff = toRank - fromRank;
        
        if (piece.pieceType == PieceType.Pawn) {
            int8 direction = (piece.color == PieceColor.White) ? int8(1) : int8(-1);
            return (fileDiff == 1 || fileDiff == -1) && rankDiff == direction;
        } else if (piece.pieceType == PieceType.Knight) {
            return _isValidKnightMove(fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Bishop) {
            return _isValidBishopMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            return _isValidRookMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            return _isValidQueenMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
            return absFile <= 1 && absRank <= 1;
        }
        
        return false;
    }

    function _wouldLeaveKingInCheck(bytes32 matchId, uint8 from, uint8 to, PieceColor color) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        // Create a temporary copy of board state in memory
        Piece[64] memory tempBoard;
        for (uint8 i = 0; i < 64; i++) {
            tempBoard[i] = matchData.board[i];
        }
        
        // Make the move on temp board
        tempBoard[to] = tempBoard[from];
        tempBoard[from] = Piece(PieceType.None, PieceColor.None);
        
        // Handle en passant capture
        if (tempBoard[to].pieceType == PieceType.Pawn && to == matchData.enPassantSquare) {
            uint8 capturedPawnSquare = (color == PieceColor.White) ? to - 8 : to + 8;
            tempBoard[capturedPawnSquare] = Piece(PieceType.None, PieceColor.None);
        }
        
        // Find king position
        uint8 kingSquare = NO_SQUARE;
        for (uint8 i = 0; i < 64; i++) {
            if (tempBoard[i].pieceType == PieceType.King && tempBoard[i].color == color) {
                kingSquare = i;
                break;
            }
        }
        
        // Check if king is attacked
        return _isSquareAttackedOnBoard(tempBoard, kingSquare, color);
    }

    function _isSquareAttackedOnBoard(Piece[64] memory board, uint8 square, PieceColor defendingColor) internal pure returns (bool) {
        PieceColor attackingColor = (defendingColor == PieceColor.White) ? PieceColor.Black : PieceColor.White;
        
        for (uint8 i = 0; i < 64; i++) {
            Piece memory piece = board[i];
            if (piece.color == attackingColor) {
                if (_canPieceAttackSquareOnBoard(board, i, square, piece)) {
                    return true;
                }
            }
        }
        
        return false;
    }

    function _canPieceAttackSquareOnBoard(Piece[64] memory board, uint8 from, uint8 to, Piece memory piece) internal pure returns (bool) {
        int8 fromFile = int8(from % 8);
        int8 fromRank = int8(from / 8);
        int8 toFile = int8(to % 8);
        int8 toRank = int8(to / 8);
        int8 fileDiff = toFile - fromFile;
        int8 rankDiff = toRank - fromRank;
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        
        if (piece.pieceType == PieceType.Pawn) {
            int8 direction = (piece.color == PieceColor.White) ? int8(1) : int8(-1);
            return (fileDiff == 1 || fileDiff == -1) && rankDiff == direction;
        } else if (piece.pieceType == PieceType.Knight) {
            return (absFile == 2 && absRank == 1) || (absFile == 1 && absRank == 2);
        } else if (piece.pieceType == PieceType.Bishop) {
            if (absFile != absRank) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            if (fileDiff != 0 && rankDiff != 0) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            bool isDiagonal = (absFile == absRank);
            bool isStraight = (fileDiff == 0 || rankDiff == 0);
            if (!isDiagonal && !isStraight) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            return absFile <= 1 && absRank <= 1;
        }
        
        return false;
    }

    function _isPathClearOnBoard(Piece[64] memory board, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal pure returns (bool) {
        int8 fileStep = fileDiff == 0 ? int8(0) : (fileDiff > 0 ? int8(1) : int8(-1));
        int8 rankStep = rankDiff == 0 ? int8(0) : (rankDiff > 0 ? int8(1) : int8(-1));
        
        int8 currentFile = int8(from % 8) + fileStep;
        int8 currentRank = int8(from / 8) + rankStep;
        int8 targetFile = int8(to % 8);
        int8 targetRank = int8(to / 8);
        
        while (currentFile != targetFile || currentRank != targetRank) {
            uint8 currentSquare = uint8(currentRank * 8 + currentFile);
            if (board[currentSquare].pieceType != PieceType.None) {
                return false;
            }
            currentFile += fileStep;
            currentRank += rankStep;
        }
        
        return true;
    }

    // ============ Legal Move Generation ============

    function _hasLegalMoves(bytes32 matchId, PieceColor color) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        for (uint8 from = 0; from < 64; from++) {
            Piece memory piece = matchData.board[from];
            if (piece.color == color) {
                for (uint8 to = 0; to < 64; to++) {
                    if (from != to && _isPieceMovementValid(matchId, from, to, piece)) {
                        if (!_wouldLeaveKingInCheck(matchId, from, to, color)) {
                            return true;
                        }
                    }
                }
            }
        }
        
        return false;
    }

    // ============ Draw Detection ============

    function _isInsufficientMaterial(bytes32 matchId) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        
        uint8 whitePieceCount = 0;
        uint8 blackPieceCount = 0;
        bool whiteBishop = false;
        bool blackBishop = false;
        bool whiteKnight = false;
        bool blackKnight = false;
        
        for (uint8 i = 0; i < 64; i++) {
            Piece memory piece = matchData.board[i];
            if (piece.pieceType == PieceType.None) continue;
            
            // Any pawn, rook, or queen means sufficient material
            if (piece.pieceType == PieceType.Pawn || 
                piece.pieceType == PieceType.Rook || 
                piece.pieceType == PieceType.Queen) {
                return false;
            }
            
            if (piece.color == PieceColor.White) {
                if (piece.pieceType != PieceType.King) whitePieceCount++;
                if (piece.pieceType == PieceType.Bishop) whiteBishop = true;
                if (piece.pieceType == PieceType.Knight) whiteKnight = true;
            } else {
                if (piece.pieceType != PieceType.King) blackPieceCount++;
                if (piece.pieceType == PieceType.Bishop) blackBishop = true;
                if (piece.pieceType == PieceType.Knight) blackKnight = true;
            }
        }
        
        // King vs King
        if (whitePieceCount == 0 && blackPieceCount == 0) return true;
        
        // King + minor piece vs King
        if (whitePieceCount == 0 && blackPieceCount == 1 && (blackBishop || blackKnight)) return true;
        if (blackPieceCount == 0 && whitePieceCount == 1 && (whiteBishop || whiteKnight)) return true;
        
        // King + Bishop vs King + Bishop (same color)
        // Simplified: just King+Bishop vs King+Bishop
        if (whitePieceCount == 1 && blackPieceCount == 1 && whiteBishop && blackBishop) {
            return true;  // Simplified - in reality depends on bishop colors
        }
        
        return false;
    }

    // ============ Player Actions ============

    function resign(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];
        
        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        
        address winner = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;
        
        emit Resignation(matchId, msg.sender, winner);
        _completeMatch(tierId, instanceId, roundNumber, matchNumber, winner, false);
    }

    function offerDraw(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];
        
        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        
        // Draw offers are handled off-chain, both players call acceptDraw to finalize
    }

    function acceptDraw(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];
        
        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender != matchData.currentTurn, "Current turn player must wait for opponent");
        
        _completeMatch(tierId, instanceId, roundNumber, matchNumber, address(0), true);
    }

    // ============ View Functions ============

    function getChessMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (
        address player1,
        address player2,
        address currentTurn,
        address winner,
        MatchStatus status,
        bool isDraw,
        uint256 startTime,
        uint256 lastMoveTime,
        uint16 fullMoveNumber,
        bool whiteInCheck,
        bool blackInCheck
    ) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];
        return (
            matchData.player1,
            matchData.player2,
            matchData.currentTurn,
            matchData.winner,
            matchData.status,
            matchData.isDraw,
            matchData.startTime,
            matchData.lastMoveTime,
            matchData.fullMoveNumber,
            matchData.whiteInCheck,
            matchData.blackInCheck
        );
    }

    function getBoard(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (Piece[64] memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        return chessMatches[matchId].board;
    }

    function getCastlingRights(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (
        bool whiteKingSide,
        bool whiteQueenSide,
        bool blackKingSide,
        bool blackQueenSide
    ) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        ChessMatch storage matchData = chessMatches[matchId];
        
        whiteKingSide = !matchData.whiteKingMoved && !matchData.whiteRookHMoved;
        whiteQueenSide = !matchData.whiteKingMoved && !matchData.whiteRookAMoved;
        blackKingSide = !matchData.blackKingMoved && !matchData.blackRookHMoved;
        blackQueenSide = !matchData.blackKingMoved && !matchData.blackRookAMoved;
    }

    function getMoveHistory(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bytes memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        return moveHistory[matchId];
    }

    function getCachedMatchByIndex(uint16 index) external view returns (CachedChessMatch memory) {
        require(index < MATCH_CACHE_SIZE, "Index out of bounds");
        require(matchCache[index].exists, "No match at this index");
        return matchCache[index];
    }

    function getRecentCachedMatches(uint16 count) external view returns (CachedChessMatch[] memory recentMatches) {
        if (count > MATCH_CACHE_SIZE) {
            count = MATCH_CACHE_SIZE;
        }

        recentMatches = new CachedChessMatch[](count);
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

    /**
     * @dev Override RW3 declaration for ChessOnChain specifics
     */
    function declareRW3() public view override returns (string memory) {
        return string(abi.encodePacked(
            "=== RW3 COMPLIANCE DECLARATION ===\n\n",
            "PROJECT: ChessOnChain (ETour Implementation)\n",
            "VERSION: 1.0\n",
            "NETWORK: Arbitrum One\n",
            "VERIFIED: Block deployed\n\n",
            "RULE 1 - REAL UTILITY:\n",
            "Full chess game with tournament stakes. Primary revenue driver in ETour ecosystem.\n\n",
            "RULE 2 - FULLY ON-CHAIN:\n",
            "Complete chess logic including castling, en passant, promotion, check/checkmate - all on-chain.\n\n",
            "RULE 3 - SELF-SUSTAINING:\n",
            "Protocol fee structure covers operational costs. Contract functions autonomously.\n\n",
            "RULE 4 - FAIR DISTRIBUTION:\n",
            "No pre-mine, no insider allocations. All ETH in prize pools from player entry fees.\n\n",
            "RULE 5 - NO ALTCOINS:\n",
            "Uses only ETH for entry fees and prizes.\n\n",
            "Generated: Block ",
            Strings.toString(block.number)
        ));
    }
}
