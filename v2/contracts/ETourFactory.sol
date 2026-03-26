// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ETourInstance_Base.sol";
import "./interfaces/IPlayerRegistry.sol";

/**
 * @title ETourFactory
 * @dev Base factory contract for ETour tournament instances.
 *
 * Responsibilities:
 * - Deploys new tournament instance clones via EIP-1167 minimal proxy pattern
 * - Manages demand-driven tier registry (tiers created on first use)
 * - Tracks all instance addresses per tier
 * - Accumulates owner share from child instances (sent at tournament conclusion)
 * - Delegates player profile management to PlayerRegistry
 *
 * Each game type deploys its own factory inheriting this contract.
 *
 * TIER SYSTEM:
 * A "tier" is a unique (playerCount, entryFee) pair. No predefined list —
 * tiers are registered lazily when the first instance with a new config is created.
 *
 * GUARDRAILS:
 * - playerCount: must be power of 2, in [2, 32]
 * - entryFee: must be a multiple of 0.001 ETH, in [0.001 ETH, maxEntryFee]
 *
 * FEE MODEL (deferred):
 * All fee buckets (90% prize, 7.5% owner, 2.5% protocol raffle) stay on the instance
 * until tournament conclusion. The owner share is forwarded here at conclusion time
 * via receiveOwnerShare(). The protocol share is raffled among players on the instance.
 * This ensures 100% refund on EL1/EL2 (tournaments that never ran).
 */
contract ETourFactory is ReentrancyGuard {

    // ============ Errors ============

    error InvalidPlayerCount();
    error InvalidEntryFee();
    error InvalidTimeoutConfig();
    error Unauthorized();
    error TransferFailed();

    // ============ Structs ============

    struct TierConfig {
        uint8 playerCount;
        uint256 entryFee;
        ETourInstance_Base.TimeoutConfig timeouts;
        uint8 totalRounds;      // log2(playerCount)
        bytes32 tierKey;
    }

    // ============ Constants ============

    uint256 public constant MIN_ENTRY_FEE = 0.001 ether;
    uint256 public constant FEE_INCREMENT = 0.001 ether;
    uint256 public constant BASIS_POINTS = 10000;

    // Escalation delay constants (not user-configurable)
    uint256 public constant MATCH_LEVEL_2_DELAY = 2 minutes;      // ML2: 2 mins after ML1
    uint256 public constant MATCH_LEVEL_3_DELAY = 3 minutes;      // ML3: 3 mins after ML2 (5 mins total)
    uint256 public constant ENROLLMENT_LEVEL_2_DELAY = 2 minutes; // EL2: 2 mins after EL1

    // ============ State ============

    address public owner;
    address public immutable implementation;  // EIP-1167 clone target
    address public immutable PLAYER_REGISTRY;

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

    // Instance tracking (global list for this factory)
    address[] public instances;

    // Player profile tracking: player wallet → profile contract address
    // Populated on first enrollment; mirrors PlayerRegistry.profiles for quick lookup.
    mapping(address => address) public players;

    // Tournament lifecycle tracking
    address[] public activeTournaments;   // instances not yet concluded
    address[] public pastTournaments;     // concluded instances
    mapping(address => uint256) private _activeTournamentIndex; // instance → index+1 (0 = not tracked)

    // Owner share accumulation (received from instances at conclusion)
    uint256 public ownerBalance;

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
    event OwnerWithdrawn(address indexed to, uint256 amount);

    // ============ Constructor ============

    constructor(
        address _implementation,
        address _moduleCore,
        address _moduleMatches,
        address _modulePrizes,
        address _moduleEscalation,
        address _playerRegistry
    ) {
        owner = msg.sender;
        implementation = _implementation;
        MODULE_CORE = _moduleCore;
        MODULE_MATCHES = _moduleMatches;
        MODULE_PRIZES = _modulePrizes;
        MODULE_ESCALATION = _moduleEscalation;
        PLAYER_REGISTRY = _playerRegistry;
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
     * @param playerCount Must be power of 2 in [2, 32]
     * @param entryFee Must be multiple of 0.001 ETH in [0.001 ETH, maxEntryFee]
     * @param enrollmentWindow Must be 2, 5, 10, or 30 minutes
     * @param matchTimePerPlayer Must be 2, 5, 10, or 15 minutes
     * @param timeIncrementPerMove Must be 15 or 30 seconds
     * @return instance Address of the newly deployed instance clone
     */
    function createInstance(
        uint8 playerCount,
        uint256 entryFee,
        uint256 enrollmentWindow,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove
    ) external payable virtual returns (address instance) {
        require(msg.value == entryFee, "Must send exact entry fee to auto-enroll");
        _validatePlayerCount(playerCount);
        _validateEntryFee(entryFee);
        _validateUserTimeouts(enrollmentWindow, matchTimePerPlayer, timeIncrementPerMove);

        // Construct full TimeoutConfig with hardcoded escalation delays
        ETourInstance_Base.TimeoutConfig memory timeouts = ETourInstance_Base.TimeoutConfig({
            matchTimePerPlayer: matchTimePerPlayer,
            timeIncrementPerMove: timeIncrementPerMove,
            matchLevel2Delay: MATCH_LEVEL_2_DELAY,
            matchLevel3Delay: MATCH_LEVEL_3_DELAY,
            enrollmentWindow: enrollmentWindow,
            enrollmentLevel2Delay: ENROLLMENT_LEVEL_2_DELAY
        });

        bytes32 tierKey = _computeTierKey(playerCount, entryFee);
        if (!_tierExists(tierKey)) {
            _registerTier(tierKey, playerCount, entryFee, timeouts);
        }

        TierConfig storage config = tierRegistry[tierKey];

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
        activeTournaments.push(instance);
        _activeTournamentIndex[instance] = activeTournaments.length; // store index+1

        emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);

        // Auto-enroll the creator on their behalf
        ETourInstance_Base(instance).enrollOnBehalf{value: entryFee}(msg.sender);
    }

    // ============ Player Registration (called by instances on enrollment) ============

    /**
     * @dev Register a player's participation in an instance.
     * Called by each instance during enrollment (best-effort, does not revert).
     * Delegates to PlayerRegistry to create/update the player's profile.
     */
    function registerPlayer(address player, uint256 entryFee) external {
        // Delegate to PlayerRegistry (best-effort — failure must not block enrollment)
        (bool ok, ) = PLAYER_REGISTRY.call(
            abi.encodeWithSignature(
                "recordEnrollment(address,address,uint8,uint256)",
                player, msg.sender, _gameType(), entryFee
            )
        );
        ok; // intentionally ignore

        // Mirror the profile address locally (first enrollment creates the profile)
        if (players[player] == address(0)) {
            (bool pOk, bytes memory pRet) = PLAYER_REGISTRY.staticcall(
                abi.encodeWithSignature("getProfile(address)", player)
            );
            if (pOk && pRet.length >= 32) {
                address profile = abi.decode(pRet, (address));
                if (profile != address(0)) players[player] = profile;
            }
        }

        emit PlayerRegistered(player, msg.sender);
    }

    // ============ Fee Receiver (called by instances at conclusion) ============

    /**
     * @dev Receive owner share from an instance at tournament conclusion.
     * Called by instances unconditionally (even when ownerShare == 0 on EL1/EL2).
     * Also moves the instance from activeTournaments → pastTournaments.
     */
    function receiveOwnerShare() external payable {
        ownerBalance += msg.value;
        emit OwnerShareReceived(msg.sender, msg.value);

        // Swap-and-pop: move msg.sender from activeTournaments → pastTournaments
        uint256 idx1 = _activeTournamentIndex[msg.sender]; // index+1
        if (idx1 > 0) {
            uint256 idx = idx1 - 1;
            uint256 last = activeTournaments.length - 1;
            if (idx != last) {
                address tail = activeTournaments[last];
                activeTournaments[idx] = tail;
                _activeTournamentIndex[tail] = idx1; // update tail's stored index
            }
            activeTournaments.pop();
            _activeTournamentIndex[msg.sender] = 0;
            pastTournaments.push(msg.sender);
        }
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

    // ============ View Functions ============

    function getPlayerProfile(address player) external view returns (address) {
        // Use local mirror first (cheaper); fall back to registry for edge cases
        address local = players[player];
        if (local != address(0)) return local;
        (bool ok, bytes memory ret) = PLAYER_REGISTRY.staticcall(
            abi.encodeWithSignature("getProfile(address)", player)
        );
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    function getActiveTournamentCount() external view returns (uint256) {
        return activeTournaments.length;
    }

    function getPastTournamentCount() external view returns (uint256) {
        return pastTournaments.length;
    }

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

    // ============ Internal: Game Type ============

    /**
     * @dev Returns the game type identifier for this factory.
     * Overridden by child factories.
     */
    function _gameType() internal view virtual returns (uint8) {
        return 0;
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
        ETourInstance_Base.TimeoutConfig memory timeouts
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
        // Must be power of 2 in [2, 32]
        if (playerCount < 2 || playerCount > 32) revert InvalidPlayerCount();
        if ((playerCount & (playerCount - 1)) != 0) revert InvalidPlayerCount();
    }

    function _validateEntryFee(uint256 entryFee) internal view {
        if (entryFee < MIN_ENTRY_FEE) revert InvalidEntryFee();
        if (entryFee > maxEntryFee) revert InvalidEntryFee();
        if (entryFee % FEE_INCREMENT != 0) revert InvalidEntryFee();
    }

    /**
     * @dev Validate user-provided timeout parameters.
     * Escalation delays are hardcoded and not validated here.
     */
    function _validateUserTimeouts(
        uint256 enrollmentWindow,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove
    ) internal pure {
        // Validate enrollment window: 2, 5, 10, or 30 minutes
        if (
            enrollmentWindow != 2 minutes &&
            enrollmentWindow != 5 minutes &&
            enrollmentWindow != 10 minutes &&
            enrollmentWindow != 30 minutes
        ) {
            revert InvalidTimeoutConfig();
        }

        // Validate time per player: 2, 5, 10, or 15 minutes
        if (
            matchTimePerPlayer != 2 minutes &&
            matchTimePerPlayer != 5 minutes &&
            matchTimePerPlayer != 10 minutes &&
            matchTimePerPlayer != 15 minutes
        ) {
            revert InvalidTimeoutConfig();
        }

        // Validate increment time: 15 or 30 seconds
        if (
            timeIncrementPerMove != 15 seconds &&
            timeIncrementPerMove != 30 seconds
        ) {
            revert InvalidTimeoutConfig();
        }
    }

    // ============ Internal: EIP-1167 Clone ============

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
        // Accept ETH sent directly (e.g. rescue fallback)
        ownerBalance += msg.value;
    }
}
