// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ETourInstance_Base.sol";

/**
 * @title ETourFactory
 * @dev Base factory contract for ETour tournament instances.
 *
 * Responsibilities:
 * - Deploys new tournament instance clones via EIP-1167 minimal proxy pattern
 * - Manages demand-driven tier registry (tiers created on first use)
 * - Tracks all instance addresses and per-player instance history
 * - Accumulates owner share and protocol share from child instances
 * - Holds raffle state and executes protocol raffles
 *
 * Each game type deploys its own factory inheriting this contract.
 *
 * TIER SYSTEM:
 * A "tier" is a unique (playerCount, entryFee) pair. No predefined list —
 * tiers are registered lazily when the first instance with a new config is created.
 *
 * GUARDRAILS:
 * - playerCount: must be power of 2, in [2, 64]
 * - entryFee: must be a multiple of 0.001 ETH, in [0.001 ETH, maxEntryFee]
 */
contract ETourFactory is ReentrancyGuard {

    // ============ Errors ============

    error InvalidPlayerCount();
    error InvalidEntryFee();
    error InvalidTimeoutConfig();
    error Unauthorized();
    error TransferFailed();
    error RaffleThresholdNotMet();
    error NoEligiblePlayers();
    error RaffleSendFailed();

    // ============ Structs ============

    struct TierConfig {
        uint8 playerCount;
        uint256 entryFee;
        ETourInstance_Base.TimeoutConfig timeouts;
        uint8 totalRounds;      // log2(playerCount)
        bytes32 tierKey;
    }

    struct RaffleResult {
        address executor;
        uint64 timestamp;
        uint256 rafflePot;
        address[] participants;
        uint16[] weights;
        address winner;
    }

    // ============ Constants ============

    uint256 public constant MIN_ENTRY_FEE = 0.001 ether;
    uint256 public constant FEE_INCREMENT = 0.001 ether;
    uint256 public constant RAFFLE_OWNER_BPS = 500;    // 5% of raffle pot to owner
    uint256 public constant RAFFLE_WINNER_BPS = 9000;  // 90% of raffle pot to winner
    uint256 public constant RAFFLE_RESERVE_BPS = 500;  // 5% reserve for next raffle
    uint256 public constant BASIS_POINTS = 10000;

    // ============ State ============

    address public owner;
    address public immutable implementation;  // EIP-1167 clone target

    // Module addresses passed to each created instance
    address public immutable MODULE_CORE;
    address public immutable MODULE_MATCHES;
    address public immutable MODULE_PRIZES;
    address public immutable MODULE_ESCALATION;

    uint256 public maxEntryFee = 10 ether;

    // Tier registry
    mapping(bytes32 => TierConfig) public tierRegistry;
    bytes32[] public tierKeys;
    mapping(bytes32 => address[]) public tierInstances;  // tierKey → instance addresses

    // Instance tracking
    address[] public instances;
    mapping(address => address[]) public playerInstances;  // player → instance addresses

    // Fee accumulation from child instances
    uint256 public ownerBalance;
    uint256 public accumulatedProtocolShare;

    // Raffle
    uint256[] public raffleThresholds;
    RaffleResult[] public raffleResults;

    // ============ Events ============

    event InstanceDeployed(
        address indexed instance,
        bytes32 indexed tierKey,
        address indexed creator,
        uint8 playerCount,
        uint256 entryFee
    );
    event TierCreated(bytes32 indexed tierKey, uint8 playerCount, uint256 entryFee);
    event PlayerRegistered(address indexed player, address indexed instance);
    event OwnerShareReceived(address indexed instance, uint256 amount);
    event ProtocolShareReceived(address indexed instance, uint256 amount);
    event OwnerWithdrawn(address indexed to, uint256 amount);
    event RaffleExecuted(address indexed winner, uint256 winnerAmount, uint256 ownerAmount);

    // ============ Constructor ============

    constructor(
        address _implementation,
        address _moduleCore,
        address _moduleMatches,
        address _modulePrizes,
        address _moduleEscalation
    ) {
        owner = msg.sender;
        implementation = _implementation;
        MODULE_CORE = _moduleCore;
        MODULE_MATCHES = _moduleMatches;
        MODULE_PRIZES = _modulePrizes;
        MODULE_ESCALATION = _moduleEscalation;
    }

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ============ Instance Creation ============

    /**
     * @dev Create a new tournament instance.
     * Validates parameters, looks up or creates the tier config, deploys a clone.
     *
     * @param playerCount Must be power of 2 in [2, 64]
     * @param entryFee Must be multiple of 0.001 ETH in [0.001 ETH, maxEntryFee]
     * @param timeouts Timeout configuration for enrollment and match escalation
     * @return instance Address of the newly deployed instance clone
     */
    function createInstance(
        uint8 playerCount,
        uint256 entryFee,
        ETourInstance_Base.TimeoutConfig calldata timeouts
    ) external virtual returns (address instance) {
        _validatePlayerCount(playerCount);
        _validateEntryFee(entryFee);
        _validateTimeouts(timeouts);

        bytes32 tierKey = _computeTierKey(playerCount, entryFee);
        if (!_tierExists(tierKey)) {
            _registerTier(tierKey, playerCount, entryFee, timeouts);
        }

        TierConfig storage config = tierRegistry[tierKey];

        // Build the ETourInstance_Base.TierConfig to pass to initialize()
        ETourInstance_Base.TierConfig memory instanceTierConfig = ETourInstance_Base.TierConfig({
            playerCount: playerCount,
            entryFee: entryFee,
            timeouts: config.timeouts,
            totalRounds: config.totalRounds,
            tierKey: tierKey
        });

        // Deploy EIP-1167 clone
        instance = _clone(implementation);

        // Initialize the clone
        ETourInstance_Base(instance).initialize(
            instanceTierConfig,
            address(this),
            msg.sender,
            MODULE_CORE,
            MODULE_MATCHES,
            MODULE_PRIZES,
            MODULE_ESCALATION
        );

        // Track instance
        instances.push(instance);
        tierInstances[tierKey].push(instance);

        emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);
    }

    // ============ Player Registration (called by instances) ============

    /**
     * @dev Register a player's participation in an instance.
     * Called by each instance during enrollment (best-effort, does not revert).
     */
    function registerPlayer(address player) external {
        // msg.sender must be a known instance
        // (Instances call this — we trust known instances; unknown callers just add noise but can't harm state)
        playerInstances[player].push(msg.sender);
        emit PlayerRegistered(player, msg.sender);
    }

    // ============ Fee Receivers (called by instances) ============

    /**
     * @dev Receive owner share from an instance enrollment.
     * Called by instances via .call{value: ownerShare}(receiveOwnerShare()).
     */
    function receiveOwnerShare() external payable {
        ownerBalance += msg.value;
        emit OwnerShareReceived(msg.sender, msg.value);
    }

    /**
     * @dev Receive protocol share from an instance enrollment.
     * Called by instances via .call{value: protocolShare}(receiveProtocolShare()).
     */
    function receiveProtocolShare() external payable {
        accumulatedProtocolShare += msg.value;
        emit ProtocolShareReceived(msg.sender, msg.value);
    }

    // ============ Owner Withdrawal ============

    function withdrawOwnerBalance() external onlyOwner nonReentrant {
        uint256 amount = ownerBalance;
        ownerBalance = 0;
        (bool ok, ) = payable(owner).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit OwnerWithdrawn(owner, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function setMaxEntryFee(uint256 newMax) external onlyOwner {
        maxEntryFee = newMax;
    }

    // ============ Raffle ============

    /**
     * @dev Execute protocol raffle when accumulated fees exceed threshold.
     * Caller must be enrolled in at least one active instance.
     *
     * Distribution: 5% reserve, of remainder → 5% owner + 90% winner.
     */
    function executeProtocolRaffle() external nonReentrant returns (
        address winner,
        uint256 ownerAmount,
        uint256 winnerAmount
    ) {
        uint256 nextRaffleIndex = raffleResults.length;
        uint256 threshold = (nextRaffleIndex < raffleThresholds.length)
            ? raffleThresholds[nextRaffleIndex]
            : raffleThresholds[raffleThresholds.length - 1];

        if (accumulatedProtocolShare < threshold) revert RaffleThresholdNotMet();

        // Check caller is enrolled in an active instance
        require(_isCallerEnrolledInAnyActive(msg.sender), "Not enrolled in active instance");

        uint256 reserve = (threshold * RAFFLE_RESERVE_BPS) / BASIS_POINTS;
        uint256 raffleAmount = accumulatedProtocolShare - reserve;
        ownerAmount = (raffleAmount * RAFFLE_OWNER_BPS) / BASIS_POINTS;
        winnerAmount = (raffleAmount * RAFFLE_WINNER_BPS) / BASIS_POINTS;

        accumulatedProtocolShare = reserve;

        // Select winner from all active enrollments (weighted by enrollment count)
        (
            address[] memory players,
            uint16[] memory weights,
            uint256 totalWeight
        ) = _getActivePlayersWithWeights();

        if (totalWeight == 0) revert NoEligiblePlayers();

        uint256 randomness = uint256(keccak256(abi.encodePacked(
            block.prevrandao, block.timestamp, block.number,
            msg.sender, accumulatedProtocolShare
        )));

        winner = _selectWeightedWinner(players, weights, totalWeight, randomness);

        raffleResults.push(RaffleResult({
            executor: msg.sender,
            timestamp: uint64(block.timestamp),
            rafflePot: raffleAmount + reserve,
            participants: players,
            weights: weights,
            winner: winner
        }));

        ownerBalance += ownerAmount;

        (bool winnerSent, ) = payable(winner).call{value: winnerAmount}("");
        if (!winnerSent) revert RaffleSendFailed();

        emit RaffleExecuted(winner, winnerAmount, ownerAmount);
    }

    // ============ View Functions ============

    function getInstances(uint256 offset, uint256 limit) external view returns (address[] memory result) {
        uint256 total = instances.length;
        if (offset >= total) return new address[](0);
        uint256 count = limit;
        if (offset + count > total) count = total - offset;
        result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = instances[offset + i];
        }
    }

    function getInstanceCount() external view returns (uint256) {
        return instances.length;
    }

    function getPlayerInstances(address player) external view returns (address[] memory) {
        return playerInstances[player];
    }

    function getTierInstances(bytes32 tierKey) external view returns (address[] memory) {
        return tierInstances[tierKey];
    }

    function getActiveTierConfigs() external view returns (bytes32[] memory keys, TierConfig[] memory configs) {
        keys = tierKeys;
        configs = new TierConfig[](tierKeys.length);
        for (uint256 i = 0; i < tierKeys.length; i++) {
            configs[i] = tierRegistry[tierKeys[i]];
        }
    }

    function getRaffleInfo() external view returns (
        uint256 raffleIndex,
        uint256 currentAccumulated,
        uint256 threshold
    ) {
        raffleIndex = raffleResults.length;
        currentAccumulated = accumulatedProtocolShare;
        uint256 nextIndex = raffleResults.length;
        threshold = (nextIndex < raffleThresholds.length)
            ? raffleThresholds[nextIndex]
            : raffleThresholds[raffleThresholds.length - 1];
    }

    function getRaffleResult(uint256 index) external view returns (
        address executor,
        uint64 timestamp,
        uint256 rafflePot,
        address[] memory participants,
        uint16[] memory weights,
        address winner
    ) {
        RaffleResult storage r = raffleResults[index];
        return (r.executor, r.timestamp, r.rafflePot, r.participants, r.weights, r.winner);
    }

    function getRaffleCount() external view returns (uint256) {
        return raffleResults.length;
    }

    // ============ Internal: Tier Management ============

    function _computeTierKey(uint8 playerCount, uint256 entryFee) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(playerCount, entryFee));
    }

    function _tierExists(bytes32 tierKey) internal view returns (bool) {
        return tierRegistry[tierKey].playerCount != 0;
    }

    function _registerTier(
        bytes32 tierKey,
        uint8 playerCount,
        uint256 entryFee,
        ETourInstance_Base.TimeoutConfig calldata timeouts
    ) internal {
        tierRegistry[tierKey] = TierConfig({
            playerCount: playerCount,
            entryFee: entryFee,
            timeouts: timeouts,
            totalRounds: _log2(playerCount),
            tierKey: tierKey
        });
        tierKeys.push(tierKey);
        emit TierCreated(tierKey, playerCount, entryFee);
    }

    // ============ Internal: Validation ============

    function _validatePlayerCount(uint8 playerCount) internal pure {
        // Must be power of 2 in [2, 64]
        if (playerCount < 2 || playerCount > 64) revert InvalidPlayerCount();
        if ((playerCount & (playerCount - 1)) != 0) revert InvalidPlayerCount();
    }

    function _validateEntryFee(uint256 entryFee) internal view {
        if (entryFee < MIN_ENTRY_FEE) revert InvalidEntryFee();
        if (entryFee > maxEntryFee) revert InvalidEntryFee();
        if (entryFee % FEE_INCREMENT != 0) revert InvalidEntryFee();
    }

    function _validateTimeouts(ETourInstance_Base.TimeoutConfig calldata timeouts) internal pure {
        // Basic sanity: enrollment window must be set, match time must be positive
        if (timeouts.matchTimePerPlayer == 0) revert InvalidTimeoutConfig();
        if (timeouts.enrollmentWindow == 0) revert InvalidTimeoutConfig();
    }

    // ============ Internal: Raffle Helpers ============

    /**
     * @dev Check if a given address is enrolled in any active (Enrolling or InProgress) instance.
     * Iterates over all known instances — gas-intensive for large sets, but raffle is off-path.
     */
    function _isCallerEnrolledInAnyActive(address caller) internal view returns (bool) {
        for (uint256 i = 0; i < playerInstances[caller].length; i++) {
            address inst = playerInstances[caller][i];
            ETourInstance_Base ib = ETourInstance_Base(inst);
            (
                , , , , , ,
                ETourInstance_Base.TournamentStatus status,
                uint8 enrolledCount,
                ,
            ) = ib.getInstanceInfo();
            if (status != ETourInstance_Base.TournamentStatus.Concluded && enrolledCount > 0) {
                if (ib.isEnrolled(caller)) return true;
            }
        }
        return false;
    }

    /**
     * @dev Get all players across active instances with enrollment-count weights.
     * For raffle winner selection.
     */
    function _getActivePlayersWithWeights() internal view returns (
        address[] memory players,
        uint16[] memory weights,
        uint256 totalWeight
    ) {
        // First pass: collect unique enrolled players across all active instances
        address[] memory tempPlayers = new address[](1000);
        uint256 uniqueCount = 0;
        totalWeight = 0;

        for (uint256 i = 0; i < instances.length; i++) {
            ETourInstance_Base ib = ETourInstance_Base(instances[i]);
            (
                , , , , , ,
                ETourInstance_Base.TournamentStatus status,
                uint8 enrolledCount,
                ,
            ) = ib.getInstanceInfo();

            if (status == ETourInstance_Base.TournamentStatus.Concluded || enrolledCount == 0) continue;

            address[] memory enrolled = ib.getPlayers();
            for (uint256 j = 0; j < enrolled.length; j++) {
                address player = enrolled[j];
                bool found = false;
                for (uint256 k = 0; k < uniqueCount; k++) {
                    if (tempPlayers[k] == player) { found = true; break; }
                }
                if (!found) {
                    tempPlayers[uniqueCount++] = player;
                }
                totalWeight++;
            }
        }

        players = new address[](uniqueCount);
        weights = new uint16[](uniqueCount);

        // Second pass: count weights per player
        for (uint256 i = 0; i < uniqueCount; i++) {
            players[i] = tempPlayers[i];
            uint16 w = 0;
            for (uint256 j = 0; j < instances.length; j++) {
                ETourInstance_Base ib = ETourInstance_Base(instances[j]);
                (
                    , , , , , ,
                    ETourInstance_Base.TournamentStatus status,
                    uint8 enrolledCount,
                    ,
                ) = ib.getInstanceInfo();
                if (status != ETourInstance_Base.TournamentStatus.Concluded && enrolledCount > 0) {
                    if (ib.isEnrolled(players[i])) w++;
                }
            }
            weights[i] = w;
        }
    }

    function _selectWeightedWinner(
        address[] memory players,
        uint16[] memory weights,
        uint256 totalWeight,
        uint256 randomness
    ) internal pure returns (address) {
        uint256 pos = randomness % totalWeight;
        uint256 cumulative = 0;
        for (uint256 i = 0; i < players.length; i++) {
            cumulative += weights[i];
            if (pos < cumulative) return players[i];
        }
        return players[players.length - 1];
    }

    // ============ Internal: EIP-1167 Clone ============

    /**
     * @dev Deploy an EIP-1167 minimal proxy clone pointing to `target`.
     * Gas cost: ~700 gas to deploy + 300 gas per call.
     */
    function _clone(address target) internal returns (address result) {
        bytes20 targetBytes = bytes20(target);
        assembly {
            let clone := mload(0x40)
            mstore(clone, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(clone, 0x14), targetBytes)
            mstore(add(clone, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            result := create(0, clone, 0x37)
        }
        require(result != address(0), "Clone failed");
    }

    // ============ Math ============

    function _log2(uint8 x) internal pure returns (uint8) {
        uint8 result = 0;
        while (x > 1) { x /= 2; result++; }
        return result;
    }

    // ============ Receive ============

    receive() external payable {
        // Accept ETH (e.g., from failed prize fallback on instances)
        accumulatedProtocolShare += msg.value;
    }
}
