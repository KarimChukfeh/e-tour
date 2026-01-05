// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour_Storage.sol";

/**
 * @title TicTacChain
 * @dev Classic Tic-Tac-Toe game implementing ETour tournament protocol (MODULAR VERSION)
 * Simple, solved game used as the lowest-barrier demonstration of the ETour protocol.
 *
 * This contract demonstrates how to implement ETour by:
 * 1. Registering custom tier configurations in the constructor
 * 2. Implementing all abstract game functions
 * 3. Providing game-specific logic (board state, win detection, etc.)
 *
 * MODULAR ARCHITECTURE:
 * - Inherits ETour_Storage for storage layout
 * - Delegates tournament logic to 5 stateless modules via delegatecall
 * - Modules: Core, Matches, Prizes, Raffle, Escalation
 *
 * ERROR CODES:
 * E=Enrollment, S=Start, C=Claim, R=Reset, RF=Raffle, FE=ForceElim, RC=ReplClaim
 * T0/T1/T2=Tier registration, RT=RaffleThreshold, A=Advance, P1=Player, P2=Address
 * CA=CacheAdd, CT=CompleteTournament, AW=AdvanceWalkover, CE=ClearEscalation
 * CR=CompleteRound, MA=MatchActive, NP=NotPlayer, NT=NotTurn, IC=InvalidCell
 * CO=CellOccupied, TO=Timeout, MS=MarkStalled, CL=CacheLookup, IT=InvalidTier
 * IR=InvalidRanking, GF=GetFailed, RR=RaffleReserve
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract TicTacChain is ETour_Storage {

    // ============ Game-Specific Constants ============

    // ============ Game-Specific Enums ============

    enum Cell { Empty, X, O }

    // ============ Game-Specific Structs ============

    /**
     * @dev Match struct with optimized storage packing
     * Slot 1 (22 bytes): player1 (20) + status (1) + isDraw (1)
     * Slot 2 (20 bytes): player2
     * Slot 3 (20 bytes): currentTurn
     * Slot 4 (20 bytes): winner
     * Slot 5 (20 bytes): firstPlayer
     * Slot 6-11 (192 bytes): 6 uint256 fields
     * Total: 11 slots (saves 2-3 slots vs unpacked)
     */
    struct Match {
        // Slot 1: Pack address + enums + bool (20 + 1 + 1 = 22 bytes)
        address player1;
        MatchStatus status;         // uint8 enum
        bool isDraw;

        // Slots 2-5: Individual addresses (20 bytes each)
        address player2;
        address currentTurn;
        address winner;
        address firstPlayer;

        // Slot 6: Packed board (32 bytes)
        uint256 packedBoard;        // 2 bits per cell, 9 cells = 18 bits

        // Slots 7-11: Time and timestamp fields (32 bytes each)
        uint256 lastMoveTime;
        uint256 startTime;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        uint256 lastMoveTimestamp;
    }


    /**
     * @dev Extended match data for TicTacToe including common fields and game-specific state
     */
    struct TicTacToeMatchData {
        CommonMatchData common;     // Embedded common data
        uint256 packedBoard;              // Packed board: 2 bits per cell
        address currentTurn;
        address firstPlayer;
        uint256 player1TimeRemaining;     // Time bank for player1 (seconds)
        uint256 player2TimeRemaining;     // Time bank for player2 (seconds)
        uint256 lastMoveTimestamp;        // Timestamp of last move
    }

    // ============ Game-Specific State ============

    mapping(bytes32 => Match) public matches;

    // One-time initialization flag
    bool public allInstancesInitialized;

    // ============ Game-Specific Events ============

    event MoveMade(bytes32 indexed matchId, address indexed player, uint8 cellIndex);
    event AllInstancesInitialized(address indexed caller, uint8 tierCount);
    // MatchCached event now defined in ETour_Storage

    // ============ Module Addresses ============

    address public immutable MODULE_PLAYER_TRACKING;
    address public immutable MODULE_GAME;

    // ============ Constructor ============

    constructor(
        address _moduleCoreAddress,
        address _moduleMatchesAddress,
        address _modulePrizesAddress,
        address _moduleRaffleAddress,
        address _moduleEscalationAddress,
        address _moduleGameCacheAddress,
        address _modulePlayerTrackingAddress,
        address _moduleGameAddress
    ) ETour_Storage(
        _moduleCoreAddress,
        _moduleMatchesAddress,
        _modulePrizesAddress,
        _moduleRaffleAddress,
        _moduleEscalationAddress,
        _moduleGameCacheAddress
    ) {
        MODULE_PLAYER_TRACKING = _modulePlayerTrackingAddress;
        MODULE_GAME = _moduleGameAddress;
        // Tier registration moved to initializeAllInstances() for gas optimization
    }

    // ============ Initialization ============

    /**
     * @dev One-time initialization of all tournament instances
     *
     * Pre-allocates storage for all tier instances to avoid lazy initialization gas costs.
     * Can only be called once by anyone (typically by deployer immediately after deployment).
     *
     * Gas cost estimate:
     * - Tier 0: 100 instances × ~20k gas = ~2M gas
     * - Tier 1: 40 instances × ~20k gas = ~800k gas
     * - Tier 2: 20 instances × ~20k gas = ~400k gas
     * - Total: ~3.2M gas (~0.0032 ETH at 1 gwei)
     *
     * After this is called:
     * - All instances are in Enrolling state
     * - First enrollers pay normal gas (no lazy init overhead)
     * - Function cannot be called again
     */
    function initializeAllInstances() external {
        require(!allInstancesInitialized, "I");

        _registerTicTacChainTiers();

        allInstancesInitialized = true;
        emit AllInstancesInitialized(msg.sender, tierCount);
    }

    // ============ Match Creation Override ============
    // TicTacChain handles match creation directly instead of delegating to modules

    /**
     * @dev Initialize round and create matches
     * Overrides module implementation to call _createMatchGame directly
     */
    function initializeRound(uint8 tierId, uint8 instanceId, uint8 roundNumber) public {
        uint8 matchCount = getMatchCountForRound(tierId, instanceId);

        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.allMatchesDrew = false;

        emit RoundInitialized(tierId, instanceId, roundNumber, matchCount);

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

                emit PlayerAutoAdvancedWalkover(tierId, instanceId, roundNumber, walkoverPlayer);
            }

            // Create matches directly - this is the key fix!
            for (uint8 i = 0; i < matchCount; i++) {
                _createMatchGame(tierId, instanceId, roundNumber, i, players[i * 2], players[i * 2 + 1]);
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
        // Check if player was already enrolled before delegatecall
        bool wasEnrolled = isEnrolled[tierId][instanceId][msg.sender];
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("enrollInTournament(uint8,uint8)", tierId, instanceId)
        );
        require(success, "E");

        // If player wasn't enrolled before but is now, call tracking hook
        if (!wasEnrolled && isEnrolled[tierId][instanceId][msg.sender]) {
            _onPlayerEnrolled(tierId, instanceId, msg.sender);
        }

        // If tournament auto-started (enrollment filled up), initialize round and call hooks
        if (oldStatus == TournamentStatus.Enrolling && tournament.status == TournamentStatus.InProgress) {
            initializeRound(tierId, instanceId, 0);
            _onTournamentStarted(tierId, instanceId);
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
        require(success, "S");

        // If tournament status changed to InProgress, initialize round and call hook
        if (oldStatus != TournamentStatus.InProgress && tournament.status == TournamentStatus.InProgress) {
            initializeRound(tierId, instanceId, 0);
            _onTournamentStarted(tierId, instanceId);
        }
    }

    /**
     * @dev Claim abandoned enrollment pool - delegates to Core module
     */
    function claimAbandonedEnrollmentPool(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("claimAbandonedEnrollmentPool(uint8,uint8)", tierId, instanceId)
        );
        require(success, "C");
    }

    /**
     * @dev Reset enrollment window - delegates to Core module
     */
    function resetEnrollmentWindow(uint8 tierId, uint8 instanceId) external nonReentrant {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("resetEnrollmentWindow(uint8,uint8)", tierId, instanceId)
        );
        require(success, "R");
    }

    /**
     * @dev Execute protocol raffle - delegates to Raffle module
     */
    function executeProtocolRaffle() external nonReentrant returns (
        address winner,
        uint256 ownerAmount,
        uint256 winnerAmount
    ) {
        (bool success, bytes memory data) = MODULE_RAFFLE.delegatecall(
            abi.encodeWithSignature("executeProtocolRaffle()")
        );
        require(success, "RF");
        return abi.decode(data, (address, uint256, uint256));
    }

    /**
     * @dev Force eliminate stalled match - delegates to Escalation module
     */
    function forceEliminateStalledMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("forceEliminateStalledMatch(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "FE");
    }

    /**
     * @dev Claim match slot by replacement - delegates to Escalation module
     */
    function claimMatchSlotByReplacement(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        (bool success, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("claimMatchSlotByReplacement(uint8,uint8,uint8,uint8)", tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "RC");
    }

    // ============ Tier Registration ============

    /**
     * @dev Register all tournament tiers for TicTacChain
     * This is where TicTacChain defines its specific tournament structure.
     * Other games implementing ETour would define their own tiers here.
     */
    function _registerTicTacChainTiers() internal {
        // ============ Tier 0: 2-Player Classic (Entry Level) ============
        // Simple head-to-head, winner takes all
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;  // 1st place: 100%
        tier0Prizes[1] = 0;    // 2nd place: 0%

        TimeoutConfig memory timeouts0 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 5 minutes,        // 5 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        (bool success0, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                0,                    // tierId
                2,                    // playerCount
                100,                  // instanceCount
                0.001 ether,          // entryFee
                Mode.Classic,         // mode
                timeouts0,            // timeout configuration
                tier0Prizes           // prizeDistribution
            )
        );
        require(success0, "T0");

        // ============ Tier 1: 4-Player Classic ============
        // Semi-final + Final bracket, winner takes majority
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 70;   // 1st place: 70%
        tier1Prizes[1] = 30;   // 2nd place: 30%
        tier1Prizes[2] = 0;    // 3rd place: 0%
        tier1Prizes[3] = 0;    // 4th place: 0%

        TimeoutConfig memory timeouts1 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 10 minutes,       // 10 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        (bool success1, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                1,                    // tierId
                4,                    // playerCount
                40,                   // instanceCount
                0.002 ether,          // entryFee
                Mode.Classic,
                timeouts1,
                tier1Prizes
            )
        );
        require(success1, "T1");

        // ============ Tier 2: 8-Player Classic ============
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 70;   // 1st
        tier2Prizes[1] = 20;   // 2nd
        tier2Prizes[2] = 5;    // 3rd
        tier2Prizes[3] = 5;    // 4th
        tier2Prizes[4] = 0;    // 5th-8th
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        TimeoutConfig memory timeouts2 = TimeoutConfig({
            matchTimePerPlayer: 2 minutes,      // 2 minutes per player
            timeIncrementPerMove: 15 seconds,   // Fischer increment: 15 seconds bonus per move
            matchLevel2Delay: 2 minutes,        // L2 starts 2 min after timeout
            matchLevel3Delay: 4 minutes,        // L3 starts 4 min after timeout (cumulative)
            enrollmentWindow: 15 minutes,       // 15 min to fill tournament
            enrollmentLevel2Delay: 2 minutes    // L2 starts 2 min after enrollment window
        });

        (bool success2, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature(
                "registerTier(uint8,uint8,uint8,uint256,uint8,(uint256,uint256,uint256,uint256,uint256,uint256),uint8[])",
                2,                    // tierId
                8,                    // playerCount
                20,                   // instanceCount
                0.004 ether,          // entryFee
                Mode.Classic,
                timeouts2,
                tier2Prizes
            )
        );
        require(success2, "T2");

        // ============ Configure Raffle Thresholds ============
        // Progressive thresholds: 0.1, 0.2, 0.3, 0.3, 0.5 ETH for first 5 raffles
        // Then 1.0 ETH for all subsequent raffles
        uint256[] memory thresholds = new uint256[](5);
        thresholds[0] = 0.1 ether;
        thresholds[1] = 0.2 ether;
        thresholds[2] = 0.3 ether;
        thresholds[3] = 0.3 ether;
        thresholds[4] = 0.5 ether;

        (bool successRaffle, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("registerRaffleThresholds(uint256[],uint256)", thresholds, 1.0 ether)
        );
        require(successRaffle, "RT");
    }

    // ============ ETour Abstract Implementation ============

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

        // Initialize empty board (packed board = 0 means all cells empty)
        matchData.packedBoard = 0;

        // Initialize time banks for both players
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;

        // Add match to both players' active match lists
        playerActiveMatches[player1].push(matchId);
        playerMatchIndex[player1][matchId] = playerActiveMatches[player1].length - 1;

        playerActiveMatches[player2].push(matchId);
        playerMatchIndex[player2][matchId] = playerActiveMatches[player2].length - 1;

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    function _resetMatchGame(bytes32 matchId) public override {
        Match storage matchData = matches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.lastMoveTime = 0;
        matchData.startTime = 0;
        matchData.firstPlayer = address(0);
        matchData.isDraw = false;
        matchData.packedBoard = 0;  // Reset to empty board
    }

    function _getMatchResult(bytes32 matchId) public view override returns (address winner, bool isDraw, MatchStatus status) {
        Match storage matchData = matches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // Encode packed board state for generic storage
        bytes memory boardData = abi.encode(matchData.packedBoard);

        // Delegate to GameCacheModule
        (bool success, ) = MODULE_GAME_CACHE.delegatecall(
            abi.encodeWithSignature(
                "addToMatchCache(bytes32,uint8,uint8,uint8,uint8,address,address,address,address,uint256,bool,bytes)",
                matchId,
                tierId,
                instanceId,
                roundNumber,
                matchNumber,
                matchData.player1,
                matchData.player2,
                matchData.firstPlayer,
                matchData.winner,
                matchData.startTime,
                matchData.isDraw,
                boardData
            )
        );
        require(success, "CA");
    }

    function _getMatchPlayers(bytes32 matchId) public view override returns (address player1, address player2) {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    // ============ Match Management Overrides ============

    /**
     * @dev Consolidate scattered players - delegated to MODULE_MATCHES
     * Call MODULE_MATCHES.consolidateScatteredPlayers() directly
     */

    /**
     * @dev Override completeMatch to handle storage access directly
     * This avoids delegatecall issues with removePlayerActiveMatch
     */
    function completeMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw
    ) public {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Mark match as completed with result
        _completeMatchWithResult(matchId, winner, isDraw);

        // Get players
        (address player1, address player2) = _getMatchPlayers(matchId);

        // Remove match from player1's active matches - DIRECT storage access
        uint256 index1 = playerMatchIndex[player1][matchId];
        uint256 lastIndex1 = playerActiveMatches[player1].length - 1;
        if (index1 != lastIndex1) {
            bytes32 lastMatchId1 = playerActiveMatches[player1][lastIndex1];
            playerActiveMatches[player1][index1] = lastMatchId1;
            playerMatchIndex[player1][lastMatchId1] = index1;
        }
        playerActiveMatches[player1].pop();
        delete playerMatchIndex[player1][matchId];

        // Remove match from player2's active matches - DIRECT storage access
        uint256 index2 = playerMatchIndex[player2][matchId];
        uint256 lastIndex2 = playerActiveMatches[player2].length - 1;
        if (index2 != lastIndex2) {
            bytes32 lastMatchId2 = playerActiveMatches[player2][lastIndex2];
            playerActiveMatches[player2][index2] = lastMatchId2;
            playerMatchIndex[player2][lastMatchId2] = index2;
        }
        playerActiveMatches[player2].pop();
        delete playerMatchIndex[player2][matchId];

        // Trigger elimination hook for both players - module will check if they should be removed
        // Note: We don't know which player was eliminated (could be draw, timeout, etc)
        // So we call the hook for both and let the module determine if removal is needed
        _onPlayerEliminatedFromTournament(player1, tierId, instanceId, roundNumber);
        _onPlayerEliminatedFromTournament(player2, tierId, instanceId, roundNumber);

        // Update player stats - DIRECT storage access
        playerStats[player1].matchesPlayed++;
        playerStats[player2].matchesPlayed++;
        if (!isDraw) {
            playerStats[winner].matchesWon++;
        }

        // Clear escalation state - delegate to Escalation module
        (bool clearSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("clearEscalationState(bytes32)", matchId)
        );
        require(clearSuccess, "CE");

        emit MatchCompleted(matchId, winner, isDraw);

        // Handle winner advancement if not a draw and not final round
        if (!isDraw) {
            TierConfig storage config = _tierConfigs[tierId];
            if (roundNumber < config.totalRounds - 1) {
                // Delegate to Matches module for advanceWinner
                (bool advanceSuccess, ) = MODULE_MATCHES.delegatecall(
                    abi.encodeWithSignature("advanceWinner(uint8,uint8,uint8,uint8,address)",
                        tierId, instanceId, roundNumber, matchNumber, winner)
                );
                require(advanceSuccess, "A");
            }
        }

        // Update round completion tracking
        Round storage round = rounds[tierId][instanceId][roundNumber];
        round.completedMatches++;

        if (isDraw) {
            round.drawCount++;
        }

        // Check if round is complete
        if (round.completedMatches == round.totalMatches) {
            // Complete the round - this handles orphaned winners, tournament completion, etc.
            // Note: completeRound in MODULE_MATCHES calls hasOrphanedWinners, processOrphanedWinners,
            // and checkForSoleWinnerCompletion internally, so we don't need to call them explicitly
            (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
                abi.encodeWithSignature("completeRound(uint8,uint8,uint8)", tierId, instanceId, roundNumber)
            );
            require(completeSuccess, "CR");
        }
    }

    // ============ IETourGame Public Interface (Makes internal functions accessible to modules) ============
    // Note: These are not true external wrappers - they make the contract satisfy IETourGame interface
    // by exposing internal functions publicly

    function _getTimeIncrement() public view override returns (uint256) {
        // Note: This function is called during match, so we get config from the match's tier
        // In practice, all tiers in TicTacChain use 15 seconds
        return 15 seconds; // Fischer increment: 15 seconds per move
    }

    /**
     * @dev Check if the current player has run out of time
     * Used by escalation system to detect stalled matches
     */
    function _hasCurrentPlayerTimedOut(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];

        // If match is not in progress, return false
        if (matchData.status != MatchStatus.InProgress) {
            return false;
        }

        // Calculate time elapsed since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Get current player's remaining time
        uint256 currentPlayerTimeRemaining;
        if (matchData.currentTurn == matchData.player1) {
            currentPlayerTimeRemaining = matchData.player1TimeRemaining;
        } else {
            currentPlayerTimeRemaining = matchData.player2TimeRemaining;
        }

        // Current player has timed out if elapsed time >= their remaining time
        return timeElapsed >= currentPlayerTimeRemaining;
    }

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) public override {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) public override {
        Match storage matchData = matches[matchId];

        require(matchData.player1 != matchData.player2, "P1");

        matchData.status = MatchStatus.InProgress;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            matchData.player1,
            matchData.player2,
            matchId
        )));
        matchData.firstPlayer = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.currentTurn = matchData.firstPlayer;

        // Initialize empty board
        matchData.packedBoard = 0;

        // Initialize time banks for both players
        uint256 timePerPlayer = _tierConfigs[tierId].timeouts.matchTimePerPlayer;
        matchData.player1TimeRemaining = timePerPlayer;
        matchData.player2TimeRemaining = timePerPlayer;
        matchData.lastMoveTimestamp = block.timestamp;
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) public override {
        Match storage matchData = matches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    function _isMatchActive(bytes32 matchId) public view override returns (bool) {
        Match storage matchData = matches[matchId];
        // Active if player1 assigned and not completed
        return matchData.player1 != address(0) &&
               matchData.status != MatchStatus.Completed;
    }

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
            endTime: 0,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
    }

    function _getMatchFromCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public override returns (CommonMatchData memory data, bool exists) {
        // Delegate to GameCacheModule
        (bool success, bytes memory result) = MODULE_GAME_CACHE.delegatecall(
            abi.encodeWithSignature(
                "getMatchFromCacheByMatchId(bytes32,uint8,uint8,uint8,uint8)",
                matchId,
                tierId,
                instanceId,
                roundNumber,
                matchNumber
            )
        );

        if (!success) {
            return (data, false);
        }

        // Decode result
        (
            address player1,
            address player2,
            address firstPlayer,
            address winner,
            uint256 startTime,
            uint256 endTime,
            bool isDraw,
            bool cacheExists,
            bytes memory boardData
        ) = abi.decode(result, (address, address, address, address, uint256, uint256, bool, bool, bytes));

        if (!cacheExists) {
            return (data, false);
        }

        // Derive loser
        address loser = address(0);
        if (!isDraw && winner != address(0)) {
            loser = (winner == player1) ? player2 : player1;
        }

        // Populate CommonMatchData
        data = CommonMatchData({
            player1: player1,
            player2: player2,
            winner: winner,
            loser: loser,
            status: MatchStatus.Completed,
            isDraw: isDraw,
            startTime: startTime,
            lastMoveTime: endTime,
            endTime: endTime,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: true
        });

        return (data, true);
    }

    // ============ Gameplay Functions ============

    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Delegate game logic to MODULE_GAME
        (bool success, ) = MODULE_GAME.delegatecall(
            abi.encodeWithSignature("makeMove(uint8,uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber, cellIndex)
        );
        require(success, "MV");

        // Check if match was completed by the module
        Match storage matchData = matches[matchId];
        if (matchData.status == MatchStatus.Completed) {
            completeMatch(tierId, instanceId, roundNumber, matchNumber, matchData.winner, matchData.isDraw);
            _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
        }
    }

    // ============ Timeout Functions ============

    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Delegate timeout logic to MODULE_GAME
        (bool success, ) = MODULE_GAME.delegatecall(
            abi.encodeWithSignature("claimTimeoutWin(uint8,uint8,uint8,uint8)",
                tierId, instanceId, roundNumber, matchNumber)
        );
        require(success, "TW");

        // Mark match as stalled to enable escalation
        (bool stallSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature("markMatchStalled(bytes32,uint8,uint256)", matchId, tierId, uint256(0))
        );
        require(stallSuccess, "MS");

        // Complete match and cache
        Match storage matchData = matches[matchId];
        address loser = (matchData.winner == matchData.player1) ? matchData.player2 : matchData.player1;
        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, matchData.winner, loser);

        completeMatch(tierId, instanceId, roundNumber, matchNumber, matchData.winner, matchData.isDraw);
        _addToMatchCacheGame(tierId, instanceId, roundNumber, matchNumber);
    }

    // ============ Game Logic ============
    // Game-specific logic (makeMove, claimTimeoutWin, board helpers) delegated to MODULE_GAME

    // ============ View Functions ============

    /**
     * @dev Get complete TicTacToe match data with automatic cache fallback
     * Replaces legacy tuple return with structured data
     * BREAKING CHANGE: Returns struct instead of tuple
     */
    function getMatch(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public returns (TicTacToeMatchData memory) {
        // Get common data via helper
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);

        // Try active match first
        if (_isMatchActive(matchId)) {
            CommonMatchData memory common = _getActiveMatchData(matchId, tierId, instanceId, roundNumber, matchNumber);

            TicTacToeMatchData memory fullData;
            fullData.common = common;

            Match storage matchData = matches[matchId];
            fullData.packedBoard = matchData.packedBoard;
            fullData.currentTurn = matchData.currentTurn;
            fullData.firstPlayer = matchData.firstPlayer;
            fullData.player1TimeRemaining = matchData.player1TimeRemaining;
            fullData.player2TimeRemaining = matchData.player2TimeRemaining;
            fullData.lastMoveTimestamp = matchData.lastMoveTimestamp;

            return fullData;
        }

        // Try cache
        (CommonMatchData memory cachedCommon, bool exists) = _getMatchFromCache(matchId, tierId, instanceId, roundNumber, matchNumber);
        if (exists) {
            TicTacToeMatchData memory fullData;
            fullData.common = cachedCommon;

            // Initialize default values for cached matches
            fullData.packedBoard = 0;  // Empty board for cached matches
            fullData.firstPlayer = cachedCommon.player1;
            fullData.currentTurn = address(0);  // N/A for completed matches
            fullData.player1TimeRemaining = 0;  // N/A for completed matches
            fullData.player2TimeRemaining = 0;
            fullData.lastMoveTimestamp = 0;

            return fullData;
        }

        revert("Match not found");
    }

    /**
     * @dev Get real-time remaining time for both players
     * Calculates current player's time by subtracting elapsed time since last move
     * Returns stored time for waiting player
     */
    function getCurrentTimeRemaining(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view returns (uint256 player1Time, uint256 player2Time) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        // For completed or not started matches, return stored values
        if (matchData.status != MatchStatus.InProgress) {
            return (matchData.player1TimeRemaining, matchData.player2TimeRemaining);
        }

        // Calculate elapsed time since last move
        uint256 timeElapsed = block.timestamp - matchData.lastMoveTimestamp;

        // Calculate real-time remaining for current player
        if (matchData.currentTurn == matchData.player1) {
            // Player 1's turn - deduct elapsed time
            player1Time = matchData.player1TimeRemaining > timeElapsed
                ? matchData.player1TimeRemaining - timeElapsed
                : 0;
            player2Time = matchData.player2TimeRemaining;
        } else {
            // Player 2's turn - deduct elapsed time
            player1Time = matchData.player1TimeRemaining;
            player2Time = matchData.player2TimeRemaining > timeElapsed
                ? matchData.player2TimeRemaining - timeElapsed
                : 0;
        }

        return (player1Time, player2Time);
    }

    /**
     * @dev Cache getter functions - call MODULE_GAME_CACHE directly:
     * - getCachedMatch(address, address)
     * - getCachedMatchByIndex(uint16)
     * - getAllCachedMatches()
     * - getRecentCachedMatches(uint16)
     * - isMatchCached(address, address)
     */

    // ============ Player Activity Tracking Implementation ============

    /**
     * @dev Hook override: Called when player enrolls in tournament
     * Adds player to enrolling list for activity tracking
     */
    function _onPlayerEnrolled(uint8 tierId, uint8 instanceId, address player) internal override {
        (bool success, ) = MODULE_PLAYER_TRACKING.delegatecall(
            abi.encodeWithSignature("onPlayerEnrolled(uint8,uint8,address)", tierId, instanceId, player)
        );
        require(success, "TE");
    }

    function _onTournamentStarted(uint8 tierId, uint8 instanceId) internal override {
        (bool success, ) = MODULE_PLAYER_TRACKING.delegatecall(
            abi.encodeWithSignature("onTournamentStarted(uint8,uint8)", tierId, instanceId)
        );
        require(success, "TS");
    }

    function _onPlayerEliminatedFromTournament(
        address player,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber
    ) internal override {
        (bool success, ) = MODULE_PLAYER_TRACKING.delegatecall(
            abi.encodeWithSignature("onPlayerEliminatedFromTournament(address,uint8,uint8,uint8)",
                player, tierId, instanceId, roundNumber)
        );
        require(success, "TL");
    }

    function _onExternalPlayerReplacement(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) internal override {
        (bool success, ) = MODULE_PLAYER_TRACKING.delegatecall(
            abi.encodeWithSignature("onExternalPlayerReplacement(uint8,uint8,address)",
                tierId, instanceId, player)
        );
        require(success, "TR");
    }

    function _onTournamentCompleted(
        uint8 tierId,
        uint8 instanceId,
        address[] memory players
    ) public override {
        (bool success, ) = MODULE_PLAYER_TRACKING.delegatecall(
            abi.encodeWithSignature("onTournamentCompleted(uint8,uint8,address[])",
                tierId, instanceId, players)
        );
        require(success, "TC");
    }

    // ============ Player Activity View Functions ============
    // Player tracking logic delegated to MODULE_PLAYER_TRACKING

    /**
     * @dev Player tournament list getters - call MODULE_PLAYER_TRACKING directly:
     * - getPlayerEnrollingTournaments(address)
     * - getPlayerActiveTournaments(address)
     */

    /**
     * @dev Get counts (gas-efficient for checking if player has any activity)
     */
    function getPlayerActivityCounts(address player) external view returns (
        uint256 enrollingCount,
        uint256 activeCount
    ) {
        return (
            playerEnrollingTournaments[player].length,
            playerActiveTournaments[player].length
        );
    }

    /**
     * @dev Player tournament status - call MODULE_PLAYER_TRACKING.isPlayerInTournament() directly
     */

    /**
     * @dev Tier configuration - access via inherited getTierConfig() from ETour_Storage
     */

    // ============ Missing Getter Functions ============

    function getTournamentInfo(uint8 tierId, uint8 instanceId) external view returns (
        TournamentStatus status,
        Mode mode,
        uint8 currentRound,
        uint8 enrolledCount,
        uint256 prizePool,
        address winner
    ) {
        TournamentInstance storage tournament = tournaments[tierId][instanceId];
        return (
            tournament.status,
            tournament.mode,
            tournament.currentRound,
            tournament.enrolledCount,
            tournament.prizePool,
            tournament.winner
        );
    }

    function getPlayerActiveMatches(address player) external view returns (bytes32[] memory) {
        return playerActiveMatches[player];
    }

    function getEnrolledPlayers(uint8 tierId, uint8 instanceId) external view returns (address[] memory) {
        return enrolledPlayers[tierId][instanceId];
    }

    function getRoundInfo(uint8 tierId, uint8 instanceId, uint8 roundNumber) external view returns (
        uint8 totalMatches,
        uint8 completedMatches,
        bool initialized
    ) {
        Round storage round = rounds[tierId][instanceId][roundNumber];
        return (round.totalMatches, round.completedMatches, round.initialized);
    }

    function getPlayerStats() external view returns (int256 totalEarnings) {
        return playerEarnings[msg.sender];
    }

    function getTierOverview(uint8 tierId) external view returns (
        TournamentStatus[] memory statuses,
        uint8[] memory enrolledCounts,
        uint256[] memory prizePools
    ) {
        TierConfig storage config = _tierConfigs[tierId];
        uint8 instanceCount = config.instanceCount;
        statuses = new TournamentStatus[](instanceCount);
        enrolledCounts = new uint8[](instanceCount);
        prizePools = new uint256[](instanceCount);

        for (uint8 i = 0; i < instanceCount; i++) {
            TournamentInstance storage tournament = tournaments[tierId][i];
            statuses[i] = tournament.status;
            enrolledCounts[i] = tournament.enrolledCount;
            prizePools[i] = tournament.prizePool;
        }

        return (statuses, enrolledCounts, prizePools);
    }

    /**
     * @dev Prize and leaderboard getters - access storage directly:
     * - _tierPrizeDistribution[tierId][ranking] - get prize percentage
     * - _tierPrizeDistribution[tierId] - get full distribution array
     * - _leaderboardPlayers.length - get leaderboard count
     */

    function _getRaffleThreshold() internal view returns (uint256) {
        // If no raffle thresholds configured, use default
        if (raffleThresholds.length == 0) {
            return 3 ether;
        }

        // If currentRaffleIndex is within the configured array, use that value
        if (currentRaffleIndex < raffleThresholds.length) {
            return raffleThresholds[currentRaffleIndex];
        }

        // Otherwise, use the final threshold
        return raffleThresholdFinal;
    }

    function getRaffleThresholds() external view returns (
        uint256[] memory thresholds,
        uint256 finalThreshold,
        uint256 currentThreshold
    ) {
        thresholds = raffleThresholds;
        finalThreshold = raffleThresholdFinal;
        currentThreshold = _getRaffleThreshold();
        return (thresholds, finalThreshold, currentThreshold);
    }

    /**
     * @dev Simple getters - access storage/helpers directly:
     * - _getMatchId(tierId, instanceId, roundNumber, matchNumber) - get match ID
     * - _tierConfigs[tierId].entryFee - get entry fee
     * - _tierConfigs[tierId].instanceCount - get instance count
     * - _tierConfigs[tierId].playerCount - get tier size
     */

    // ============ View Function Wrappers (Delegatecall to Modules) ============

    /**
     * @dev Get all tier IDs - reads from own storage
     */
    function getAllTierIds() external view returns (uint8[] memory) {
        uint8[] memory tierIds = new uint8[](tierCount);
        for (uint8 i = 0; i < tierCount; i++) {
            tierIds[i] = i;
        }
        return tierIds;
    }

    /**
     * @dev Get tier info - reads from own storage
     */
    function getTierInfo(uint8 tierId) external view returns (
        uint8 playerCount,
        uint8 instanceCount,
        uint256 entryFee
    ) {
        require(_tierConfigs[tierId].initialized, "IT");
        TierConfig storage config = _tierConfigs[tierId];
        return (
            config.playerCount,
            config.instanceCount,
            config.entryFee
        );
    }

    /**
     * @dev Can reset enrollment window - reads from own storage
     */
    function canResetEnrollmentWindow(uint8 tierId, uint8 instanceId) external view returns (bool canReset) {
        TierConfig storage config = _tierConfigs[tierId];

        if (!config.initialized) return false;
        if (instanceId >= config.instanceCount) return false;

        TournamentInstance storage tournament = tournaments[tierId][instanceId];

        bool isEnrollingStatus = tournament.status == TournamentStatus.Enrolling;
        bool isExactlyOnePlayer = tournament.enrolledCount == 1;
        bool isPlayerEnrolled = isEnrolled[tierId][instanceId][msg.sender];
        bool hasWindowExpired = block.timestamp >= tournament.enrollmentTimeout.escalation1Start;

        return isEnrollingStatus && isExactlyOnePlayer && isPlayerEnrolled && hasWindowExpired;
    }

    /**
     * @dev Get raffle info - delegates to Raffle module
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
        (bool success, bytes memory data) = MODULE_RAFFLE.staticcall(
            abi.encodeWithSignature("getRaffleInfo()")
        );
        require(success, "GF");
        return abi.decode(data, (uint256, bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    /**
     * @dev Get leaderboard - delegates to Prizes module
     */
    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        (bool success, bytes memory data) = MODULE_PRIZES.staticcall(
            abi.encodeWithSignature("getLeaderboard()")
        );
        require(success, "GF");
        // Decode the struct array - we need to define LeaderboardEntry locally
        return abi.decode(data, (LeaderboardEntry[]));
    }

    /**
     * @dev LeaderboardEntry struct for decoding
     */
    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    /**
     * @dev Escalation availability checks (L1, L2, L3) - delegated to MODULE_ESCALATION
     * Call MODULE_ESCALATION.isMatchEscLXAvailable() directly
     */

    /**
     * @dev Advanced player checks - delegated to MODULE_ESCALATION
     * Call MODULE_ESCALATION.isPlayerInAdvancedRound() directly
     */

    /**
     * @dev Get raffle configuration - delegates to Raffle module
     */
    function getRaffleConfiguration() external view returns (
        uint256 threshold,
        uint256 reserve,
        uint256 ownerSharePercentage,
        uint256 winnerSharePercentage
    ) {
        threshold = _getRaffleThreshold();
        (bool success, bytes memory data) = MODULE_RAFFLE.staticcall(
            abi.encodeWithSignature("getRaffleReserve()")
        );
        require(success, "RR");
        reserve = abi.decode(data, (uint256));
        return (
            threshold,
            reserve,
            20,  // 20% to owner
            80   // 80% to winner
        );
    }
}
