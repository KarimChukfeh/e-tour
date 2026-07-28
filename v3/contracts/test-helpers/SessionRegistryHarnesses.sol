// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* solhint-disable use-natspec */

/**
 * @title SessionFactoryHarness
 * @author ETour
 * @notice Test-only implementation of the session factory attestation surface.
 */
contract SessionFactoryHarness {
    address public immutable PLAYER_REGISTRY;
    address public immutable SESSION_REGISTRY;
    mapping(address instance => bool) public isInstance;

    // solhint-disable-next-line func-visibility
    constructor(address playerRegistry, address sessionRegistry) {
        PLAYER_REGISTRY = playerRegistry;
        SESSION_REGISTRY = sessionRegistry;
    }

    function setInstance(address instance, bool approved) external {
        isInstance[instance] = approved;
    }
}
