// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourInstance_Base.sol";

/**
 * @title ETourInstance_Prizes
 * @dev Stateless module for prize distribution.
 *
 * Adapted from ETour_Prizes for single-instance storage:
 * - No tierId/instanceId parameters
 * - No tournament reset — instances are permanent records
 * - No leaderboard — player earnings are read from instance view functions
 * - Failed prize sends are redistributed across the remaining enrolled players
 *   that can accept ETH, instead of falling back to the factory
 * - playerPrizes mapping is kept on the instance as part of the permanent record
 *
 * DELEGATECALL SEMANTICS: Executes in instance contract's storage context.
 */
contract ETourInstance_Prizes is ETourInstance_Base {

    constructor() {}

    // ============ Abstract Stubs ============

    function moduleCreateMatch(uint8, uint8, address, address) public override { revert("Module stub"); }
    function moduleResetMatch(bytes32) public override { revert("Module stub"); }
    function moduleInitializeMatchForPlay(bytes32) public override { revert("Module stub"); }
    function initializeRound(uint8) public payable override { revert("Module stub"); }

    // ============ Prize Distribution ============

    /**
     * @dev Distribute prize to tournament winner (winner-takes-all).
     * Called via delegatecall from ETourInstance_Base._handleTournamentConclusion().
     */
    function distributePrizes(uint256 winnersPot) payable
        external
        onlyDelegateCall
        returns (address[] memory winners, uint256[] memory prizes)
    {
        address[] memory initialRecipients = new address[](1);
        uint256[] memory initialAmounts = new uint256[](1);
        PayoutReason[] memory initialReasons = new PayoutReason[](1);
        initialRecipients[0] = tournament.winner;
        initialAmounts[0] = winnersPot;
        initialReasons[0] = PayoutReason.Victory;
        return _distributeWithRedistribution(initialRecipients, initialAmounts, initialReasons);
    }

    /**
     * @dev Distribute equal prizes to all remaining players (all-draw scenario).
     * Called via delegatecall from ETourInstance_Base._handleTournamentConclusion().
     */
    function distributeEqualPrizes(address[] memory remainingPlayers, uint256 winnersPot) payable
        external
        onlyDelegateCall
        returns (address[] memory winners, uint256[] memory prizes)
    {
        address[] memory initialRecipients = new address[](remainingPlayers.length);
        uint256[] memory initialAmounts = new uint256[](remainingPlayers.length);
        PayoutReason[] memory initialReasons = new PayoutReason[](remainingPlayers.length);
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;
        uint256 remainder = winnersPot % remainingPlayers.length;
        for (uint256 i = 0; i < remainingPlayers.length; i++) {
            initialRecipients[i] = remainingPlayers[i];
            initialAmounts[i] = prizePerPlayer;
            initialReasons[i] = PayoutReason.EvenSplit;
            if (remainder > 0) {
                initialAmounts[i] += 1;
                remainder--;
            }
        }
        return _distributeWithRedistribution(initialRecipients, initialAmounts, initialReasons);
    }

    // ============ Internal ============

    /**
     * @dev Attempt the requested payouts. Any failed payout is redistributed
     * equally across the other enrolled players that have not already rejected ETH.
     */
    function _distributeWithRedistribution(
        address[] memory initialRecipients,
        uint256[] memory initialAmounts,
        PayoutReason[] memory initialReasons
    ) internal returns (address[] memory winners, uint256[] memory prizes) {
        uint256 enrolledCount = enrolledPlayers.length;
        uint256 maxPayouts = initialRecipients.length + (enrolledCount * enrolledCount);

        address[] memory payoutRecipients = new address[](maxPayouts);
        uint256[] memory payoutAmounts = new uint256[](maxPayouts);
        PayoutReason[] memory payoutReasons = new PayoutReason[](maxPayouts);
        address[] memory tempWinners = new address[](maxPayouts);
        uint256[] memory tempPrizes = new uint256[](maxPayouts);
        bool[] memory blocked = new bool[](enrolledCount);

        uint256 queueLen = initialRecipients.length;
        for (uint256 i = 0; i < initialRecipients.length; i++) {
            payoutRecipients[i] = initialRecipients[i];
            payoutAmounts[i] = initialAmounts[i];
            payoutReasons[i] = initialReasons[i];
        }

        uint256 successCount = 0;
        for (uint256 i = 0; i < queueLen; i++) {
            address recipient = payoutRecipients[i];
            uint256 amount = payoutAmounts[i];
            PayoutReason payoutReason = payoutReasons[i];

            if (recipient == address(0) || amount == 0) {
                continue;
            }

            (bool isEnrolledRecipient, uint256 enrolledIndex) = _getEnrolledIndex(recipient);
            if (isEnrolledRecipient && blocked[enrolledIndex]) {
                queueLen = _queueRedistribution(
                    amount,
                    recipient,
                    blocked,
                    payoutRecipients,
                    payoutAmounts,
                    payoutReasons,
                    queueLen
                );
                continue;
            }

            (bool sent, ) = payable(recipient).call{value: amount}("");
            if (sent) {
                playerPrizes[recipient] += amount;
                if (playerPayoutReasons[recipient] != PayoutReason.WalletRejected) {
                    playerPayoutReasons[recipient] = payoutReason;
                }
                tempWinners[successCount] = recipient;
                tempPrizes[successCount] = amount;
                successCount++;
                continue;
            }

            playerPayoutReasons[recipient] = PayoutReason.WalletRejected;
            if (isEnrolledRecipient) {
                blocked[enrolledIndex] = true;
            }

            queueLen = _queueRedistribution(
                amount,
                recipient,
                blocked,
                payoutRecipients,
                payoutAmounts,
                payoutReasons,
                queueLen
            );
        }

        winners = new address[](successCount);
        prizes = new uint256[](successCount);
        for (uint256 i = 0; i < successCount; i++) {
            winners[i] = tempWinners[i];
            prizes[i] = tempPrizes[i];
        }
    }

    function _queueRedistribution(
        uint256 amount,
        address excludedRecipient,
        bool[] memory blocked,
        address[] memory payoutRecipients,
        uint256[] memory payoutAmounts,
        PayoutReason[] memory payoutReasons,
        uint256 queueLen
    ) internal view returns (uint256 newQueueLen) {
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < enrolledPlayers.length; i++) {
            if (!blocked[i] && enrolledPlayers[i] != excludedRecipient) {
                eligibleCount++;
            }
        }

        if (eligibleCount == 0 || amount == 0) {
            return queueLen;
        }

        uint256 share = amount / eligibleCount;
        uint256 remainder = amount % eligibleCount;
        newQueueLen = queueLen;

        for (uint256 i = 0; i < enrolledPlayers.length; i++) {
            address player = enrolledPlayers[i];
            if (blocked[i] || player == excludedRecipient) {
                continue;
            }

            uint256 payout = share;
            if (remainder > 0) {
                payout += 1;
                remainder--;
            }
            if (payout == 0) {
                continue;
            }

            require(newQueueLen < payoutRecipients.length, "PQ");
            payoutRecipients[newQueueLen] = player;
            payoutAmounts[newQueueLen] = payout;
            payoutReasons[newQueueLen] = PayoutReason.EvenSplit;
            newQueueLen++;
        }
    }

    function _getEnrolledIndex(address player) internal view returns (bool found, uint256 index) {
        for (uint256 i = 0; i < enrolledPlayers.length; i++) {
            if (enrolledPlayers[i] == player) {
                return (true, i);
            }
        }
        return (false, 0);
    }
}
