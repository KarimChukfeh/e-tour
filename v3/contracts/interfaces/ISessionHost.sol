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
    /// @return The requested value.
    function factory() external view returns (address);

    /// @notice Returns the session registry configured at initialization.
    /// @return The requested value.
    function SESSION_REGISTRY() external view returns (address);

    /// @notice Reports whether a primary wallet is enrolled.
    /// @param player Primary wallet to inspect.
    /// @return The requested value.
    function isEnrolled(address player) external view returns (bool);

    /// @notice Reports whether the tournament permanently concluded.
    /// @return The requested value.
    function isConcluded() external view returns (bool);
}

/**
 * @title ISessionFactory
 * @author ETour
 * @notice Minimal factory provenance surface used by the session registry.
 */
interface ISessionFactory {
    /// @notice Returns the shared player registry.
    /// @return The requested value.
    function PLAYER_REGISTRY() external view returns (address);

    /// @notice Returns the shared session registry.
    /// @return The requested value.
    function SESSION_REGISTRY() external view returns (address);

    /// @notice Reports whether this factory created an instance clone.
    /// @param instance Candidate instance address.
    /// @return The requested value.
    function isInstance(address instance) external view returns (bool);
}
