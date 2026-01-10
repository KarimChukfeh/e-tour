// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

interface IChessRules {
    function processMove(uint256 board, uint256 state, uint8 from, uint8 to, uint8 promotion, bool isWhite) external pure returns (bool valid, uint256 newBoard, uint256 newState, uint8 gameEnd);
}

contract ChessOnChain is ETour_Storage {

    IChessRules public immutable CHESS_RULES;

    uint256 private constant INITIAL_BOARD = 0xA89CB98A77777777000000000000000000000000000000001111111142365324;
    uint256 private constant INITIAL_STATE = 63 | (1 << 22);  // 63 = NO_EN_PASSANT, bit 22 = fullMoveNumber=1

    // ============ Game-Specific Structs ============

    struct Match {
        address player1;              // White
        address player2;              // Black
        address winner;
        address currentTurn;
        address firstPlayer;
        MatchStatus status;
        bool isDraw;
        uint256 packedBoard;
        uint256 packedState;
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        string moves;
    }

    struct ChessMatchData {
        CommonMatchData common;
        uint256 packedBoard;
        uint256 packedState;
        address currentTurn;
        address firstPlayer;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
    }
    struct LeaderboardEntry { address player; int256 earnings; }

    // ============ Game-Specific Storage ============

    mapping(bytes32 => Match) public matches;

    // Elite tournament match history (Tier 3 and Tier 7 finals)
    Match[] public eliteMatches;

    // ============ Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 from, uint8 to);

    // ============ Constructor ============

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress,
        address _moduleGameCacheAddress,
        address _moduleChessRulesAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress,
        _moduleGameCacheAddress
    ) {
        CHESS_RULES = IChessRules(_moduleChessRulesAddress);

        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 600,
            timeIncrementPerMove: 15,
            matchLevel2Delay: 180,
            matchLevel3Delay: 360,
            enrollmentWindow: 0,  // Set per tier in loop
            enrollmentLevel2Delay: 300
        });

        for (uint8 i = 0; i < 8; i++) {
            timeouts.enrollmentWindow = i < 4 ? 600 : 1800;
            timeouts.matchTimePerPlayer = i == 3 || i == 7 ? 1200 : 600;
            timeouts.timeIncrementPerMove = i == 3 || i == 7 ? 30 : 15;

            MODULE_CORE.delegatecall(
                abi.encodeWithSignature("registerTier(uint8,uint8,uint8,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))",
                    i,                           // tierId
                    i < 4 ? 2 : 4,               // playerCount
                    i < 4 ? 100 : 50,            // instanceCount
                    (
                        i == 0 ? 0.003 ether :
                        i == 1 ? 0.008 ether :
                        i == 2 ? 0.015 ether :
                        i == 3 ? 0.1 ether :
                        i == 4 ? 0.004 ether :
                        i == 5 ? 0.009 ether :
                        i == 6 ? 0.02 ether :
                                 0.15 ether
                    ),                          // entryFee                
                    timeouts
                )
            );
        }
    }

    // ============ Initialization ============

    function initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId);
        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;

        if (roundNumber == 0) {
            address[] storage players = enrolledPlayers[tierId][instanceId];
            TournamentInstance storage tournament = tournaments[tierId][instanceId];

            address walkoverPlayer = address(0);
            if (tournament.enrolledCount % 2 == 1) {
                uint256 randomness = uint256(keccak256(abi.encodePacked(
                    block.prevrandao, block.timestamp, tierId, instanceId, tournament.enrolledCount
                )));
                uint8 walkoverIndex = uint8(randomness % tournament.enrolledCount);
                walkoverPlayer = players[walkoverIndex];

                address lastPlayer = players[tournament.enrolledCount - 1];
                players[walkoverIndex] = lastPlayer;
                players[tournament.enrolledCount - 1] = walkoverPlayer;
            }

            for (uint8 i = 0; i < matchCount; i++) {
                address p1 = players[i * 2];
                address p2 = players[i * 2 + 1];
                _createMatchGame(tierId, instanceId, roundNumber, i, p1, p2);

                bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                playerActiveMatches[p1].push(matchId);
                playerMatchIndex[p1][matchId] = playerActiveMatches[p1].length - 1;
                playerActiveMatches[p2].push(matchId);
                playerMatchIndex[p2][matchId] = playerActiveMatches[p2].length - 1;
            }

            if (walkoverPlayer != address(0)) {
                MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchCount, walkoverPlayer)
                );
            }
        }
    }

    function getMatchCountForRound(uint8 tierId, uint8 instanceId) public view returns (uint8) {
        return tournaments[tierId][instanceId].enrolledCount / 2;
    }

    // ============ Inline Helpers ============

    function _getPiece(uint256 board, uint8 square) private pure returns (uint8) {
        return uint8((board >> (square * 4)) & 0xF);
    }

    function _isWhitePiece(uint8 piece) private pure returns (bool) {
        return piece >= 1 && piece <= 6;
    }

    function _isBlackPiece(uint8 piece) private pure returns (bool) {
        return piece >= 7 && piece <= 12;
    }


    // ============ Public ETour Function Wrappers ============

    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "E");

        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }
    }

    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("forceStartTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "FS");

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }

        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.Completed) {
            address winner = tournament.winner;
            address[] memory singlePlayer = new address[](1);
            singlePlayer[0] = winner;

            (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
            );
            require(resetSuccess, "RT");

            _onTournamentCompleted(tierId, instanceId, singlePlayer);
        }
    }

    function executeProtocolRaffle(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle(uint8,uint8)", tierId, instanceId)
        );
        require(success, "ER");
    }

    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("resetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "RW");
    }

    /// @dev Check if enrollment window can be reset (single player after timeout)
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool) {
        TournamentInstance storage t = tournaments[tierId][instanceId];
        return t.status == TournamentStatus.Enrolling &&
               t.enrolledCount == 1 &&
               isEnrolled[tierId][instanceId][msg.sender] &&
               block.timestamp >= t.enrollmentTimeout.escalation1Start;
    }

    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "CAE");

        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );
        require(resetSuccess, "RT");
    }

    function forceEliminateStalledMatch(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external nonReentrant {
        // Save enrolled players before delegatecall modifies state
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("forceEliminateStalledMatch(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "FE");

        // Check if round is complete before consolidating
        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (round.completedMatches == round.totalMatches) {
            // Consolidate next round if ML2 left odd number of winners
            MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature(
                    "consolidateAndStartOddRound(uint8,uint8,uint8)",
                    tierId, instanceId, roundNumber
                )
            );
        }

        // Check if tournament completed and handle prize distribution/reset
        _handleTournamentCompletion(tierId, instanceId, enrolledPlayersCopy);
    }

    function claimMatchSlotByReplacement(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external nonReentrant {
        // Save enrolled players before delegatecall modifies state
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("claimMatchSlotByReplacement(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "CR");
        _onExternalPlayerReplacement(tierId, instanceId, msg.sender);

        // Check if round is complete before consolidating
        Round storage round = rounds[tierId][instanceId][roundNumber];
        if (round.completedMatches == round.totalMatches) {
            // Consolidate next round if ML3 left odd number of winners
            MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature(
                    "consolidateAndStartOddRound(uint8,uint8,uint8)",
                    tierId, instanceId, roundNumber
                )
            );
        }

        // Add external player to cleanup list for tournament completion
        address[] memory allPlayers = new address[](enrolledPlayersCopy.length + 1);
        for (uint256 i = 0; i < enrolledPlayersCopy.length; i++) {
            allPlayers[i] = enrolledPlayersCopy[i];
        }
        allPlayers[enrolledPlayersCopy.length] = msg.sender; // Add external player

        // Check if tournament completed and handle prize distribution/reset
        _handleTournamentCompletion(tierId, instanceId, allPlayers);
    }

    /**
     * @dev Check if Level 1 escalation is available (opponent timeout claim)
     */
    function isMatchEscL1Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool) {
        (bool success, bytes memory result) = MODULE_ESCALATION.staticcall(
            abi.encodeWithSignature(
                "isMatchEscL1Available(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(success, "L1");
        return abi.decode(result, (bool));
    }

    /**
     * @dev Check if Level 2 escalation is available (advanced player force eliminate)
     */
    function isMatchEscL2Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool) {
        (bool success, bytes memory result) = MODULE_ESCALATION.staticcall(
            abi.encodeWithSignature(
                "isMatchEscL2Available(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(success, "L2");
        return abi.decode(result, (bool));
    }

    /**
     * @dev Check if Level 3 escalation is available (external player replacement)
     */
    function isMatchEscL3Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool) {
        (bool success, bytes memory result) = MODULE_ESCALATION.staticcall(
            abi.encodeWithSignature(
                "isMatchEscL3Available(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        require(success, "L3");
        return abi.decode(result, (bool));
    }

    /**
     * @dev Check if a player has advanced in the tournament
     */
    function isPlayerInAdvancedRound(
        uint8 tierId,
        uint8 instanceId,
        uint8 stalledRoundNumber,
        address player
    ) external view returns (bool) {
        if (!isEnrolled[tierId][instanceId][player]) {
            return false;
        }

        // Check 1: Has player won a match in any round up to and including the stalled round?
        for (uint8 r = 0; r <= stalledRoundNumber; r++) {
            Round storage round = rounds[tierId][instanceId][r];

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                Match storage matchData = matches[matchId];

                // Check active storage first
                if (matchData.player1 != address(0)) {
                    // Match exists in active storage
                    if (matchData.status == MatchStatus.Completed &&
                        matchData.winner == player &&
                        !matchData.isDraw) {
                        return true;
                    }
                } else {
                    // Match might be cached - check cache
                    (CommonMatchData memory cachedMatch, bool exists) = _getMatchFromCache(matchId, tierId, instanceId, r, m);
                    if (exists &&
                        cachedMatch.status == MatchStatus.Completed &&
                        cachedMatch.winner == player &&
                        !cachedMatch.isDraw) {
                        return true;
                    }
                }
            }
        }

        // Check 2: Is player assigned to a match in a round AFTER the stalled round?
        // This catches walkover/auto-advanced players
        TierConfig storage config = _tierConfigs[tierId];
        for (uint8 r = stalledRoundNumber + 1; r < config.totalRounds; r++) {
            Round storage round = rounds[tierId][instanceId][r];
            if (!round.initialized) continue;

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                Match storage matchData = matches[matchId];

                if (matchData.player1 == player || matchData.player2 == player) {
                    return true;
                }
            }
        }

        return false;
    }

    // ============ Chess Gameplay ============

    function makeMove(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber, uint8 from, uint8 to, uint8 promotion) external nonReentrant {
        require(from < 64 && to < 64 && from != to, "IS");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.InProgress, "MA");
        require(msg.sender == m.player1 || msg.sender == m.player2, "NP");
        require(msg.sender == m.currentTurn, "NT");

        bool isWhite = (msg.sender == m.player1);
        uint8 piece = _getPiece(m.packedBoard, from);
        require(isWhite ? _isWhitePiece(piece) : _isBlackPiece(piece), "NYP");

        // Single call to module for validation, execution, and game-end detection
        (bool valid, uint256 newBoard, uint256 newState, uint8 gameEnd) = CHESS_RULES.processMove(m.packedBoard, m.packedState, from, to, promotion, isWhite);
        require(valid, "IM");

        // Update time bank
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        if (isWhite) {
            m.player1TimeRemaining = m.player1TimeRemaining > elapsed ? m.player1TimeRemaining - elapsed + 15 : 15;
        } else {
            m.player2TimeRemaining = m.player2TimeRemaining > elapsed ? m.player2TimeRemaining - elapsed + 15 : 15;
        }
        m.lastMoveTime = block.timestamp;
        m.packedBoard = newBoard;
        m.packedState = newState;

        // Store move in history as compact bytes: each move is 2 bytes (from, to)
        m.moves = string(abi.encodePacked(m.moves, from, to));

        // Clear any escalation state since a move was made (match is no longer stalled) - inlined
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        emit MoveMade(matchId, msg.sender, from, to);

        if (gameEnd == 1) { // checkmate
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
        } else if (gameEnd == 2) { // stalemate
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, address(0), true);
        } else if (gameEnd == 4) { // insufficient material
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, address(0), true);
        } else {
            m.currentTurn = isWhite ? m.player2 : m.player1;
        }
    }

    function claimTimeoutWin(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender != matchData.currentTurn, "OT");

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 opponentTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining : matchData.player2TimeRemaining;

        require(elapsed >= opponentTime, "TO");

        (bool markSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("markMatchStalled(bytes32,uint8,uint256)", matchId, tierId, block.timestamp)
        );
        require(markSuccess, "MS");

        address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;
        _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    function _handleTournamentCompletion(
        uint8 tierId,
        uint8 instanceId,
        address[] memory enrolledPlayersCopy
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        if (tournament.status != TournamentStatus.Completed || enrolledPlayersCopy.length == 0) {
            return;
        }

        address tournamentWinner = tournament.winner;
        uint256 winnersPot = tournament.prizePool;

        // Distribute prizes based on completion type
        if (tournament.allDrawResolution) {
            (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributeEqualPrizes(uint8,uint8,address[],uint256)",
                    tierId, instanceId, enrolledPlayersCopy, winnersPot)
            );
            require(distributeSuccess, "DP");
        } else {
            (bool distributeSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributePrizes(uint8,uint8,uint256)",
                    tierId, instanceId, winnersPot)
            );
            require(distributeSuccess, "DP");
        }

        // Update earnings for the winner (if there is one)
        if (tournamentWinner != address(0)) {
            (bool earningsSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("updatePlayerEarnings(uint8,uint8,address)",
                    tierId, instanceId, tournamentWinner)
            );
        }

        // Emit TournamentCompleted event with actual prize amount
        uint256 winnerPrize = playerPrizes[tierId][instanceId][tournamentWinner];
        emit TournamentCompleted(tierId, instanceId, tournamentWinner, winnerPrize,
            tournament.completionReason, enrolledPlayersCopy);

        // Archive elite tournament finals match (Tier 3 or Tier 7) - BEFORE reset
        if (tierId == 3 || tierId == 7) {
            bytes32 finalsMatchId = _getMatchId(tierId, instanceId, tournament.currentRound, 0);
            eliteMatches.push(matches[finalsMatchId]);
        }

        // Reset tournament
        MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );

        // Call completion hook
        _onTournamentCompleted(tierId, instanceId, enrolledPlayersCopy);
    }

    function _completeMatchInternal(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber, address winner, bool isDraw) private {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        _completeMatchWithResult(tierId, instanceId, roundNumber, matchNumber, winner, isDraw);

        // Clear escalation state - inlined
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        address[] memory epc = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            epc[i] = enrolledPlayers[tierId][instanceId][i];
        }

        MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("completeMatch(uint8,uint8,uint8,uint8,address,bool)", tierId, instanceId, roundNumber, matchNumber, winner, isDraw)
        );

        if (!isDraw) {
            Match storage matchData = matches[matchId];
            address loser = (winner == matchData.player1) ? matchData.player2 : matchData.player1;
            _onPlayerEliminatedFromTournament(loser, tierId, instanceId, roundNumber);
        }

        // Check if tournament completed and handle prize distribution/reset
        _handleTournamentCompletion(tierId, instanceId, epc);
    }

    // ============ IETourGame Interface ============

    function _createMatchGame(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber, address player1, address player2) public override {
        require(player1 != player2 && player1 != address(0) && player2 != address(0), "IP");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.player1 = player2;
        matchData.player2 = player1;

        if (block.prevrandao % 2 == 0) {
            matchData.player1 = player1;
            matchData.player2 = player2;
        }

        matchData.currentTurn = matchData.player1;
        matchData.firstPlayer = matchData.player1;
        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.lastMoveTime = block.timestamp;
        matchData.isDraw = false;
        matchData.packedBoard = INITIAL_BOARD;
        matchData.packedState = INITIAL_STATE;
        matchData.moves = "";

        matchData.player1TimeRemaining = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
    }

    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];
        return matchData.player1 != address(0) && matchData.status != MatchStatus.Completed;
    }

    function _completeMatchWithResult(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber, address winner, bool isDraw) internal {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;

        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
    }

    function _addToMatchCacheGame(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) public override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        bytes memory boardData = abi.encode(matchData.packedBoard, matchData.packedState);

        (bool success, ) = MODULE_GAME_CACHE.delegatecall(
            abi.encodeWithSignature("addToMatchCache(bytes32,uint8,uint8,uint8,uint8,address,address,address,address,uint256,bool,bytes)",
                matchId, tierId, instanceId, roundNumber, matchNumber,
                matchData.player1, matchData.player2, matchData.firstPlayer, matchData.winner,
                matchData.startTime, matchData.isDraw, boardData
            )
        );
        require(success, "CF");
    }

    function _getTimeIncrement() public pure override returns (uint256) { return 15; }

    function _resetMatchGame(bytes32 matchId) public override {
        Match storage m = matches[matchId];
        m.player1 = address(0); m.player2 = address(0); m.winner = address(0);
        m.currentTurn = address(0); m.firstPlayer = address(0);
        m.status = MatchStatus.NotStarted; m.isDraw = false;
        m.packedBoard = 0; m.packedState = 0;
        m.startTime = 0; m.lastMoveTime = 0;
        m.player1TimeRemaining = 0; m.player2TimeRemaining = 0;
    }

    function _getMatchResult(bytes32 matchId) public view override returns (address, bool, MatchStatus) {
        Match storage m = matches[matchId];
        return (m.winner, m.isDraw, m.status);
    }

    function _getMatchPlayers(bytes32 matchId) public view override returns (address, address) {
        Match storage m = matches[matchId];
        return (m.player1, m.player2);
    }

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public override {
        Match storage m = matches[matchId];
        if (slot == 0) m.player1 = player; else m.player2 = player;
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
        Match storage m = matches[matchId];
        m.status = MatchStatus.InProgress;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.packedBoard = INITIAL_BOARD;
        m.packedState = INITIAL_STATE;
        m.isDraw = false;
        m.winner = address(0);

        if (block.prevrandao % 2 == 1) {
            (m.player1, m.player2) = (m.player2, m.player1);
        }
        m.currentTurn = m.player1;
        m.firstPlayer = m.player1;

        m.player1TimeRemaining = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        m.player2TimeRemaining = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage m = matches[matchId];
        m.status = MatchStatus.Completed;
        m.winner = winner;
        m.isDraw = isDraw;
    }

    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage m = matches[matchId];
        if (m.status != MatchStatus.InProgress) return false;
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        uint256 time = (m.currentTurn == m.player1) ? m.player1TimeRemaining : m.player2TimeRemaining;
        return elapsed >= time;
    }

    function _getActiveMatchData(bytes32 matchId, uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) public view override returns (CommonMatchData memory) {
        Match storage m = matches[matchId];
        address loser = (!m.isDraw && m.winner != address(0)) ? (m.winner == m.player1 ? m.player2 : m.player1) : address(0);
        return CommonMatchData(m.player1, m.player2, m.winner, loser, m.status, m.isDraw, m.startTime, m.lastMoveTime, tierId, instanceId, roundNumber, matchNumber, false);
    }
    

    function _getMatchFromCache(bytes32 matchId, uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) public view override returns (CommonMatchData memory data, bool exists) {
        (bool success, bytes memory result) = MODULE_GAME_CACHE.staticcall(
            abi.encodeWithSignature("getMatchFromCacheByMatchId(bytes32,uint8,uint8,uint8,uint8)", matchId, tierId, instanceId, roundNumber, matchNumber)
        );
        if (!success) return (data, false);
        (data, exists) = abi.decode(result, (CommonMatchData, bool));
    }

    // ============ View Functions ============

    function getMatch(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) public view returns (ChessMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage m = matches[matchId];

        if (m.player1 != address(0)) {
            address loser = (!m.isDraw && m.winner != address(0)) ? (m.winner == m.player1 ? m.player2 : m.player1) : address(0);
            return ChessMatchData(
                CommonMatchData(m.player1, m.player2, m.winner, loser, m.status, m.isDraw, m.startTime, m.lastMoveTime, tierId, instanceId, roundNumber, matchNumber, false),
                m.packedBoard, m.packedState, m.currentTurn, m.firstPlayer, m.player1TimeRemaining, m.player2TimeRemaining
            );
        }

        (bool success, bytes memory result) = MODULE_GAME_CACHE.staticcall(
            abi.encodeWithSignature("getMatchFromCacheByMatchId(bytes32,uint8,uint8,uint8,uint8)", matchId, tierId, instanceId, roundNumber, matchNumber)
        );

        if (success) {
            (address p1, address p2, address fp, address w, uint256 st, uint256 et, bool isDraw, bool exists, bytes memory bd) =
                abi.decode(result, (address, address, address, address, uint256, uint256, bool, bool, bytes));
            if (exists) {
                address loser = (!isDraw && w != address(0)) ? (w == p1 ? p2 : p1) : address(0);
                uint256 board; uint256 state;
                if (bd.length > 0) (board, state) = abi.decode(bd, (uint256, uint256));
                return ChessMatchData(
                    CommonMatchData(p1, p2, w, loser, MatchStatus.Completed, isDraw, st, et, tierId, instanceId, roundNumber, matchNumber, true),
                    board, state, address(0), fp, 0, 0
                );
            }
        }
    }

    function getBoard(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) external view returns (uint8[64] memory board) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        uint256 packed = matches[matchId].packedBoard;
        for (uint8 i = 0; i < 64; i++) board[i] = _getPiece(packed, i);
    }

    function getCurrentTimeRemaining(uint8 tierId, uint8 instanceId, uint8 roundNumber, uint8 matchNumber) public view returns (uint256 p1, uint256 p2) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage m = matches[matchId];
        if (m.status != MatchStatus.InProgress) return (m.player1TimeRemaining, m.player2TimeRemaining);
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        if (m.currentTurn == m.player1) {
            p1 = m.player1TimeRemaining > elapsed ? m.player1TimeRemaining - elapsed : 0;
            p2 = m.player2TimeRemaining;
        } else {
            p1 = m.player1TimeRemaining;
            p2 = m.player2TimeRemaining > elapsed ? m.player2TimeRemaining - elapsed : 0;
        }
    }

    function getPlayerStats() external view returns (int256) { return playerEarnings[msg.sender]; }
    function getPlayerEnrollingTournaments(address player) external view returns (TournamentRef[] memory) { return playerEnrollingTournaments[player]; }
    function getPlayerActiveTournaments(address player) external view returns (TournamentRef[] memory) { return playerActiveTournaments[player]; }

    function getTournamentInfo(uint8 tierId, uint8 instanceId) external view returns (TournamentStatus, uint8, uint8, uint256, address) {
        TournamentInstance storage t = tournaments[tierId][instanceId];
        return (t.status, t.currentRound, t.enrolledCount, t.prizePool, t.winner);
    }

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (uint8, uint8, bool) {
        Round storage r = rounds[tierId][instanceId][roundNumber];
        return (r.totalMatches, r.completedMatches, r.initialized);
    }

    function getLeaderboard() external view returns (LeaderboardEntry[] memory entries) {
        entries = new LeaderboardEntry[](_leaderboardPlayers.length);
        for (uint256 i = 0; i < _leaderboardPlayers.length; i++) {
            entries[i] = LeaderboardEntry(_leaderboardPlayers[i], playerEarnings[_leaderboardPlayers[i]]);
        }
    }

    function getRaffleInfo() external view returns (
        uint32 raffleIndex, bool isReady, uint256 currentAccumulated, uint256 threshold,
        uint256 reserve, uint256 raffleAmount, uint256 ownerShare, uint256 winnerShare, uint32 eligiblePlayerCount
    ) {
        raffleIndex = uint32(currentRaffleIndex);
        currentAccumulated = accumulatedProtocolShare;
        threshold = 3 ether;
        reserve = (threshold * 10) / 100;
        isReady = currentAccumulated >= threshold;
        raffleAmount = threshold - reserve;
        ownerShare = (raffleAmount * 20) / 100;
        winnerShare = (raffleAmount * 80) / 100;
        (bool s, bytes memory d) = MODULE_RAFFLE.staticcall(abi.encodeWithSignature("getEligiblePlayerCount()"));
        eligiblePlayerCount = s ? uint32(abi.decode(d, (uint256))) : 0;
    }

    function getEliteMatch(uint256 index) external view returns (address, address, address, address, address, MatchStatus, bool, uint256, uint256, uint256, uint256, uint256, uint256, bytes memory) {
        Match storage m = eliteMatches[index];
        return (m.player1, m.player2, m.winner, m.currentTurn, m.firstPlayer, m.status, m.isDraw, m.packedBoard, m.packedState, m.startTime, m.lastMoveTime, m.player1TimeRemaining, m.player2TimeRemaining, bytes(m.moves));
    }

    // ============ Player Tracking Hooks ============

    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal override {
        if (playerEnrollingIndex[player][tierId][instanceId] != 0) return;
        playerEnrollingTournaments[player].push(TournamentRef(tierId, instanceId));
        playerEnrollingIndex[player][tierId][instanceId] = playerEnrollingTournaments[player].length;
    }

    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal override {
        address[] storage players = enrolledPlayers[tierId][instanceId];
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            _removeEnrolling(p, tierId, instanceId);
            _addActive(p, tierId, instanceId);
        }
    }

    function _onPlayerEliminatedFromTournament(address player, uint8 tierId, uint8 instanceId, uint8) internal override {
        _removeActive(player, tierId, instanceId);
    }

    function _onExternalPlayerReplacement(uint8 tierId, uint8 instanceId, address player) internal override {
        _addActive(player, tierId, instanceId);
    }

    function _onTournamentCompleted(uint8 tierId, uint8 instanceId, address[] memory players) internal override {
        for (uint256 i = 0; i < players.length; i++) {
            _removeEnrolling(players[i], tierId, instanceId);
            _removeActive(players[i], tierId, instanceId);
        }
    }

    function _removeEnrolling(address p, uint8 t, uint8 i) private {
        uint256 idx = playerEnrollingIndex[p][t][i];
        if (idx == 0) return;
        uint256 last = playerEnrollingTournaments[p].length - 1;
        if (idx - 1 != last) {
            TournamentRef memory r = playerEnrollingTournaments[p][last];
            playerEnrollingTournaments[p][idx - 1] = r;
            playerEnrollingIndex[p][r.tierId][r.instanceId] = idx;
        }
        playerEnrollingTournaments[p].pop();
        delete playerEnrollingIndex[p][t][i];
    }

    function _addActive(address p, uint8 t, uint8 i) private {
        if (playerActiveIndex[p][t][i] != 0) return;
        playerActiveTournaments[p].push(TournamentRef(t, i));
        playerActiveIndex[p][t][i] = playerActiveTournaments[p].length;
    }

    function _removeActive(address p, uint8 t, uint8 i) private {
        uint256 idx = playerActiveIndex[p][t][i];
        if (idx == 0) return;
        uint256 last = playerActiveTournaments[p].length - 1;
        if (idx - 1 != last) {
            TournamentRef memory r = playerActiveTournaments[p][last];
            playerActiveTournaments[p][idx - 1] = r;
            playerActiveIndex[p][r.tierId][r.instanceId] = idx;
        }
        playerActiveTournaments[p].pop();
        delete playerActiveIndex[p][t][i];
    }
}
