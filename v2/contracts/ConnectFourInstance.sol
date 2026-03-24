// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourInstance.sol";

/**
 * @title ConnectFourInstance
 * @dev Connect Four game instance for the ETour factory/instance architecture.
 *
 * Board: 6 rows × 7 columns = 42 cells, 2 bits per cell (0=empty,1=Red,2=Yellow)
 * Win condition: 4 in a row (horizontal, vertical, diagonal, anti-diagonal)
 * Gravity: pieces drop to the lowest empty row in a column.
 */
contract ConnectFourInstance is ETourInstance {

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

    // ============ ETourInstance_Base Abstract Implementations ============

    function _createMatchGame(uint8 roundNumber, uint8 matchNumber, address player1, address player2) public override {
        require(player1 != player2 && player1 != address(0) && player2 != address(0), "IP");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, block.number,
            roundNumber, matchNumber, player1, player2
        )));
        // Randomly assign Red (player1) and Yellow (player2)
        if (randomness % 2 == 0) {
            m.player1 = player1; m.player2 = player2;
        } else {
            m.player1 = player2; m.player2 = player1;
        }
        m.currentTurn = m.player1;
        m.firstPlayer = m.player1;
        m.status = MatchStatus.InProgress;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.isDraw = false;
        m.packedBoard = 0;
        m.moves = "";
        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
    }

    function _resetMatchGame(bytes32 matchId) public override {
        Match storage m = matches[matchId];
        m.player1 = address(0); m.player2 = address(0); m.winner = address(0);
        m.currentTurn = address(0); m.firstPlayer = address(0);
        m.status = MatchStatus.NotStarted; m.isDraw = false;
        m.packedBoard = 0; m.packedState = 0;
        m.startTime = 0; m.lastMoveTime = 0;
        m.player1TimeRemaining = 0; m.player2TimeRemaining = 0;
        m.moves = "";
    }

    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage m = matches[matchId];
        return (m.winner, m.isDraw, m.status);
    }

    function _initializeMatchForPlay(bytes32 matchId) public override {
        Match storage m = matches[matchId];
        m.status = MatchStatus.InProgress;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.packedBoard = 0;
        m.isDraw = false;
        m.winner = address(0);
        m.moves = "";

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, block.number, matchId, m.player1, m.player2
        )));
        if (randomness % 2 == 1) {
            (m.player1, m.player2) = (m.player2, m.player1);
        }
        m.currentTurn = m.player1;
        m.firstPlayer = m.player1;
        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage m = matches[matchId];
        m.status = MatchStatus.Completed;
        m.winner = isDraw ? address(0) : winner;
        m.isDraw = isDraw;
    }

    function _completeMatchGameSpecific(uint8 roundNumber, uint8 matchNumber, address winner, bool isDraw) internal override {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];
        m.status = MatchStatus.Completed;
        m.winner = isDraw ? address(0) : winner;
        m.isDraw = isDraw;
    }

    function _getTimeIncrement() public view override returns (uint256) {
        return tierConfig.timeouts.timeIncrementPerMove;
    }

    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage m = matches[matchId];
        if (m.status != MatchStatus.InProgress) return false;
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        uint256 t = (m.currentTurn == m.player1) ? m.player1TimeRemaining : m.player2TimeRemaining;
        return elapsed >= t;
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

        // Update time bank
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        if (m.currentTurn == m.player1) {
            m.player1TimeRemaining = (m.player1TimeRemaining > elapsed)
                ? m.player1TimeRemaining - elapsed + _getTimeIncrement()
                : _getTimeIncrement();
        } else {
            m.player2TimeRemaining = (m.player2TimeRemaining > elapsed)
                ? m.player2TimeRemaining - elapsed + _getTimeIncrement()
                : _getTimeIncrement();
        }
        m.lastMoveTime = block.timestamp;

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
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        emit MoveMade(matchId, msg.sender, column, targetRow);

        if (_checkWin(m.packedBoard, piece, targetRow, column)) {
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, CompletionReason.NormalWin);
            return;
        }
        if (_isBoardFull(m.packedBoard)) {
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, CompletionReason.Draw);
            return;
        }

        m.currentTurn = (m.currentTurn == m.player1) ? m.player2 : m.player1;
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
