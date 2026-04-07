// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IConnectFourLike {
    function enrollInTournament() external payable;
    function makeMove(uint8 roundNumber, uint8 matchNumber, uint8 column) external;
}

/**
 * @dev Test helper that can participate in a v2 ConnectFour tournament and
 * optionally reject ETH payouts.
 */
contract RejectingConnectFourPlayer {
    IConnectFourLike public immutable instance;
    bool public rejectPayments;
    uint256 public receivedAmount;
    uint256 public rejectionCount;

    event PaymentReceived(uint256 amount);
    event PaymentRejected(uint256 amount);

    constructor(address instanceAddress) {
        instance = IConnectFourLike(instanceAddress);
    }

    function setRejectPayments(bool reject_) external {
        rejectPayments = reject_;
    }

    function enrollInTournament() external payable {
        instance.enrollInTournament{value: msg.value}();
    }

    function makeMove(uint8 roundNumber, uint8 matchNumber, uint8 column) external {
        instance.makeMove(roundNumber, matchNumber, column);
    }

    receive() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("RejectingConnectFourPlayer: Payment rejected");
        }

        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }

    fallback() external payable {
        if (rejectPayments) {
            rejectionCount++;
            emit PaymentRejected(msg.value);
            revert("RejectingConnectFourPlayer: Payment rejected");
        }

        receivedAmount += msg.value;
        emit PaymentReceived(msg.value);
    }
}
