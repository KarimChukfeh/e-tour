// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PackedUserOperation, IEntryPointV08} from "./ERC4337Types.sol";

/* solhint-disable func-visibility, immutable-vars-naming, no-inline-assembly, use-natspec */

/**
 * @title ETourSessionAccount
 * @notice Non-upgradeable, single-browser-key ERC-4337 session account.
 * @dev The immutable owner is the temporary browser key, never the player's
 * primary wallet. Protocol authority still comes exclusively from the
 * instance-scoped SessionKeyRegistry.
 */
contract ETourSessionAccount {
    address public immutable ENTRY_POINT;
    address public immutable owner;
    address public immutable factory;

    error UnauthorizedCaller();
    error TransferFailed();

    constructor(address entryPoint_, address owner_, address factory_) {
        if (
            entryPoint_ == address(0) ||
            owner_ == address(0) ||
            factory_ == address(0)
        ) revert UnauthorizedCaller();
        ENTRY_POINT = entryPoint_;
        owner = owner_;
        factory = factory_;
    }

    receive() external payable {}

    /**
     * @notice Executes one call authorized by EntryPoint validation or owner.
     * @dev The paymaster separately restricts sponsored calls to game moves.
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external {
        if (msg.sender != ENTRY_POINT && msg.sender != owner) {
            revert UnauthorizedCaller();
        }
        (bool success, bytes memory result) =
            target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /**
     * @notice ERC-4337 account validation entry point.
     * @return validationData Zero for a valid signature, one otherwise.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != ENTRY_POINT) revert UnauthorizedCaller();
        if (
            ECDSA.recover(userOpHash, userOp.signature) != owner
        ) {
            return 1;
        }
        if (missingAccountFunds != 0) {
            (bool success, ) =
                payable(msg.sender).call{value: missingAccountFunds}("");
            if (!success) revert TransferFailed();
        }
        return 0;
    }

    function addDeposit() external payable {
        IEntryPointV08(ENTRY_POINT).depositTo{value: msg.value}(
            address(this)
        );
    }

    function getDeposit() external view returns (uint256) {
        return IEntryPointV08(ENTRY_POINT).balanceOf(address(this));
    }

    function withdrawDepositTo(
        address payable withdrawAddress,
        uint256 amount
    ) external {
        if (msg.sender != owner) revert UnauthorizedCaller();
        IEntryPointV08(ENTRY_POINT).withdrawTo(withdrawAddress, amount);
    }
}
