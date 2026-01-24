// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

/**
 * @title TicTacChain
 * @dev Classic Tic-Tac-Toe game implementing ETour tournament protocol (Modular Architecture)
 * Simple, solved game used as the lowest-barrier demonstration of the ETour protocol.
 *
 * This contract demonstrates modular ETour integration by:
 * 1. Inheriting ETour_Storage for shared tournament state
 * 2. Delegating to specialized modules (Core, Matches, Prizes, etc.)
 * 3. Implementing IETourGame interface (8 abstract functions)
 * 4. Managing game-specific logic (board state, win detection, time banks)
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacChain is ETour_Storage {

    // ============ Game-Specific Structs ============

    /**
     * @dev Match storage structure for active Tic-Tac-Toe games
     * Board is packed: 2 bits per cell (0=empty, 1=player1, 2=player2)
     * Total 9 cells = 18 bits (fits in uint256 with room to spare)
     */
    struct Match {
        address player1;
        address player2;
        address winner;
        address currentTurn;
        address firstPlayer;
        MatchStatus status;
        bool isDraw;
        uint256 packedBoard;           // 9 cells, 2 bits each
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;  // Time bank with Fischer increment
        uint256 player2TimeRemaining;
    }

    /**
     * @dev Extended match data for TicTacToe including common fields and game-specific state
     * Used for view functions to return complete match information
     */
    struct TicTacToeMatchData {
        CommonMatchData common;        // Standardized tournament match data
        uint256 packedBoard;           // Game-specific: packed board state
        address currentTurn;           // Who plays next (address(0) for completed)
        address firstPlayer;           // Who started the match
        uint256 player1TimeRemaining;  // Time bank for player1
        uint256 player2TimeRemaining;  // Time bank for player2
        uint256 lastMoveTimestamp;     // When last move was made
    }

    // ============ Game-Specific Storage ============

    mapping(bytes32 => Match) public matches;  // Active matches only (matchId => Match)

    // ============ Module Addresses ============
    // (All ETour modules inherited from ETour_Storage, game logic is built-in)

    // ============ Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);

    // ============ Constructor ============

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress
    ) {
        TimeoutConfig memory timeouts = TimeoutConfig({
            matchTimePerPlayer: 120,
            timeIncrementPerMove: 15,
            matchLevel2Delay: 120,
            matchLevel3Delay: 240,
            enrollmentWindow: 0,
            enrollmentLevel2Delay: 300
        });

        // Register tiers 0-2 in loop (saves bytecode vs individual calls)
        for (uint8 i = 0; i < 3; i++) {
            timeouts.enrollmentWindow = i == 0 ? 180 : (i == 1 ? 300 : 480);
            MODULE_CORE.delegatecall(
                abi.encodeWithSignature("registerTier(uint8,uint8,uint8,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))",
                    i,
                    i == 0 ? 2 : (i == 1 ? 4 : 8),
                    i == 0 ? 100 : (i == 1 ? 50 : 25),
                    (i == 0 ? 0.0003 ether : (i == 1 ? 0.0007 ether : 0.0013 ether)),
                    timeouts
                )
            );
        }

        // Initialize progressive raffle thresholds for TicTacChain
        // Lower thresholds than base ETour to make raffles more accessible
        raffleThresholds.push(0.001 ether);
        raffleThresholds.push(0.005 ether);  // Raffle #1
        raffleThresholds.push(0.02 ether);  // Raffle #2
        raffleThresholds.push(0.05 ether);  // Raffle #3
        raffleThresholds.push(0.25 ether);  // Raffle #4
        raffleThresholds.push(0.5 ether);   // Raffle #5
        raffleThresholds.push(0.75 ether);  // Raffle #6
        raffleThresholdFinal = 1.0 ether;   // Raffle #7+
    }

    /**
     * @dev Initialize round and create matches
     * Called when tournament starts or when advancing to next round
     */
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
                    block.prevrandao,
                    block.timestamp,
                    tierId,
                    instanceId,
                    tournament.enrolledCount
                )));
                uint8 walkoverIndex = uint8(randomness % tournament.enrolledCount);
                walkoverPlayer = players[walkoverIndex];

                address lastPlayer = players[tournament.enrolledCount - 1];
                players[walkoverIndex] = lastPlayer;
                players[tournament.enrolledCount - 1] = walkoverPlayer;
            }

            // Create matches directly - this is the key fix!
            for (uint8 i = 0; i < matchCount; i++) {
                address player1 = players[i * 2];
                address player2 = players[i * 2 + 1];
                _createMatchGame(tierId, instanceId, roundNumber, i, player1, player2);

                // Add players to active match tracking
                bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, i);
                playerActiveMatches[player1].push(matchId);
                playerMatchIndex[player1][matchId] = playerActiveMatches[player1].length - 1;
                playerActiveMatches[player2].push(matchId);
                playerMatchIndex[player2][matchId] = playerActiveMatches[player2].length - 1;
            }

            if (walkoverPlayer != address(0)) {
                // Delegate winner advancement to Matches module
                (bool success, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchCount, walkoverPlayer)
                );
                require(success, "AW");
            }
        }
    }

    /**
     * @dev Get match count for round - helper function
     */
    function getMatchCountForRound(uint8 tierId, uint8 instanceId) public view returns (uint8) {
        TierConfig storage config = _tierConfigs[tierId];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return tournament.enrolledCount / 2;
    }

    // ============ Public ETour Function Wrappers (Delegatecall to Modules) ============

    /**
     * @dev Enroll in tournament - delegates to Core module
     */
    function enrollInTournament(uint8 tierId, uint8 instanceId) external payable nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        // MODULE_CORE handles enrollment logic via delegatecall
        // Note: MODULE_CORE calls _onPlayerEnrolled/_onTournamentStarted internally,
        // but those are empty stubs in the module's bytecode.
        // We must call the real hooks here after the delegatecall.
        (bool success, bytes memory returnData) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(32, returnData), mload(returnData))
                }
            } else {
                revert("Enrollment delegatecall failed");
            }
        }

        // Call player enrolled hook (always call, module checks if already enrolled)
        _onPlayerEnrolled(tierId, instanceId, msg.sender);

        // If tournament auto-started, call hooks and initialize round
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }
    }

    /**
     * @dev Force start tournament - delegates to Core module
     */
    function forceStartTournament(uint8 tierId, uint8 instanceId) external nonReentrant {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("forceStartTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "FS");

        // If tournament started with multiple players
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            _onTournamentStarted(tierId, instanceId);
            initializeRound(tierId, instanceId, 0);
        }

        // If single-player tournament completed immediately
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.Completed) {
            address winner = tournament.winner;
            address[] memory singlePlayer = new address[](1);
            singlePlayer[0] = winner;

            // Reset tournament (modules can't do nested delegatecalls)
            (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
            );
            require(resetSuccess, "RT");

            // Call completion hook
            _onTournamentCompleted(tierId, instanceId, singlePlayer);
        }
    }

    /**
     * @dev Execute protocol raffle - delegates to Raffle module
     */
    function executeProtocolRaffle() external nonReentrant {
        (bool success, ) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle()")
        );
        require(success, "ER");
    }

    /**
     * @dev Get all historic raffle results - reads from local storage
     * Returns array of all raffles executed (index 1 to currentRaffleIndex)
     */
    function getRaffleHistory() external view returns (RaffleResult[] memory) {
        uint256 count = currentRaffleIndex;
        RaffleResult[] memory history = new RaffleResult[](count);

        for (uint256 i = 1; i <= count; i++) {
            history[i - 1] = raffleResults[i];
        }

        return history;
    }

    /**
     * @dev Reset enrollment window (single player extends timeout)
     */
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("resetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "RW");
    }

    /// @dev Check if enrollment window can be reset (single player after timeout)
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool) {
        TierConfig storage c = _tierConfigs[tierId];
        if (!c.initialized || instanceId >= c.instanceCount) return false;
        TournamentInstance storage t = tournaments[tierId][instanceId];
        return t.status == TournamentStatus.Enrolling &&
               t.enrolledCount == 1 &&
               isEnrolled[tierId][instanceId][msg.sender] &&
               block.timestamp >= t.enrollmentTimeout.escalation1Start;
    }

    /**
     * @dev Claim abandoned enrollment pool - delegates to Core module
     */
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "CAE");

        // Reset tournament after claiming abandoned pool (modules can't do nested delegatecalls)
        (bool resetSuccess, ) = MODULE_PRIZES.delegatecall(
            abi.encodeWithSignature("resetTournamentAfterCompletion(uint8,uint8)", tierId, instanceId)
        );
        require(resetSuccess, "RT");
    }

    /**
     * @dev Escalation Level 2: Advanced players force eliminate both stalled players
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        // Save enrolled players before delegatecall (in case tournament completes and resets)
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        (bool success, bytes memory returnData) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "forceEliminateStalledMatch(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    let returnDataSize := mload(returnData)
                    revert(add(32, returnData), returnDataSize)
                }
            } else {
                revert("FE");
            }
        }

        // Emit MatchCompleted event from game contract (triggering player wins)
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage m = matches[matchId];
        emit MatchCompleted(matchId, m.player1, m.player2, msg.sender, false, CompletionReason.ForceElimination, m.packedBoard);

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
        // (can happen if this was a finals match or creates orphaned winner)
        _handleTournamentCompletion(tierId, instanceId, enrolledPlayersCopy);
    }

    /**
     * @dev Escalation Level 3: External player claims stalled match slot
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        // Save enrolled players before delegatecall (in case tournament completes and resets)
        address[] memory enrolledPlayersCopy = new address[](enrolledPlayers[tierId][instanceId].length);
        for (uint256 i = 0; i < enrolledPlayers[tierId][instanceId].length; i++) {
            enrolledPlayersCopy[i] = enrolledPlayers[tierId][instanceId][i];
        }

        (bool success, bytes memory returnData) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "claimMatchSlotByReplacement(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber
            )
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    let returnDataSize := mload(returnData)
                    revert(add(32, returnData), returnDataSize)
                }
            } else {
                revert("CR");
            }
        }

        // Emit MatchCompleted event from game contract (replacement player wins)
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage m = matches[matchId];
        emit MatchCompleted(matchId, m.player1, m.player2, msg.sender, false, CompletionReason.Replacement, m.packedBoard);

        // Hook for external player replacement
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

        // Check if tournament completed and handle prize distribution/reset
        // (can happen if this was a finals match)
        // Note: External player was added during delegatecall, so include them in cleanup
        address[] memory allPlayers = new address[](enrolledPlayersCopy.length + 1);
        for (uint256 i = 0; i < enrolledPlayersCopy.length; i++) {
            allPlayers[i] = enrolledPlayersCopy[i];
        }
        allPlayers[enrolledPlayersCopy.length] = msg.sender; // Add external player
        _handleTournamentCompletion(tierId, instanceId, allPlayers);
    }

    /**
     * @dev Check if Level 2 escalation is available (advanced player force eliminate)
     * Implementation directly in TicTacChain to avoid delegatecall in view function
     */
    function isMatchEscL2Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool) {
        // SECURITY: Tournament must be in progress for escalation
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        if (tournament.status != TournamentStatus.InProgress) {
            return false;
        }

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Check if match is active and in progress
        if (matchData.player1 == address(0) || matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        if (elapsed < currentPlayerTime) {
            return false;
        }

        // Check timeout state
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If not marked as stalled yet, calculate when L2 would start
        if (!timeout.isStalled) {
            TierConfig storage config = _tierConfigs[tierId];
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;
            uint256 l2Start = timeoutOccurredAt + config.timeouts.matchLevel2Delay;
            return block.timestamp >= l2Start;
        }

        // If already marked as stalled, check if L2 window is active
        return block.timestamp >= timeout.escalation1Start;
    }

    /**
     * @dev Check if Level 3 escalation is available (external player replacement)
     * Implementation directly in TicTacChain to avoid delegatecall in view function
     */
    function isMatchEscL3Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool) {
        // SECURITY: Tournament must be in progress for escalation
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        if (tournament.status != TournamentStatus.InProgress) {
            return false;
        }

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Check if match is active and in progress
        if (matchData.player1 == address(0) || matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        if (elapsed < currentPlayerTime) {
            return false;
        }

        // Check timeout state
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If not marked as stalled yet, calculate when L3 would start
        if (!timeout.isStalled) {
            TierConfig storage config = _tierConfigs[tierId];
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;
            uint256 l3Start = timeoutOccurredAt + config.timeouts.matchLevel3Delay;
            return block.timestamp >= l3Start;
        }

        // If already marked as stalled, check if L3 window is active
        return block.timestamp >= timeout.escalation2Start;
    }

    /**
     * @dev Check if a player has advanced in the tournament
     * Implementation directly in TicTacChain (not delegated) to avoid staticcall issues
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

                // Check active storage
                if (matchData.status == MatchStatus.Completed &&
                    matchData.winner == player &&
                    !matchData.isDraw) {
                    return true;
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

    // ============ Game Logic (Tic-Tac-Toe Specific) ============

    /**
     * @dev Make a move on the Tic-Tac-Toe board
     * Handles time bank updates with Fischer increment
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external nonReentrant {
        require(cellIndex < 9, "IC");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender == matchData.currentTurn, "NT");
        require(_getCell(matchData.packedBoard, cellIndex) == 0, "CO");

        // Update time bank for current player
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        if (matchData.currentTurn == matchData.player1) {
            matchData.player1TimeRemaining = (matchData.player1TimeRemaining > elapsed)
                ? matchData.player1TimeRemaining - elapsed
                : 0;
            matchData.player1TimeRemaining += _getTimeIncrement();
        } else {
            matchData.player2TimeRemaining = (matchData.player2TimeRemaining > elapsed)
                ? matchData.player2TimeRemaining - elapsed
                : 0;
            matchData.player2TimeRemaining += _getTimeIncrement();
        }
        matchData.lastMoveTime = block.timestamp;

        // Make move: Set cell to player's symbol (1 or 2)
        uint8 symbol = (msg.sender == matchData.player1) ? 1 : 2;
        matchData.packedBoard = _setCell(matchData.packedBoard, cellIndex, symbol);

        // Clear any escalation state since a move was made (match is no longer stalled) - inlined
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        emit MoveMade(matchId, msg.sender, cellIndex);

        // Check for win
        if (_checkWin(matchData.packedBoard, symbol)) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false, CompletionReason.NormalWin);
            return;
        }

        // Check for draw
        if (_checkDraw(matchData.packedBoard)) {
            _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, address(0), true, CompletionReason.Draw);
            return;
        }

        // Switch turn
        matchData.currentTurn = (matchData.currentTurn == matchData.player1)
            ? matchData.player2
            : matchData.player1;
    }

    /**
     * @dev Claim timeout victory when opponent runs out of time
     * This is Escalation Level 1 (player-initiated)
     */
    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender != matchData.currentTurn, "OT");

        // Check if current player has timed out
        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 opponentTimeRemaining = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        require(elapsed >= opponentTimeRemaining, "TO");

        // Mark match as stalled (enables L2/L3 escalation later if needed)
        (bool markSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "markMatchStalled(bytes32,uint8,uint256)",
                matchId, tierId, block.timestamp
            )
        );
        require(markSuccess, "MS");

        address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;

        // Complete match with timeout winner
        _completeMatchInternal(tierId, instanceId, roundNumber, matchNumber, msg.sender, false, CompletionReason.Timeout);
    }

    /**
     * @dev Internal match completion handler
     * Coordinates with Escalation and Matches modules
     */
    // Note: _completeMatchInternal() is now inherited from ETour_Storage

    // ============ Board Helper Functions ============

    /**
     * @dev Get cell value from packed board
     * @param packedBoard The packed board state (2 bits per cell)
     * @param cellIndex Index 0-8
     * @return value 0=empty, 1=player1, 2=player2
     */
    function _getCell(uint256 packedBoard, uint8 cellIndex) private pure returns (uint8) {
        return uint8((packedBoard >> (cellIndex * 2)) & 3);
    }

    /**
     * @dev Set cell value in packed board
     * @param packedBoard Current packed board state
     * @param cellIndex Index 0-8
     * @param value 0=empty, 1=player1, 2=player2
     * @return Updated packed board
     */
    function _setCell(uint256 packedBoard, uint8 cellIndex, uint8 value) private pure returns (uint256) {
        uint256 mask = ~(uint256(3) << (cellIndex * 2));
        return (packedBoard & mask) | (uint256(value) << (cellIndex * 2));
    }

    /**
     * @dev Check if player has won
     * Checks all 8 winning lines: 3 rows, 3 columns, 2 diagonals
     */
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

    /**
     * @dev Check if board is full (draw)
     */
    function _checkDraw(uint256 board) private pure returns (bool) {
        for (uint8 i = 0; i < 9; i++) {
            if (_getCell(board, i) == 0) return false;
        }
        return true;
    }

    // ============ IETourGame Interface Implementation ============

    /**
     * @dev Create new match - called by initializeRound
     */
    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public override {
        require(player1 != player2, "P1");
        require(player1 != address(0) && player2 != address(0), "P2");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.player1 = player1;
        matchData.player2 = player2;
        matchData.status = MatchStatus.InProgress;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;
        matchData.isDraw = false;

        // Random starting player
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            player1,
            player2,
            matchId
        )));
        matchData.currentTurn = (randomness % 2 == 0) ? player1 : player2;
        matchData.firstPlayer = matchData.currentTurn;

        // Initialize time banks: 60 seconds base
        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;

        // Clear board
        matchData.packedBoard = 0;
    }

    /**
     * @dev Check if match is active (exists and not completed)
     */
    // Note: _isMatchActive() uses default implementation from ETour_Storage

    /**
     * @dev Complete match with result
     */
    /**
     * @dev Mark match as complete in TicTacToe Match storage
     * Implements hook from ETour_Storage
     */
    function _completeMatchGameSpecific(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) internal override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    /**
     * @dev Get time increment per move (Fischer increment)
     */
    function _getTimeIncrement() public view override returns (uint256) {
        return 15; // 15 seconds Fischer increment
    }

    // ============ Wrapper Functions (bytes32 matchId variants for module compatibility) ============

    /**
     * @dev Reset match - wrapper for modules expecting bytes32 matchId
     */
    function _resetMatchGame(bytes32 matchId) public override {
        Match storage matchData = matches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.winner = address(0);
        matchData.currentTurn = address(0);
        matchData.firstPlayer = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.isDraw = false;
        matchData.packedBoard = 0;
        matchData.startTime = 0;
        matchData.lastMoveTime = 0;
        matchData.player1TimeRemaining = 0;
        matchData.player2TimeRemaining = 0;
    }

    /**
     * @dev Get match result - wrapper for modules
     */
    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    /**
     * @dev Get match players - wrapper for modules
     */
    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    /**
     * @dev Set match player - wrapper for modules
     */
    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public override {
        Match storage matchData = matches[matchId];

        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    /**
     * @dev Initialize match for play - wrapper for modules
     */
    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
        Match storage matchData = matches[matchId];

        // Set match status and times
        matchData.status = MatchStatus.InProgress;
        matchData.startTime = block.timestamp;
        matchData.lastMoveTime = block.timestamp;
        matchData.packedBoard = 0;  // Clear board
        matchData.isDraw = false;
        matchData.winner = address(0);

        // Re-randomize starting player
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            matchData.player1,
            matchData.player2,
            matchId,
            "replay"
        )));
        matchData.currentTurn = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.firstPlayer = matchData.currentTurn;

        // Reset time banks
        TierConfig storage config = _tierConfigs[tierId];
        matchData.player1TimeRemaining = config.timeouts.matchTimePerPlayer;
        matchData.player2TimeRemaining = config.timeouts.matchTimePerPlayer;
    }

    /**
     * @dev Complete match with result - wrapper for modules
     */
    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage matchData = matches[matchId];

        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;

        // Note: Caching is handled by _completeMatchInternal which calls the other overload
        // This override is just for module interface compliance
    }

    /**
     * @dev Check if current player timed out - wrapper for modules
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];

        if (matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        return elapsed >= currentPlayerTime;
    }

    /**
     * @dev Get active match data - for modules that need CommonMatchData
     */
    function _getActiveMatchData(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view override returns (CommonMatchData memory) {
        Match storage matchData = matches[matchId];

        // Derive loser
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = (matchData.winner == matchData.player1)
                ? matchData.player2
                : matchData.player1;
        }

        return CommonMatchData({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            loser: loser,
            status: matchData.status,
            isDraw: matchData.isDraw,
            startTime: matchData.startTime,
            lastMoveTime: matchData.lastMoveTime,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
    }

    // ============ View Functions ============

    /**
     * @dev Get complete match data
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (TicTacToeMatchData memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Check if match exists in active storage (even if completed)
        if (matchData.player1 != address(0)) {
            TicTacToeMatchData memory fullData;

            // Build CommonMatchData
            address loser = address(0);
            if (!matchData.isDraw && matchData.winner != address(0)) {
                loser = (matchData.winner == matchData.player1) ? matchData.player2 : matchData.player1;
            }

            fullData.common = CommonMatchData({
                player1: matchData.player1,
                player2: matchData.player2,
                winner: matchData.winner,
                loser: loser,
                status: matchData.status,
                isDraw: matchData.isDraw,
                startTime: matchData.startTime,
                lastMoveTime: matchData.lastMoveTime,
                tierId: tierId,
                instanceId: instanceId,
                roundNumber: roundNumber,
                matchNumber: matchNumber,
                isCached: false
            });

            // Add game-specific data
            fullData.packedBoard = matchData.packedBoard;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.player1TimeRemaining = matchData.player1TimeRemaining;
            fullData.player2TimeRemaining = matchData.player2TimeRemaining;
            fullData.lastMoveTimestamp = matchData.lastMoveTime;

            return fullData;
        }

        // Match not found in active storage - return empty data
        TicTacToeMatchData memory emptyData;
        return emptyData;
    }

    /**
     * @dev Get player's total earnings across all tournaments
     */
    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    /**
     * @dev Handle tournament completion: distribute prizes, update earnings, emit event, reset
     * Called after tournament status is set to Completed by modules
     */
    // Note: _handleTournamentCompletion() is now inherited from ETour_Storage

    // ============ Player Tracking View Functions ============

    /**
     * @dev Get all tournaments a player is currently enrolling in
     */
    function getPlayerEnrollingTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerEnrollingTournaments[player];
    }

    /**
     * @dev Get all tournaments a player is actively competing in
     */
    function getPlayerActiveTournaments(address player) external view returns (TournamentRef[] memory) {
        return playerActiveTournaments[player];
    }

    /**
     * @dev Tier configuration - access via inherited getTierConfig() from ETour_Storage
     */

    // ============ Missing Getter Functions ============

    function getTournamentInfo(uint8 tierId, uint8 instanceId) external view returns (
        TournamentStatus status,
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    ) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return (
            tournament.status,
            tournament.currentRound,
            tournament.enrolledCount,
            tournament.prizePool,
            tournament.winner
        );
    }

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (
        uint8 totalMatches,
        uint8 completedMatches,
        bool initialized
    ) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        return (
            round.totalMatches,
            round.completedMatches,
            round.initialized
        );
    }

    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        // Read directly from storage (staticcall won't work - reads wrong storage)
        LeaderboardEntry[] memory entries = new LeaderboardEntry[](_leaderboardPlayers.length);
        for (uint256 i = 0; i < _leaderboardPlayers.length; i++) {
            entries[i] = LeaderboardEntry({
                player: _leaderboardPlayers[i],
                earnings: playerEarnings[_leaderboardPlayers[i]]
            });
        }
        return entries;
    }

    /**
     * @dev Get raffle info - calculated locally to read from contract's storage
     */
    function getRaffleInfo() external view returns (
        uint256 raffleIndex,
        bool isReady,
        uint256 currentAccumulated,
        uint256 threshold,
        uint256 reserve,
        uint256 raffleAmount,
        uint256 ownerShare,
        uint256 winnerShare,
        uint256 eligiblePlayerCount
    ) {
        raffleIndex = currentRaffleIndex;
        currentAccumulated = accumulatedProtocolShare;

        // Calculate threshold locally (reads from this contract's storage)
        threshold = _getRaffleThreshold();
        reserve = (threshold * 5) / 100;  // 5% reserve

        isReady = currentAccumulated >= threshold;
        raffleAmount = threshold - reserve;
        ownerShare = (raffleAmount * 5) / 95;  // 5% of total
        winnerShare = (raffleAmount * 90) / 95;  // 90% of total

        // Count eligible players (those with enrolling or active tournaments)
        // This is a simplified count - in production would use a more efficient tracking mechanism
        eligiblePlayerCount = 0;
        for (uint8 t = 0; t < tierCount; t++) {
            for (uint8 i = 0; i < _tierConfigs[t].instanceCount; i++) {
                address[] storage players = enrolledPlayers[t][i];
                eligiblePlayerCount += players.length;
            }
        }
    }

    // Note: _getRaffleThreshold() is now inherited from ETour_Storage

    // ============ Player Tracking Hooks (Built-in Implementation) ============

    /**
     * @dev Hook: Called when player enrolls in tournament
     */
    function _onPlayerEnrolled(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal override {
        _addPlayerEnrollingTournament(player, tierId, instanceId);
    }

    /**
     * @dev Hook: Called when tournament starts
     * Atomic transition: Move ALL enrolled players from enrolling → active
     */
    // Note: _onTournamentStarted(), _onPlayerEliminatedFromTournament(), _onExternalPlayerReplacement(),
    //       and _onTournamentCompleted() use default implementations from ETour_Storage

    // ============ Game-Specific Overrides ============

    /**
     * @dev Emit MatchCompleted event with TicTacToe board data
     * Implements abstract function from ETour_Storage
     */
    function _emitMatchCompletedEvent(
        bytes32 matchId,
        address winner,
        bool isDraw,
        CompletionReason reason
    ) internal override {
        Match storage m = matches[matchId];
        emit MatchCompleted(matchId, m.player1, m.player2, winner, isDraw, reason, m.packedBoard);
    }

    // ============ Player Tracking Helper Functions ============

    // Note: Player tracking functions (_addPlayerEnrollingTournament, _removePlayerEnrollingTournament,
    //       _addPlayerActiveTournament, _removePlayerActiveTournament) are now inherited from ETour_Storage
}
