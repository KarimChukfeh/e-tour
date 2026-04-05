// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

/**
 * @title ConnectFourInstance
 * @dev Connect Four game instance for the ETour factory/instance architecture.
 *
 * Board: 6 rows × 7 columns = 42 cells, 2 bits per cell (0=empty,1=Red,2=Yellow)
 * Win condition: 4 in a row (horizontal, vertical, diagonal, anti-diagonal)
 * Gravity: pieces drop to the lowest empty row in a column.
 */
contract ConnectFourInstance is ETourGame {

    error InvalidColumn();
    error ColumnFull();

    uint8 private constant ROWS = 6;
    uint8 private constant COLS = 7;
    uint8 private constant TOTAL_CELLS = 42;
    uint8 private constant CONNECT_COUNT = 4;

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 column, uint8 row);

    // ============ Board Helpers ============

    function _getCell(uint256 board, uint8 idx) private pure returns (uint8) {
        return uint8((board >> (idx * 2)) & 3);
    }

    function _setCell(uint256 board, uint8 idx, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(3) << (idx * 2));
        return (board & mask) | (uint256(value) << (idx * 2));
    }

    function _cellIdx(uint8 row, uint8 col) private pure returns (uint8) {
        return row * COLS + col;
    }

    function _validPos(int8 row, int8 col) private pure returns (bool) {
        return row >= 0 && row < int8(ROWS) && col >= 0 && col < int8(COLS);
    }

    function _isBoardFull(uint256 board) private pure returns (bool) {
        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
            if (_getCell(board, i) == 0) return false;
        }
        return true;
    }

    function _checkLine(uint256 board, uint8 piece, uint8 row, uint8 col, int8 dRow, int8 dCol)
        private pure returns (bool)
    {
        uint8 count = 1;
        int8 r = int8(row) + dRow;
        int8 c = int8(col) + dCol;
        while (_validPos(r, c) && _getCell(board, _cellIdx(uint8(r), uint8(c))) == piece) {
            if (++count >= CONNECT_COUNT) return true;
            r += dRow; c += dCol;
        }
        r = int8(row) - dRow; c = int8(col) - dCol;
        while (_validPos(r, c) && _getCell(board, _cellIdx(uint8(r), uint8(c))) == piece) {
            if (++count >= CONNECT_COUNT) return true;
            r -= dRow; c -= dCol;
        }
        return false;
    }

    function _checkWin(uint256 board, uint8 piece, uint8 row, uint8 col) private pure returns (bool) {
        return _checkLine(board, piece, row, col, 0, 1)   // horizontal
            || _checkLine(board, piece, row, col, 1, 0)   // vertical
            || _checkLine(board, piece, row, col, 1, 1)   // diagonal
            || _checkLine(board, piece, row, col, 1, -1); // anti-diagonal
    }

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool) internal override {
        Match storage m = matches[matchId];
        m.packedBoard = 0;
    }

    // ============ Game Logic ============

    /**
     * @dev Drop a piece into the given column. Gravity places it in the lowest empty row.
     */
    function makeMove(uint8 roundNumber, uint8 matchNumber, uint8 column)
        external nonReentrant notConcluded
    {
        if (column >= COLS) revert InvalidColumn();

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.InProgress, "MA");
        require(msg.sender == m.player1 || msg.sender == m.player2, "NP");
        require(msg.sender == m.currentTurn, "NT");

        _consumeTurnClock(m);

        // Find landing row (gravity)
        uint8 targetRow = ROWS; // sentinel: no empty cell found
        for (uint8 row = ROWS; row > 0; row--) {
            if (_getCell(m.packedBoard, _cellIdx(row - 1, column)) == 0) {
                targetRow = row - 1;
                break;
            }
        }
        if (targetRow >= ROWS) revert ColumnFull();

        uint8 piece = (msg.sender == m.player1) ? 1 : 2;
        m.packedBoard = _setCell(m.packedBoard, _cellIdx(targetRow, column), piece);

        // Move history: each move is 1 byte (column index)
        m.moves = string(abi.encodePacked(m.moves, column));

        // Clear any escalation state
        _clearMatchEscalation(matchId);

        emit MoveMade(matchId, msg.sender, column, targetRow);

        if (_checkWin(m.packedBoard, piece, targetRow, column)) {
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, MatchCompletionReason.NormalWin);
            return;
        }
        if (_isBoardFull(m.packedBoard)) {
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, MatchCompletionReason.Draw);
            return;
        }

        _switchTurn(m);
    }

    // ============ View ============

    function getBoard(uint8 roundNumber, uint8 matchNumber)
        external view returns (uint8[42] memory board)
    {
        uint256 packed = matches[_getMatchId(roundNumber, matchNumber)].packedBoard;
        for (uint8 i = 0; i < TOTAL_CELLS; i++) {
            board[i] = _getCell(packed, i);
        }
    }
}
