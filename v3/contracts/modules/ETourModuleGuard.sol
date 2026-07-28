// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ETourModuleGuard
 * @author ETour
 * @notice Storage-free direct-call guard shared by delegatecall modules.
 * @dev The immutable is embedded in each module's bytecode and does not consume
 * instance storage.
 */
abstract contract ETourModuleGuard {
    error DirectModuleCall();

    address private immutable MODULE_SELF = address(this);

    /// @dev Restricts module entry points to execution in an instance context.
    modifier onlyDelegateCall() {
        if (address(this) == MODULE_SELF) revert DirectModuleCall();
        _;
    }
}
