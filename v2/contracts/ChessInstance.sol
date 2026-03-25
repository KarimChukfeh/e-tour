// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourInstance.sol";

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
 * @title ChessInstance
 * @dev Chess game instance for the ETour factory/instance architecture.
 *
 * Board: 4-bit piece encoding per square (64 squares × 4 bits = 256 bits in uint256)
 * White pieces: 1-6 (Pawn=1, Knight=2, Bishop=3, Rook=4, Queen=5, King=6)
 * Black pieces: 7-12 (Pawn=7, Knight=8, Bishop=9, Rook=10, Queen=11, King=12)
 * Rules validation: delegated to IChessRules (CHESS_RULES) via staticcall
 * Threefold repetition tracked per-match via _positionCounts
 */
contract ChessInstance is ETourInstance {

    IChessRules public CHESS_RULES;

    uint256 private constant INITIAL_BOARD = 0xA89CB98A77777777000000000000000000000000000000001111111142365324;
    uint256 private constant INITIAL_STATE = 63 | (1 << 22); // 63 = NO_EN_PASSANT, bit 22 = fullMoveNumber=1

    // Threefold repetition tracking: matchId -> positionHash -> count
    // Nonce invalidates counts when match is reset/replayed
    mapping(bytes32 => mapping(bytes32 => uint8)) private _positionCounts;
    mapping(bytes32 => uint256) private _gameNonce;

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 from, uint8 to);

    // ============ Chess-Specific Initializer ============

    /**
     * @dev Extended initialize that also sets the chess rules address.
     * Called by ChessOnChainFactory.createInstance() after cloning.
     * Replaces the base initialize() — do NOT call both.
     */
    function initializeChess(
        TierConfig calldata config_,
        address factory_,
        address creator_,
        address moduleCore_,
        address moduleMatches_,
        address modulePrizes_,
        address moduleEscalation_,
        address chessRules_
    ) external {
        // Calls the base initializer (sets _initialized = true)
        this.initialize(config_, factory_, creator_, moduleCore_, moduleMatches_, modulePrizes_, moduleEscalation_);
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

    // ============ ETourInstance_Base Abstract Implementations ============

    function _createMatchGame(uint8 roundNumber, uint8 matchNumber, address player1, address player2) public override {
        require(player1 != player2 && player1 != address(0) && player2 != address(0), "IP");

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, block.number,
            roundNumber, matchNumber, player1, player2
        )));
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
        m.packedBoard = INITIAL_BOARD;
        m.packedState = INITIAL_STATE;
        m.moves = "";
        m.player1TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = tierConfig.timeouts.matchTimePerPlayer;

        // Record initial position (white to move)
        bytes32 initHash = _computePositionHash(INITIAL_BOARD, INITIAL_STATE, true, _gameNonce[matchId]);
        _positionCounts[matchId][initHash] = 1;
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
        m.completionReason = CompletionReason.NormalWin;
        // Increment nonce to invalidate stale position counts
        ++_gameNonce[matchId];
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
        m.packedBoard = INITIAL_BOARD;
        m.packedState = INITIAL_STATE;
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

        // Increment nonce then record initial position
        uint256 nonce = ++_gameNonce[matchId];
        bytes32 initHash = _computePositionHash(INITIAL_BOARD, INITIAL_STATE, true, nonce);
        _positionCounts[matchId][initHash] = 1;
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

        // Update time bank
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        if (isWhite) {
            m.player1TimeRemaining = (m.player1TimeRemaining > elapsed)
                ? m.player1TimeRemaining - elapsed + _getTimeIncrement()
                : _getTimeIncrement();
        } else {
            m.player2TimeRemaining = (m.player2TimeRemaining > elapsed)
                ? m.player2TimeRemaining - elapsed + _getTimeIncrement()
                : _getTimeIncrement();
        }
        m.lastMoveTime = block.timestamp;
        m.packedBoard = newBoard;
        m.packedState = newState;

        // Record move history: 2 bytes per move (from, to)
        m.moves = string(abi.encodePacked(m.moves, from, to));

        // Track position for threefold repetition (position after move, opponent to move)
        bytes32 posHash = _computePositionHash(newBoard, newState, !isWhite, _gameNonce[matchId]);
        uint8 posCount = ++_positionCounts[matchId][posHash];

        // Clear escalation state
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        emit MoveMade(matchId, msg.sender, from, to);

        if (gameEnd == 1) { // checkmate
            _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, CompletionReason.NormalWin);
        } else if (gameEnd == 2 || gameEnd == 3 || gameEnd == 4) { // stalemate / fifty-move / insufficient material
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, CompletionReason.Draw);
        } else if (posCount >= 3) { // threefold repetition
            _completeMatchInternal(roundNumber, matchNumber, address(0), true, CompletionReason.Draw);
        } else {
            m.currentTurn = isWhite ? m.player2 : m.player1;
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
