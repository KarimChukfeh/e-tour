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
    function senderCreator() external view returns (address);

    function depositTo(address account) external payable;

    function balanceOf(address account) external view returns (uint256);

    function withdrawTo(
        address payable withdrawAddress,
        uint256 withdrawAmount
    ) external;

    function addStake(uint32 unstakeDelaySec) external payable;

    function unlockStake() external;

    function withdrawStake(address payable withdrawAddress) external;
}

interface IETourSessionAccountFactory {
    function isAccount(address account) external view returns (bool);
}
