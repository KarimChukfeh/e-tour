// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEntryPointV08} from "./ERC4337Types.sol";
import {ETourSessionAccount} from "./ETourSessionAccount.sol";

/* solhint-disable func-visibility, use-natspec */

/**
 * @title ETourSessionAccountFactory
 * @notice CREATE2 factory and immutable provenance registry for session
 * accounts accepted by the ETour paymaster.
 */
contract ETourSessionAccountFactory {
    address public immutable ENTRY_POINT;
    address public immutable SENDER_CREATOR;
    mapping(address account => bool created) public isAccount;

    error InvalidEntryPoint();
    error SenderCreatorOnly();
    error CounterfactualAddressMismatch();

    event SessionAccountCreated(
        address indexed account,
        address indexed owner,
        uint256 indexed salt
    );

    constructor(address entryPoint_) {
        if (entryPoint_ == address(0)) revert InvalidEntryPoint();
        ENTRY_POINT = entryPoint_;
        SENDER_CREATOR = IEntryPointV08(entryPoint_).senderCreator();
        if (SENDER_CREATOR == address(0)) revert InvalidEntryPoint();
    }

    /**
     * @notice Deploys or returns the deterministic account.
     * @dev EntryPoint v0.8 routes initCode through SenderCreator.
     */
    function createAccount(
        address owner,
        uint256 salt
    ) external returns (ETourSessionAccount account) {
        if (msg.sender != SENDER_CREATOR) revert SenderCreatorOnly();
        address predicted = getAddress(owner, salt);
        if (predicted.code.length != 0) {
            if (!isAccount[predicted]) {
                revert CounterfactualAddressMismatch();
            }
            return ETourSessionAccount(payable(predicted));
        }
        account = new ETourSessionAccount{
            salt: bytes32(salt)
        }(ENTRY_POINT, owner, address(this));
        if (address(account) != predicted) {
            revert CounterfactualAddressMismatch();
        }
        isAccount[address(account)] = true;
        emit SessionAccountCreated(address(account), owner, salt);
    }

    /// @notice Computes the session executor before deployment.
    function getAddress(
        address owner,
        uint256 salt
    ) public view returns (address) {
        bytes32 codeHash = keccak256(
            abi.encodePacked(
                type(ETourSessionAccount).creationCode,
                abi.encode(ENTRY_POINT, owner, address(this))
            )
        );
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                bytes32(salt),
                                codeHash
                            )
                        )
                    )
                )
            );
    }
}
