// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";
import "../interfaces/IETourGame.sol";

/**
 * @title ETour_Escalation
 * @dev Stateless module for timeout tracking and escalation logic
 *
 * This module handles:
 * - Match stalling detection when players run out of time
 * - 3-level escalation system for handling stalled matches
 * - Level 1: Opponent claims timeout victory (via game contract)
 * - Level 2: Advanced players force eliminate both stalled players
 * - Level 3: External players replace stalled players and win match
 * - Escalation state management and availability checks
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (matchTimeouts, tournaments, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 * - msg.value = value sent
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract ETour_Escalation is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
    // This is a bit of a hack - modules inherit ETour_Storage for type definitions
    // but their storage is never used (delegatecall uses game contract's storage)
    constructor() ETour_Storage(address(0), address(0), address(0), address(0), address(0), address(0)) {}

    // ============ Abstract Function Stubs (Never Called - Modules Use IETourGame Interface) ============
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
    function _getMatchFromCache(bytes32, uint8, uint8, uint8, uint8) public view override returns (CommonMatchData memory, bool) { revert("Module: Use IETourGame"); }

    // ============ Match Stalling Functions ============

    /**
     * @dev Mark a match as stalled when timeout is claimable
     * EXACT COPY from ETour.sol lines 1669-1683
     */
    function markMatchStalled(bytes32 matchId, uint8 tierId, uint256 timeoutOccurredAt) external {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            timeout.isStalled = true;
            TierConfig storage config = _tierConfigs[tierId];

            // If timeoutOccurredAt is 0, use current time
            uint256 baseTime = timeoutOccurredAt == 0 ? block.timestamp : timeoutOccurredAt;

            // Use tier-specific timeout configuration
            timeout.escalation1Start = baseTime + config.timeouts.matchLevel2Delay;
            timeout.escalation2Start = baseTime + config.timeouts.matchLevel3Delay;
            timeout.activeEscalation = EscalationLevel.None;
        }
    }

    /**
     * @dev Internal helper for marking match as stalled
     * EXACT COPY from ETour.sol lines 1669-1683
     */
    function _markMatchStalled(bytes32 matchId, uint8 tierId, uint256 timeoutOccurredAt) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            timeout.isStalled = true;
            TierConfig storage config = _tierConfigs[tierId];

            // If timeoutOccurredAt is 0, use current time
            uint256 baseTime = timeoutOccurredAt == 0 ? block.timestamp : timeoutOccurredAt;

            // Use tier-specific timeout configuration
            timeout.escalation1Start = baseTime + config.timeouts.matchLevel2Delay;
            timeout.escalation2Start = baseTime + config.timeouts.matchLevel3Delay;
            timeout.activeEscalation = EscalationLevel.None;
        }
    }

    /**
     * @dev Clear escalation state for a match after it completes
     * EXACT COPY from ETour.sol lines 1696-1702
     */
    function clearEscalationState(bytes32 matchId) external {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    /**
     * @dev Internal helper for clearing escalation state
     * EXACT COPY from ETour.sol lines 1696-1702
     */
    function _clearEscalationState(bytes32 matchId) internal {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;
    }

    /**
     * @dev Check if a match should be marked as stalled and mark it if needed
     * EXACT COPY from ETour.sol lines 1709-1748
     */
    function checkAndMarkStalled(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external returns (bool) {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If already marked as stalled, return true
        if (timeout.isStalled) {
            return true;
        }

        // Check if match is active
        if (!this._isMatchActive(matchId)) {
            return false;
        }

        // Get match common data to check status
        CommonMatchData memory matchData = this._getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has run out of time (using game-specific time bank logic)
        if (this._hasCurrentPlayerTimedOut(matchId)) {
            TierConfig storage config = _tierConfigs[tierId];

            // Calculate when the timeout occurred for accurate escalation timing
            // Timeout occurs at: lastMoveTime + currentPlayer's timeRemaining
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;

            // Mark as stalled with escalation timers starting from timeout occurrence
            _markMatchStalled(matchId, tierId, timeoutOccurredAt);
            return true;
        }

        return false;
    }

    /**
     * @dev Internal helper for checking and marking stalled
     * EXACT COPY from ETour.sol lines 1709-1748
     */
    function _checkAndMarkStalled(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal returns (bool) {
        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // If already marked as stalled, return true
        if (timeout.isStalled) {
            return true;
        }

        // Check if match is active
        if (!this._isMatchActive(matchId)) {
            return false;
        }

        // Get match common data to check status
        CommonMatchData memory matchData = this._getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has run out of time (using game-specific time bank logic)
        if (this._hasCurrentPlayerTimedOut(matchId)) {
            TierConfig storage config = _tierConfigs[tierId];

            // Calculate when the timeout occurred for accurate escalation timing
            // Timeout occurs at: lastMoveTime + currentPlayer's timeRemaining
            uint256 timeoutOccurredAt = matchData.lastMoveTime + config.timeouts.matchTimePerPlayer;

            // Mark as stalled with escalation timers starting from timeout occurrence
            _markMatchStalled(matchId, tierId, timeoutOccurredAt);
            return true;
        }

        return false;
    }

    // ============ Escalation Level 2 & 3 Functions ============

    /**
     * @dev Level 2 Escalation: Advanced player forces elimination of stalled match
     * EXACT COPY from ETour.sol lines 1755-1779
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check and mark match as stalled if it qualifies
        // Call to MODULE_ESCALATION for _checkAndMarkStalled via delegatecall
        (bool checkSuccess, bytes memory checkData) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("checkAndMarkStalled(bytes32,uint8,uint8,uint8,uint8)", matchId, tierId, instanceId, roundNumber, matchNumber)
        );
        require(checkSuccess, "Check stalled failed");

        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // Require match is stalled and Level 2 is active
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation1Start, "Level 2 not active yet");

        // Require caller is an advanced player
        // Call to MODULE_ESCALATION for _isPlayerInAdvancedRound via delegatecall
        (bool advancedSuccess, bytes memory advancedData) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("isPlayerInAdvancedRound(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, msg.sender)
        );
        require(advancedSuccess, "Advanced check failed");
        bool isAdvanced = abi.decode(advancedData, (bool));
        require(isAdvanced, "Not an advanced player");

        // Mark escalation level and double eliminate both players
        timeout.activeEscalation = EscalationLevel.Escalation2_AdvancedPlayers;

        // Call to MODULE_ESCALATION for _completeMatchDoubleElimination via delegatecall
        (bool eliminateSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("completeMatchDoubleElimination(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(eliminateSuccess, "Double elimination failed");
    }

    /**
     * @dev Level 3 Escalation: External player replaces stalled players
     * EXACT COPY from ETour.sol lines 1787-1812
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check and mark match as stalled if it qualifies
        // Call to MODULE_ESCALATION for _checkAndMarkStalled via delegatecall
        (bool checkSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("checkAndMarkStalled(bytes32,uint8,uint8,uint8,uint8)", matchId, tierId, instanceId, roundNumber, matchNumber)
        );
        require(checkSuccess, "Check stalled failed");

        MatchTimeoutState storage timeout = matchTimeouts[matchId];

        // Require match is stalled and Level 3 window is active
        require(timeout.isStalled, "Match not stalled");
        require(block.timestamp >= timeout.escalation2Start, "Level 3 not active yet");

        // Prevent advanced players from claiming (they should use L2 instead)
        // Call to MODULE_ESCALATION for _isPlayerInAdvancedRound via delegatecall
        (bool advancedSuccess, bytes memory advancedData) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("isPlayerInAdvancedRound(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, msg.sender)
        );
        require(advancedSuccess, "Advanced check failed");
        bool isAdvanced = abi.decode(advancedData, (bool));
        require(!isAdvanced, "Advanced players cannot claim L3");

        // Mark escalation level and complete match with replacement winner
        timeout.activeEscalation = EscalationLevel.Escalation3_ExternalPlayers;

        // Call to MODULE_ESCALATION for _completeMatchByReplacement via delegatecall
        (bool replacementSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("completeMatchByReplacement(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchNumber, msg.sender)
        );
        require(replacementSuccess, "Replacement failed");
    }

    // ============ Advanced Player Checking ============

    /**
     * @dev Check if a player has advanced in the tournament
     * EXACT COPY from ETour.sol lines 1822-1866
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
                (address winner, bool isDraw, MatchStatus status) = this._getMatchResult(matchId);

                if (status == MatchStatus.Completed &&
                    winner == player &&
                    !isDraw) {
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
                (address p1, address p2) = this._getMatchPlayers(matchId);

                if (p1 == player || p2 == player) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @dev Internal helper for checking if player is in advanced round
     * EXACT COPY from ETour.sol lines 1822-1866
     */
    function _isPlayerInAdvancedRound(
        uint8 tierId,
        uint8 instanceId,
        uint8 stalledRoundNumber,
        address player
    ) internal view returns (bool) {
        if (!isEnrolled[tierId][instanceId][player]) {
            return false;
        }

        // Check 1: Has player won a match in any round up to and including the stalled round?
        for (uint8 r = 0; r <= stalledRoundNumber; r++) {
            Round storage round = rounds[tierId][instanceId][r];

            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(tierId, instanceId, r, m);
                (address winner, bool isDraw, MatchStatus status) = this._getMatchResult(matchId);

                if (status == MatchStatus.Completed &&
                    winner == player &&
                    !isDraw) {
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
                (address p1, address p2) = this._getMatchPlayers(matchId);

                if (p1 == player || p2 == player) {
                    return true;
                }
            }
        }

        return false;
    }

    // ============ Match Completion Functions ============

    /**
     * @dev Complete a match by double elimination (both players eliminated, no winner)
     * EXACT COPY from ETour.sol lines 1871-1910
     */
    function completeMatchDoubleElimination(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        (address player1, address player2) = this._getMatchPlayers(matchId);

        this._completeMatchWithResult(matchId, address(0), false);
        this._addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        // Call to MODULE_ESCALATION for _assignRankingOnElimination via delegatecall
        (bool rank1Success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("assignRankingOnElimination(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, player1)
        );
        require(rank1Success, "Ranking assignment failed");

        (bool rank2Success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("assignRankingOnElimination(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, player2)
        );
        require(rank2Success, "Ranking assignment failed");

        // Call to MODULE_MATCHES for _removePlayerActiveMatch via delegatecall
        (bool remove1Success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("removePlayerActiveMatch(address,bytes32)", player1, matchId)
        );
        require(remove1Success, "Remove active match failed");

        (bool remove2Success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("removePlayerActiveMatch(address,bytes32)", player2, matchId)
        );
        require(remove2Success, "Remove active match failed");

        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;

        emit MatchCompleted(matchId, address(0), false);

        // Clear escalation state
        _clearEscalationState(matchId);

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            // Call to MODULE_MATCHES for _hasOrphanedWinners via delegatecall
            (bool hasOrphansSuccess, bytes memory hasOrphansData) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("hasOrphanedWinners(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(hasOrphansSuccess, "Check orphans failed");
            bool hasOrphans = abi.decode(hasOrphansData, (bool));

            if (hasOrphans) {
                (bool processSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("processOrphanedWinners(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
                );
                require(processSuccess, "Process orphans failed");

                // After processing orphaned winners, check if tournament can complete
                (bool checkSoleSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("checkForSoleWinnerCompletion(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
                );
                require(checkSoleSuccess, "Check sole winner failed");
            }

            (bool completeRoundSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeRound(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(completeRoundSuccess, "Complete round failed");
        }
    }

    /**
     * @dev Complete a match by replacement (external player takes over as winner)
     * EXACT COPY from ETour.sol lines 1915-1972
     */
    function completeMatchByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address replacementPlayer
    ) external {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        IETourGame gameContract = IETourGame(address(this));
        (address player1, address player2) = gameContract._getMatchPlayers(matchId);

        gameContract._completeMatchWithResult(matchId, replacementPlayer, false);
        gameContract._addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);

        // Call to MODULE_ESCALATION for _assignRankingOnElimination via delegatecall
        (bool rank1Success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("assignRankingOnElimination(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, player1)
        );
        require(rank1Success, "Ranking assignment failed");

        (bool rank2Success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("assignRankingOnElimination(uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, player2)
        );
        require(rank2Success, "Ranking assignment failed");

        // Call to MODULE_MATCHES for _removePlayerActiveMatch via delegatecall
        (bool remove1Success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("removePlayerActiveMatch(address,bytes32)", player1, matchId)
        );
        require(remove1Success, "Remove active match failed");

        (bool remove2Success, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature("removePlayerActiveMatch(address,bytes32)", player2, matchId)
        );
        require(remove2Success, "Remove active match failed");

        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;

        // Add replacement player to tournament if not already enrolled
        if (!isEnrolled[tierId][instanceId][replacementPlayer]) {
            enrolledPlayers[tierId][instanceId].push(replacementPlayer);
            isEnrolled[tierId][instanceId][replacementPlayer] = true;
            TournamentInstance storage tournament = tournaments[tierId][instanceId];
            tournament.enrolledCount++;
            _onExternalPlayerReplacement(tierId, instanceId, replacementPlayer);
        }

        playerStats[replacementPlayer].matchesPlayed++;
        playerStats[replacementPlayer].matchesWon++;

        emit MatchCompleted(matchId, replacementPlayer, false);

        // Clear escalation state
        _clearEscalationState(matchId);

        TierConfig storage config = _tierConfigs[tierId];
        if (roundNumber < config.totalRounds - 1) {
            // Call to MODULE_MATCHES for _advanceWinner via delegatecall
            (bool advanceSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)", tierId, instanceId, roundNumber, matchNumber, replacementPlayer)
            );
            require(advanceSuccess, "Advance winner failed");
        }

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (round.completedMatches == round.totalMatches) {
            // Call to MODULE_MATCHES for _hasOrphanedWinners via delegatecall
            (bool hasOrphansSuccess, bytes memory hasOrphansData) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("hasOrphanedWinners(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(hasOrphansSuccess, "Check orphans failed");
            bool hasOrphans = abi.decode(hasOrphansData, (bool));

            if (hasOrphans) {
                (bool processSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("processOrphanedWinners(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
                );
                require(processSuccess, "Process orphans failed");

                // After processing orphaned winners, check if tournament can complete
                (bool checkSoleSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("checkForSoleWinnerCompletion(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
                );
                require(checkSoleSuccess, "Check sole winner failed");
            }

            (bool completeRoundSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeRound(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(completeRoundSuccess, "Complete round failed");
        }
    }

    /**
     * @dev Assign ranking to player when eliminated
     * EXACT COPY from ETour.sol lines 1367-1386
     */
    function assignRankingOnElimination(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address player
    ) external {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];
        uint8 playerCount = tournament.enrolledCount;

        uint8 baseRank;
        if (roundNumber == config.totalRounds - 1) {
            baseRank = 2;
        } else {
            uint8 remainingAfterRound = playerCount / uint8(2 ** (roundNumber + 1));
            baseRank = remainingAfterRound + 1;
        }

        playerRanking[tierId][instanceId][player] = baseRank;
    }

    /**
     * @dev Internal helper for assigning ranking on elimination
     * EXACT COPY from ETour.sol lines 1367-1386
     */
    function _assignRankingOnElimination(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        address player
    ) internal {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TierConfig storage config = _tierConfigs[tierId];
        uint8 playerCount = tournament.enrolledCount;

        uint8 baseRank;
        if (roundNumber == config.totalRounds - 1) {
            baseRank = 2;
        } else {
            uint8 remainingAfterRound = playerCount / uint8(2 ** (roundNumber + 1));
            baseRank = remainingAfterRound + 1;
        }

        playerRanking[tierId][instanceId][player] = baseRank;
    }

    // ============ Escalation Availability Helpers (Public View) ============

    /**
     * @dev Check if Level 1 escalation (opponent timeout claim) is available
     * EXACT COPY from ETour.sol lines 1980-2001
     */
    function isMatchEscL1Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!this._isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = this._getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        return this._hasCurrentPlayerTimedOut(matchId);
    }

    /**
     * @dev Check if Level 2 escalation (advanced player force eliminate) is available
     * EXACT COPY from ETour.sol lines 2007-2044
     */
    function isMatchEscL2Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!this._isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = this._getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        if (!this._hasCurrentPlayerTimedOut(matchId)) {
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
     * @dev Check if Level 3 escalation (external player replacement) is available
     * EXACT COPY from ETour.sol lines 2050-2087
     */
    function isMatchEscL3Available(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (bool available) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Check if match is active
        if (!this._isMatchActive(matchId)) {
            return false;
        }

        // Get match data
        CommonMatchData memory matchData = this._getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Check if current player has timed out
        if (!this._hasCurrentPlayerTimedOut(matchId)) {
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
}
