// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RejectingReceiver
 * @dev Test helper contract that rejects all ETH transfers
 *
 * Used to test the prize distribution fallback mechanism in ETour.
 * When this contract is set as a prize recipient, the transfer will fail,
 * triggering the fallback to keep funds in the contract.
 */
contract RejectingReceiver {
    // Track rejection attempts for testing
    uint256 public rejectionCount;
    uint256 public lastRejectedAmount;

    /**
     * @dev Reject all ETH transfers via receive()
     */
    receive() external payable {
        rejectionCount++;
        lastRejectedAmount = msg.value;
        revert("RejectingReceiver: I reject your ETH!");
    }

    /**
     * @dev Reject all ETH transfers via fallback()
     */
    fallback() external payable {
        rejectionCount++;
        lastRejectedAmount = msg.value;
        revert("RejectingReceiver: I reject your ETH!");
    }

    /**
     * @dev View function to check rejection stats
     */
    function getRejectionStats() external view returns (uint256 count, uint256 amount) {
        return (rejectionCount, lastRejectedAmount);
    }
}
