// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";

/**
 * @title TicTacToeGameModule
 * @dev Stateless module for Tic-Tac-Toe game-specific logic
 *
 * Contains game mechanics extracted from TicTacChain:
 * - makeMove() - Core gameplay logic with time banks and win/draw detection
 * - claimTimeoutWin() - Timeout victory claiming
 * - Board manipulation helpers (pack/unpack cells, win/draw checking)
 *
 * Designed to be called via delegatecall from TicTacChain
 */
contract TicTacToeGameModule is ETour_Storage {

    // ============ Game-Specific Enums ============

    enum Cell { Empty, X, O }

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
    // TimeoutVictoryClaimed inherited from ETour_Storage

    // ============ Game-Specific Structs ============

    struct Match {
        address player1;
        MatchStatus status;
        bool isDraw;
        address player2;
        address currentTurn;
        address winner;
        address firstPlayer;
        uint256 packedBoard;
        uint256 lastMoveTime;
        uint256 startTime;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }

    // ============ Storage Layout Alignment ============
    // CRITICAL: Must match TicTacChain storage layout for delegatecall

    mapping(bytes32 => Match) public matches;

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

    // ============ Game Logic ============

    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender == matchData.currentTurn, "NT");
        require(cellIndex < 9, "IC");
        require(_getCell(matchData.packedBoard, cellIndex) == Cell.Empty, "CO");

        // Update time bank for current player (Fischer increment)
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;
        uint256 timeIncrement = 15 seconds; // Fixed increment for tic-tac-toe

        if (msg.sender == matchData.player1) {
            if (matchData.player1TimeRemaining >= timeElapsed) {
                matchData.player1TimeRemaining -= timeElapsed;
            } else {
                matchData.player1TimeRemaining = 0;
            }
            matchData.player1TimeRemaining += timeIncrement;
        } else {
            if (matchData.player2TimeRemaining >= timeElapsed) {
                matchData.player2TimeRemaining -= timeElapsed;
            } else {
                matchData.player2TimeRemaining = 0;
            }
            matchData.player2TimeRemaining += timeIncrement;
        }

        // Update board with packed cell
        Cell cellValue = (msg.sender == matchData.player1) ? Cell.X : Cell.O;
        matchData.packedBoard = _packCell(matchData.packedBoard, cellIndex, cellValue);
        matchData.lastMoveTime = block.timestamp;
        matchData.lastMoveTimestamp = block.timestamp;

        emit MoveMade(matchId, msg.sender, cellIndex);

        if (_checkWin(matchData.packedBoard)) {
            // Set match status for main contract to handle completion
            matchData.status = MatchStatus.Completed;
            matchData.winner = msg.sender;
            matchData.isDraw = false;
            return;
        }

        if (_checkDraw(matchData.packedBoard)) {
            // Set match status for main contract to handle completion
            matchData.status = MatchStatus.Completed;
            matchData.winner = address(0);
            matchData.isDraw = true;
            return;
        }

        matchData.currentTurn = (matchData.currentTurn == matchData.player1) ? matchData.player2 : matchData.player1;
    }

    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender != matchData.currentTurn, "NT");

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
        require(timeElapsed >= opponentTimeRemaining, "TO");

        // Set match status for main contract to handle completion
        // Note: TimeoutVictoryClaimed event will be emitted by main contract
        matchData.status = MatchStatus.Completed;
        matchData.winner = msg.sender;
        matchData.isDraw = false;
    }

    // ============ Board Packing Helpers ============

    function _packCell(uint256 board, uint8 index, Cell cell) internal pure returns (uint256) {
        require(index < 9, "IC");
        uint256 shift = uint256(index) * 2;
        uint256 mask = ~(uint256(3) << shift);
        return (board & mask) | (uint256(cell) << shift);
    }

    function _getCell(uint256 board, uint8 index) internal pure returns (Cell) {
        require(index < 9, "IC");
        uint256 shift = uint256(index) * 2;
        return Cell((board >> shift) & 3);
    }

    function _isBoardEmpty(uint256 board) internal pure returns (bool) {
        return board == 0;
    }

    // ============ Win/Draw Detection ============

    function _checkWin(uint256 board) internal pure returns (bool) {
        uint8[3][8] memory lines = [
            [uint8(0),1,2], [3,4,5], [6,7,8],  // Rows
            [uint8(0),3,6], [1,4,7], [2,5,8],  // Cols
            [uint8(0),4,8], [2,4,6]             // Diagonals
        ];

        for (uint256 i = 0; i < 8; i++) {
            Cell a = _getCell(board, lines[i][0]);
            Cell b = _getCell(board, lines[i][1]);
            Cell c = _getCell(board, lines[i][2]);

            if (a != Cell.Empty && a == b && b == c) {
                return true;
            }
        }
        return false;
    }

    function _checkDraw(uint256 board) internal pure returns (bool) {
        for (uint8 i = 0; i < 9; i++) {
            if (_getCell(board, i) == Cell.Empty) {
                return false;
            }
        }
        return true;
    }
}
