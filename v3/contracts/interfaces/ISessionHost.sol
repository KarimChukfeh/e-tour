// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISessionHost
 * @author ETour
 * @notice Minimal tournament-instance attestation surface used by the session
 * registry.
 */
interface ISessionHost {
    /// @notice Returns the factory that created this instance.
    function factory() external view returns (address);

    /// @notice Returns the session registry configured at initialization.
    function SESSION_REGISTRY() external view returns (address);

    /// @notice Reports whether a primary wallet is enrolled.
    /// @param player Primary wallet to inspect.
    function isEnrolled(address player) external view returns (bool);

    /// @notice Reports whether the tournament permanently concluded.
    function isConcluded() external view returns (bool);
}

/**
 * @title ISessionFactory
 * @author ETour
 * @notice Minimal factory provenance surface used by the session registry.
 */
interface ISessionFactory {
    /// @notice Returns the shared player registry.
    function PLAYER_REGISTRY() external view returns (address);

    /// @notice Returns the shared session registry.
    function SESSION_REGISTRY() external view returns (address);

    /// @notice Reports whether this factory created an instance clone.
    /// @param instance Candidate instance address.
    function isInstance(address instance) external view returns (bool);
}
