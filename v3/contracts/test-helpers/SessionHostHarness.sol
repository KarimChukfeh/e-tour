// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    ISessionKeyRegistry
} from "../interfaces/ISessionKeyRegistry.sol";

/* solhint-disable use-natspec, immutable-vars-naming */

/**
 * @title SessionHostHarness
 * @author ETour
 * @notice Test-only implementation of the tournament session-host surface.
 */
contract SessionHostHarness {
    address public immutable factory;
    address public immutable SESSION_REGISTRY;
    mapping(address player => bool) public isEnrolled;
    bool private _concluded;

    // solhint-disable-next-line func-visibility
    constructor(address factory_, address sessionRegistry_) {
        factory = factory_;
        SESSION_REGISTRY = sessionRegistry_;
    }

    function setEnrolled(address player, bool enrolled) external {
        isEnrolled[player] = enrolled;
    }

    function setConcluded(bool concluded) external {
        _concluded = concluded;
    }

    function isConcluded() external view returns (bool) {
        return _concluded;
    }

    function registerSession(address player, address executor) external {
        ISessionKeyRegistry(SESSION_REGISTRY).registerSession(
            player,
            executor
        );
    }
}
