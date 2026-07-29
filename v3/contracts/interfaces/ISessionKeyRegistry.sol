// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISessionKeyRegistry
 * @author ETour
 * @notice Instance-scoped session authorization and primary-wallet recovery.
 */
interface ISessionKeyRegistry {
    struct Session {
        address executor;
        uint48 issuedAt;
        uint48 validUntil;
        uint64 generation;
    }

    struct ExecutorBinding {
        address instance;
        address player;
        uint64 generation;
    }

    /**
     * @notice Emitted when an instance registers a primary's first live executor.
     * @param instance Tournament instance that owns the authorization.
     * @param player Enrolled primary wallet.
     * @param executor Temporary executor authorized for gameplay.
     * @param validUntil Exclusive session expiry timestamp.
     * @param generation Monotonic player/instance session generation.
     */
    event SessionRegistered(
        address indexed instance,
        address indexed player,
        address indexed executor,
        uint48 validUntil,
        uint64 generation
    );

    /**
     * @notice Emitted when a primary atomically replaces its executor.
     * @param instance Tournament instance that owns the authorization.
     * @param player Enrolled primary wallet.
     * @param oldExecutor Executor invalidated by the refresh.
     * @param newExecutor Replacement temporary executor.
     * @param validUntil Exclusive replacement-session expiry timestamp.
     * @param generation Monotonic player/instance session generation.
     */
    event SessionRefreshed(
        address indexed instance,
        address indexed player,
        address indexed oldExecutor,
        address newExecutor,
        uint48 validUntil,
        uint64 generation
    );

    /**
     * @notice Emitted when a primary explicitly revokes its executor.
     * @param instance Tournament instance that owned the authorization.
     * @param player Enrolled primary wallet.
     * @param executor Executor invalidated by the revocation.
     * @param generation Monotonic player/instance session generation.
     */
    event SessionRevoked(
        address indexed instance,
        address indexed player,
        address indexed executor,
        uint64 generation
    );

    /// @notice Returns the immutable duration of every issued session.
    /// @return The requested value.
    function SESSION_TTL() external view returns (uint48);

    /// @notice Returns the player registry anchoring factory authorization.
    /// @return The requested value.
    function PLAYER_REGISTRY() external view returns (address);

    /// @notice Registers an executor during atomic instance enrollment.
    /// @param player Enrolled primary wallet.
    /// @param executor Temporary executor to authorize.
    function registerSession(address player, address executor) external;

    /// @notice Replaces or issues an executor under primary-wallet authority.
    /// @param instance Tournament instance containing the primary.
    /// @param newExecutor Replacement temporary executor.
    function refreshSession(address instance, address newExecutor) external;

    /// @notice Revokes the caller's executor for one instance.
    /// @param instance Tournament instance containing the primary.
    function revokeSession(address instance) external;

    /// @notice Returns the stored session record.
    /// @param instance Tournament instance namespace.
    /// @param player Enrolled primary wallet.
    /// @return The requested value.
    function getSession(address instance, address player)
        external
        view
        returns (Session memory);

    /// @notice Returns an executor's reverse binding.
    /// @param executor Temporary executor to inspect.
    /// @return The requested value.
    function getExecutorBinding(address executor)
        external
        view
        returns (ExecutorBinding memory);

    /**
     * @notice Resolves a currently active executor to its primary wallet.
     * @param instance Tournament instance namespace.
     * @param executor Temporary executor to resolve.
     * @return player Enrolled primary, or zero when inactive.
     * @return validUntil Exclusive expiry timestamp, or zero when inactive.
     * @return generation Session generation, or zero when inactive.
     */
    function resolveSession(address instance, address executor)
        external
        view
        returns (address player, uint48 validUntil, uint64 generation);

    /**
     * @notice Reports whether an exact primary/executor binding is active.
     * @param instance Tournament instance namespace.
     * @param player Enrolled primary wallet.
     * @param executor Temporary executor to inspect.
     * @return The requested value.
     */
    function isSessionActive(
        address instance,
        address player,
        address executor
    ) external view returns (bool);
}
