// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETour.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title EternalBattleship
 * @dev Battleship game implementing ETour tournament protocol with hidden information
 *
 * Commit-Reveal Scheme with Tournament-Level Wallet Signatures:
 * - Players sign ONCE at enrollment to generate their tournament secret
 * - The same signature/secret is used for ALL matches in that tournament
 * - Salt is derived from signing a deterministic message (tierId + instanceId + player)
 * - Players can always regenerate their secret by re-signing the same message
 * - On reveal, contract verifies signature and reconstructs the commitment
 * - No private keys stored - only commitments and revealed data
 *
 * Game Flow:
 * 1. Player enrolls and signs tournament message to generate secret
 * 2. Match starts in AwaitingCommitments phase
 * 3. Both players submit commitments (hash of board + signature-derived salt)
 * 4. Once both committed, phase moves to AwaitingReveals
 * 5. Both players reveal boards with their signatures for verification
 * 6. Once both revealed, gameplay begins (InProgress phase)
 * 7. Players alternate firing shots - hit/miss revealed immediately
 * 8. First player to sink all opponent ships wins
 * 9. For subsequent rounds, same tournament signature is reused
 *
 * Part of the RW3 (Reclaim Web3) movement.
 */
contract EternalBattleship is ETour {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Game-Specific Constants ============

    uint8 public constant BOARD_SIZE = 100;  // 10x10 grid
    uint8 public constant BOARD_WIDTH = 10;
    uint8 public constant TOTAL_SHIP_CELLS = 17;
    uint8 public constant NO_CELL = 255;

    // Ship sizes (positions in the shipPositions array)
    uint8 public constant CARRIER_SIZE = 5;      // positions[0..4]
    uint8 public constant BATTLESHIP_SIZE = 4;   // positions[5..8]
    uint8 public constant CRUISER_SIZE = 3;      // positions[9..11]
    uint8 public constant SUBMARINE_SIZE = 3;    // positions[12..14]
    uint8 public constant DESTROYER_SIZE = 2;    // positions[15..16]

    // Timeout configuration
    uint256 public constant DEFAULT_ENROLLMENT_WINDOW = 1 hours;
    uint256 public constant DEFAULT_MATCH_MOVE_TIMEOUT = 3 minutes;
    uint256 public constant DEFAULT_ESCALATION_INTERVAL = 2 minutes;

    // ============ Game-Specific Enums ============

    enum CellState { Empty, Ship, Hit, Miss }

    enum MatchPhase {
        NotStarted,
        AwaitingCommitments,  // Waiting for both players to commit
        AwaitingReveals,      // Waiting for both players to reveal
        InProgress,           // Normal gameplay
        Completed
    }

    // ============ Game-Specific Structs ============

    struct PlayerBoard {
        CellState[100] cells;       // The actual board state
        bool[100] shotsReceived;    // Which cells have been shot at
        bytes32 commitment;         // Hash of (shipPositions, salt)
        bool hasCommitted;
        bool hasRevealed;
        uint8 shipsRemaining;       // Count of unhit ship cells
    }

    struct BattleshipMatch {
        address player1;
        address player2;
        address currentTurn;
        address winner;
        MatchStatus status;
        MatchPhase phase;
        PlayerBoard player1Board;
        PlayerBoard player2Board;
        uint256 lastMoveTime;
        uint256 startTime;
        address firstPlayer;
        bool isDraw;

        // Timeout fields
        MatchTimeoutState timeoutState;
        bool isTimedOut;
        address timeoutClaimant;
        uint256 timeoutClaimReward;
    }

    struct CachedBattleshipMatch {
        address player1;
        address player2;
        address winner;
        uint256 startTime;
        uint256 endTime;
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool exists;
        uint8 player1ShotsHit;
        uint8 player2ShotsHit;
    }

    // ============ Game-Specific State ============

    mapping(bytes32 => BattleshipMatch) private _battleshipMatches;

    // Match cache
    uint16 public constant MATCH_CACHE_SIZE = 500;
    CachedBattleshipMatch[MATCH_CACHE_SIZE] public matchCache;
    uint16 public nextCacheIndex;
    mapping(bytes32 => uint16) public cacheKeyToIndex;
    bytes32[MATCH_CACHE_SIZE] private cacheKeys;

    // Store match coordinates for reverse lookup
    struct MatchCoordinates {
        uint8 tierId;
        uint8 instanceId;
        uint8 roundNumber;
        uint8 matchNumber;
        bool exists;
    }
    mapping(bytes32 => MatchCoordinates) public matchCoordinates;

    // ============ Game-Specific Events ============

    event BoardCommitted(bytes32 indexed matchId, address indexed player);
    event BoardRevealed(bytes32 indexed matchId, address indexed player);
    event ShotFired(bytes32 indexed matchId, address indexed shooter, uint8 targetCell, bool isHit);
    event AllShipsSunk(bytes32 indexed matchId, address indexed winner, address indexed loser);
    event BattleshipMatchCached(bytes32 indexed matchKey, uint16 cacheIndex, address indexed player1, address indexed player2);

    // ============ Constructor ============

    constructor() ETour() {
        _registerBattleshipTiers();
    }

    /**
     * @dev Register tournament tiers for EternalBattleship
     */
    function _registerBattleshipTiers() internal {
        // Tier 0: 2-Player (Head-to-Head)
        uint8[] memory tier0Prizes = new uint8[](2);
        tier0Prizes[0] = 100;
        tier0Prizes[1] = 0;

        _registerTier(
            0, 2, 10, 0.005 ether, Mode.Classic,
            DEFAULT_ENROLLMENT_WINDOW,
            DEFAULT_MATCH_MOVE_TIMEOUT,
            DEFAULT_ESCALATION_INTERVAL,
            tier0Prizes
        );

        // Tier 1: 4-Player Tournament
        uint8[] memory tier1Prizes = new uint8[](4);
        tier1Prizes[0] = 65;
        tier1Prizes[1] = 25;
        tier1Prizes[2] = 10;
        tier1Prizes[3] = 0;

        _registerTier(
            1, 4, 5, 0.01 ether, Mode.Pro,
            DEFAULT_ENROLLMENT_WINDOW,
            DEFAULT_MATCH_MOVE_TIMEOUT,
            DEFAULT_ESCALATION_INTERVAL,
            tier1Prizes
        );

        // Tier 2: 8-Player Tournament
        uint8[] memory tier2Prizes = new uint8[](8);
        tier2Prizes[0] = 50;
        tier2Prizes[1] = 25;
        tier2Prizes[2] = 15;
        tier2Prizes[3] = 10;
        tier2Prizes[4] = 0;
        tier2Prizes[5] = 0;
        tier2Prizes[6] = 0;
        tier2Prizes[7] = 0;

        _registerTier(
            2, 8, 3, 0.02 ether, Mode.Pro,
            DEFAULT_ENROLLMENT_WINDOW,
            DEFAULT_MATCH_MOVE_TIMEOUT,
            DEFAULT_ESCALATION_INTERVAL,
            tier2Prizes
        );
    }

    // ============ Signature & Commitment Helpers ============

    /**
     * @dev Get the message that players must sign to generate their tournament secret
     * This message is deterministic and can be regenerated anytime
     * Players sign ONCE at enrollment and use the same secret for all matches in the tournament
     */
    function getCommitMessage(
        uint8 tierId,
        uint8 instanceId,
        address player
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            "EternalBattleship:tournament:",
            tierId,
            instanceId,
            player
        ));
    }

    /**
     * @dev Verify that a signature was created by the expected signer
     * @param messageHash The hash of the message that was signed
     * @param signature The signature bytes
     * @param expectedSigner The address that should have signed
     */
    function verifySignature(
        bytes32 messageHash,
        bytes memory signature,
        address expectedSigner
    ) public pure returns (bool) {
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        address recoveredSigner = ethSignedMessageHash.recover(signature);
        return recoveredSigner == expectedSigner;
    }

    /**
     * @dev Generate commitment hash from ship positions and signature
     * This is a helper for clients to generate their commitment off-chain
     * @param shipPositions Array of 17 cell positions for all ships
     * @param signature The wallet signature used as salt source
     */
    function generateCommitment(
        uint8[17] calldata shipPositions,
        bytes calldata signature
    ) external pure returns (bytes32) {
        bytes32 salt = keccak256(signature);
        return keccak256(abi.encodePacked(shipPositions, salt));
    }

    /**
     * @dev Derive salt from signature (used internally)
     */
    function _deriveSalt(bytes memory signature) internal pure returns (bytes32) {
        return keccak256(signature);
    }

    // ============ ETour Abstract Implementation ============

    function _createMatchGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) internal override {
        require(player1 != player2, "Cannot match player against themselves");
        require(player1 != address(0) && player2 != address(0), "Invalid player address");

        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        matchData.player1 = player1;
        matchData.player2 = player2;
        matchData.status = MatchStatus.InProgress;
        matchData.phase = MatchPhase.AwaitingCommitments;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;
        matchData.isDraw = false;

        _initializePlayerBoard(matchData.player1Board);
        _initializePlayerBoard(matchData.player2Board);

        // Store match coordinates for reverse lookup
        matchCoordinates[matchId] = MatchCoordinates({
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            exists: true
        });

        // Determine first player (used when gameplay starts)
        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, player1, player2, matchId
        )));
        matchData.firstPlayer = (randomness % 2 == 0) ? player1 : player2;
        matchData.currentTurn = matchData.firstPlayer;

        _addPlayerActiveMatch(player1, matchId);
        _addPlayerActiveMatch(player2, matchId);
        _initializeMatchTimeoutState(matchId, tierId);

        emit MatchStarted(tierId, instanceId, roundNumber, matchNumber, player1, player2);
    }

    function _initializePlayerBoard(PlayerBoard storage board) internal {
        board.hasCommitted = false;
        board.hasRevealed = false;
        board.shipsRemaining = 0;
        board.commitment = bytes32(0);

        for (uint8 i = 0; i < BOARD_SIZE; i++) {
            board.cells[i] = CellState.Empty;
            board.shotsReceived[i] = false;
        }
    }

    function _resetMatchGame(bytes32 matchId) internal override {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        matchData.player1 = address(0);
        matchData.player2 = address(0);
        matchData.currentTurn = address(0);
        matchData.winner = address(0);
        matchData.status = MatchStatus.NotStarted;
        matchData.phase = MatchPhase.NotStarted;
        matchData.lastMoveTime = 0;
        matchData.startTime = 0;
        matchData.firstPlayer = address(0);
        matchData.isDraw = false;
        matchData.isTimedOut = false;
        matchData.timeoutClaimant = address(0);
        matchData.timeoutClaimReward = 0;
        matchData.timeoutState.escalation1Start = 0;
        matchData.timeoutState.escalation2Start = 0;
        matchData.timeoutState.escalation3Start = 0;
        matchData.timeoutState.activeEscalation = EscalationLevel.None;
        matchData.timeoutState.timeoutActive = false;
        matchData.timeoutState.forfeitAmount = 0;

        _resetPlayerBoard(matchData.player1Board);
        _resetPlayerBoard(matchData.player2Board);
    }

    function _resetPlayerBoard(PlayerBoard storage board) internal {
        board.hasCommitted = false;
        board.hasRevealed = false;
        board.shipsRemaining = 0;
        board.commitment = bytes32(0);

        for (uint8 i = 0; i < BOARD_SIZE; i++) {
            board.cells[i] = CellState.Empty;
            board.shotsReceived[i] = false;
        }
    }

    function _getMatchResult(bytes32 matchId) internal view override returns (address winner, bool isDraw, MatchStatus status) {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        return (matchData.winner, matchData.isDraw, matchData.status);
    }

    function _addToMatchCacheGame(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) internal override {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        bytes32 matchKey = keccak256(abi.encodePacked(matchData.player1, matchData.player2, block.timestamp));
        uint16 cacheIndex = nextCacheIndex;

        bytes32 oldKey = cacheKeys[cacheIndex];
        if (oldKey != bytes32(0)) {
            delete cacheKeyToIndex[oldKey];
        }

        uint8 p1Hits = TOTAL_SHIP_CELLS - matchData.player2Board.shipsRemaining;
        uint8 p2Hits = TOTAL_SHIP_CELLS - matchData.player1Board.shipsRemaining;

        matchCache[cacheIndex] = CachedBattleshipMatch({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            startTime: matchData.startTime,
            endTime: block.timestamp,
            tierId: tierId,
            instanceId: instanceId,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            exists: true,
            player1ShotsHit: p1Hits,
            player2ShotsHit: p2Hits
        });

        cacheKeys[cacheIndex] = matchKey;
        cacheKeyToIndex[matchKey] = cacheIndex;
        nextCacheIndex = uint16((cacheIndex + 1) % MATCH_CACHE_SIZE);

        emit BattleshipMatchCached(matchKey, cacheIndex, matchData.player1, matchData.player2);
    }

    function _getMatchPlayers(bytes32 matchId) internal view override returns (address player1, address player2) {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function _setMatchTimeoutState(bytes32 matchId, MatchTimeoutState memory state) internal override {
        _battleshipMatches[matchId].timeoutState = state;
    }

    function _getMatchTimeoutState(bytes32 matchId) internal view override returns (MatchTimeoutState memory) {
        return _battleshipMatches[matchId].timeoutState;
    }

    function _setMatchTimedOut(bytes32 matchId, address claimant, EscalationLevel level) internal override {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        matchData.isTimedOut = true;
        matchData.timeoutClaimant = claimant;
        matchData.timeoutState.activeEscalation = level;
        matchData.timeoutState.timeoutActive = true;
    }

    function _setMatchPlayer(bytes32 matchId, uint8 slot, address player) internal override {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function _initializeMatchForPlay(bytes32 matchId, uint8 tierId) internal override {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(matchData.player1 != matchData.player2, "Cannot match player against themselves");

        matchData.status = MatchStatus.InProgress;
        matchData.phase = MatchPhase.AwaitingCommitments;
        matchData.lastMoveTime = block.timestamp;
        matchData.startTime = block.timestamp;

        _initializePlayerBoard(matchData.player1Board);
        _initializePlayerBoard(matchData.player2Board);

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, matchData.player1, matchData.player2, matchId
        )));
        matchData.firstPlayer = (randomness % 2 == 0) ? matchData.player1 : matchData.player2;
        matchData.currentTurn = matchData.firstPlayer;

        _initializeMatchTimeoutState(matchId, tierId);
    }

    function _completeMatchWithResult(bytes32 matchId, address winner, bool isDraw) internal override {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        matchData.status = MatchStatus.Completed;
        matchData.phase = MatchPhase.Completed;
        matchData.winner = winner;
        matchData.isDraw = isDraw;
    }

    // ============ Timeout Functions ============

    function _initializeMatchTimeoutState(bytes32 matchId, uint8 tierId) internal {
        BattleshipMatch storage matchData = _battleshipMatches[matchId];
        uint256 baseTime = matchData.lastMoveTime;
        TierConfig storage config = _tierConfigs[tierId];

        matchData.timeoutState.escalation1Start = baseTime + config.matchMoveTimeout;
        matchData.timeoutState.escalation2Start = matchData.timeoutState.escalation1Start + config.escalationInterval;
        matchData.timeoutState.escalation3Start = matchData.timeoutState.escalation2Start + config.escalationInterval;
        matchData.timeoutState.activeEscalation = EscalationLevel.None;
        matchData.timeoutState.timeoutActive = false;
        matchData.timeoutState.forfeitAmount = config.entryFee;
    }

    function claimTimeoutWin(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(block.timestamp >= matchData.timeoutState.escalation1Start, "Timeout not reached");

        address expectedActor;

        if (matchData.phase == MatchPhase.AwaitingCommitments) {
            // Check if opponent hasn't committed
            PlayerBoard storage myBoard = (msg.sender == matchData.player1)
                ? matchData.player1Board
                : matchData.player2Board;
            PlayerBoard storage opponentBoard = (msg.sender == matchData.player1)
                ? matchData.player2Board
                : matchData.player1Board;

            require(myBoard.hasCommitted, "You must commit first");
            require(!opponentBoard.hasCommitted, "Opponent has committed");
            expectedActor = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;

        } else if (matchData.phase == MatchPhase.AwaitingReveals) {
            // Check if opponent hasn't revealed
            PlayerBoard storage myBoard = (msg.sender == matchData.player1)
                ? matchData.player1Board
                : matchData.player2Board;
            PlayerBoard storage opponentBoard = (msg.sender == matchData.player1)
                ? matchData.player2Board
                : matchData.player1Board;

            require(myBoard.hasRevealed, "You must reveal first");
            require(!opponentBoard.hasRevealed, "Opponent has revealed");
            expectedActor = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;

        } else {
            // InProgress - must be opponent's turn
            require(msg.sender != matchData.currentTurn, "Cannot claim timeout on your own turn");
            expectedActor = matchData.currentTurn;
        }

        matchData.isTimedOut = true;
        matchData.timeoutClaimant = msg.sender;
        matchData.timeoutState.activeEscalation = EscalationLevel.Escalation1_OpponentClaim;
        matchData.timeoutState.timeoutActive = true;

        playerForfeitedAmounts[tierId][instanceId][expectedActor] += _tierConfigs[tierId].entryFee;

        emit TimeoutVictoryClaimed(tierId, instanceId, roundNumber, matchNumber, msg.sender, expectedActor);

        _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
    }

    // ============ Commit-Reveal Functions ============

    /**
     * @dev Submit a commitment to your board layout
     * Commitment = keccak256(abi.encodePacked(shipPositions, keccak256(signature)))
     *
     * Client-side process:
     * 1. Sign the message from getCommitMessage() with your wallet
     * 2. Use generateCommitment(shipPositions, signature) to get the commitment hash
     * 3. Submit that commitment hash here
     *
     * @param commitment The hash commitment (generated off-chain or via generateCommitment)
     */
    function commitBoard(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        bytes32 commitment
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(matchData.phase == MatchPhase.AwaitingCommitments, "Not in commitment phase");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(commitment != bytes32(0), "Invalid commitment");

        PlayerBoard storage playerBoard = (msg.sender == matchData.player1)
            ? matchData.player1Board
            : matchData.player2Board;

        require(!playerBoard.hasCommitted, "Already committed");

        playerBoard.commitment = commitment;
        playerBoard.hasCommitted = true;
        matchData.lastMoveTime = block.timestamp;

        emit BoardCommitted(matchId, msg.sender);

        // Transition to reveal phase if both committed
        if (matchData.player1Board.hasCommitted && matchData.player2Board.hasCommitted) {
            matchData.phase = MatchPhase.AwaitingReveals;
        }

        _initializeMatchTimeoutState(matchId, tierId);
    }

    /**
     * @dev Reveal your board layout with signature verification
     * The signature must be for the message from getCommitMessage() and signed by msg.sender
     *
     * @param shipPositions Array of 17 cell positions for all ships:
     *        [0..4] = Carrier (5), [5..8] = Battleship (4), [9..11] = Cruiser (3),
     *        [12..14] = Submarine (3), [15..16] = Destroyer (2)
     * @param signature The wallet signature used to derive the salt
     */
    function revealBoard(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8[17] calldata shipPositions,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(matchData.phase == MatchPhase.AwaitingReveals, "Not in reveal phase");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");

        PlayerBoard storage playerBoard = (msg.sender == matchData.player1)
            ? matchData.player1Board
            : matchData.player2Board;

        require(playerBoard.hasCommitted, "Must commit first");
        require(!playerBoard.hasRevealed, "Already revealed");

        // 1. Verify signature is from msg.sender for this tournament
        bytes32 messageHash = getCommitMessage(tierId, instanceId, msg.sender);
        require(verifySignature(messageHash, signature, msg.sender), "Invalid signature");

        // 2. Derive salt from signature
        bytes32 salt = _deriveSalt(signature);

        // 3. Verify commitment matches
        bytes32 calculatedCommitment = keccak256(abi.encodePacked(shipPositions, salt));
        require(calculatedCommitment == playerBoard.commitment, "Commitment mismatch");

        // 4. Validate ship placement
        require(_validateShipPlacement(shipPositions), "Invalid ship placement");

        // 5. Place ships on board
        for (uint8 i = 0; i < TOTAL_SHIP_CELLS; i++) {
            playerBoard.cells[shipPositions[i]] = CellState.Ship;
        }

        playerBoard.hasRevealed = true;
        playerBoard.shipsRemaining = TOTAL_SHIP_CELLS;
        matchData.lastMoveTime = block.timestamp;

        emit BoardRevealed(matchId, msg.sender);

        // Transition to gameplay if both revealed
        if (matchData.player1Board.hasRevealed && matchData.player2Board.hasRevealed) {
            matchData.phase = MatchPhase.InProgress;
        }

        _initializeMatchTimeoutState(matchId, tierId);
    }

    /**
     * @dev Validate that ship positions form valid ships
     */
    function _validateShipPlacement(uint8[17] calldata positions) internal pure returns (bool) {
        bool[100] memory occupied;

        for (uint8 i = 0; i < TOTAL_SHIP_CELLS; i++) {
            if (positions[i] >= BOARD_SIZE) return false;
            if (occupied[positions[i]]) return false;
            occupied[positions[i]] = true;
        }

        // Validate each ship forms a contiguous line
        if (!_isValidShip(positions, 0, CARRIER_SIZE)) return false;
        if (!_isValidShip(positions, 5, BATTLESHIP_SIZE)) return false;
        if (!_isValidShip(positions, 9, CRUISER_SIZE)) return false;
        if (!_isValidShip(positions, 12, SUBMARINE_SIZE)) return false;
        if (!_isValidShip(positions, 15, DESTROYER_SIZE)) return false;

        return true;
    }

    function _isValidShip(uint8[17] calldata positions, uint8 startIdx, uint8 shipSize) internal pure returns (bool) {
        if (shipSize == 1) return true;

        uint8 pos0 = positions[startIdx];
        uint8 pos1 = positions[startIdx + 1];

        uint8 row0 = pos0 / BOARD_WIDTH;
        uint8 col0 = pos0 % BOARD_WIDTH;
        uint8 row1 = pos1 / BOARD_WIDTH;
        uint8 col1 = pos1 % BOARD_WIDTH;

        bool isHorizontal;
        bool isVertical;

        if (row0 == row1 && _absDiff(col0, col1) == 1) {
            isHorizontal = true;
        } else if (col0 == col1 && _absDiff(row0, row1) == 1) {
            isVertical = true;
        } else {
            return false;
        }

        uint8[] memory sortedPositions = new uint8[](shipSize);
        for (uint8 i = 0; i < shipSize; i++) {
            sortedPositions[i] = positions[startIdx + i];
        }
        _sortPositions(sortedPositions);

        for (uint8 i = 1; i < shipSize; i++) {
            uint8 prevPos = sortedPositions[i - 1];
            uint8 currPos = sortedPositions[i];

            if (isHorizontal) {
                if (currPos / BOARD_WIDTH != prevPos / BOARD_WIDTH) return false;
                if (currPos - prevPos != 1) return false;
            } else if (isVertical) {
                if (currPos % BOARD_WIDTH != prevPos % BOARD_WIDTH) return false;
                if (currPos - prevPos != BOARD_WIDTH) return false;
            }
        }

        return true;
    }

    function _absDiff(uint8 a, uint8 b) internal pure returns (uint8) {
        return a > b ? a - b : b - a;
    }

    function _sortPositions(uint8[] memory arr) internal pure {
        uint256 n = arr.length;
        for (uint256 i = 0; i < n - 1; i++) {
            for (uint256 j = 0; j < n - i - 1; j++) {
                if (arr[j] > arr[j + 1]) {
                    uint8 temp = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = temp;
                }
            }
        }
    }

    // ============ Gameplay Functions ============

    /**
     * @dev Fire a shot at the opponent's board
     * The result (hit/miss) is immediately revealed to the shooter
     * @param targetCell The cell to fire at (0-99)
     */
    function fireShot(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 targetCell
    ) external nonReentrant {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(matchData.status == MatchStatus.InProgress, "Match not active");
        require(matchData.phase == MatchPhase.InProgress, "Not in gameplay phase");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(msg.sender == matchData.currentTurn, "Not your turn");
        require(targetCell < BOARD_SIZE, "Invalid cell");

        PlayerBoard storage opponentBoard = (msg.sender == matchData.player1)
            ? matchData.player2Board
            : matchData.player1Board;

        require(!opponentBoard.shotsReceived[targetCell], "Cell already shot");

        // Mark cell as shot
        opponentBoard.shotsReceived[targetCell] = true;

        // Determine hit or miss and update cell state
        bool isHit = (opponentBoard.cells[targetCell] == CellState.Ship);

        if (isHit) {
            opponentBoard.cells[targetCell] = CellState.Hit;
            opponentBoard.shipsRemaining--;

            emit ShotFired(matchId, msg.sender, targetCell, true);

            // Check for win
            if (opponentBoard.shipsRemaining == 0) {
                address loser = (msg.sender == matchData.player1) ? matchData.player2 : matchData.player1;
                emit AllShipsSunk(matchId, msg.sender, loser);
                _completeMatch(tierId, instanceId, roundNumber, matchNumber, msg.sender, false);
                return;
            }
        } else {
            opponentBoard.cells[targetCell] = CellState.Miss;
            emit ShotFired(matchId, msg.sender, targetCell, false);
        }

        // Update game state
        matchData.lastMoveTime = block.timestamp;
        matchData.currentTurn = (matchData.currentTurn == matchData.player1)
            ? matchData.player2
            : matchData.player1;

        _initializeMatchTimeoutState(matchId, tierId);
    }

    // ============ View Functions (Access Controlled) ============

    /**
     * @dev Get your own board (full visibility)
     * Only the board owner can see their complete board with ship positions
     */
    function getMyBoard(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (CellState[100] memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");

        PlayerBoard storage myBoard = (msg.sender == matchData.player1)
            ? matchData.player1Board
            : matchData.player2Board;

        return myBoard.cells;
    }

    /**
     * @dev Get opponent's board with fog of war
     * Only cells that have been shot at are revealed (Hit/Miss)
     * Unshot cells appear as Empty (hiding ship locations)
     */
    function getOpponentBoard(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (CellState[100] memory fogBoard) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");

        PlayerBoard storage opponentBoard = (msg.sender == matchData.player1)
            ? matchData.player2Board
            : matchData.player1Board;

        // Apply fog of war - only show cells that have been shot at
        for (uint8 i = 0; i < BOARD_SIZE; i++) {
            if (opponentBoard.shotsReceived[i]) {
                fogBoard[i] = opponentBoard.cells[i];
            } else {
                fogBoard[i] = CellState.Empty;
            }
        }

        return fogBoard;
    }

    /**
     * @dev Query a single cell on opponent's board
     * Requires having shot that cell first
     */
    function queryOpponentCell(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 cellIndex
    ) external view returns (CellState) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "Not a player");
        require(cellIndex < BOARD_SIZE, "Invalid cell");

        PlayerBoard storage opponentBoard = (msg.sender == matchData.player1)
            ? matchData.player2Board
            : matchData.player1Board;

        require(opponentBoard.shotsReceived[cellIndex], "Must shoot cell first to see result");

        return opponentBoard.cells[cellIndex];
    }

    /**
     * @dev Get match state (public info)
     */
    function getMatchState(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) external view returns (
        address player1,
        address player2,
        address currentTurn,
        address winner,
        MatchStatus status,
        MatchPhase phase,
        bool player1Committed,
        bool player2Committed,
        bool player1Revealed,
        bool player2Revealed,
        uint8 player1ShipsRemaining,
        uint8 player2ShipsRemaining
    ) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        return (
            matchData.player1,
            matchData.player2,
            matchData.currentTurn,
            matchData.winner,
            matchData.status,
            matchData.phase,
            matchData.player1Board.hasCommitted,
            matchData.player2Board.hasCommitted,
            matchData.player1Board.hasRevealed,
            matchData.player2Board.hasRevealed,
            matchData.player1Board.shipsRemaining,
            matchData.player2Board.shipsRemaining
        );
    }

    /**
     * @dev Get which cells have been shot at for a player's board
     */
    function getShotsReceivedBy(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        address player
    ) external view returns (bool[100] memory) {
        bytes32 matchId = _getMatchId(tierId, instanceId, roundNumber, matchNumber);
        BattleshipMatch storage matchData = _battleshipMatches[matchId];

        require(player == matchData.player1 || player == matchData.player2, "Invalid player");

        PlayerBoard storage board = (player == matchData.player1)
            ? matchData.player1Board
            : matchData.player2Board;

        return board.shotsReceived;
    }

    function getCachedMatchByIndex(uint16 index) external view returns (CachedBattleshipMatch memory) {
        require(index < MATCH_CACHE_SIZE, "Index out of bounds");
        require(matchCache[index].exists, "No match at this index");
        return matchCache[index];
    }

    function getRecentCachedMatches(uint16 count) external view returns (CachedBattleshipMatch[] memory recentMatches) {
        if (count > MATCH_CACHE_SIZE) {
            count = MATCH_CACHE_SIZE;
        }

        recentMatches = new CachedBattleshipMatch[](count);
        uint16 currentIndex = nextCacheIndex;

        for (uint16 i = 0; i < count; i++) {
            if (currentIndex == 0) {
                currentIndex = MATCH_CACHE_SIZE - 1;
            } else {
                currentIndex--;
            }

            if (matchCache[currentIndex].exists) {
                recentMatches[i] = matchCache[currentIndex];
            }
        }

        return recentMatches;
    }

    /**
     * @dev Find a player's current active match info
     * Returns all coordinates and state needed to participate in the match
     * This scans through tiers/instances to find where the player has an active match
     */
    function findPlayerMatch(address player) external view returns (
        bool found,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber,
        MatchPhase phase,
        address opponent,
        bool isPlayerTurn,
        bool playerHasCommitted,
        bool playerHasRevealed,
        bool opponentHasCommitted,
        bool opponentHasRevealed
    ) {
        // Iterate through all tiers and instances to find player's active match
        for (uint8 t = 0; t < tierCount; t++) {
            TierConfig storage config = _tierConfigs[t];
            if (!config.initialized) continue;

            for (uint8 i = 0; i < config.instanceCount; i++) {
                // Check if player is enrolled in this tournament
                if (!isEnrolled[t][i][player]) continue;

                TournamentInstance storage tournament = tournaments[t][i];
                if (tournament.status != TournamentStatus.InProgress) continue;

                // Scan rounds to find player's match
                for (uint8 r = 0; r <= tournament.currentRound; r++) {
                    Round storage round = rounds[t][i][r];
                    if (!round.initialized) continue;

                    for (uint8 m = 0; m < round.totalMatches; m++) {
                        bytes32 matchId = _getMatchId(t, i, r, m);
                        BattleshipMatch storage matchData = _battleshipMatches[matchId];

                        // Check if player is in this match and match is active
                        if (matchData.status != MatchStatus.InProgress) continue;
                        if (matchData.player1 != player && matchData.player2 != player) continue;

                        // Found the player's active match
                        bool isPlayer1 = (matchData.player1 == player);
                        PlayerBoard storage playerBoard = isPlayer1 ? matchData.player1Board : matchData.player2Board;
                        PlayerBoard storage opponentBoard = isPlayer1 ? matchData.player2Board : matchData.player1Board;

                        return (
                            true,
                            t,
                            i,
                            r,
                            m,
                            matchData.phase,
                            isPlayer1 ? matchData.player2 : matchData.player1,
                            matchData.currentTurn == player,
                            playerBoard.hasCommitted,
                            playerBoard.hasRevealed,
                            opponentBoard.hasCommitted,
                            opponentBoard.hasRevealed
                        );
                    }
                }
            }
        }

        // No active match found
        return (false, 0, 0, 0, 0, MatchPhase.NotStarted, address(0), false, false, false, false, false);
    }

    /**
     * @dev Get match coordinates from a matchId (if stored)
     * Only works for matches created via _createMatchGame (round 0)
     * For subsequent rounds, use findPlayerMatch instead
     */
    function getMatchCoordinates(bytes32 matchId) external view returns (
        bool exists,
        uint8 tierId,
        uint8 instanceId,
        uint8 roundNumber,
        uint8 matchNumber
    ) {
        MatchCoordinates storage coords = matchCoordinates[matchId];
        return (coords.exists, coords.tierId, coords.instanceId, coords.roundNumber, coords.matchNumber);
    }

    /**
     * @dev Override RW3 declaration
     */
    function declareRW3() public view override returns (string memory) {
        return string(abi.encodePacked(
            "=== RW3 COMPLIANCE DECLARATION ===\n\n",
            "PROJECT: EternalBattleship (ETour Implementation)\n",
            "VERSION: 3.0 (Commit-Reveal with Wallet Signatures)\n",
            "NETWORK: Arbitrum One\n\n",
            "RULE 1 - REAL UTILITY:\n",
            "Battleship with cryptographic hidden information.\n\n",
            "RULE 2 - FULLY ON-CHAIN:\n",
            "Commit-reveal scheme with wallet signature verification.\n",
            "No client-side secret storage required - regenerate from wallet.\n\n",
            "RULE 3 - SELF-SUSTAINING:\n",
            "Protocol fee structure covers operational costs.\n\n",
            "RULE 4 - FAIR DISTRIBUTION:\n",
            "No pre-mine. All ETH from player entry fees.\n\n",
            "RULE 5 - NO ALTCOINS:\n",
            "Uses only ETH.\n\n",
            "Generated: Block ",
            Strings.toString(block.number)
        ));
    }
}
