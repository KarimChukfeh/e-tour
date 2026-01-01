// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITicTacChain {
    function enrollInTournament(
        uint8 tierId,
        uint8 instanceId
    ) external payable;

    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundIndex,
        uint8 matchIndex,
        uint8 position
    ) external;

    function forceStartTournament(
        uint8 tierId,
        uint8 instanceId
    ) external;
}

/**
 * @title PlayerProxy
 * @dev Test helper contract that can participate in tournaments and optionally reject prize distribution
 * @notice Used to test the prize distribution fallback mechanism when a winner rejects ETH
 */
contract PlayerProxy {
    ITicTacChain public game;
    bool public rejectPayments;
    uint256 public receivedAmount;
    uint256 public rejectionCount;

    event PaymentReceived(uint256 amount);
    event PaymentRejected(uint256 amount);

    constructor(address _game) {
        game = ITicTacChain(_game);
        rejectPayments = false;
    }

    /**
     * @dev Toggle whether this contract accepts or rejects ETH payments
     */
    function setRejectPayments(bool _reject) external {
        rejectPayments = _reject;
    }

    /**
     * @dev Enroll in tournament by forwarding the call
     */
    function enrollInTournament(
        uint8 tierId,
        uint8 instanceId
    ) external payable {
        game.enrollInTournament{value: msg.value}(tierId, instanceId);
    }

    /**
     * @dev Make a move in the game
     */
    function makeMove(
        uint8 tierId,
        uint8 instanceId,
        uint8 roundIndex,
        uint8 matchIndex,
        uint8 position
    ) external {
        game.makeMove(tierId, instanceId, roundIndex, matchIndex, position);
    }

    /**
     * @dev Force start a tournament
     */
    function forceStartTournament(
        uint8 tierId,
        uint8 instanceId
    ) external {
        game.forceStartTournament(tierId, instanceId);
    }

    /**
     * @dev Receive ETH - can be configured to reject
     */
    receive() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("PlayerProxy: Payment rejected");
        }
        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }

    /**
     * @dev Fallback - can be configured to reject
     */
    fallback() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("PlayerProxy: Payment rejected");
        }
        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }

    /**
     * @dev Get payment statistics
     */
    function getStats() external view returns (
        uint256 received,
        uint256 rejected,
        bool isRejecting
    ) {
        return (receivedAmount, rejectionCount, rejectPayments);
    }

    /**
     * @dev Allow withdrawing any received ETH (for cleanup)
     */
    function withdraw() external {
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }
}
