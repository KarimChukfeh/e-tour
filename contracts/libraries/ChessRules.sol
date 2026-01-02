// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ChessRules
 * @dev Library containing all chess game rules and move validation logic
 * Extracted from ChessOnChain to reduce contract size
 */
library ChessRules {

    // ============ Chess Types ============

    enum PieceType { None, Pawn, Knight, Bishop, Rook, Queen, King }
    enum PieceColor { None, White, Black }

    struct Piece {
        PieceType pieceType;
        PieceColor color;
    }

    uint8 constant NO_SQUARE = 255;

    // ============ Move Validation ============

    /**
     * @dev Validate if a move is legal
     */
    function isValidMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        PieceColor currentPlayer,
        bool whiteKingMoved,
        bool blackKingMoved,
        bool whiteRookAMoved,
        bool whiteRookHMoved,
        bool blackRookAMoved,
        bool blackRookHMoved,
        uint8 enPassantSquare,
        PieceType promotion
    ) public pure returns (bool) {
        Piece memory movingPiece = board[from];

        // Basic validations
        if (movingPiece.color != currentPlayer) return false;
        if (movingPiece.pieceType == PieceType.None) return false;
        if (from == to) return false;
        if (board[to].color == currentPlayer) return false;

        // Get move deltas
        int8 fileDiff = int8(uint8(to % 8)) - int8(uint8(from % 8));
        int8 rankDiff = int8(uint8(to / 8)) - int8(uint8(from / 8));

        // Validate move based on piece type
        bool isValid = false;

        if (movingPiece.pieceType == PieceType.Pawn) {
            isValid = isValidPawnMove(board, from, to, movingPiece.color, fileDiff, rankDiff, enPassantSquare);
        } else if (movingPiece.pieceType == PieceType.Knight) {
            isValid = isValidKnightMove(fileDiff, rankDiff);
        } else if (movingPiece.pieceType == PieceType.Bishop) {
            isValid = isValidBishopMove(board, from, to, fileDiff, rankDiff);
        } else if (movingPiece.pieceType == PieceType.Rook) {
            isValid = isValidRookMove(board, from, to, fileDiff, rankDiff);
        } else if (movingPiece.pieceType == PieceType.Queen) {
            isValid = isValidQueenMove(board, from, to, fileDiff, rankDiff);
        } else if (movingPiece.pieceType == PieceType.King) {
            isValid = isValidKingMove(
                board, from, to, movingPiece.color, fileDiff, rankDiff,
                whiteKingMoved, blackKingMoved, whiteRookAMoved, whiteRookHMoved,
                blackRookAMoved, blackRookHMoved
            );
        }

        if (!isValid) return false;

        // Check if move would leave king in check
        return !wouldBeInCheck(board, from, to, currentPlayer);
    }

    // ============ Piece-Specific Move Validation ============

    function isValidPawnMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        PieceColor color,
        int8 fileDiff,
        int8 rankDiff,
        uint8 enPassantSquare
    ) public pure returns (bool) {
        int8 direction = (color == PieceColor.White) ? int8(1) : int8(-1);
        uint8 startRank = (color == PieceColor.White) ? 1 : 6;

        // Forward move (1 square)
        if (fileDiff == 0 && rankDiff == direction) {
            return board[to].pieceType == PieceType.None;
        }

        // Forward move (2 squares from starting position)
        if (fileDiff == 0 && rankDiff == 2 * direction && from / 8 == startRank) {
            uint8 middleSquare = uint8(int8(from) + direction * 8);
            return board[middleSquare].pieceType == PieceType.None &&
                   board[to].pieceType == PieceType.None;
        }

        // Diagonal capture
        if ((fileDiff == 1 || fileDiff == -1) && rankDiff == direction) {
            // Normal capture
            if (board[to].pieceType != PieceType.None &&
                board[to].color != color) {
                return true;
            }
            // En passant
            if (to == enPassantSquare && enPassantSquare != NO_SQUARE) {
                return true;
            }
        }

        return false;
    }

    function isValidKnightMove(int8 fileDiff, int8 rankDiff) public pure returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        return (absFile == 2 && absRank == 1) || (absFile == 1 && absRank == 2);
    }

    function isValidBishopMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        int8 fileDiff,
        int8 rankDiff
    ) public pure returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
        if (absFile != absRank) return false;
        return isPathClear(board, from, to, fileDiff, rankDiff);
    }

    function isValidRookMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        int8 fileDiff,
        int8 rankDiff
    ) public pure returns (bool) {
        if (fileDiff != 0 && rankDiff != 0) return false;
        return isPathClear(board, from, to, fileDiff, rankDiff);
    }

    function isValidQueenMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        int8 fileDiff,
        int8 rankDiff
    ) public pure returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;

        // Queen moves like rook or bishop
        bool isRookMove = (fileDiff == 0 || rankDiff == 0);
        bool isBishopMove = (absFile == absRank);

        if (!isRookMove && !isBishopMove) return false;

        return isPathClear(board, from, to, fileDiff, rankDiff);
    }

    function isValidKingMove(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        PieceColor color,
        int8 fileDiff,
        int8 rankDiff,
        bool whiteKingMoved,
        bool blackKingMoved,
        bool whiteRookAMoved,
        bool whiteRookHMoved,
        bool blackRookAMoved,
        bool blackRookHMoved
    ) public pure returns (bool) {
        int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
        int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;

        // Normal king move (1 square in any direction)
        if (absFile <= 1 && absRank <= 1) {
            return true;
        }

        // Castling
        if (absRank == 0 && absFile == 2) {
            return canCastle(
                board, color, fileDiff > 0,
                whiteKingMoved, blackKingMoved,
                whiteRookAMoved, whiteRookHMoved,
                blackRookAMoved, blackRookHMoved
            );
        }

        return false;
    }

    // ============ Castling ============

    function canCastle(
        Piece[64] memory board,
        PieceColor color,
        bool kingSide,
        bool whiteKingMoved,
        bool blackKingMoved,
        bool whiteRookAMoved,
        bool whiteRookHMoved,
        bool blackRookAMoved,
        bool blackRookHMoved
    ) public pure returns (bool) {
        bool kingMoved = (color == PieceColor.White) ? whiteKingMoved : blackKingMoved;
        if (kingMoved) return false;

        uint8 rank = (color == PieceColor.White) ? 0 : 7;
        uint8 kingSquare = rank * 8 + 4;

        // Check if king is in check
        if (isSquareAttacked(board, kingSquare, color)) return false;

        if (kingSide) {
            // Kingside castling
            bool rookMoved = (color == PieceColor.White) ? whiteRookHMoved : blackRookHMoved;
            if (rookMoved) return false;

            // Check squares between king and rook are empty
            if (board[kingSquare + 1].pieceType != PieceType.None) return false;
            if (board[kingSquare + 2].pieceType != PieceType.None) return false;

            // Check king doesn't pass through check
            if (isSquareAttacked(board, kingSquare + 1, color)) return false;
            if (isSquareAttacked(board, kingSquare + 2, color)) return false;

            return true;
        } else {
            // Queenside castling
            bool rookMoved = (color == PieceColor.White) ? whiteRookAMoved : blackRookAMoved;
            if (rookMoved) return false;

            // Check squares between king and rook are empty
            if (board[kingSquare - 1].pieceType != PieceType.None) return false;
            if (board[kingSquare - 2].pieceType != PieceType.None) return false;
            if (board[kingSquare - 3].pieceType != PieceType.None) return false;

            // Check king doesn't pass through check
            if (isSquareAttacked(board, kingSquare - 1, color)) return false;
            if (isSquareAttacked(board, kingSquare - 2, color)) return false;

            return true;
        }
    }

    // ============ Path Checking ============

    function isPathClear(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        int8 fileDiff,
        int8 rankDiff
    ) public pure returns (bool) {
        int8 fileStep = 0;
        int8 rankStep = 0;

        if (fileDiff != 0) fileStep = fileDiff > 0 ? int8(1) : int8(-1);
        if (rankDiff != 0) rankStep = rankDiff > 0 ? int8(1) : int8(-1);

        int16 current = int16(uint16(from));
        int16 target = int16(uint16(to));

        // Move towards target, checking each square
        while (true) {
            current = current + rankStep * 8 + fileStep;
            if (current == target) break;
            if (board[uint8(uint16(current))].pieceType != PieceType.None) {
                return false;
            }
        }

        return true;
    }

    // ============ Check Detection ============

    function isSquareAttacked(
        Piece[64] memory board,
        uint8 square,
        PieceColor defendingColor
    ) public pure returns (bool) {
        PieceColor attackingColor = (defendingColor == PieceColor.White)
            ? PieceColor.Black
            : PieceColor.White;

        // Check all squares for attacking pieces
        for (uint8 from = 0; from < 64; from++) {
            Piece memory piece = board[from];
            if (piece.color == attackingColor && piece.pieceType != PieceType.None) {
                if (canPieceAttackSquare(board, from, square, piece)) {
                    return true;
                }
            }
        }

        return false;
    }

    function canPieceAttackSquare(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        Piece memory piece
    ) public pure returns (bool) {
        if (from == to) return false;

        int8 fileDiff = int8(uint8(to % 8)) - int8(uint8(from % 8));
        int8 rankDiff = int8(uint8(to / 8)) - int8(uint8(from / 8));

        if (piece.pieceType == PieceType.Pawn) {
            int8 direction = (piece.color == PieceColor.White) ? int8(1) : int8(-1);
            // Pawns attack diagonally
            return (fileDiff == 1 || fileDiff == -1) && rankDiff == direction;
        } else if (piece.pieceType == PieceType.Knight) {
            return isValidKnightMove(fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Bishop) {
            int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
            if (absFile != absRank) return false;
            return isPathClear(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Rook) {
            if (fileDiff != 0 && rankDiff != 0) return false;
            return isPathClear(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.Queen) {
            int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
            bool isRookMove = (fileDiff == 0 || rankDiff == 0);
            bool isBishopMove = (absFile == absRank);
            if (!isRookMove && !isBishopMove) return false;
            return isPathClear(board, from, to, fileDiff, rankDiff);
        } else if (piece.pieceType == PieceType.King) {
            int8 absFile = fileDiff < 0 ? -fileDiff : fileDiff;
            int8 absRank = rankDiff < 0 ? -rankDiff : rankDiff;
            return absFile <= 1 && absRank <= 1;
        }

        return false;
    }

    function wouldBeInCheck(
        Piece[64] memory board,
        uint8 from,
        uint8 to,
        PieceColor color
    ) public pure returns (bool) {
        // Create a copy of the board with the move applied
        Piece[64] memory tempBoard;
        for (uint8 i = 0; i < 64; i++) {
            tempBoard[i] = board[i];
        }

        // Apply move
        tempBoard[to] = tempBoard[from];
        tempBoard[from] = Piece(PieceType.None, PieceColor.None);

        // Find king position
        uint8 kingSquare = NO_SQUARE;
        for (uint8 i = 0; i < 64; i++) {
            if (tempBoard[i].pieceType == PieceType.King && tempBoard[i].color == color) {
                kingSquare = i;
                break;
            }
        }

        if (kingSquare == NO_SQUARE) return true; // King not found, error state

        return isSquareAttacked(tempBoard, kingSquare, color);
    }

    // ============ Game End Detection ============

    function hasLegalMoves(
        Piece[64] memory board,
        PieceColor color,
        bool whiteKingMoved,
        bool blackKingMoved,
        bool whiteRookAMoved,
        bool whiteRookHMoved,
        bool blackRookAMoved,
        bool blackRookHMoved,
        uint8 enPassantSquare
    ) public pure returns (bool) {
        // Check if any piece of the given color can make a legal move
        for (uint8 from = 0; from < 64; from++) {
            Piece memory piece = board[from];
            if (piece.color != color || piece.pieceType == PieceType.None) continue;

            // Try all possible destination squares
            for (uint8 to = 0; to < 64; to++) {
                if (from == to) continue;

                bool valid = isValidMove(
                    board, from, to, color,
                    whiteKingMoved, blackKingMoved,
                    whiteRookAMoved, whiteRookHMoved,
                    blackRookAMoved, blackRookHMoved,
                    enPassantSquare,
                    PieceType.Queen // Default promotion
                );

                if (valid) return true;
            }
        }

        return false;
    }
}
