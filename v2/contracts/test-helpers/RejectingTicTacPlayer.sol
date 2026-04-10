// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITicTacToeLike {
    function enrollInTournament() external payable;
    function makeMove(uint8 roundNumber, uint8 matchNumber, uint8 cellIndex) external;
}

/**
 * @dev Test helper that can participate in a v2 TicTacToe and optionally
 * reject ETH payouts.
 */
contract RejectingTicTacPlayer {
    ITicTacToeLike public immutable instance;
    bool public rejectPayments;
    uint256 public receivedAmount;
    uint256 public rejectionCount;

    event PaymentReceived(uint256 amount);
    event PaymentRejected(uint256 amount);

    constructor(address instanceAddress) {
        instance = ITicTacToeLike(instanceAddress);
    }

    function setRejectPayments(bool reject_) external {
        rejectPayments = reject_;
    }

    function enrollInTournament() external payable {
        instance.enrollInTournament{value: msg.value}();
    }

    function makeMove(uint8 roundNumber, uint8 matchNumber, uint8 cellIndex) external {
        instance.makeMove(roundNumber, matchNumber, cellIndex);
    }

    receive() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("RejectingTicTacPlayer: Payment rejected");
        }

        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }

    fallback() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("RejectingTicTacPlayer: Payment rejected");
        }

        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }
}
