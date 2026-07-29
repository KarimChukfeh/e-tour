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
    /**
     * @notice Returns entry point.
     */
    address public immutable ENTRY_POINT;
    /**
     * @notice Returns owner.
     */
    address public immutable owner;
    /**
     * @notice Returns factory.
     */
    address public immutable factory;

    error UnauthorizedCaller();
    error TransferFailed();

    /**
     * @notice Initializes the etour session account constructor.
     * @param entryPoint_ The entry point address.
     * @param owner_ The owner address.
     * @param factory_ The factory address.
     */
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

    /**
     * @notice Accepts native ETH sent directly to this contract.
     */
    receive() external payable {}

    /**
     * @notice Executes one call authorized by EntryPoint validation or owner.
     * @dev The paymaster separately restricts sponsored calls to game moves.
     * @param target The target address.
     * @param value The value value.
     * @param data The data data.
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
     * @param userOp The user op configuration.
     * @param userOpHash The user op hash data.
     * @param missingAccountFunds The missing account funds value.
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

    /**
     * @notice Deposits ETH into the EntryPoint.
     */
    function addDeposit() external payable {
        IEntryPointV08(ENTRY_POINT).depositTo{value: msg.value}(
            address(this)
        );
    }

    /**
     * @notice Returns deposit.
     * @return The requested value.
     */
    function getDeposit() external view returns (uint256) {
        return IEntryPointV08(ENTRY_POINT).balanceOf(address(this));
    }

    /**
     * @notice Withdraws deposit to.
     * @param withdrawAddress The withdraw address.
     * @param amount The amount value.
     */
    function withdrawDepositTo(
        address payable withdrawAddress,
        uint256 amount
    ) external {
        if (msg.sender != owner) revert UnauthorizedCaller();
        IEntryPointV08(ENTRY_POINT).withdrawTo(withdrawAddress, amount);
    }
}
