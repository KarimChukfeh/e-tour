// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ETourStorage
 * @author ETour
 * @notice Canonical storage layout shared by every V3 tournament instance and
 * delegatecall module.
 *
 * Never reorder or insert fields among the V2-compatible declarations. Append
 * game-independent V3 fields only at the end. ReentrancyGuard is intentionally
 * inherited here so its storage is identically positioned in every consumer.
 *
 * This contract intentionally contains declarations only.
 */
abstract contract ETourStorage is ReentrancyGuard {
    enum TournamentStatus { Enrolling, InProgress, Concluded }
    enum MatchStatus { NotStarted, InProgress, Completed }

    enum EscalationLevel {
        None,
        Escalation0_SoloCancel,
        Escalation1_OpponentClaim,
        Escalation2_AdvancedPlayers,
        Escalation3_ExternalPlayers
    }

    enum MatchCompletionCategory { None, MatchResult, Escalation }

    enum MatchCompletionReason {
        NormalWin,
        Timeout,
        Draw,
        ForceElimination,
        Replacement
    }

    enum TournamentResolutionCategory {
        None,
        MatchResult,
        Escalation,
        DrawResolution,
        EnrollmentResolution
    }

    enum TournamentResolutionReason {
        NormalWin,
        Timeout,
        Draw,
        ForceElimination,
        Replacement,
        SoloEnrollCancelled,
        AbandonedTournamentClaimed,
        UncontestedFinalsWin
    }

    enum PlayerMatchOutcomeCategory { None, Victory, Defeat, Draw }

    enum PlayerMatchOutcome {
        None,
        NormalVictory,
        NormalDefeat,
        TimeoutVictory,
        TimeoutDefeat,
        Draw,
        ForceEliminationVictory,
        ForceEliminationDefeat,
        ReplacementVictory,
        ReplacementDefeat
    }

    enum PayoutReason { None, Victory, EvenSplit, WalletRejected, Cancelation }

    struct TimeoutConfig {
        uint256 matchTimePerPlayer;
        uint256 timeIncrementPerMove;
        uint256 matchLevel2Delay;
        uint256 matchLevel3Delay;
        uint256 enrollmentWindow;
        uint256 enrollmentLevel2Delay;
    }

    struct TierConfig {
        uint8 playerCount;
        uint256 entryFee;
        TimeoutConfig timeouts;
        uint8 totalRounds;
        bytes32 tierKey;
    }

    struct EnrollmentTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        uint256 forfeitPool;
    }

    struct TournamentState {
        TournamentStatus status;
        uint8 currentRound;
        uint8 enrolledCount;
        uint256 totalEntryFeesAccrued;
        uint256 prizePool;
        uint256 ownerAccrued;
        uint256 protocolAccrued;
        uint256 startTime;
        uint256 createdAt;
        address winner;
        bool finalsWasDraw;
        bool allDrawResolution;
        uint8 allDrawRound;
        TournamentResolutionReason completionReason;
        TournamentResolutionCategory completionCategory;
        EnrollmentTimeoutState enrollmentTimeout;
        uint8 actualTotalRounds;
        uint256 prizeAwarded;
        address prizeRecipient;
        uint256 raffleAwarded;
        address raffleRecipient;
    }

    struct Round {
        uint8 totalMatches;
        uint8 completedMatches;
        bool initialized;
        uint8 drawCount;
        uint8 playerCount;
    }

    struct MatchTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        bool isStalled;
    }

    struct Match {
        address player1;
        address player2;
        address winner;
        address currentTurn;
        address firstPlayer;
        MatchStatus status;
        bool isDraw;
        uint256 packedBoard;
        uint256 packedState;
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        string moves;
        MatchCompletionReason completionReason;
        MatchCompletionCategory completionCategory;
    }

    struct LeaderboardEntry {
        address player;
        int256 earnings;
    }

    struct CommonMatchData {
        address player1;
        address player2;
        address winner;
        address loser;
        MatchStatus status;
        bool isDraw;
        uint256 startTime;
        uint256 lastMoveTime;
        uint8 roundNumber;
        uint8 matchNumber;
        bool isCached;
    }

    // V2-compatible canonical order. ReentrancyGuard._status precedes these.
    bool internal _initialized;

    /**
     * @notice Returns factory.
     */
    address public factory;
    /**
     * @notice Returns creator.
     */
    address public creator;
    /**
     * @notice Returns module core.
     */
    address public MODULE_CORE;
    /**
     * @notice Returns module matches.
     */
    address public MODULE_MATCHES;
    /**
     * @notice Returns module prizes.
     */
    address public MODULE_PRIZES;
    /**
     * @notice Returns module escalation.
     */
    address public MODULE_ESCALATION;

    /**
     * @notice Returns tier config.
     */
    TierConfig public tierConfig;
    /**
     * @notice Returns tournament.
     */
    TournamentState public tournament;

    /**
     * @notice Returns enrolled players.
     */
    address[] public enrolledPlayers;
    /**
     * @notice Returns whether a player is enrolled.
     */
    mapping(address => bool) public isEnrolled;
    /**
     * @notice Returns rounds.
     */
    mapping(uint8 => Round) public rounds;
    /**
     * @notice Returns matches.
     */
    mapping(bytes32 => Match) public matches;
    /**
     * @notice Returns match timeouts.
     */
    mapping(bytes32 => MatchTimeoutState) public matchTimeouts;
    /**
     * @notice Returns player prizes.
     */
    mapping(address => uint256) public playerPrizes;
    /**
     * @notice Returns draw participants.
     */
    mapping(uint8 => mapping(uint8 => mapping(address => bool))) public drawParticipants;

    bytes32 internal _entropyState;
    uint256 internal _entropyNonce;
    /**
     * @notice Returns player payout reasons.
     */
    mapping(address => PayoutReason) public playerPayoutReasons;

    // V3 fields are append-only below this line.
    /// @notice Session authorization registry used by this tournament instance.
    address public SESSION_REGISTRY;
}
