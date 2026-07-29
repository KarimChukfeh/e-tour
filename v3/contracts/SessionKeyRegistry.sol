// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPlayerRegistry} from "./interfaces/IPlayerRegistry.sol";
import {
    ISessionFactory,
    ISessionHost
} from "./interfaces/ISessionHost.sol";
import {
    ISessionKeyRegistry
} from "./interfaces/ISessionKeyRegistry.sol";

/**
 * @title SessionKeyRegistry
 * @author ETour
 * @notice Stores fixed-TTL, instance-scoped executor authorization while
 * keeping the enrolled primary wallet as the protocol identity.
 *
 * The registry has no owner and no privileged session mutation path.
 * Registration authority comes from an authorized factory-created instance;
 * refresh and revocation authority belongs only to the enrolled primary.
 */
contract SessionKeyRegistry is ISessionKeyRegistry {
    /// @notice Fixed lifetime assigned to every newly issued session.
    uint48 public constant override SESSION_TTL = 1 hours;

    /// @notice Player registry anchoring authorized factory provenance.
    address public immutable override PLAYER_REGISTRY;

    mapping(address instance => mapping(address player => Session))
        private _sessions;
    mapping(address executor => ExecutorBinding) private _executorBindings;

    error ZeroAddress();
    error ExecutorIsPrimary();
    error InvalidSessionHost();
    error PlayerNotEnrolled();
    error InstanceConcluded();
    error SessionAlreadyActive();
    error ExecutorAlreadyBound(address instance, address player);
    error SameExecutor();
    error NoSession();

    /**
     * @notice Initializes the session key registry constructor.
     * @param playerRegistry The player registry address.
     */
    // solhint-disable-next-line func-visibility
    constructor(address playerRegistry) {
        if (playerRegistry == address(0)) revert ZeroAddress();
        PLAYER_REGISTRY = playerRegistry;
    }

    /**
     * @notice Registers an executor in the calling instance's namespace.
     * @param player Enrolled primary wallet.
     * @param executor Temporary executor account.
     */
    function registerSession(
        address player,
        address executor
    ) external override {
        address instance = msg.sender;
        _requireCompatibleHost(instance, player, true);
        _validateExecutor(player, executor);

        Session storage current = _sessions[instance][player];
        if (_isActive(instance, player, current.executor)) {
            revert SessionAlreadyActive();
        }

        _clearBindingIfCurrent(
            current.executor,
            instance,
            player,
            current.generation
        );
        _claimExecutor(executor);

        uint64 generation = current.generation + 1;
        uint48 issuedAt = uint48(block.timestamp);
        uint48 validUntil = issuedAt + SESSION_TTL;
        current.executor = executor;
        current.issuedAt = issuedAt;
        current.validUntil = validUntil;
        current.generation = generation;
        _executorBindings[executor] = ExecutorBinding({
            instance: instance,
            player: player,
            generation: generation
        });

        emit SessionRegistered(
            instance,
            player,
            executor,
            validUntil,
            generation
        );
    }

    /**
     * @notice Replaces or issues an executor for the calling primary.
     * @param instance Tournament instance containing the primary.
     * @param newExecutor Replacement temporary executor.
     */
    function refreshSession(
        address instance,
        address newExecutor
    ) external override {
        address player = msg.sender;
        _requireCompatibleHost(instance, player, true);
        _validateExecutor(player, newExecutor);

        Session storage current = _sessions[instance][player];
        if (newExecutor == current.executor) revert SameExecutor();
        _claimExecutor(newExecutor);

        address oldExecutor = current.executor;
        _clearBindingIfCurrent(
            oldExecutor,
            instance,
            player,
            current.generation
        );

        uint64 generation = current.generation + 1;
        uint48 issuedAt = uint48(block.timestamp);
        uint48 validUntil = issuedAt + SESSION_TTL;
        current.executor = newExecutor;
        current.issuedAt = issuedAt;
        current.validUntil = validUntil;
        current.generation = generation;
        _executorBindings[newExecutor] = ExecutorBinding({
            instance: instance,
            player: player,
            generation: generation
        });

        emit SessionRefreshed(
            instance,
            player,
            oldExecutor,
            newExecutor,
            validUntil,
            generation
        );
    }

    /**
     * @notice Revokes the calling primary's current session.
     * @dev Remains available after tournament conclusion so a primary can
     * explicitly clean up a reverse binding. Refresh does not.
     * @param instance Tournament instance containing the primary.
     */
    function revokeSession(address instance) external override {
        address player = msg.sender;
        _requireCompatibleHost(instance, player, false);

        Session storage current = _sessions[instance][player];
        address executor = current.executor;
        if (executor == address(0)) revert NoSession();

        _clearBindingIfCurrent(
            executor,
            instance,
            player,
            current.generation
        );
        uint64 generation = current.generation + 1;
        current.executor = address(0);
        current.issuedAt = 0;
        current.validUntil = 0;
        current.generation = generation;

        emit SessionRevoked(instance, player, executor, generation);
    }

    /// @inheritdoc ISessionKeyRegistry
    function getSession(
        address instance,
        address player
    ) external view override returns (Session memory) {
        return _sessions[instance][player];
    }

    /// @inheritdoc ISessionKeyRegistry
    function getExecutorBinding(
        address executor
    ) external view override returns (ExecutorBinding memory) {
        return _executorBindings[executor];
    }

    /// @inheritdoc ISessionKeyRegistry
    function resolveSession(
        address instance,
        address executor
    )
        external
        view
        override
        returns (address player, uint48 validUntil, uint64 generation)
    {
        ExecutorBinding storage binding = _executorBindings[executor];
        if (binding.instance != instance) return (address(0), 0, 0);
        player = binding.player;
        Session storage session = _sessions[instance][player];
        if (
            session.executor != executor ||
            session.generation != binding.generation ||
            !_isActive(instance, player, executor)
        ) {
            return (address(0), 0, 0);
        }
        return (player, session.validUntil, session.generation);
    }

    /// @inheritdoc ISessionKeyRegistry
    function isSessionActive(
        address instance,
        address player,
        address executor
    ) external view override returns (bool) {
        return _isActive(instance, player, executor);
    }

    function _validateExecutor(
        address player,
        address executor
    ) private pure {
        if (player == address(0) || executor == address(0)) {
            revert ZeroAddress();
        }
        if (executor == player) revert ExecutorIsPrimary();
    }

    function _requireCompatibleHost(
        address instance,
        address player,
        bool requireActive
    ) private view {
        if (instance == address(0) || player == address(0)) {
            revert ZeroAddress();
        }

        ISessionHost host = ISessionHost(instance);
        _requireAuthorizedFactory(instance, host);
        try host.SESSION_REGISTRY() returns (address value) {
            if (value != address(this)) revert InvalidSessionHost();
        } catch {
            revert InvalidSessionHost();
        }
        try host.isEnrolled(player) returns (bool value) {
            if (!value) revert PlayerNotEnrolled();
        } catch {
            revert InvalidSessionHost();
        }
        if (requireActive && _hostIsConcluded(instance)) {
            revert InstanceConcluded();
        }
    }

    function _requireAuthorizedFactory(
        address instance,
        ISessionHost host
    ) private view {
        address factoryAddress;
        try host.factory() returns (address value) {
            factoryAddress = value;
        } catch {
            revert InvalidSessionHost();
        }
        if (factoryAddress == address(0)) revert InvalidSessionHost();

        ISessionFactory factory = ISessionFactory(factoryAddress);
        try factory.PLAYER_REGISTRY() returns (address value) {
            if (value != PLAYER_REGISTRY) revert InvalidSessionHost();
        } catch {
            revert InvalidSessionHost();
        }
        try factory.SESSION_REGISTRY() returns (address value) {
            if (value != address(this)) revert InvalidSessionHost();
        } catch {
            revert InvalidSessionHost();
        }
        try factory.isInstance(instance) returns (bool value) {
            if (!value) revert InvalidSessionHost();
        } catch {
            revert InvalidSessionHost();
        }
        if (
            !IPlayerRegistry(PLAYER_REGISTRY).authorizedFactories(
                factoryAddress
            )
        ) {
            revert InvalidSessionHost();
        }
    }

    function _claimExecutor(address executor) private {
        ExecutorBinding storage binding = _executorBindings[executor];
        if (binding.player == address(0)) return;
        if (_bindingIsLive(binding, executor)) {
            revert ExecutorAlreadyBound(binding.instance, binding.player);
        }
        delete _executorBindings[executor];
    }

    function _clearBindingIfCurrent(
        address executor,
        address instance,
        address player,
        uint64 generation
    ) private {
        if (executor == address(0)) return;
        ExecutorBinding storage binding = _executorBindings[executor];
        if (
            binding.instance == instance &&
            binding.player == player &&
            binding.generation == generation
        ) {
            delete _executorBindings[executor];
        }
    }

    function _bindingIsLive(
        ExecutorBinding storage binding,
        address executor
    ) private view returns (bool) {
        return _isActive(binding.instance, binding.player, executor);
    }

    function _isActive(
        address instance,
        address player,
        address executor
    ) private view returns (bool) {
        if (
            instance == address(0) ||
            player == address(0) ||
            executor == address(0)
        ) {
            return false;
        }
        Session storage session = _sessions[instance][player];
        if (
            session.executor != executor ||
            !(block.timestamp < session.validUntil)
        ) {
            return false;
        }
        ExecutorBinding storage binding = _executorBindings[executor];
        if (
            binding.instance != instance ||
            binding.player != player ||
            binding.generation != session.generation
        ) {
            return false;
        }
        return !_hostIsConcluded(instance);
    }

    function _hostIsConcluded(address instance) private view returns (bool) {
        try ISessionHost(instance).isConcluded() returns (bool value) {
            return value;
        } catch {
            return true;
        }
    }
}
