// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ETourInstance_Base.sol";
import "./interfaces/IPlayerRegistry.sol";
import {ISessionKeyRegistry} from "./interfaces/ISessionKeyRegistry.sol";
import {ETourStorage} from "./storage/ETourStorage.sol";

/**
 * @title ETourFactory
 * @dev Base factory contract for ETour tournament instances.
 *
 * Responsibilities:
 * - Deploys new tournament instance clones via EIP-1167 minimal proxy pattern
 * - Manages demand-driven tier registry (tiers created on first use)
 * - Tracks all instance addresses per tier
 * - Receives owner share from child instances at conclusion and forwards it to the owner
 *   immediately when possible
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
 * - entryFee: must be a multiple of 0.0001 ETH, in [0.0001 ETH, maxEntryFee]
 *
 * FEE MODEL (deferred):
 * All fee buckets (95% prize, 5% owner) stay on the instance until tournament
 * conclusion. The owner share is sent here at conclusion time via
 * receiveOwnerShare(), which immediately forwards it to the owner wallet when
 * possible and falls back to ownerBalance only if that transfer fails.
 * This ensures 100% refund on EL1/EL2 (tournaments that never ran).
 */
contract ETourFactory is ReentrancyGuard {

    // ============ Errors ============

    error InvalidPlayerCount();
    error InvalidEntryFee();
    error InvalidTimeoutConfig();
    error Unauthorized();
    error TransferFailed();
    error InvalidSessionRegistry();

    // ============ Structs ============

    struct TierConfig {
        uint8 playerCount;
        uint256 entryFee;
        ETourStorage.TimeoutConfig timeouts;
        uint8 totalRounds;      // log2(playerCount)
        bytes32 tierKey;
    }

    struct InstanceInit {
        ETourStorage.TierConfig tierConfig;
        address creator;
    }

    // ============ Constants ============

    /**
     * @notice Returns min entry fee.
     */
    uint256 public constant MIN_ENTRY_FEE = 0.0001 ether;
    /**
     * @notice Returns fee increment.
     */
    uint256 public constant FEE_INCREMENT = 0.0001 ether;
    /**
     * @notice Returns basis points.
     */
    uint256 public constant BASIS_POINTS = 10000;

    // Escalation delay constants (not user-configurable)
    /**
     * @notice Returns match level 2 delay.
     */
    uint256 public constant MATCH_LEVEL_2_DELAY = 2 minutes;      // ML2: 2 mins after ML1
    /**
     * @notice Returns match level 3 delay.
     */
    uint256 public constant MATCH_LEVEL_3_DELAY = 3 minutes;      // ML3: 3 mins after ML2 (5 mins total)
    /**
     * @notice Returns enrollment level 2 delay.
     */
    uint256 public constant ENROLLMENT_LEVEL_2_DELAY = 2 minutes; // EL2: 2 mins after EL1

    // ============ State ============

    /**
     * @notice Returns owner.
     */
    address public owner;
    /**
     * @notice Returns implementation.
     */
    address public immutable implementation;  // EIP-1167 clone target
    /**
     * @notice Returns player registry.
     */
    address public immutable PLAYER_REGISTRY;
    /// @notice Shared registry used by instances for session authorization.
    address public immutable SESSION_REGISTRY;

    // Module addresses passed to each created instance
    /**
     * @notice Returns module core.
     */
    address public immutable MODULE_CORE;
    /**
     * @notice Returns module matches.
     */
    address public immutable MODULE_MATCHES;
    /**
     * @notice Returns module prizes.
     */
    address public immutable MODULE_PRIZES;
    /**
     * @notice Returns module escalation.
     */
    address public immutable MODULE_ESCALATION;

    /**
     * @notice Returns max entry fee.
     */
    uint256 public maxEntryFee = 1 ether;

    // Tier registry
    /**
     * @notice Returns tier registry.
     */
    mapping(bytes32 => TierConfig) public tierRegistry;
    /**
     * @notice Returns tier keys.
     */
    bytes32[] public tierKeys;
    /**
     * @notice Returns tier instances.
     */
    mapping(bytes32 => address[]) public tierInstances;  // tierKey → instance addresses

    // Instance tracking (global list for this factory)
    /**
     * @notice Returns instances.
     */
    address[] public instances;
    /// @notice Whether an address is a clone created by this factory.
    mapping(address => bool) public isInstance;

    // Player profile tracking for this factory's game only: player wallet → profile contract address.
    // Populated on first enrollment; mirrors PlayerRegistry.getProfile(player, gameType()) for quick lookup.
    /**
     * @notice Returns players.
     */
    mapping(address => address) public players;

    // Tournament lifecycle tracking
    /**
     * @notice Returns active tournaments.
     */
    address[] public activeTournaments;   // instances not yet concluded
    /**
     * @notice Returns past tournaments.
     */
    address[] public pastTournaments;     // concluded instances
    mapping(address => uint256) private _activeTournamentIndex; // instance → index+1 (0 = not tracked)

    // Owner-share fallback bucket. Successful conclusion payouts are forwarded
    // to owner immediately; this balance is only used for direct ETH receipts
    // or if an owner-forwarding attempt fails.
    /**
     * @notice Returns owner balance.
     */
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

    /**
     * @notice Initializes the etour factory constructor.
     * @param _implementation The implementation address.
     * @param _moduleCore The module core address.
     * @param _moduleMatches The module matches address.
     * @param _modulePrizes The module prizes address.
     * @param _moduleEscalation The module escalation address.
     * @param _playerRegistry The player registry address.
     * @param _sessionRegistry The session registry address.
     */
    constructor(
        address _implementation,
        address _moduleCore,
        address _moduleMatches,
        address _modulePrizes,
        address _moduleEscalation,
        address _playerRegistry,
        address _sessionRegistry
    ) {
        if (_sessionRegistry == address(0)) revert InvalidSessionRegistry();
        address registryPlayerRegistry;
        try
            ISessionKeyRegistry(_sessionRegistry).PLAYER_REGISTRY()
        returns (address value) {
            registryPlayerRegistry = value;
        } catch {
            revert InvalidSessionRegistry();
        }
        if (registryPlayerRegistry != _playerRegistry) {
            revert InvalidSessionRegistry();
        }
        owner = msg.sender;
        implementation = _implementation;
        MODULE_CORE = _moduleCore;
        MODULE_MATCHES = _moduleMatches;
        MODULE_PRIZES = _modulePrizes;
        MODULE_ESCALATION = _moduleEscalation;
        PLAYER_REGISTRY = _playerRegistry;
        SESSION_REGISTRY = _sessionRegistry;
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
     * @param entryFee Must be multiple of 0.0001 ETH in [0.0001 ETH, maxEntryFee]
     * @param enrollmentWindow Whole minutes in [2, 30]
     * @param matchTimePerPlayer Whole minutes in [1, 20]
     * @param timeIncrementPerMove Whole seconds in [0, 60]
     * @param sessionExecutor Optional temporary executor; zero explicitly opts out
     * @return instance Address of the newly deployed instance clone
     */
    function createInstance(
        uint8 playerCount,
        uint256 entryFee,
        uint256 enrollmentWindow,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove,
        address sessionExecutor
    ) external payable virtual returns (address instance) {
        require(msg.value == entryFee, "Must send exact entry fee to auto-enroll");
        _validatePlayerCount(playerCount);
        _validateEntryFee(entryFee);
        _validateUserTimeouts(enrollmentWindow, matchTimePerPlayer, timeIncrementPerMove);

        ETourStorage.TimeoutConfig memory timeouts = _buildTimeouts(
            enrollmentWindow,
            matchTimePerPlayer,
            timeIncrementPerMove
        );

        bytes32 tierKey = _computeTierKey(playerCount, entryFee, timeouts);
        if (!_tierExists(tierKey)) {
            _registerTier(tierKey, playerCount, entryFee, timeouts);
        }

        TierConfig storage config = tierRegistry[tierKey];

        ETourStorage.TierConfig memory instanceTierConfig = ETourStorage.TierConfig({
            playerCount: playerCount,
            entryFee: entryFee,
            timeouts: config.timeouts,
            totalRounds: config.totalRounds,
            tierKey: tierKey
        });

        instance = _deployAndInitializeInstance(
            instanceTierConfig,
            msg.sender
        );

        _trackNewInstance(instance, tierKey);

        emit InstanceDeployed(instance, tierKey, msg.sender, playerCount, entryFee);

        // Auto-enroll the creator on their behalf
        ETourInstance_Base(instance).enrollOnBehalf{value: entryFee}(
            msg.sender,
            sessionExecutor
        );
    }

    // ============ Player Registration (called by instances on enrollment) ============

    /**
     * @dev Register a player's participation in an instance.
     * Called by each instance during enrollment (best-effort, does not revert).
     * Delegates to PlayerRegistry to create/update the player's profile.
     * @param player The player address.
     * @param entryFee The entry fee value.
     */
    function registerPlayer(address player, uint256 entryFee) external {
        if (!isInstance[msg.sender]) revert Unauthorized();
        uint8 game = _gameType();

        // Delegate to PlayerRegistry (best-effort — failure must not block enrollment)
        (bool ok, ) = PLAYER_REGISTRY.call(
            abi.encodeWithSignature(
                "recordEnrollment(address,address,uint8,uint256)",
                player, msg.sender, game, entryFee
            )
        );
        ok; // intentionally ignore

        // Mirror the profile address locally (first enrollment creates the profile)
        if (players[player] == address(0)) {
            (bool pOk, bytes memory pRet) = PLAYER_REGISTRY.staticcall(
                abi.encodeWithSignature("getProfile(address,uint8)", player, game)
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
     * Attempts to forward the ETH to owner immediately. If that send fails, the
     * amount is retained in ownerBalance as a manual-withdraw fallback.
     * Also moves the instance from activeTournaments → pastTournaments.
     */
    function receiveOwnerShare() external payable nonReentrant {
        if (!isInstance[msg.sender]) revert Unauthorized();
        if (msg.value > 0) {
            (bool ok, ) = payable(owner).call{value: msg.value}("");
            if (!ok) {
                ownerBalance += msg.value;
            }
        }

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

    /**
     * @notice Withdraws owner balance.
     */
    function withdrawOwnerBalance() external onlyOwner nonReentrant {
        uint256 amount = ownerBalance;
        ownerBalance = 0;
        (bool ok, ) = payable(owner).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit OwnerWithdrawn(owner, amount);
    }

    /**
     * @notice Transfers ownership.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    /**
     * @notice Updates max entry fee.
     * @param newMax The new max value.
     */
    function setMaxEntryFee(uint256 newMax) external onlyOwner {
        maxEntryFee = newMax;
    }

    // ============ View Functions ============

    /**
     * @notice Returns player profile.
     * @param player The player address.
     * @return The requested value.
     */
    function getPlayerProfile(address player) external view returns (address) {
        // Use local mirror first (cheaper); fall back to registry for edge cases
        address local = players[player];
        if (local != address(0)) return local;
        (bool ok, bytes memory ret) = PLAYER_REGISTRY.staticcall(
            abi.encodeWithSignature("getProfile(address,uint8)", player, _gameType())
        );
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    /**
     * @notice Returns the factory game-type identifier.
     * @return The requested value.
     */
    function gameType() external view returns (uint8) {
        return _gameType();
    }

    /**
     * @notice Returns active tournament count.
     * @return The requested value.
     */
    function getActiveTournamentCount() external view returns (uint256) {
        return activeTournaments.length;
    }

    /**
     * @notice Returns past tournament count.
     * @return The requested value.
     */
    function getPastTournamentCount() external view returns (uint256) {
        return pastTournaments.length;
    }

    /**
     * @notice Returns instances.
     * @param offset The offset value.
     * @param limit The limit value.
     * @return result The result.
     */
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

    /**
     * @notice Returns instance count.
     * @return The requested value.
     */
    function getInstanceCount() external view returns (uint256) {
        return instances.length;
    }

    /**
     * @notice Returns tier instances.
     * @param tierKey The tier key data.
     * @return The requested value.
     */
    function getTierInstances(bytes32 tierKey) external view returns (address[] memory) {
        return tierInstances[tierKey];
    }

    /**
     * @notice Returns active tier configs.
     * @return keys The keys.
     * @return configs The configs.
     */
    function getActiveTierConfigs() external view returns (bytes32[] memory keys, TierConfig[] memory configs) {
        keys = tierKeys;
        configs = new TierConfig[](tierKeys.length);
        for (uint256 i = 0; i < tierKeys.length; i++) {
            configs[i] = tierRegistry[tierKeys[i]];
        }
    }

    function _trackNewInstance(address instance, bytes32 tierKey) internal {
        isInstance[instance] = true;
        instances.push(instance);
        tierInstances[tierKey].push(instance);
        activeTournaments.push(instance);
        _activeTournamentIndex[instance] = activeTournaments.length; // store index+1
    }

    // ============ Internal: Instance initialization hooks ============

    function _deployAndInitializeInstance(
        ETourStorage.TierConfig memory instanceTierConfig,
        address instanceCreator
    ) internal returns (address instance) {
        instance = _clone(implementation);
        InstanceInit memory init = InstanceInit({
            tierConfig: instanceTierConfig,
            creator: instanceCreator
        });

        // Every game uses this one creation pipeline. Game-specific setup is
        // restricted to the two internal hooks.
        _initializeInstance(instance, init);
        _postInitializeInstance(instance);
    }

    function _initializeInstance(
        address instance,
        InstanceInit memory init
    ) internal virtual {
        ETourInstance_Base(instance).initialize(
            init.tierConfig,
            address(this),
            init.creator,
            MODULE_CORE,
            MODULE_MATCHES,
            MODULE_PRIZES,
            MODULE_ESCALATION,
            SESSION_REGISTRY
        );
    }

    function _postInitializeInstance(address instance) internal virtual {
        instance;
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

    function _computeTierKey(
        uint8 playerCount,
        uint256 entryFee,
        ETourStorage.TimeoutConfig memory timeouts
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                playerCount,
                entryFee,
                timeouts.matchTimePerPlayer,
                timeouts.timeIncrementPerMove,
                timeouts.matchLevel2Delay,
                timeouts.matchLevel3Delay,
                timeouts.enrollmentWindow,
                timeouts.enrollmentLevel2Delay
            )
        );
    }

    function _tierExists(bytes32 tierKey) internal view returns (bool) {
        return tierRegistry[tierKey].playerCount != 0;
    }

    function _registerTier(
        bytes32 tierKey,
        uint8 playerCount,
        uint256 entryFee,
        ETourStorage.TimeoutConfig memory timeouts
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

    function _buildTimeouts(
        uint256 enrollmentWindow,
        uint256 matchTimePerPlayer,
        uint256 timeIncrementPerMove
    ) internal pure returns (ETourStorage.TimeoutConfig memory) {
        return ETourStorage.TimeoutConfig({
            matchTimePerPlayer: matchTimePerPlayer,
            timeIncrementPerMove: timeIncrementPerMove,
            matchLevel2Delay: MATCH_LEVEL_2_DELAY,
            matchLevel3Delay: MATCH_LEVEL_3_DELAY,
            enrollmentWindow: enrollmentWindow,
            enrollmentLevel2Delay: ENROLLMENT_LEVEL_2_DELAY
        });
    }

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
        // Validate enrollment window: whole minutes in [2, 30]
        if (
            enrollmentWindow < 2 minutes ||
            enrollmentWindow > 30 minutes ||
            enrollmentWindow % 1 minutes != 0
        ) {
            revert InvalidTimeoutConfig();
        }

        // Validate time per player: whole minutes in [1, 20]
        if (
            matchTimePerPlayer < 1 minutes ||
            matchTimePerPlayer > 20 minutes ||
            matchTimePerPlayer % 1 minutes != 0
        ) {
            revert InvalidTimeoutConfig();
        }

        // Validate increment time: whole seconds in [0, 60]
        if (timeIncrementPerMove > 60 seconds) {
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

    /**
     * @notice Accepts native ETH sent directly to this contract.
     */
    receive() external payable {
        // Accept ETH sent directly (e.g. rescue fallback) into the manual
        // withdrawal bucket.
        ownerBalance += msg.value;
    }
}
