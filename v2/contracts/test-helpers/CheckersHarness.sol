// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../Checkers.sol";

contract CheckersHarness is Checkers {

    function harnessSetup(
        address player1,
        address player2,
        address currentTurn,
        uint256 board,
        uint256 state
    ) external {
        tournament.status = TournamentStatus.InProgress;
        tournament.currentRound = 0;
        tournament.enrolledCount = 2;
        tournament.actualTotalRounds = 1;
        tierConfig.playerCount = 2;
        tierConfig.totalRounds = 1;
        tierConfig.timeouts.matchTimePerPlayer = 10 minutes;
        tierConfig.timeouts.timeIncrementPerMove = 0;

        bytes32 matchId = _getMatchId(0, 0);
        Match storage m = matches[matchId];
        m.player1 = player1;
        m.player2 = player2;
        m.currentTurn = currentTurn;
        m.firstPlayer = player1;
        m.status = MatchStatus.InProgress;
        m.packedBoard = board;
        m.packedState = state;
        m.startTime = block.timestamp;
        m.lastMoveTime = block.timestamp;
        m.player1TimeRemaining = 10 minutes;
        m.player2TimeRemaining = 10 minutes;
        m.moves = "";
    }
}
