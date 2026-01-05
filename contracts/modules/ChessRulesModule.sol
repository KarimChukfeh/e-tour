// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";

/**
 * @title ChessRulesModule
 * @dev Stateless module for chess rules validation and game logic
 *
 * This module handles all chess-specific rule enforcement:
 * - Move validation for all piece types
 * - Check and checkmate detection
 * - Path clearing verification
 * - Special moves (castling, en passant)
 * - Insufficient material detection
 *
 * Designed to be called via delegatecall from ChessOnChain
 */
contract ChessRulesModule is ETour_Storage {

    // ============ Enums from ChessOnChain ============

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
        uint16 fullMoveNumber;
        bool whiteInCheck;
        bool blackInCheck;

        // Time Bank Fields (chess clock style)
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }

    // ============ Storage Layout Alignment ============
    // CRITICAL: These storage variables MUST match ChessOnChain's layout exactly
    // for delegatecall to access the correct storage slots

    uint8 constant NO_SQUARE = 255;

    // Storage for chess matches - accessed via delegatecall from ChessOnChain
    mapping(bytes32 => ChessMatch) public chessMatches;

    // Additional ChessOnChain storage (not accessed by this module, but needed for slot alignment)
    mapping(bytes32 => bytes) public moveHistory;

    // Constructor
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs ============

    function _createMatchGame(uint8, uint8, uint8, uint8, address, address) public override { revert("Module: Use IETourGame"); }
    function _resetMatchGame(bytes32) public override { revert("Module: Use IETourGame"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module: Use IETourGame"); }
    function _addToMatchCacheGame(uint8, uint8, uint8, uint8) public override { revert("Module: Use IETourGame"); }
    function _getMatchPlayers(bytes32) public view override returns (address, address) { revert("Module: Use IETourGame"); }
    function _setMatchPlayer(bytes32, uint8, address) public override { revert("Module: Use IETourGame"); }
    function _initializeMatchForPlay(bytes32, uint8) public override { revert("Module: Use IETourGame"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module: Use IETourGame"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module: Use IETourGame"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _isMatchActive(bytes32) public view override returns (bool) { revert("Module: Use IETourGame"); }
    function _getActiveMatchData(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory) { revert("Module: Use IETourGame"); }
    function _getMatchFromCache(bytes32, uint8, uint8, uint8, uint8) public override returns (CommonMatchData memory, bool) { revert("Module: Use IETourGame"); }

    // ============ Move Validation Functions ============

    /**
     * @dev Validate if a move is legal
     * @param matchId The match identifier
     * @param from Source square (0-63)
     * @param to Destination square (0-63)
     * @param promotion Piece type for pawn promotion (None if not promoting)
     * @return bool True if move is valid
     */
    function isValidMove(bytes32 matchId, uint8 from, uint8 to, PieceType promotion) public view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        Piece memory piece = matchData.board[from];

        // Basic validation
        if (piece.pieceType == PieceType.None) return false;
        if (from == to) return false;
        if (from > 63 || to > 63) return false;

        // Check if destination has own piece
        Piece memory destPiece = matchData.board[to];
        if (destPiece.color == piece.color) return false;

        // Check piece-specific movement
        if (!_isPieceMovementValid(matchId, from, to, piece)) return false;

        // Check if move would leave king in check
        if (_wouldLeaveKingInCheck(matchId, from, to, piece.color)) return false;

        // Validate promotion
        if (piece.pieceType == PieceType.Pawn) {
            uint8 toRank = to / 8;
            if ((piece.color == PieceColor.White && toRank == 7) ||
                (piece.color == PieceColor.Black && toRank == 0)) {
                if (promotion == PieceType.None || promotion == PieceType.Pawn || promotion == PieceType.King) {
                    return false;
                }
            }
        }

        return true;
    }

    function _isPieceMovementValid(bytes32 matchId, uint8 from, uint8 to, Piece memory piece) internal view returns (bool) {
        int8 fileDiff = int8(int256(uint256(to % 8))) - int8(int256(uint256(from % 8)));
        int8 rankDiff = int8(int256(uint256(to / 8))) - int8(int256(uint256(from / 8)));

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

        // Forward move
        if (fileDiff == 0) {
            if (rankDiff == direction && matchData.board[to].pieceType == PieceType.None) {
                return true;
            }
            // Double move from starting position
            uint8 startRank = (color == PieceColor.White) ? 1 : 6;
            if (from / 8 == startRank && rankDiff == direction * 2) {
                uint8 middleSquare = (color == PieceColor.White) ? from + 8 : from - 8;
                if (matchData.board[middleSquare].pieceType == PieceType.None &&
                    matchData.board[to].pieceType == PieceType.None) {
                    return true;
                }
            }
            return false;
        }

        // Capture move
        if ((fileDiff == 1 || fileDiff == -1) && rankDiff == direction) {
            if (matchData.board[to].pieceType != PieceType.None &&
                matchData.board[to].color != color) {
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
        int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
        return (absFileDiff == 2 && absRankDiff == 1) || (absFileDiff == 1 && absRankDiff == 2);
    }

    function _isValidBishopMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
        if (absFileDiff != absRankDiff) return false;
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidRookMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        if (fileDiff != 0 && rankDiff != 0) return false;
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidQueenMove(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;

        // Queen moves like rook or bishop
        bool isDiagonal = (absFileDiff == absRankDiff);
        bool isStraight = (fileDiff == 0 || rankDiff == 0);

        if (!isDiagonal && !isStraight) return false;
        return _isPathClear(matchId, from, to, fileDiff, rankDiff);
    }

    function _isValidKingMove(bytes32 matchId, uint8 from, uint8 to, PieceColor color, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;

        // Normal king move (one square in any direction)
        if (absFileDiff <= 1 && absRankDiff <= 1) {
            return true;
        }

        // Castling
        if (absRankDiff == 0 && absFileDiff == 2) {
            bool kingSide = fileDiff > 0;
            return _canCastle(matchId, color, kingSide);
        }

        return false;
    }

    function _canCastle(bytes32 matchId, PieceColor color, bool kingSide) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

        // Check if king has moved
        if (color == PieceColor.White && matchData.whiteKingMoved) return false;
        if (color == PieceColor.Black && matchData.blackKingMoved) return false;

        // Check if rook has moved
        if (color == PieceColor.White) {
            if (kingSide && matchData.whiteRookHMoved) return false;
            if (!kingSide && matchData.whiteRookAMoved) return false;
        } else {
            if (kingSide && matchData.blackRookHMoved) return false;
            if (!kingSide && matchData.blackRookAMoved) return false;
        }

        // King cannot be in check
        if (color == PieceColor.White && matchData.whiteInCheck) return false;
        if (color == PieceColor.Black && matchData.blackInCheck) return false;

        // Check path is clear and not under attack
        uint8 kingPos = (color == PieceColor.White) ? 4 : 60;

        if (kingSide) {
            // Kingside castling: squares f and g must be empty and not attacked
            uint8 f = kingPos + 1;
            uint8 g = kingPos + 2;

            if (matchData.board[f].pieceType != PieceType.None ||
                matchData.board[g].pieceType != PieceType.None) {
                return false;
            }

            if (_isSquareAttacked(matchId, f, color) ||
                _isSquareAttacked(matchId, g, color)) {
                return false;
            }
        } else {
            // Queenside castling: squares b, c, d must be empty; c and d not attacked
            uint8 b = kingPos - 3;
            uint8 c = kingPos - 2;
            uint8 d = kingPos - 1;

            if (matchData.board[b].pieceType != PieceType.None ||
                matchData.board[c].pieceType != PieceType.None ||
                matchData.board[d].pieceType != PieceType.None) {
                return false;
            }

            if (_isSquareAttacked(matchId, c, color) ||
                _isSquareAttacked(matchId, d, color)) {
                return false;
            }
        }

        return true;
    }

    function _isPathClear(bytes32 matchId, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

        int8 fileStep = (fileDiff == 0) ? int8(0) : (fileDiff > 0 ? int8(1) : int8(-1));
        int8 rankStep = (rankDiff == 0) ? int8(0) : (rankDiff > 0 ? int8(1) : int8(-1));

        int8 currentFile = int8(int256(uint256(from % 8))) + fileStep;
        int8 currentRank = int8(int256(uint256(from / 8))) + rankStep;
        int8 toFile = int8(int256(uint256(to % 8)));
        int8 toRank = int8(int256(uint256(to / 8)));

        while (currentFile != toFile || currentRank != toRank) {
            uint8 square = uint8(uint256(int256(currentRank * 8 + currentFile)));
            if (matchData.board[square].pieceType != PieceType.None) {
                return false;
            }
            currentFile += fileStep;
            currentRank += rankStep;
        }

        return true;
    }

    // ============ Check/Checkmate Detection ============

    function isKingInCheck(bytes32 matchId, uint8 kingColor) public view returns (bool) {
        PieceColor color = PieceColor(kingColor);
        uint8 kingPos = _findKing(matchId, color);
        if (kingPos == 255) return false; // King not found (shouldn't happen)
        return _isSquareAttacked(matchId, kingPos, color);
    }

    function _findKing(bytes32 matchId, PieceColor color) internal view returns (uint8) {
        ChessMatch storage matchData = chessMatches[matchId];
        for (uint8 i = 0; i < 64; i++) {
            if (matchData.board[i].pieceType == PieceType.King &&
                matchData.board[i].color == color) {
                return i;
            }
        }
        return 255; // Not found
    }

    function _isSquareAttacked(bytes32 matchId, uint8 square, PieceColor defendingColor) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];
        PieceColor attackingColor = (defendingColor == PieceColor.White) ? PieceColor.Black : PieceColor.White;

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
        int8 fileDiff = int8(int256(uint256(to % 8))) - int8(int256(uint256(from % 8)));
        int8 rankDiff = int8(int256(uint256(to / 8))) - int8(int256(uint256(from / 8)));

        if (piece.pieceType == PieceType.Pawn) {
            int8 direction = (piece.color == PieceColor.White) ? int8(1) : int8(-1);
            return ((fileDiff == 1 || fileDiff == -1) && rankDiff == direction);
        } else if (piece.pieceType == PieceType.Knight) {
            return _isValidKnightMove(fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Bishop) {
            return _isValidBishopMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            return _isValidRookMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            return _isValidQueenMove(matchId, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
            return (absFileDiff <= 1 && absRankDiff <= 1);
        }

        return false;
    }

    function _wouldLeaveKingInCheck(bytes32 matchId, uint8 from, uint8 to, PieceColor color) internal view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

        // Create temporary board with move applied
        Piece[64] memory tempBoard;
        for (uint8 i = 0; i < 64; i++) {
            tempBoard[i] = matchData.board[i];
        }

        tempBoard[to] = tempBoard[from];
        tempBoard[from] = Piece(PieceType.None, PieceColor.None);

        // Find king position
        uint8 kingPos = 255;
        for (uint8 i = 0; i < 64; i++) {
            if (tempBoard[i].pieceType == PieceType.King && tempBoard[i].color == color) {
                kingPos = i;
                break;
            }
        }

        if (kingPos == 255) return true; // King missing (shouldn't happen)

        return _isSquareAttackedOnBoard(tempBoard, kingPos, color);
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
        int8 fileDiff = int8(int256(uint256(to % 8))) - int8(int256(uint256(from % 8)));
        int8 rankDiff = int8(int256(uint256(to / 8))) - int8(int256(uint256(from / 8)));

        if (piece.pieceType == PieceType.Pawn) {
            int8 direction = (piece.color == PieceColor.White) ? int8(1) : int8(-1);
            return ((fileDiff == 1 || fileDiff == -1) && rankDiff == direction);
        } else if (piece.pieceType == PieceType.Knight) {
            return _isValidKnightMove(fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Bishop) {
            int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
            if (absFileDiff != absRankDiff) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            if (fileDiff != 0 && rankDiff != 0) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
            bool isDiagonal = (absFileDiff == absRankDiff);
            bool isStraight = (fileDiff == 0 || rankDiff == 0);
            if (!isDiagonal && !isStraight) return false;
            return _isPathClearOnBoard(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            int8 absFileDiff = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRankDiff = rankDiff < 0 ? -rankDiff : rankDiff;
            return (absFileDiff <= 1 && absRankDiff <= 1);
        }

        return false;
    }

    function _isPathClearOnBoard(Piece[64] memory board, uint8 from, uint8 to, int8 fileDiff, int8 rankDiff) internal pure returns (bool) {
        int8 fileStep = (fileDiff == 0) ? int8(0) : (fileDiff > 0 ? int8(1) : int8(-1));
        int8 rankStep = (rankDiff == 0) ? int8(0) : (rankDiff > 0 ? int8(1) : int8(-1));

        int8 currentFile = int8(int256(uint256(from % 8))) + fileStep;
        int8 currentRank = int8(int256(uint256(from / 8))) + rankStep;
        int8 toFile = int8(int256(uint256(to % 8)));
        int8 toRank = int8(int256(uint256(to / 8)));

        while (currentFile != toFile || currentRank != toRank) {
            uint8 square = uint8(uint256(int256(currentRank * 8 + currentFile)));
            if (board[square].pieceType != PieceType.None) {
                return false;
            }
            currentFile += fileStep;
            currentRank += rankStep;
        }

        return true;
    }

    function hasLegalMoves(bytes32 matchId, uint8 color) public view returns (bool) {
        PieceColor pieceColor = PieceColor(color);
        ChessMatch storage matchData = chessMatches[matchId];

        for (uint8 from = 0; from < 64; from++) {
            Piece memory piece = matchData.board[from];
            if (piece.color != pieceColor) continue;

            for (uint8 to = 0; to < 64; to++) {
                if (from == to) continue;

                // Check if destination has own piece
                if (matchData.board[to].color == pieceColor) continue;

                // Quick check if this could be a valid move
                if (_isPieceMovementValid(matchId, from, to, piece)) {
                    if (!_wouldLeaveKingInCheck(matchId, from, to, pieceColor)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function isInsufficientMaterial(bytes32 matchId) public view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

        uint8 whitePieceCount = 0;
        uint8 blackPieceCount = 0;
        bool whiteBishop = false;
        bool blackBishop = false;
        bool whiteKnight = false;
        bool blackKnight = false;

        for (uint8 i = 0; i < 64; i++) {
            Piece memory piece = matchData.board[i];
            if (piece.pieceType == PieceType.None || piece.pieceType == PieceType.King) continue;

            if (piece.color == PieceColor.White) {
                whitePieceCount++;
                if (piece.pieceType == PieceType.Bishop) whiteBishop = true;
                if (piece.pieceType == PieceType.Knight) whiteKnight = true;
                // If any pawn, rook, or queen exists, not insufficient
                if (piece.pieceType == PieceType.Pawn ||
                    piece.pieceType == PieceType.Rook ||
                    piece.pieceType == PieceType.Queen) {
                    return false;
                }
            } else {
                blackPieceCount++;
                if (piece.pieceType == PieceType.Bishop) blackBishop = true;
                if (piece.pieceType == PieceType.Knight) blackKnight = true;
                if (piece.pieceType == PieceType.Pawn ||
                    piece.pieceType == PieceType.Rook ||
                    piece.pieceType == PieceType.Queen) {
                    return false;
                }
            }
        }

        // King vs King
        if (whitePieceCount == 0 && blackPieceCount == 0) return true;

        // King + Bishop/Knight vs King
        if ((whitePieceCount == 1 && blackPieceCount == 0 && (whiteBishop || whiteKnight)) ||
            (blackPieceCount == 1 && whitePieceCount == 0 && (blackBishop || blackKnight))) {
            return true;
        }

        // King + Bishop vs King + Bishop (same color squares)
        if (whitePieceCount == 1 && blackPieceCount == 1 && whiteBishop && blackBishop) {
            return true;
        }

        return false;
    }

    // ============ Board Setup ============

    /**
     * @dev Setup initial chess board position
     */
    function setupInitialPosition(bytes32 matchId) public {
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

    // ============ Move Execution ============

    /**
     * @dev Execute a validated chess move and update all game state
     * IMPORTANT: This assumes the move has already been validated via isValidMove
     * @param matchId The match identifier
     * @param from Source square
     * @param to Destination square
     * @param promotion Piece type for pawn promotion
     * @return isCapture True if move captured a piece
     * @return isPawnMove True if pawn moved
     * @return isCastling True if castling occurred
     * @return isEnPassantCapture True if en passant capture occurred
     */
    function executeMove(
        bytes32 matchId,
        uint8 from,
        uint8 to,
        PieceType promotion
    ) public returns (
        bool isCapture,
        bool isPawnMove,
        bool isCastling,
        bool isEnPassantCapture
    ) {
        ChessMatch storage matchData = chessMatches[matchId];

        Piece memory movingPiece = matchData.board[from];
        Piece memory capturedPiece = matchData.board[to];
        PieceColor playerColor = movingPiece.color;

        isCapture = capturedPiece.pieceType != PieceType.None;
        isPawnMove = movingPiece.pieceType == PieceType.Pawn;

        // Handle castling
        if (movingPiece.pieceType == PieceType.King) {
            int8 fileDiff = int8(to % 8) - int8(from % 8);
            if (fileDiff == 2 || fileDiff == -2) {
                _executeCastling(matchId, from, to, playerColor);
                isCastling = true;
            }

            // Mark king as moved
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
            isEnPassantCapture = true;
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
            }
        }

        // Update full move number
        if (playerColor == PieceColor.Black) {
            matchData.fullMoveNumber++;
        }

        // Clear moving player's check status
        if (playerColor == PieceColor.White) {
            matchData.whiteInCheck = false;
        } else {
            matchData.blackInCheck = false;
        }

        return (isCapture, isPawnMove, isCastling, isEnPassantCapture);
    }

    /**
     * @dev Execute castling move (rook movement)
     * King is moved by the caller, this handles the rook
     */
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
    }
}
