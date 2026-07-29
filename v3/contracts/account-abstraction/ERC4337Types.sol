// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* solhint-disable use-natspec */

/**
 * @notice ERC-4337 v0.8 packed operation shape.
 * @dev Kept local so ETour contracts remain on the V3 Solidity 0.8.20
 * compiler while remaining ABI-compatible with the pinned EntryPoint.
 */
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointV08 {
    /**
     * @notice Returns the EntryPoint SenderCreator address.
     * @return The requested value.
     */
    function senderCreator() external view returns (address);

    /**
     * @notice Executes deposit to.
     * @param account The account address.
     */
    function depositTo(address account) external payable;

    /**
     * @notice Returns the EntryPoint deposit balance.
     * @param account The account address.
     * @return The requested value.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @notice Withdraws to.
     * @param withdrawAddress The withdraw address.
     * @param withdrawAmount The withdraw amount value.
     */
    function withdrawTo(
        address payable withdrawAddress,
        uint256 withdrawAmount
    ) external;

    /**
     * @notice Adds stake to the EntryPoint.
     * @param unstakeDelaySec The unstake delay sec value.
     */
    function addStake(uint32 unstakeDelaySec) external payable;

    /**
     * @notice Unlocks the EntryPoint stake.
     */
    function unlockStake() external;

    /**
     * @notice Withdraws stake.
     * @param withdrawAddress The withdraw address.
     */
    function withdrawStake(address payable withdrawAddress) external;
}

interface IETourSessionAccountFactory {
    /**
     * @notice Returns whether account.
     * @param account The account address.
     * @return The requested value.
     */
    function isAccount(address account) external view returns (bool);
}
