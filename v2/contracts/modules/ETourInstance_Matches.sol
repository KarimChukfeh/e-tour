// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ETourTournamentBase.sol";

/**
 * @title ETourInstance_Matches
 * @dev Thin match-entry module that delegates heavy round resolution logic to
 * ETourInstance_MatchesResolution to keep every deployable module below 24 KB.
 *
 * DELEGATECALL SEMANTICS: Executes in instance contract's storage context.
 */
contract ETourInstance_Matches is ETourTournamentBase {

    error InvalidMatchCount();
    error NotEnoughPlayers();
    error InvalidPlayerAddresses();
    error MatchesResolutionDelegatecallFailed();

    address internal immutable _matchesResolution;

    constructor(address matchesResolution_) {
        _matchesResolution = matchesResolution_;
    }

    // ============ Abstract Stubs ============

    function moduleCreateMatch(uint8, uint8, address, address) public override {}
    function moduleResetMatch(bytes32) public override {}
    function moduleInitializeMatchForPlay(bytes32) public override {}

    // ============ Round Initialization ============

    function initializeRound(uint8 roundNumber) public payable override onlyDelegateCall {
        uint8 playerCount;
        if (roundNumber == 0) {
            playerCount = tournament.enrolledCount;
        } else {
            Round storage prevRound = rounds[roundNumber - 1];
            playerCount = (prevRound.totalMatches - prevRound.drawCount) + (prevRound.playerCount % 2);
        }

        uint8 matchCount = playerCount / 2;
        if (!(matchCount > 0 || roundNumber > 0)) revert InvalidMatchCount();

        Round storage round = rounds[roundNumber];
        round.totalMatches = matchCount;
        round.completedMatches = 0;
        round.initialized = true;
        round.drawCount = 0;
        round.playerCount = playerCount;

        if (roundNumber == 0) {
            if (enrolledPlayers.length < 2) revert NotEnoughPlayers();

            address walkoverPlayer = address(0);
            if (tournament.enrolledCount % 2 == 1) {
                uint8 walkoverIndex = uint8(_drawRandomIndex(
                    ENTROPY_WALKOVER,
                    keccak256(abi.encodePacked(roundNumber, tournament.enrolledCount)),
                    tournament.enrolledCount
                ));

                walkoverPlayer = enrolledPlayers[walkoverIndex];
                enrolledPlayers[walkoverIndex] = enrolledPlayers[tournament.enrolledCount - 1];
                enrolledPlayers[tournament.enrolledCount - 1] = walkoverPlayer;
            }

            for (uint8 i = 0; i < matchCount;) {
                if (enrolledPlayers[i * 2] == address(0) || enrolledPlayers[i * 2 + 1] == address(0)) {
                    revert InvalidPlayerAddresses();
                }
                this.moduleCreateMatch(roundNumber, i, enrolledPlayers[i * 2], enrolledPlayers[i * 2 + 1]);
                unchecked { i++; }
            }

            if (walkoverPlayer != address(0)) {
                _delegateAdvanceWinner(roundNumber, matchCount, walkoverPlayer);
            }
        }
    }

    // ============ Match Completion ============

    function completeMatch(
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason
    ) public payable onlyDelegateCall {
        if (!isDraw && roundNumber < tournament.actualTotalRounds - 1) {
            _delegateAdvanceWinner(roundNumber, matchNumber, winner);
        }

        Round storage round = rounds[roundNumber];
        round.completedMatches++;
        if (isDraw) round.drawCount++;

        bool isRoundComplete = (round.completedMatches == round.totalMatches) ||
                               (round.totalMatches == 0 && round.completedMatches == 1);

        if (isRoundComplete) {
            _delegateResolveCompletedRound(roundNumber, uint8(reason));
        }
    }

    function _delegateAdvanceWinner(uint8 roundNumber, uint8 matchNumber, address winner) internal {
        (bool ok, ) = _matchesResolution.delegatecall(
            abi.encodeWithSignature("advanceWinner(uint8,uint8,address)", roundNumber, matchNumber, winner)
        );
        if (!ok) revert MatchesResolutionDelegatecallFailed();
    }

    function _delegateResolveCompletedRound(uint8 roundNumber, uint8 reasonRaw) internal {
        (bool ok, ) = _matchesResolution.delegatecall(
            abi.encodeWithSignature("resolveCompletedRound(uint8,uint8)", roundNumber, reasonRaw)
        );
        if (!ok) revert MatchesResolutionDelegatecallFailed();
    }
}
