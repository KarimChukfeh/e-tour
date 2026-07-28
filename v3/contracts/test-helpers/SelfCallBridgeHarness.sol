// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IETourInstanceSelf} from "../interfaces/IETourInstanceSelf.sol";
import {ETourModuleGuard} from "../modules/ETourModuleGuard.sol";
import {ETourStorage} from "../storage/ETourStorage.sol";

/**
 * @title SelfCallBridgeHarness
 * @author ETour
 * @notice Test-only unrelated caller and legitimate delegatecall-module harness.
 */
contract SelfCallBridgeHarness is ETourStorage, ETourModuleGuard {
    using Address for address;

    error InsufficientPlayers();

    /**
     * @notice Calls a target as an unrelated contract and bubbles any revert.
     * @param target Contract to call.
     * @param data Encoded target calldata.
     * @return result Raw successful return data.
     */
    function callTarget(address target, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        return target.functionCallWithValue(data, msg.value);
    }

    /**
     * @notice Exercises every state-changing host bridge from a legitimate
     * delegatecall module context.
     * @param roundNumber Round used for the test match.
     */
    function initializeRound(uint8 roundNumber) external payable onlyDelegateCall {
        if (enrolledPlayers.length < 2) revert InsufficientPlayers();

        IETourInstanceSelf host = IETourInstanceSelf(address(this));
        address player1 = enrolledPlayers[0];
        address player2 = enrolledPlayers[1];
        bytes32 matchId = keccak256(abi.encodePacked(roundNumber, uint8(0)));

        host._createMatchGame(roundNumber, 0, player1, player2);
        host._resetMatchGame(matchId);
        host._setMatchPlayer(matchId, 0, player1);
        host._setMatchPlayer(matchId, 1, player2);
        host._initializeMatchForPlay(matchId);
        host._completeMatchWithResult(matchId, player1, false);
    }
}
