// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourInstance.sol";

/**
 * @title TicTacInstance
 * @dev Tic-Tac-Toe game instance for the ETour factory/instance architecture.
 *
 * Inherits ETourInstance (→ ETourInstance_Base) and adds:
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
contract TicTacInstance is ETourInstance {

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

    // ============ ETourInstance_Base Abstract Implementations ============

    function _createMatchGame(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public override {
        require(player1 != player2, "P1");
        require(player1 != address(0) && player2 != address(0), "P2");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        m.player1 = player1;
        m.player2 = player2;
        m.status = MatchStatus.InProgress;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.isDraw = false;
        m.packedBoard = 0;
        m.moves = "";

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, block.number,
            roundNumber, matchNumber, player1, player2
        )));
        m.currentTurn = (randomness % 2 == 0) ? player1 : player2;
        m.firstPlayer = m.currentTurn;

        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
    }

    function _resetMatchGame(bytes32 matchId) public override {
        Match storage m = matches[matchId];
        m.player1 = address(0);
        m.player2 = address(0);
        m.winner = address(0);
        m.currentTurn = address(0);
        m.firstPlayer = address(0);
        m.status = MatchStatus.NotStarted;
        m.isDraw = false;
        m.packedBoard = 0;
        m.packedState = 0;
        m.startTime = 0;
        m.lastMoveTime = 0;
        m.player1TimeRemaining = 0;
        m.player2TimeRemaining = 0;
        m.moves = "";
        m.completionReason = CompletionReason.NormalWin;
    }

    function _getMatchResult(bytes32 matchId)
        public view override
        returns (address winner, bool isDraw, MatchStatus status)
    {
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
            block.prevrandao, block.timestamp, block.number,
            matchId, m.player1, m.player2
        )));
        m.currentTurn = (randomness % 2 == 0) ? m.player1 : m.player2;
        m.firstPlayer = m.currentTurn;
        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage m = matches[matchId];
        m.status = MatchStatus.Completed;
        m.winner = isDraw ? address(0) : winner;
        m.isDraw = isDraw;
    }

    function _completeMatchGameSpecific(
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) internal override {
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
        uint256 currentPlayerTime = (m.currentTurn == m.player1)
            ? m.player1TimeRemaining
            : m.player2TimeRemaining;
        return elapsed >= currentPlayerTime;
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

        // Update time bank for current player
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
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, CompletionReason.NormalWin);
            return;
        }

        // Check draw
        if (_checkDraw(m.packedBoard)) {
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, CompletionReason.Draw);
            return;
        }

        // Switch turn
        m.currentTurn = (msg.sender == m.player1) ? m.player2 : m.player1;
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
