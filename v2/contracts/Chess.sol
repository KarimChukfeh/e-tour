// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourGame.sol";

interface IChessRules {
    function processMove(
        uint256 board,
        uint256 state,
        uint8 from,
        uint8 to,
        uint8 promotion,
        bool isWhite
    ) external pure returns (bool valid, uint256 newBoard, uint256 newState, uint8 gameEnd);
}

/**
 * @title Chess
 * @dev Chess game instance for the ETour factory/instance architecture.
 *
 * Board: 4-bit piece encoding per square (64 squares × 4 bits = 256 bits in uint256)
 * White pieces: 1-6 (Pawn=1, Knight=2, Bishop=3, Rook=4, Queen=5, King=6)
 * Black pieces: 7-12 (Pawn=7, Knight=8, Bishop=9, Rook=10, Queen=11, King=12)
 * Rules validation: delegated to IChessRules (CHESS_RULES) via staticcall
 * Threefold repetition tracked per-match via _positionCounts
 */
contract Chess is ETourGame {

    IChessRules public CHESS_RULES;

    uint256 private constant INITIAL_BOARD = 0xA89CB98A77777777000000000000000000000000000000001111111142365324;
    uint256 private constant INITIAL_STATE = 63 | (1 << 22); // 63 = NO_EN_PASSANT, bit 22 = fullMoveNumber=1

    // Threefold repetition tracking: matchId -> positionHash -> count
    // Nonce invalidates counts when match is reset/replayed
    mapping(bytes32 => mapping(bytes32 => uint8)) private _positionCounts;
    mapping(bytes32 => uint256) private _gameNonce;

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 from, uint8 to);

    function setChessRules(address chessRules_) external {
        require(msg.sender == factory, "Only factory");
        require(address(CHESS_RULES) == address(0), "CRI");
        require(chessRules_ != address(0), "CR");
        CHESS_RULES = IChessRules(chessRules_);
    }

    // ============ Position Hash ============

    function _computePositionHash(
        uint256 board,
        uint256 state,
        bool isWhiteTurn,
        uint256 nonce
    ) private pure returns (bytes32) {
        uint256 positionState = state & 0xFFF; // en passant + castling flags
        return keccak256(abi.encodePacked(board, positionState, isWhiteTurn, nonce));
    }

    // ============ Piece Helpers ============

    function _getPiece(uint256 board, uint8 square) private pure returns (uint8) {
        return uint8((board >> (square * 4)) & 0xF);
    }

    function _isWhitePiece(uint8 piece) private pure returns (bool) {
        return piece >= 1 && piece <= 6;
    }

    function _isBlackPiece(uint8 piece) private pure returns (bool) {
        return piece >= 7 && piece <= 12;
    }

    function _playerAssignmentMode() internal pure override returns (PlayerAssignmentMode) {
        return PlayerAssignmentMode.RandomizePlayerOrder;
    }

    function _initializeGameState(bytes32 matchId, bool isReplay) internal override {
        Match storage m = matches[matchId];
        m.packedBoard = INITIAL_BOARD;
        m.packedState = INITIAL_STATE;
        uint256 nonce = _gameNonce[matchId];
        if (isReplay) {
            nonce = ++_gameNonce[matchId];
        }
        bytes32 initHash = _computePositionHash(INITIAL_BOARD, INITIAL_STATE, true, nonce);
        _positionCounts[matchId][initHash] = 1;
    }

    function _resetGameState(bytes32 matchId) internal override {
        ++_gameNonce[matchId];
    }

    function _getGameStateHash(bytes32 matchId) internal view override returns (bytes32) {
        Match storage m = matches[matchId];
        return keccak256(abi.encodePacked(m.packedBoard, m.packedState, _gameNonce[matchId], m.moves));
    }

    // ============ Game Logic ============

    /**
     * @dev Make a chess move. Delegates all rule validation to CHESS_RULES.processMove().
     * @param roundNumber Round number within this instance
     * @param matchNumber Match number within the round
     * @param from Source square (0-63)
     * @param to   Destination square (0-63)
     * @param promotion Promotion piece type (0 = none, 5 = queen, etc.)
     */
    function makeMove(
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 from,
        uint8 to,
        uint8 promotion
    ) external nonReentrant notConcluded {
        require(from < 64 && to < 64 && from != to, "IS");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.InProgress, "MA");
        require(msg.sender == m.player1 || msg.sender == m.player2, "NP");
        require(msg.sender == m.currentTurn, "NT");

        bool isWhite = (msg.sender == m.player1);
        uint8 piece = _getPiece(m.packedBoard, from);
        require(isWhite ? _isWhitePiece(piece) : _isBlackPiece(piece), "NYP");

        // Validate and execute move via rules module
        (bool valid, uint256 newBoard, uint256 newState, uint8 gameEnd) =
            CHESS_RULES.processMove(m.packedBoard, m.packedState, from, to, promotion, isWhite);
        require(valid, "IM");

        _consumeTurnClock(m);
        m.packedBoard = newBoard;
        m.packedState = newState;

        // Record move history: 2 bytes per move (from, to)
        m.moves = string(abi.encodePacked(m.moves, from, to));

        // Track position for threefold repetition (position after move, opponent to move)
        bytes32 posHash = _computePositionHash(newBoard, newState, !isWhite, _gameNonce[matchId]);
        uint8 posCount = ++_positionCounts[matchId][posHash];

        // Clear escalation state
        _clearMatchEscalation(matchId);

        emit MoveMade(matchId, msg.sender, from, to);

        if (gameEnd == 1) { // checkmate
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, MatchCompletionReason.NormalWin);
        } else if (gameEnd == 2 || gameEnd == 3 || gameEnd == 4) { // stalemate / fifty-move / insufficient material
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, MatchCompletionReason.Draw);
        } else if (posCount >= 3) { // threefold repetition
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, MatchCompletionReason.Draw);
        } else {
            _switchTurn(m);
        }
    }

    // ============ View ============

    function getBoard(uint8 roundNumber, uint8 matchNumber)
        external view returns (uint256 board, uint256 state)
    {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        board = matches[matchId].packedBoard;
        state = matches[matchId].packedState;
    }
}
