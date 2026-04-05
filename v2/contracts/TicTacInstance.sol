// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

/**
 * @title TicTacInstance
 * @dev Tic-Tac-Toe game instance for the ETour factory/instance architecture.
 *
 * Inherits ETourGame (→ ETourInstance → ETourInstance_Base) and adds:
 * - 2-bit packed board representation (9 cells × 2 bits = 18 bits in uint256)
 * - 3x3 win detection (8 lines)
 * - Fischer increment time control
 * - makeMove() with board update and completion detection
 *
 * Deployed once as the implementation contract; clones are deployed by
 * TicTacChainFactory.createInstance() for each tournament.
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacInstance is ETourGame {

    // ============ Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);

    // ============ Board Helpers ============

    function _getCell(uint256 board, uint8 cellIndex) private pure returns (uint8) {
        return uint8((board >> (cellIndex * 2)) & 3);
    }

    function _setCell(uint256 board, uint8 cellIndex, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(3) << (cellIndex * 2));
        return (board & mask) | (uint256(value) << (cellIndex * 2));
    }

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

    function _checkDraw(uint256 board) private pure returns (bool) {
        for (uint8 i = 0; i < 9; i++) {
            if (_getCell(board, i) == 0) return false;
        }
        return true;
    }

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizeStarterOnly;
    }

    function _initializeGameState(bytes32 matchId, bool) internal override {
        Match storage m = matches[matchId];
        m.packedBoard = 0;
    }

    // ============ Game Logic ============

    /**
     * @dev Make a move in the Tic-Tac-Toe match.
     * @param roundNumber Round number within this instance
     * @param matchNumber Match number within the round
     * @param cellIndex Board cell index (0-8, row-major)
     */
    function makeMove(
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external nonReentrant notConcluded {
        require(cellIndex < 9, "IC");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.InProgress, "MA");
        require(msg.sender == m.player1 || msg.sender == m.player2, "NP");
        require(msg.sender == m.currentTurn, "NT");
        require(_getCell(m.packedBoard, cellIndex) == 0, "CO");

        _consumeTurnClock(m);

        // Place the piece
        uint8 playerValue = (msg.sender == m.player1) ? 1 : 2;
        m.packedBoard = _setCell(m.packedBoard, cellIndex, playerValue);

        // Record move in history (append cell index as string)
        if (bytes(m.moves).length > 0) {
            m.moves = string(abi.encodePacked(m.moves, ",", _uint8ToString(cellIndex)));
        } else {
            m.moves = _uint8ToString(cellIndex);
        }

        emit MoveMade(matchId, msg.sender, cellIndex);

        // Check win condition
        if (_checkWin(m.packedBoard, playerValue)) {
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, MatchCompletionReason.NormalWin);
            return;
        }

        // Check draw
        if (_checkDraw(m.packedBoard)) {
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, MatchCompletionReason.Draw);
            return;
        }

        // Switch turn
        _switchTurn(m);
    }

    // ============ View ============

    function getBoard(uint8 roundNumber, uint8 matchNumber)
        external view
        returns (uint8[9] memory board)
    {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        uint256 packed = matches[matchId].packedBoard;
        for (uint8 i = 0; i < 9; i++) {
            board[i] = _getCell(packed, i);
        }
    }

    // ============ Utility ============

    function _uint8ToString(uint8 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint8 tmp = v;
        uint8 digits = 0;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits--; buf[digits] = bytes1(uint8(48 + (v % 10))); v /= 10; }
        return string(buf);
    }
}
