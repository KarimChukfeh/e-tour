// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

/**
 * @title Checkers
 * @dev Reference American-checkers implementation for the ETour V2 game surface.
 *
 * Board model:
 * - 32 playable dark squares only (4 bits per square in packedBoard)
 * - 0 = empty
 * - 1 = player1 man
 * - 2 = player1 king
 * - 3 = player2 man
 * - 4 = player2 king
 *
 * packedState model:
 * - bit 0: capture continuation active
 * - bits 1-5: source square that must continue capturing
 *
 * Design notes:
 * - The contract stores only the 32 playable dark squares, not all 64 board
 *   coordinates. That keeps the board compact while still giving deterministic
 *   square indices for frontends and offchain tooling.
 * - ETour owns tournament lifecycle, brackets, clocks, escalations, and prize
 *   settlement. This contract owns only rules, board state, and move flow.
 * - Multi-jump continuation is encoded in packedState so the whole live game
 *   state remains inside the base Match struct.
 */
contract Checkers is ETourGame {

    error InvalidSquare();
    error MatchNotActive();
    error NotParticipant();
    error NotYourTurn();
    error NoPieceOwned();
    error DestinationOccupied();
    error MandatoryCaptureAvailable();
    error CaptureContinuationRequired();
    error InvalidMove();

    uint8 private constant BOARD_SQUARES = 32;

    uint8 private constant EMPTY = 0;
    uint8 private constant PLAYER1_MAN = 1;
    uint8 private constant PLAYER1_KING = 2;
    uint8 private constant PLAYER2_MAN = 3;
    uint8 private constant PLAYER2_KING = 4;

    uint256 private constant PENDING_CAPTURE_FLAG = 1;
    uint256 private constant PENDING_CAPTURE_SOURCE_SHIFT = 1;

    event MoveMade(
        bytes32 indexed matchId,
        address indexed player,
        uint8 from,
        uint8 to,
        bool capture,
        bool crowned
    );

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool) internal override {
        Match storage m = matches[matchId];
        // Fresh matches always begin from the canonical opening position and
        // with no forced-capture continuation pending.
        m.packedBoard = _initialBoard();
        m.packedState = 0;
    }

    function makeMove(
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 from,
        uint8 to
    ) external nonReentrant notConcluded {
        if (from >= BOARD_SQUARES || to >= BOARD_SQUARES || from == to) revert InvalidSquare();

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        if (m.status != MatchStatus.InProgress) revert MatchNotActive();
        if (msg.sender != m.player1 && msg.sender != m.player2) revert NotParticipant();
        if (msg.sender != m.currentTurn) revert NotYourTurn();

        bool isPlayer1 = msg.sender == m.player1;
        uint256 board = m.packedBoard;
        uint8 piece = _getSquare(board, from);

        if (!_isOwnPiece(piece, isPlayer1)) revert NoPieceOwned();
        if (_getSquare(board, to) != EMPTY) revert DestinationOccupied();

        bool pendingCapture = _pendingCaptureActive(m.packedState);
        if (pendingCapture && from != _pendingCaptureSource(m.packedState)) {
            revert CaptureContinuationRequired();
        }

        // Convert from the compact 0-31 playable-square index into real board
        // row/column coordinates so diagonal movement math is straightforward.
        (uint8 fromRow, uint8 fromCol) = _indexToCoords(from);
        (uint8 toRow, uint8 toCol) = _indexToCoords(to);

        int8 rowDiff = int8(toRow) - int8(fromRow);
        int8 colDiff = int8(toCol) - int8(fromCol);

        bool isCapture;
        uint8 capturedIndex;

        if (_isSimpleStep(rowDiff, colDiff, piece, isPlayer1)) {
            if (pendingCapture || _playerHasAnyCapture(board, isPlayer1)) {
                revert MandatoryCaptureAvailable();
            }
        } else if (_isCaptureStep(rowDiff, colDiff, piece, isPlayer1)) {
            isCapture = true;
            capturedIndex = _capturedIndex(fromRow, fromCol, toRow, toCol);
            if (!_isOpponentPiece(_getSquare(board, capturedIndex), isPlayer1)) {
                revert InvalidMove();
            }
        } else {
            revert InvalidMove();
        }

        // Once the move is known to be structurally valid we charge the active
        // player's clock before mutating game state.
        _consumeTurnClock(m);

        // Clear the source square first, then optionally remove the captured
        // piece, then place the moved piece at the destination.
        board = _setSquare(board, from, EMPTY);
        if (isCapture) {
            board = _setSquare(board, capturedIndex, EMPTY);
        }

        bool crowned;
        uint8 movedPiece = piece;
        if (!_isKing(piece) && _isPromotionRow(isPlayer1, toRow)) {
            // In American checkers the move ends immediately when a man reaches
            // the back rank and becomes a king, so we track that explicitly.
            movedPiece = isPlayer1 ? PLAYER1_KING : PLAYER2_KING;
            crowned = true;
        }

        board = _setSquare(board, to, movedPiece);

        m.packedBoard = board;
        m.moves = _appendMoveNotation(m.moves, from, to, isCapture, crowned);

        _clearMatchEscalation(matchId);

        emit MoveMade(matchId, msg.sender, from, to, isCapture, crowned);

        // A capture that can legally continue must keep the same player on move.
        // Promotion intentionally stops continuation in this reference version.
        if (isCapture && !crowned && _pieceHasCapture(board, to, movedPiece, isPlayer1)) {
            m.packedState = _encodePendingCapture(to);
            return;
        }

        m.packedState = 0;

        // ETour only needs to know the terminal result. The game contract is
        // responsible for deciding when a side has no remaining pieces or no
        // legal moves left and then routing through _completeMatchInternal(...).
        if (_countPiecesForPlayer(board, !isPlayer1) == 0 || !_playerHasAnyLegalMove(board, !isPlayer1)) {
            _completeMatchInternal(
                roundNumber,
                matchNumber,
                msg.sender,
                false,
                MatchCompletionReason.NormalWin
            );
            return;
        }

        _switchTurn(m);
    }

    function getBoard(uint8 roundNumber, uint8 matchNumber)
        external
        view
        returns (uint8[32] memory board)
    {
        // Expose the compact playable-square representation directly. Frontends
        // can map each 0-31 index to an 8x8 board with the same helper math
        // used inside _indexToCoords(...).
        uint256 packed = matches[_getMatchId(roundNumber, matchNumber)].packedBoard;
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            board[i] = _getSquare(packed, i);
        }
    }

    function getPendingCapture(uint8 roundNumber, uint8 matchNumber)
        external
        view
        returns (bool active, uint8 source)
    {
        uint256 state = matches[_getMatchId(roundNumber, matchNumber)].packedState;
        active = _pendingCaptureActive(state);
        source = active ? _pendingCaptureSource(state) : 0;
    }

    function _initialBoard() private pure returns (uint256 board) {
        // Playable-square indexing runs top-to-bottom, left-to-right over only
        // the dark squares. Indices 0-11 are player2's opening men and 20-31
        // are player1's opening men.
        for (uint8 i = 0; i < 12; i++) {
            board = _setSquare(board, i, PLAYER2_MAN);
        }
        for (uint8 i = 20; i < BOARD_SQUARES; i++) {
            board = _setSquare(board, i, PLAYER1_MAN);
        }
    }

    function _getSquare(uint256 board, uint8 index) private pure returns (uint8) {
        return uint8((board >> (index * 4)) & 0xF);
    }

    function _setSquare(uint256 board, uint8 index, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(0xF) << (index * 4));
        return (board & mask) | (uint256(value) << (index * 4));
    }

    function _indexToCoords(uint8 index) private pure returns (uint8 row, uint8 col) {
        // Even rows use dark squares in columns 1,3,5,7.
        // Odd rows use dark squares in columns 0,2,4,6.
        row = index / 4;
        col = uint8((index % 4) * 2 + ((row + 1) % 2));
    }

    function _coordsToIndex(uint8 row, uint8 col) private pure returns (uint8) {
        return row * 4 + (col / 2);
    }

    function _validCoords(int8 row, int8 col) private pure returns (bool) {
        return row >= 0 && row < 8 && col >= 0 && col < 8;
    }

    function _isOwnPiece(uint8 piece, bool isPlayer1) private pure returns (bool) {
        if (isPlayer1) {
            return piece == PLAYER1_MAN || piece == PLAYER1_KING;
        }
        return piece == PLAYER2_MAN || piece == PLAYER2_KING;
    }

    function _isOpponentPiece(uint8 piece, bool isPlayer1) private pure returns (bool) {
        if (piece == EMPTY) return false;
        return !_isOwnPiece(piece, isPlayer1);
    }

    function _isKing(uint8 piece) private pure returns (bool) {
        return piece == PLAYER1_KING || piece == PLAYER2_KING;
    }

    function _isPromotionRow(bool isPlayer1, uint8 row) private pure returns (bool) {
        return isPlayer1 ? row == 0 : row == 7;
    }

    function _isSimpleStep(int8 rowDiff, int8 colDiff, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        if (!_isOne(colDiff)) return false;
        if (_isKing(piece)) return rowDiff == -1 || rowDiff == 1;
        return isPlayer1 ? rowDiff == -1 : rowDiff == 1;
    }

    function _isCaptureStep(int8 rowDiff, int8 colDiff, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        if (!_isTwo(colDiff)) return false;
        if (_isKing(piece)) return rowDiff == -2 || rowDiff == 2;
        return isPlayer1 ? rowDiff == -2 : rowDiff == 2;
    }

    function _capturedIndex(
        uint8 fromRow,
        uint8 fromCol,
        uint8 toRow,
        uint8 toCol
    ) private pure returns (uint8) {
        return _coordsToIndex((fromRow + toRow) / 2, (fromCol + toCol) / 2);
    }

    function _playerHasAnyCapture(uint256 board, bool isPlayer1) private pure returns (bool) {
        // Forced capture is a side-wide rule, so we must scan every piece for
        // at least one available jump before allowing any non-capturing move.
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            uint8 piece = _getSquare(board, i);
            if (_isOwnPiece(piece, isPlayer1) && _pieceHasCapture(board, i, piece, isPlayer1)) {
                return true;
            }
        }
        return false;
    }

    function _playerHasAnyLegalMove(uint256 board, bool isPlayer1) private pure returns (bool) {
        // Used for terminal detection after a move resolves. If the opponent
        // has pieces but no legal move, the current player wins immediately.
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            uint8 piece = _getSquare(board, i);
            if (!_isOwnPiece(piece, isPlayer1)) continue;

            if (_pieceHasCapture(board, i, piece, isPlayer1)) return true;
            if (_pieceHasSimpleMove(board, i, piece, isPlayer1)) return true;
        }
        return false;
    }

    function _pieceHasCapture(uint256 board, uint8 from, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        (uint8 row, uint8 col) = _indexToCoords(from);

        if (_isKing(piece) || isPlayer1) {
            if (_hasCaptureInDirection(board, row, col, -1, -1, isPlayer1)) return true;
            if (_hasCaptureInDirection(board, row, col, -1, 1, isPlayer1)) return true;
        }

        if (_isKing(piece) || !isPlayer1) {
            if (_hasCaptureInDirection(board, row, col, 1, -1, isPlayer1)) return true;
            if (_hasCaptureInDirection(board, row, col, 1, 1, isPlayer1)) return true;
        }

        return false;
    }

    function _pieceHasSimpleMove(uint256 board, uint8 from, uint8 piece, bool isPlayer1)
        private
        pure
        returns (bool)
    {
        (uint8 row, uint8 col) = _indexToCoords(from);

        if (_isKing(piece) || isPlayer1) {
            if (_hasSimpleMoveInDirection(board, row, col, -1, -1)) return true;
            if (_hasSimpleMoveInDirection(board, row, col, -1, 1)) return true;
        }

        if (_isKing(piece) || !isPlayer1) {
            if (_hasSimpleMoveInDirection(board, row, col, 1, -1)) return true;
            if (_hasSimpleMoveInDirection(board, row, col, 1, 1)) return true;
        }

        return false;
    }

    function _hasCaptureInDirection(
        uint256 board,
        uint8 row,
        uint8 col,
        int8 rowStep,
        int8 colStep,
        bool isPlayer1
    ) private pure returns (bool) {
        // Check the adjacent diagonal square for an opponent piece and the
        // landing square beyond it for emptiness.
        int8 middleRow = int8(row) + rowStep;
        int8 middleCol = int8(col) + colStep;
        int8 landingRow = int8(row) + (rowStep * 2);
        int8 landingCol = int8(col) + (colStep * 2);

        if (!_validCoords(middleRow, middleCol) || !_validCoords(landingRow, landingCol)) {
            return false;
        }

        uint8 middleIndex = _coordsToIndex(uint8(middleRow), uint8(middleCol));
        uint8 landingIndex = _coordsToIndex(uint8(landingRow), uint8(landingCol));

        return _isOpponentPiece(_getSquare(board, middleIndex), isPlayer1)
            && _getSquare(board, landingIndex) == EMPTY;
    }

    function _hasSimpleMoveInDirection(
        uint256 board,
        uint8 row,
        uint8 col,
        int8 rowStep,
        int8 colStep
    ) private pure returns (bool) {
        int8 landingRow = int8(row) + rowStep;
        int8 landingCol = int8(col) + colStep;

        if (!_validCoords(landingRow, landingCol)) return false;

        uint8 landingIndex = _coordsToIndex(uint8(landingRow), uint8(landingCol));
        return _getSquare(board, landingIndex) == EMPTY;
    }

    function _countPiecesForPlayer(uint256 board, bool isPlayer1) private pure returns (uint8 count) {
        for (uint8 i = 0; i < BOARD_SQUARES; i++) {
            if (_isOwnPiece(_getSquare(board, i), isPlayer1)) {
                unchecked {
                    ++count;
                }
            }
        }
    }

    function _pendingCaptureActive(uint256 state) private pure returns (bool) {
        return (state & PENDING_CAPTURE_FLAG) != 0;
    }

    function _pendingCaptureSource(uint256 state) private pure returns (uint8) {
        return uint8((state >> PENDING_CAPTURE_SOURCE_SHIFT) & 0x1F);
    }

    function _encodePendingCapture(uint8 source) private pure returns (uint256) {
        return PENDING_CAPTURE_FLAG | (uint256(source) << PENDING_CAPTURE_SOURCE_SHIFT);
    }

    function _appendMoveNotation(
        string memory existing,
        uint8 from,
        uint8 to,
        bool isCapture,
        bool crowned
    ) private pure returns (string memory) {
        // Transcript format is intentionally human-readable for the docs:
        // "20-16" for a normal move, "16x9" for a capture, and a trailing "K"
        // when the move crowns a king.
        string memory separator = isCapture ? "x" : "-";
        bytes memory moveText = abi.encodePacked(
            _uint8ToString(from),
            separator,
            _uint8ToString(to),
            crowned ? "K" : ""
        );

        if (bytes(existing).length == 0) {
            return string(moveText);
        }

        return string(abi.encodePacked(existing, ",", moveText));
    }

    function _uint8ToString(uint8 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint8 tmp = value;
        uint8 digits = 0;
        while (tmp != 0) {
            unchecked {
                ++digits;
            }
            tmp /= 10;
        }

        bytes memory out = new bytes(digits);
        while (value != 0) {
            unchecked {
                --digits;
            }
            out[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    function _isOne(int8 value) private pure returns (bool) {
        return value == -1 || value == 1;
    }

    function _isTwo(int8 value) private pure returns (bool) {
        return value == -2 || value == 2;
    }
}
