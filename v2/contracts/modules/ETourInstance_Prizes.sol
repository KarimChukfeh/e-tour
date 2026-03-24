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
 * - Prize fallback: failed sends go to factory.receiveProtocolShare() instead of
 *   accumulating on the instance (instance should not hold protocol funds)
 * - playerPrizes mapping is kept on the instance as part of the permanent record
 *
 * DELEGATECALL SEMANTICS: Executes in instance contract's storage context.
 */
contract ETourInstance_Prizes is ETourInstance_Base {

    constructor() {}

    // ============ Abstract Stubs ============

    function _createMatchGame(uint8, uint8, address, address) public override { revert("Module stub"); }
    function _resetMatchGame(bytes32) public override { revert("Module stub"); }
    function _getMatchResult(bytes32) public view override returns (address, bool, MatchStatus) { revert("Module stub"); }
    function _initializeMatchForPlay(bytes32) public override { revert("Module stub"); }
    function _completeMatchWithResult(bytes32, address, bool) public override { revert("Module stub"); }
    function _getTimeIncrement() public view override returns (uint256) { revert("Module stub"); }
    function _hasCurrentPlayerTimedOut(bytes32) public view override returns (bool) { revert("Module stub"); }
    function initializeRound(uint8) public override { revert("Module stub"); }

    // ============ Prize Distribution ============

    /**
     * @dev Distribute prize to tournament winner (winner-takes-all).
     * Called via delegatecall from ETourInstance_Base._handleTournamentConclusion().
     */
    function distributePrizes(uint256 winnersPot)
        external
        onlyDelegateCall
        returns (address[] memory winners, uint256[] memory prizes)
    {
        address winner = tournament.winner;
        playerPrizes[winner] = winnersPot;

        bool sent = _sendPrizeWithFallback(winner, winnersPot);

        winners = new address[](1);
        prizes = new uint256[](1);
        winners[0] = winner;
        prizes[0] = sent ? winnersPot : 0;
    }

    /**
     * @dev Distribute equal prizes to all remaining players (all-draw scenario).
     * Called via delegatecall from ETourInstance_Base._handleTournamentConclusion().
     */
    function distributeEqualPrizes(address[] memory remainingPlayers, uint256 winnersPot)
        external
        onlyDelegateCall
        returns (address[] memory winners, uint256[] memory prizes)
    {
        uint256 prizePerPlayer = winnersPot / remainingPlayers.length;

        address[] memory tempWinners = new address[](remainingPlayers.length);
        uint256[] memory tempPrizes = new uint256[](remainingPlayers.length);
        uint256 successCount = 0;

        for (uint256 i = 0; i < remainingPlayers.length; i++) {
            address player = remainingPlayers[i];
            playerPrizes[player] = prizePerPlayer;

            bool sent = _sendPrizeWithFallback(player, prizePerPlayer);
            if (sent) {
                tempWinners[successCount] = player;
                tempPrizes[successCount] = prizePerPlayer;
                successCount++;
            }
        }

        winners = new address[](successCount);
        prizes = new uint256[](successCount);
        for (uint256 i = 0; i < successCount; i++) {
            winners[i] = tempWinners[i];
            prizes[i] = tempPrizes[i];
        }
    }

    // ============ Internal ============

    /**
     * @dev Attempt to send prize; on failure, route to factory protocol accumulator.
     * Keeps the instance free of stranded funds.
     */
    function _sendPrizeWithFallback(address recipient, uint256 amount) internal returns (bool success) {
        require(amount > 0, "AM");
        (bool sent, ) = payable(recipient).call{value: amount}("");
        if (sent) return true;

        // Fallback: send to factory's protocol accumulator
        (bool fallbackOk, ) = payable(factory).call{value: amount}(
            abi.encodeWithSignature("receiveProtocolShare()")
        );
        // If factory also fails, funds remain on instance as part of permanent record
        fallbackOk;
        return false;
    }
}
