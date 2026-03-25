// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPlayerRegistry.sol";
import "./interfaces/IPlayerProfile.sol";

/**
 * @title PlayerRegistry
 * @dev Singleton contract that manages per-player PlayerProfile clones.
 *
 * Deployed once. All game factories hold its address and call into it on
 * enrollment and tournament conclusion.
 *
 * AUTHORIZATION:
 * Only the protocol owner can authorize factories via authorizeFactory().
 * Only authorized factories (and their child instances) can write to profiles.
 *
 * Instances are trusted implicitly through their parent factory:
 * recordResult() accepts calls from any address whose parent factory is authorized.
 * The factory address is read from the instance via instance.factory().
 * If the call cannot be validated, it is silently ignored (best-effort).
 *
 * CLONE PATTERN:
 * Uses EIP-1167 minimal proxy to deploy cheap PlayerProfile clones.
 */
contract PlayerRegistry is IPlayerRegistry {

    // ============ Errors ============

    error Unauthorized();
    error ZeroAddress();
    error CloneFailed();

    // ============ Events ============

    event ProfileCreated(address indexed player, address indexed profile);
    event FactoryAuthorized(address indexed factory);
    event FactoryDeauthorized(address indexed factory);
    event EnrollmentRecorded(address indexed player, address indexed instance, uint8 gameType);
    event ResultRecorded(address indexed player, address indexed instance, bool won, uint256 prize);

    // ============ State ============

    address public owner;
    address public immutable profileImplementation;

    mapping(address => address) public profiles;          // player → profile address
    mapping(address => bool)    public authorizedFactories;

    // ============ Constructor ============

    constructor(address _profileImplementation) {
        if (_profileImplementation == address(0)) revert ZeroAddress();
        owner = msg.sender;
        profileImplementation = _profileImplementation;
    }

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ============ Owner Admin ============

    function authorizeFactory(address factory) external onlyOwner {
        if (factory == address(0)) revert ZeroAddress();
        authorizedFactories[factory] = true;
        emit FactoryAuthorized(factory);
    }

    function deauthorizeFactory(address factory) external onlyOwner {
        authorizedFactories[factory] = false;
        emit FactoryDeauthorized(factory);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ============ IPlayerRegistry — Write (authorized factories only) ============

    /**
     * @dev Record a player enrollment. Called by factory.registerPlayer().
     * Creates a PlayerProfile clone if the player doesn't have one yet.
     * Silently ignores failures to never block enrollment.
     */
    function recordEnrollment(
        address player,
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external override {
        if (!authorizedFactories[msg.sender]) revert Unauthorized();
        if (player == address(0)) return;

        address profile = _getOrCreate(player);

        // Best-effort — failure must not revert enrollment
        try IPlayerProfile(profile).recordEnrollment(instance, gameType, entryFee) {
            emit EnrollmentRecorded(player, instance, gameType);
        } catch { }
    }

    /**
     * @dev Record a tournament result for a player. Called by instance conclusion logic.
     * The calling instance's parent factory must be authorized.
     * Silently ignores failures to never block conclusion.
     */
    function recordResult(
        address player,
        address instance,
        bool won,
        uint256 prize
    ) external override {
        // Validate: msg.sender must be an instance whose factory is authorized.
        // We read factory() from the instance (the caller itself).
        // If the call fails or factory is not authorized, silently return.
        if (!_isAuthorizedInstance(msg.sender)) return;
        if (player == address(0)) return;

        address profile = profiles[player];
        if (profile == address(0)) return; // no profile — player was never enrolled properly

        try IPlayerProfile(profile).recordResult(instance, won, prize) {
            emit ResultRecorded(player, instance, won, prize);
        } catch { }
    }

    // ============ IPlayerRegistry — View ============

    function getProfile(address player) external view override returns (address) {
        return profiles[player];
    }

    // ============ Internal ============

    /**
     * @dev Get existing profile or deploy a new clone for the player.
     */
    function _getOrCreate(address player) internal returns (address profile) {
        profile = profiles[player];
        if (profile != address(0)) return profile;

        profile = _clone(profileImplementation);
        IPlayerProfile(profile).initialize(player, address(this));
        profiles[player] = profile;

        emit ProfileCreated(player, profile);
    }

    /**
     * @dev Check whether msg.sender is an instance whose parent factory is authorized.
     * Reads factory() from the calling contract. Returns false on any failure.
     */
    function _isAuthorizedInstance(address instance) internal view returns (bool) {
        (bool ok, bytes memory ret) = instance.staticcall(
            abi.encodeWithSignature("factory()")
        );
        if (!ok || ret.length < 32) return false;
        address factoryAddr = abi.decode(ret, (address));
        return authorizedFactories[factoryAddr];
    }

    /**
     * @dev Deploy an EIP-1167 minimal proxy clone of `target`.
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
        if (result == address(0)) revert CloneFailed();
    }
}
