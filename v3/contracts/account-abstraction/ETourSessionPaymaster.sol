// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    PackedUserOperation,
    IEntryPointV08,
    IETourSessionAccountFactory
} from "./ERC4337Types.sol";
import {ISessionKeyRegistry} from "../interfaces/ISessionKeyRegistry.sol";
import {
    ISessionHost,
    ISessionFactory
} from "../interfaces/ISessionHost.sol";

/* solhint-disable func-visibility, function-max-lines, gas-indexed-events */
/* solhint-disable gas-small-strings, gas-strict-inequalities, use-natspec */

/**
 * @title ETourSessionPaymaster
 * @notice Fully on-chain sponsorship policy for active V3 session moves.
 * @dev This contract deliberately has no off-chain verifier: its immutable
 * account provenance, factory provenance, selector, value, TTL, and gas
 * checks are the complete sponsorship authority.
 */
contract ETourSessionPaymaster {
    /**
     * @notice Returns max verification gas.
     */
    uint256 public constant MAX_VERIFICATION_GAS = 2_500_000;
    // Chess checkmate validation can exceed 2.8M gas before the session
    // account wrapper. The absolute-cost cap below remains the primary
    // monetary bound on any sponsored operation.
    /**
     * @notice Returns max call gas.
     */
    uint256 public constant MAX_CALL_GAS = 4_000_000;
    /**
     * @notice Returns max pre verification gas.
     */
    uint256 public constant MAX_PRE_VERIFICATION_GAS = 200_000;
    /**
     * @notice Returns max paymaster verification gas.
     */
    uint256 public constant MAX_PAYMASTER_VERIFICATION_GAS = 500_000;
    /**
     * @notice Returns max paymaster post op gas.
     */
    uint256 public constant MAX_PAYMASTER_POST_OP_GAS = 100_000;
    /**
     * @notice Returns max user op cost.
     */
    uint256 public constant MAX_USER_OP_COST = 0.02 ether;

    /**
     * @notice Returns account execute selector.
     */
    bytes4 public constant ACCOUNT_EXECUTE_SELECTOR =
        bytes4(keccak256("execute(address,uint256,bytes)"));
    /**
     * @notice Returns standard move selector.
     */
    bytes4 public constant STANDARD_MOVE_SELECTOR =
        bytes4(keccak256("makeMove(uint8,uint8,uint8)"));
    /**
     * @notice Returns chess move selector.
     */
    bytes4 public constant CHESS_MOVE_SELECTOR =
        bytes4(
            keccak256(
                "makeMove(uint8,uint8,uint8,uint8,uint8)"
            )
        );

    /**
     * @notice Returns entry point.
     */
    address public immutable ENTRY_POINT;
    /**
     * @notice Returns session registry.
     */
    address public immutable SESSION_REGISTRY;
    /**
     * @notice Returns account factory.
     */
    address public immutable ACCOUNT_FACTORY;
    /**
     * @notice Returns owner.
     */
    address public owner;
    /**
     * @notice Returns paused.
     */
    bool public paused;
    /**
     * @notice Returns allowed factories.
     */
    mapping(address factory => bool allowed) public allowedFactories;

    error OwnerOnly();
    error EntryPointOnly();
    error SponsorshipPaused();
    error InvalidAccount();
    error MalformedPaymasterData();
    error GasLimitExceeded();
    error MaxCostExceeded();
    error InvalidExecutionWrapper();
    error ValueNotZero();
    error InvalidMoveSelector();
    error InvalidInstance();
    error InactiveSession();
    error TransferFailed();

    event FactoryPermissionSet(
        address indexed factory,
        bool allowed
    );
    event SponsorshipPauseSet(bool paused);
    event OwnershipTransferred(
        address indexed oldOwner,
        address indexed newOwner
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnerOnly();
        _;
    }

    /**
     * @notice Initializes the etour session paymaster constructor.
     * @param entryPoint_ The entry point address.
     * @param sessionRegistry_ The session registry address.
     * @param accountFactory_ The account factory address.
     */
    constructor(
        address entryPoint_,
        address sessionRegistry_,
        address accountFactory_
    ) {
        if (
            entryPoint_ == address(0) ||
            sessionRegistry_ == address(0) ||
            accountFactory_ == address(0)
        ) revert InvalidInstance();
        ENTRY_POINT = entryPoint_;
        SESSION_REGISTRY = sessionRegistry_;
        ACCOUNT_FACTORY = accountFactory_;
        owner = msg.sender;
    }

    /**
     * @notice Accepts native ETH sent directly to this contract.
     */
    receive() external payable {
        deposit();
    }

    /**
     * @notice Updates factory allowed.
     * @param factory The factory address.
     * @param allowed Whether allowed.
     */
    function setFactoryAllowed(
        address factory,
        bool allowed
    ) external onlyOwner {
        if (factory == address(0)) revert InvalidInstance();
        allowedFactories[factory] = allowed;
        emit FactoryPermissionSet(factory, allowed);
    }

    /**
     * @notice Updates paused.
     * @param value Whether the setting is enabled.
     */
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit SponsorshipPauseSet(value);
    }

    /**
     * @notice Transfers ownership.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert OwnerOnly();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Deposits ETH into the EntryPoint.
     */
    function deposit() public payable {
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
     * @notice Withdraws to.
     * @param withdrawAddress The withdraw address.
     * @param amount The amount value.
     */
    function withdrawTo(
        address payable withdrawAddress,
        uint256 amount
    ) external onlyOwner {
        IEntryPointV08(ENTRY_POINT).withdrawTo(
            withdrawAddress,
            amount
        );
    }

    /**
     * @notice Adds stake to the EntryPoint.
     * @param unstakeDelaySec The unstake delay sec value.
     */
    function addStake(
        uint32 unstakeDelaySec
    ) external payable onlyOwner {
        IEntryPointV08(ENTRY_POINT).addStake{
            value: msg.value
        }(unstakeDelaySec);
    }

    /**
     * @notice Unlocks the EntryPoint stake.
     */
    function unlockStake() external onlyOwner {
        IEntryPointV08(ENTRY_POINT).unlockStake();
    }

    /**
     * @notice Withdraws stake.
     * @param withdrawAddress The withdraw address.
     */
    function withdrawStake(
        address payable withdrawAddress
    ) external onlyOwner {
        IEntryPointV08(ENTRY_POINT).withdrawStake(withdrawAddress);
    }

    /**
     * @notice EntryPoint v0.8 paymaster validation.
     * @return context Empty because no post-operation state write is needed.
     * @return validationData Active session expiry encoded as ERC-4337 TTL.
     * @param userOp The user op configuration.
     * @param maxCost The max cost value.
     */
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external view returns (
        bytes memory context,
        uint256 validationData
    ) {
        if (msg.sender != ENTRY_POINT) revert EntryPointOnly();
        if (paused) revert SponsorshipPaused();
        if (
            !IETourSessionAccountFactory(ACCOUNT_FACTORY)
                .isAccount(userOp.sender)
        ) revert InvalidAccount();
        _validateGasAndPaymasterData(userOp, maxCost);

        if (
            userOp.callData.length < 4 ||
            bytes4(userOp.callData[:4]) !=
                ACCOUNT_EXECUTE_SELECTOR
        ) revert InvalidExecutionWrapper();
        (
            address target,
            uint256 value,
            bytes memory gameCall
        ) = abi.decode(
            userOp.callData[4:],
            (address, uint256, bytes)
        );
        uint256 expectedWrapperLength =
            132 + ((gameCall.length + 31) / 32) * 32;
        if (userOp.callData.length != expectedWrapperLength) {
            revert InvalidExecutionWrapper();
        }
        if (value != 0) revert ValueNotZero();
        if (gameCall.length < 4) revert InvalidMoveSelector();
        bytes4 moveSelector = bytes4(gameCall);
        if (moveSelector == STANDARD_MOVE_SELECTOR) {
            if (gameCall.length != 100) {
                revert InvalidMoveSelector();
            }
        } else if (moveSelector == CHESS_MOVE_SELECTOR) {
            if (gameCall.length != 164) {
                revert InvalidMoveSelector();
            }
        } else {
            revert InvalidMoveSelector();
        }

        ISessionHost host = ISessionHost(target);
        address factory = host.factory();
        if (
            !allowedFactories[factory] ||
            host.SESSION_REGISTRY() != SESSION_REGISTRY ||
            !ISessionFactory(factory).isInstance(target)
        ) revert InvalidInstance();
        (address player, uint48 validUntil, ) =
            ISessionKeyRegistry(SESSION_REGISTRY).resolveSession(
                target,
                userOp.sender
            );
        if (player == address(0) || validUntil <= block.timestamp) {
            revert InactiveSession();
        }
        return ("", uint256(validUntil) << 160);
    }

    /**
     * @notice Handles the EntryPoint post-operation callback.
     */
    function postOp(
        uint8,
        bytes calldata,
        uint256,
        uint256
    ) external view {
        if (msg.sender != ENTRY_POINT) revert EntryPointOnly();
    }

    function _validateGasAndPaymasterData(
        PackedUserOperation calldata userOp,
        uint256 maxCost
    ) private view {
        if (
            userOp.paymasterAndData.length != 52 ||
            address(bytes20(userOp.paymasterAndData[:20])) !=
                address(this)
        ) revert MalformedPaymasterData();
        uint256 gasLimits = uint256(userOp.accountGasLimits);
        uint256 verificationGas = gasLimits >> 128;
        uint256 callGas = uint128(gasLimits);
        uint256 paymasterVerificationGas =
            uint128(bytes16(userOp.paymasterAndData[20:36]));
        uint256 paymasterPostOpGas =
            uint128(bytes16(userOp.paymasterAndData[36:52]));
        if (
            verificationGas > MAX_VERIFICATION_GAS ||
            callGas > MAX_CALL_GAS ||
            userOp.preVerificationGas >
                MAX_PRE_VERIFICATION_GAS ||
            paymasterVerificationGas >
                MAX_PAYMASTER_VERIFICATION_GAS ||
            paymasterPostOpGas >
                MAX_PAYMASTER_POST_OP_GAS
        ) revert GasLimitExceeded();
        if (maxCost > MAX_USER_OP_COST) {
            revert MaxCostExceeded();
        }
    }
}
