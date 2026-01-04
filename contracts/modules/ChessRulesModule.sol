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
        address player1;              // White
        address player2;              // Black
        address currentTurn;
        address firstPlayer;
        address winner;
        Piece[64] board;
        bool whiteInCheck;
        bool blackInCheck;
        uint8 enPassantSquare;
        uint8 halfMoveClock;
        uint16 fullMoveNumber;
        bool whiteKingMoved;
        bool blackKingMoved;
        bool whiteRookAMoved;
        bool whiteRookHMoved;
        bool blackRookAMoved;
        bool blackRookHMoved;
        MatchStatus status;
        uint256 startTime;
        uint256 lastMoveTime;
        bool isDraw;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }

    // Storage for chess matches (from ChessOnChain)
    mapping(bytes32 => ChessMatch) public chessMatches;

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
    function isValidMove(bytes32 matchId, uint8 from, uint8 to, PieceType promotion) external view returns (bool) {
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
                uint8 middleSquare = from + uint8(direction * 8);
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

    function isKingInCheck(bytes32 matchId, PieceColor kingColor) external view returns (bool) {
        uint8 kingPos = _findKing(matchId, kingColor);
        if (kingPos == 255) return false; // King not found (shouldn't happen)
        return _isSquareAttacked(matchId, kingPos, kingColor);
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

    function hasLegalMoves(bytes32 matchId, PieceColor color) external view returns (bool) {
        ChessMatch storage matchData = chessMatches[matchId];

        for (uint8 from = 0; from < 64; from++) {
            Piece memory piece = matchData.board[from];
            if (piece.color != color) continue;

            for (uint8 to = 0; to < 64; to++) {
                if (from == to) continue;

                // Quick check if this could be a valid move
                if (_isPieceMovementValid(matchId, from, to, piece)) {
                    if (!_wouldLeaveKingInCheck(matchId, from, to, color)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function isInsufficientMaterial(bytes32 matchId) external view returns (bool) {
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
}
