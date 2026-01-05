// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETour_Storage.sol";

/**
 * @title GameCacheModule
 * @dev Stateless module for match caching across all game implementations
 *
 * This module handles:
 * - Circular cache for completed matches (1000 slots)
 * - Match lookup by matchId and player pair
 * - Generic board storage as bytes for game-agnostic caching
 * - Cache overflow management with cleanup
 *
 * CRITICAL - DELEGATECALL SEMANTICS:
 * When game contract calls this module via delegatecall:
 * - This code executes AS IF it's part of the game contract
 * - Can directly access storage variables (sharedMatchCache, etc.)
 * - address(this) = game contract address
 * - msg.sender = original caller
 *
 * STATELESS: This contract declares NO storage variables of its own.
 * All storage access is to the game contract's storage via delegatecall context.
 */
contract GameCacheModule is ETour_Storage {

    // Constructor - modules need to set module addresses even though they're stateless
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

    // ============ Cache Management ============

    /**
     * @dev Add completed match to cache
     * Implements circular buffer with overflow handling
     *
     * @param matchId Unique identifier for the match
     * @param tierId Tier ID for context validation
     * @param instanceId Instance ID for context validation
     * @param roundNumber Round number for context validation
     * @param matchNumber Match number for context validation
     * @param player1 First player address
     * @param player2 Second player address
     * @param firstPlayer Who started the match
     * @param winner Winner address (address(0) if draw)
     * @param startTime Match start timestamp
     * @param isDraw Whether match ended in draw
     * @param boardData Encoded board state (game-specific)
     */
    function addToMatchCache(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2,
        address firstPlayer,
        address winner,
        uint256 startTime,
        bool isDraw,
        bytes memory boardData
    ) external {
        uint16 cacheIndex = sharedNextCacheIndex;

        // Clean up old matchId mapping for the entry being overwritten
        bytes32 oldMatchId = sharedCacheMatchIds[cacheIndex];
        if (oldMatchId != bytes32(0)) {
            delete sharedMatchIdToCacheIndex[oldMatchId];
        }

        // Store new cache entry
        sharedMatchCache[cacheIndex] = CachedMatch({
            player1: player1,
            player2: player2,
            firstPlayer: firstPlayer,
            winner: winner,
            startTime: startTime,
            endTime: block.timestamp,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isDraw: isDraw,
            exists: true,
            boardData: boardData
        });

        // Update matchId index
        sharedMatchIdToCacheIndex[matchId] = cacheIndex;
        sharedCacheMatchIds[cacheIndex] = matchId;

        // Advance circular buffer index
        sharedNextCacheIndex = uint16((cacheIndex + 1) % MATCH_CACHE_SIZE);

        bytes32 matchKey = keccak256(abi.encodePacked(player1, player2));
        emit MatchCached(matchKey, cacheIndex, player1, player2);
    }

    /**
     * @dev Retrieve match from cache with context validation
     * Tries direct matchId lookup first, then falls back to player-based lookup
     *
     * @param matchId Unique identifier for the match
     * @param tierId Tier ID for context validation
     * @param instanceId Instance ID for context validation
     * @param roundNumber Round number for context validation
     * @param matchNumber Match number for context validation
     * @return player1 First player address
     * @return player2 Second player address
     * @return firstPlayer Who started the match
     * @return winner Winner address (address(0) if draw)
     * @return startTime Match start timestamp
     * @return endTime Match end timestamp
     * @return isDraw Whether match ended in draw
     * @return exists Whether cache entry was found
     * @return boardData Encoded board state
     */
    function getMatchFromCacheByMatchId(
        bytes32 matchId,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (
        address player1,
        address player2,
        address firstPlayer,
        address winner,
        uint256 startTime,
        uint256 endTime,
        bool isDraw,
        bool exists,
        bytes memory boardData
    ) {
        // Try direct matchId lookup first (works even after match reset)
        uint16 index = sharedMatchIdToCacheIndex[matchId];

        // Verify cache entry exists and context matches
        if (sharedMatchCache[index].exists &&
            sharedMatchCache[index].tierId == tierId &&
            sharedMatchCache[index].instanceId == instanceId &&
            sharedMatchCache[index].roundNumber == roundNumber &&
            sharedMatchCache[index].matchNumber == matchNumber) {

            CachedMatch storage cached = sharedMatchCache[index];
            return (
                cached.player1,
                cached.player2,
                cached.firstPlayer,
                cached.winner,
                cached.startTime,
                cached.endTime,
                cached.isDraw,
                true,
                cached.boardData
            );
        }

        // Not found
        return (address(0), address(0), address(0), address(0), 0, 0, false, false, "");
    }


    /**
     * @dev Get cached match by array index
     * @param index Cache array index (0 to MATCH_CACHE_SIZE-1)
     * @return Cached match data
     */
    function getCachedMatchByIndex(uint16 index) external view returns (CachedMatch memory) {
        require(index < MATCH_CACHE_SIZE, "Index out of bounds");
        require(sharedMatchCache[index].exists, "No match at this index");
        return sharedMatchCache[index];
    }

    /**
     * @dev Get all cached matches (expensive - 1000 slots)
     * @return cachedMatches Array of all cache entries
     */
    function getAllCachedMatches() external view returns (CachedMatch[] memory cachedMatches) {
        cachedMatches = new CachedMatch[](MATCH_CACHE_SIZE);
        for (uint16 i = 0; i < MATCH_CACHE_SIZE; i++) {
            cachedMatches[i] = sharedMatchCache[i];
        }
        return cachedMatches;
    }

    /**
     * @dev Get recent cached matches (most recently added)
     * @param count Number of recent matches to retrieve
     * @return recentMatches Array of recent cache entries
     */
    function getRecentCachedMatches(uint16 count) external view returns (CachedMatch[] memory recentMatches) {
        if (count > MATCH_CACHE_SIZE) {
            count = MATCH_CACHE_SIZE;
        }

        recentMatches = new CachedMatch[](count);
        uint16 currentIndex = sharedNextCacheIndex;

        for (uint16 i = 0; i < count; i++) {
            if (currentIndex == 0) {
                currentIndex = MATCH_CACHE_SIZE - 1;
            } else {
                currentIndex--;
            }

            if (sharedMatchCache[currentIndex].exists) {
                recentMatches[i] = sharedMatchCache[currentIndex];
            }
        }

        return recentMatches;
    }

}
