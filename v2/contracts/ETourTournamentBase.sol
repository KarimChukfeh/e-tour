// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ETourTournamentBase
 * @dev Abstract base contract for a single ETour tournament instance.
 *
 * Replaces ETour_Base for the new factory/instance architecture.
 * Each deployed clone of a game-specific instance contract holds ALL state
 * for exactly one tournament, permanently. No state is ever zeroed or recycled.
 *
 * KEY DIFFERENCES from ETour_Base:
 * - No tierId/instanceId in storage mappings — this contract IS the instance
 * - No resetTournamentAfterCompletion — instances are permanent records
 * - Enrollment window can be reset by the solo enrolled player without cycling instance state
 * - Module addresses come from factory (set at initialize() time)
 * - Fee splits route to factory address (not a hardcoded owner)
 * - Match IDs: keccak256(roundNumber, matchNumber) — no tierId/instanceId
 * - Uses initialize() instead of constructor (EIP-1167 proxy pattern)
 *
 * STORAGE LAYOUT NOTE:
 * Modules execute via delegatecall and access this storage directly.
 * The storage layout here must match what the adapted modules expect.
 * NEVER reorder or insert variables between existing ones.
 */
abstract contract ETourTournamentBase is ReentrancyGuard {

    // ============ Constants ============

    uint256 public constant PARTICIPANTS_SHARE_BPS = 9500;  // 95% to prize pool
    uint256 public constant OWNER_SHARE_BPS = 500;          // 5% to owner
    uint256 public constant BASIS_POINTS = 10000;

    uint8 public constant NO_ROUND = 255;

    bytes32 internal constant ENTROPY_INIT = keccak256("ETOUR_ENTROPY_INIT");
    bytes32 internal constant ENTROPY_ENROLL = keccak256("ETOUR_ENTROPY_ENROLL");
    bytes32 internal constant ENTROPY_MATCH_CREATE = keccak256("ETOUR_ENTROPY_MATCH_CREATE");
    bytes32 internal constant ENTROPY_MATCH_RESTART = keccak256("ETOUR_ENTROPY_MATCH_RESTART");
    bytes32 internal constant ENTROPY_MATCH_RESULT = keccak256("ETOUR_ENTROPY_MATCH_RESULT");
    bytes32 internal constant ENTROPY_WALKOVER = keccak256("ETOUR_ENTROPY_WALKOVER");

    // ============ Enums ============

    enum TournamentStatus { Enrolling, InProgress, Concluded }
    enum MatchStatus { NotStarted, InProgress, Completed }

    enum EscalationLevel {
        None,
        Escalation0_SoloCancel,
        Escalation1_OpponentClaim,
        Escalation2_AdvancedPlayers,
        Escalation3_ExternalPlayers
    }

    enum MatchCompletionCategory {
        None,
        MatchResult,
        Escalation
    }

    // Resolution code legend:
    // - R0  -> Normal Resolution (win)
    // - R1  -> Draw Resolution
    // - R2  -> Uncontested Finals Resolution (finalist auto-wins because everyone in the previous round drew)
    // - EL0 -> Tournament Canceled (by solo enrolled player)
    // - EL2 -> Abandoned Pool Claimed (tournament never started so pool was claimed by outsider)
    // - ML1 -> Timeout (match/tournament ended because player claimed Timeout victory)
    // - ML2 -> Force Elimination (match/tournament ended because advanced player force eliminated both players in stalled match)
    // - ML3 -> Replacement (match/tournament ended because outside player replaced both players in stalled match)
    enum MatchCompletionReason {
        NormalWin,                  // 0 (R0): Normal Resolution (win)
        Timeout,                    // 1 (ML1): Timeout victory claimed
        Draw,                       // 2 (R1): Draw Resolution
        ForceElimination,           // 3 (ML2): Advanced player force eliminated both stalled players
        Replacement                 // 4 (ML3): Outside player replaced both stalled players
    }

    enum TournamentResolutionCategory {
        None,
        MatchResult,
        Escalation,
        DrawResolution,
        EnrollmentResolution
    }

    enum TournamentResolutionReason {
        NormalWin,                  // 0 (R0): Normal Resolution (win)
        Timeout,                    // 1 (ML1): Timeout victory claimed
        Draw,                       // 2 (R1): Draw Resolution
        ForceElimination,           // 3 (ML2): Advanced player force eliminated both stalled players
        Replacement,                // 4 (ML3): Outside player replaced both stalled players
        SoloEnrollCancelled,        // 5 (EL0): Tournament Canceled by solo enrolled player
        AbandonedTournamentClaimed, // 6 (EL2): Abandoned pool claimed by outsider
        UncontestedFinalsWin        // 7 (R2): Finalist auto-wins because everyone in the previous round drew
    }

    enum PlayerMatchOutcomeCategory {
        None,
        Victory,
        Defeat,
        Draw
    }

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

    enum PayoutReason {
        None,
        Victory,
        EvenSplit,
        WalletRejected,
        Cancelation
    }

    // ============ Structs ============

    struct TimeoutConfig {
        uint256 matchTimePerPlayer;
        uint256 timeIncrementPerMove;
        uint256 matchLevel2Delay;
        uint256 matchLevel3Delay;
        uint256 enrollmentWindow;
        uint256 enrollmentLevel2Delay;
    }

    /**
     * @dev Tier config is set once at initialize() and never changes.
     * instanceCount and initialized fields are dropped — not needed per-instance.
     */
    struct TierConfig {
        uint8 playerCount;
        uint256 entryFee;
        TimeoutConfig timeouts;
        uint8 totalRounds;          // log2(playerCount)
        bytes32 tierKey;            // keccak256(playerCount, entryFee) — for factory grouping
    }

    struct EnrollmentTimeoutState {
        uint256 escalation1Start;
        uint256 escalation2Start;
        EscalationLevel activeEscalation;
        uint256 forfeitPool;
    }

    /**
     * @dev Single tournament state — replaces tournaments[tierId][instanceId].
     * This struct IS the tournament; there is only one per instance.
     */
    struct TournamentState {
        TournamentStatus status;
        uint8 currentRound;
        uint8 enrolledCount;
        uint256 totalEntryFeesAccrued; // Gross entry fees collected for this instance
        uint256 prizePool;      // 95% of entry fees — distributed to winner(s)
        uint256 ownerAccrued;   // 5% of entry fees — sent to factory at conclusion for immediate owner payout
        uint256 protocolAccrued; // Deprecated raffle bucket, kept only for layout compatibility
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
        uint256 raffleAwarded;  // Deprecated raffle tracking, kept only for layout compatibility
        address raffleRecipient; // Deprecated raffle tracking, kept only for layout compatibility
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
        // Game-owned state slots. Infra should treat these as opaque and use
        // _getGameStateHash(matchId) when it needs a generic fingerprint.
        uint256 packedBoard;
        uint256 packedState;
        uint256 startTime;
        uint256 lastMoveTime;
        uint256 player1TimeRemaining;
        uint256 player2TimeRemaining;
        // Game-owned move/event transcript. Games may encode however they want.
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

    // ============ Initialization Guard ============

    bool private _initialized;

    // ============ Instance Identity (set at initialize) ============

    address public factory;          // Parent factory — receives fee splits
    address public creator;          // Who called factory.createInstance()
    address public MODULE_CORE;
    address public MODULE_MATCHES;
    address public MODULE_PRIZES;
    address public MODULE_ESCALATION;

    // Delegatecall protection (same pattern as ETour_Base)
    // immutable — burned into bytecode, not overwritten by delegatecall storage context
    address internal immutable _self;

    // ============ Tier Configuration (set once at initialize) ============

    TierConfig public tierConfig;

    // ============ Tournament State (single instance, flat storage) ============

    TournamentState public tournament;

    address[] public enrolledPlayers;
    mapping(address => bool) public isEnrolled;
    mapping(uint8 => Round) public rounds;

    // Match data: key = keccak256(roundNumber, matchNumber)
    mapping(bytes32 => Match) public matches;
    mapping(bytes32 => MatchTimeoutState) public matchTimeouts;

    // Prize tracking: key = player address
    mapping(address => uint256) public playerPrizes;

    // Draw tracking: drawParticipants[roundNumber][matchNumber][player]
    mapping(uint8 => mapping(uint8 => mapping(address => bool))) public drawParticipants;

    // Tournament-scoped entropy accumulator used for lightweight in-protocol random draws.
    // Appended at the end of storage to preserve module layout compatibility.
    bytes32 private _entropyState;
    uint256 private _entropyNonce;
    mapping(address => PayoutReason) public playerPayoutReasons;

    // ============ Events ============

    event PlayerEnrolled(address indexed player, address indexed instance);
    event TournamentStarted(address indexed instance, uint8 playerCount);
    event TournamentConcluded(
        address indexed instance,
        address winner,
        TournamentResolutionReason reason,
        TournamentResolutionCategory category
    );
    event MatchCompleted(
        address indexed instance,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason,
        MatchCompletionCategory category
    );
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ============ Constructor ============

    constructor() {
        _self = address(this);
    }

    // ============ Initializer ============

    /**
     * @dev Initialize this instance clone. Called once by the factory after clone deployment.
     * Replaces constructor (EIP-1167 proxies cannot use constructors).
     */
    function initialize(
        TierConfig memory _tierConfig,
        address _factory,
        address _creator,
        address _moduleCore,
        address _moduleMatches,
        address _modulePrizes,
        address _moduleEscalation
    ) external {
        require(!_initialized, "Already initialized");
        _initialized = true;

        tierConfig = _tierConfig;
        factory = _factory;
        creator = _creator;
        MODULE_CORE = _moduleCore;
        MODULE_MATCHES = _moduleMatches;
        MODULE_PRIZES = _modulePrizes;
        MODULE_ESCALATION = _moduleEscalation;

        tournament.status = TournamentStatus.Enrolling;
        tournament.createdAt = block.timestamp;

        _mixEntropy(
            ENTROPY_INIT,
            keccak256(abi.encodePacked(
                _factory,
                _creator,
                _tierConfig.playerCount,
                _tierConfig.entryFee,
                _tierConfig.totalRounds
            ))
        );
    }

    // ============ Modifiers ============

    modifier onlyDelegateCall() {
        require(address(this) != _self, "Must be called via delegatecall");
        _;
    }

    modifier onlySelfCall() {
        require(msg.sender == address(this), "Only self");
        _;
    }

    /**
     * @dev Reverts if instance has concluded — no writes allowed after conclusion.
     */
    modifier notConcluded() {
        require(tournament.status != TournamentStatus.Concluded, "Instance concluded");
        _;
    }

    // ============ Match ID Helper ============

    /**
     * @dev Generate match ID. No tierId/instanceId — instance IS the tournament.
     */
    function _getMatchId(uint8 roundNumber, uint8 matchNumber) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(roundNumber, matchNumber));
    }

    function _previousBlockHash() internal view returns (bytes32) {
        if (block.number == 0) return bytes32(0);
        return blockhash(block.number - 1);
    }

    function _mixEntropy(bytes32 domain, bytes32 salt) internal returns (bytes32 mixed) {
        mixed = keccak256(abi.encodePacked(
            _entropyState,
            domain,
            salt,
            _entropyNonce,
            address(this),
            creator,
            block.prevrandao,
            _previousBlockHash(),
            tournament.status,
            tournament.currentRound,
            tournament.enrolledCount,
            tournament.totalEntryFeesAccrued
        ));
        _entropyState = mixed;
        unchecked {
            ++_entropyNonce;
        }
    }

    function _drawRandomIndex(bytes32 domain, bytes32 salt, uint256 upperBound)
        internal
        returns (uint256)
    {
        require(upperBound > 0, "RB");
        return uint256(_mixEntropy(domain, salt)) % upperBound;
    }

    function _drawRandomStarter(
        bytes32 domain,
        bytes32 salt,
        address player1,
        address player2
    ) internal returns (address starter) {
        return _drawRandomIndex(domain, salt, 2) == 0 ? player1 : player2;
    }

    function _drawRandomizedPlayerOrder(
        bytes32 domain,
        bytes32 salt,
        address player1,
        address player2
    ) internal returns (address first, address second) {
        if (_drawRandomIndex(domain, salt, 2) == 0) {
            return (player1, player2);
        }
        return (player2, player1);
    }

    // ============ Math Helpers ============

    function _log2(uint8 x) internal pure returns (uint8) {
        uint8 result = 0;
        while (x > 1) {
            x /= 2;
            result++;
        }
        return result;
    }

    function _matchCompletionCategoryFor(MatchCompletionReason reason)
        internal
        pure
        returns (MatchCompletionCategory)
    {
        if (
            reason == MatchCompletionReason.ForceElimination ||
            reason == MatchCompletionReason.Replacement
        ) {
            return MatchCompletionCategory.Escalation;
        }
        return MatchCompletionCategory.MatchResult;
    }

    function _tournamentResolutionCategoryFor(TournamentResolutionReason reason)
        internal
        pure
        returns (TournamentResolutionCategory)
    {
        if (
            reason == TournamentResolutionReason.SoloEnrollCancelled ||
            reason == TournamentResolutionReason.AbandonedTournamentClaimed
        ) {
            return TournamentResolutionCategory.EnrollmentResolution;
        }
        if (reason == TournamentResolutionReason.Draw) {
            return TournamentResolutionCategory.DrawResolution;
        }
        if (
            reason == TournamentResolutionReason.ForceElimination ||
            reason == TournamentResolutionReason.Replacement
        ) {
            return TournamentResolutionCategory.Escalation;
        }
        return TournamentResolutionCategory.MatchResult;
    }

    function _setTournamentResolution(TournamentResolutionReason reason) internal {
        tournament.completionReason = reason;
        tournament.completionCategory = _tournamentResolutionCategoryFor(reason);
    }

    function _getPlayerRegistry() internal view returns (address reg) {
        (bool ok, bytes memory ret) = factory.staticcall(
            abi.encodeWithSignature("PLAYER_REGISTRY()")
        );
        if (ok && ret.length >= 32) {
            reg = abi.decode(ret, (address));
        }
    }

    function _recordPlayerMatchOutcome(
        address player,
        uint8 roundNumber,
        uint8 matchNumber,
        PlayerMatchOutcome outcome,
        PlayerMatchOutcomeCategory category,
        MatchCompletionReason resolutionReason
    ) internal {
        if (player == address(0) || outcome == PlayerMatchOutcome.None) return;

        address reg = _getPlayerRegistry();
        if (reg == address(0)) return;

        // Replacement winners may need first-time profile creation plus a
        // match write; give the registry enough headroom to complete that.
        (bool recorded, ) = reg.call{gas: 400_000}(
            abi.encodeWithSignature(
                "recordMatchOutcome(address,address,uint8,uint8,uint8,uint8,uint8)",
                player,
                address(this),
                roundNumber,
                matchNumber,
                uint8(outcome),
                uint8(category),
                uint8(resolutionReason)
            )
        );
        recorded;
    }

    function _recordStandardMatchOutcomes(
        Match storage m,
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason
    ) internal {
        if (isDraw) {
            _recordPlayerMatchOutcome(
                m.player1,
                roundNumber,
                matchNumber,
                PlayerMatchOutcome.Draw,
                PlayerMatchOutcomeCategory.Draw,
                reason
            );
            _recordPlayerMatchOutcome(
                m.player2,
                roundNumber,
                matchNumber,
                PlayerMatchOutcome.Draw,
                PlayerMatchOutcomeCategory.Draw,
                reason
            );
            return;
        }

        if (reason == MatchCompletionReason.Timeout) {
            _recordPlayerMatchOutcome(
                winner,
                roundNumber,
                matchNumber,
                PlayerMatchOutcome.TimeoutVictory,
                PlayerMatchOutcomeCategory.Victory,
                reason
            );
            _recordPlayerMatchOutcome(
                winner == m.player1 ? m.player2 : m.player1,
                roundNumber,
                matchNumber,
                PlayerMatchOutcome.TimeoutDefeat,
                PlayerMatchOutcomeCategory.Defeat,
                reason
            );
            return;
        }

        _recordPlayerMatchOutcome(
            winner,
            roundNumber,
            matchNumber,
            PlayerMatchOutcome.NormalVictory,
            PlayerMatchOutcomeCategory.Victory,
            reason
        );
        _recordPlayerMatchOutcome(
            winner == m.player1 ? m.player2 : m.player1,
            roundNumber,
            matchNumber,
            PlayerMatchOutcome.NormalDefeat,
            PlayerMatchOutcomeCategory.Defeat,
            reason
        );
    }

    function _recordEscalationMatchOutcomes(
        Match storage m,
        uint8 roundNumber,
        uint8 matchNumber,
        address actor,
        MatchCompletionReason reason
    ) internal {
        PlayerMatchOutcome victoryOutcome = reason == MatchCompletionReason.Replacement
            ? PlayerMatchOutcome.ReplacementVictory
            : PlayerMatchOutcome.ForceEliminationVictory;
        PlayerMatchOutcome defeatOutcome = reason == MatchCompletionReason.Replacement
            ? PlayerMatchOutcome.ReplacementDefeat
            : PlayerMatchOutcome.ForceEliminationDefeat;

        _recordPlayerMatchOutcome(
            m.player1,
            roundNumber,
            matchNumber,
            defeatOutcome,
            PlayerMatchOutcomeCategory.Defeat,
            reason
        );
        _recordPlayerMatchOutcome(
            m.player2,
            roundNumber,
            matchNumber,
            defeatOutcome,
            PlayerMatchOutcomeCategory.Defeat,
            reason
        );
        _recordPlayerMatchOutcome(
            actor,
            roundNumber,
            matchNumber,
            victoryOutcome,
            PlayerMatchOutcomeCategory.Victory,
            reason
        );
    }

    // ============ Match Completion (shared internal logic) ============

    function _completeMatchInternal(
        uint8 roundNumber,
        uint8 matchNumber,
        address winner,
        bool isDraw,
        MatchCompletionReason reason
    ) internal {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];

        m.winner = isDraw ? address(0) : winner;
        m.isDraw = isDraw;
        m.status = MatchStatus.Completed;
        m.completionReason = reason;
        m.completionCategory = _matchCompletionCategoryFor(reason);

        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        timeout.isStalled = false;
        timeout.escalation1Start = 0;
        timeout.escalation2Start = 0;
        timeout.activeEscalation = EscalationLevel.None;

        _mixEntropy(
            ENTROPY_MATCH_RESULT,
            keccak256(abi.encodePacked(
                roundNumber,
                matchNumber,
                m.player1,
                m.player2,
                winner,
                isDraw,
                uint8(reason),
                _getGameStateHash(matchId),
                m.startTime,
                m.lastMoveTime
            ))
        );

        (bool completeSuccess, ) = MODULE_MATCHES.delegatecall(
            abi.encodeWithSignature(
                "completeMatch(uint8,uint8,address,bool,uint8)",
                roundNumber, matchNumber, winner, isDraw, uint8(reason)
            )
        );
        require(completeSuccess, "CM");

        _recordStandardMatchOutcomes(m, roundNumber, matchNumber, winner, isDraw, reason);

        emit MatchCompleted(
            address(this),
            roundNumber,
            matchNumber,
            winner,
            isDraw,
            m.completionReason,
            m.completionCategory
        );

        _handleTournamentConclusion();
    }

    function _handleTournamentConclusion() internal {
        if (tournament.status != TournamentStatus.Concluded) {
            return;
        }

        address tournamentWinner = tournament.winner;
        uint256 winnersPot = tournament.prizePool;
        if (tournament.completionReason != TournamentResolutionReason.SoloEnrollCancelled) {
            tournament.prizeAwarded = 0;
            tournament.prizeRecipient = tournamentWinner;
        }
        // ── Step 1: Distribute prize pool (95%) to winner(s) ──────────────────
        // Skip if prizePool is 0 — happens on EL0 solo cancel where the full
        // refund was already sent and all buckets zeroed before conclusion.
        address[] memory winners;
        uint256[] memory prizes;

        if (winnersPot == 0) {
            // EL0 solo cancel: refund already sent, nothing to distribute
            winners = new address[](0);
            prizes  = new uint256[](0);
        } else if (tournament.allDrawResolution) {
            (bool ok, bytes memory ret) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributeEqualPrizes(address[],uint256)",
                    enrolledPlayers, winnersPot)
            );
            require(ok, "DP");
            (winners, prizes) = abi.decode(ret, (address[], uint256[]));
        } else if (tournament.finalsWasDraw) {
            bytes32 finalMatchId = _getMatchId(tournament.actualTotalRounds - 1, 0);
            Match storage finalMatch = matches[finalMatchId];
            address[] memory finalists = new address[](2);
            finalists[0] = finalMatch.player1;
            finalists[1] = finalMatch.player2;
            (bool ok, bytes memory ret) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributeEqualPrizes(address[],uint256)",
                    finalists, winnersPot)
            );
            require(ok, "DP");
            (winners, prizes) = abi.decode(ret, (address[], uint256[]));
        } else {
            (bool ok, bytes memory ret) = MODULE_PRIZES.delegatecall(
                abi.encodeWithSignature("distributePrizes(uint256)", winnersPot)
            );
            require(ok, "DP");
            (winners, prizes) = abi.decode(ret, (address[], uint256[]));
        }

        for (uint256 i = 0; i < winners.length; i++) {
            if (prizes[i] > 0) {
                emit Transfer(address(this), winners[i], prizes[i]);
            }
        }

        if (winners.length == 1 && winners[0] == tournamentWinner) {
            tournament.prizeAwarded = prizes[0];
        }

        emit TournamentConcluded(
            address(this),
            tournamentWinner,
            tournament.completionReason,
            tournament.completionCategory
        );

        // ── Step 2: Profile callbacks — push final result to each player's profile ─
        // Best-effort: individual failures must never revert conclusion.
        // Keep this ahead of the deferred owner-share call so gas estimation for
        // ordinary user actions includes the profile writes instead of starving
        // later callbacks and silently leaving records unresolved.
        address reg = _getPlayerRegistry();
        if (reg != address(0)) {
            for (uint256 i = 0; i < enrolledPlayers.length; i++) {
                _recordPlayerProfileResult(reg, enrolledPlayers[i]);
            }

            // EL2 can conclude with an external claimer as winner; ensure they
            // still get a profile result after their synthetic zero-fee enrollment.
            if (tournamentWinner != address(0) && !isEnrolled[tournamentWinner]) {
                _recordPlayerProfileResult(reg, tournamentWinner);
            }
        }

        // ── Step 3: Send deferred owner share (5%) to factory ─────────────────
        // Always call receiveOwnerShare() even if ownerShare == 0 (EL1/EL2).
        // The factory uses this call to move the instance from activeTournaments
        // → pastTournaments and immediately forwards the owner share when possible.
        uint256 ownerShare = tournament.ownerAccrued;
        {
            // Best-effort — failure leaves funds on instance for rescue
            (bool _ownerOk, ) = factory.call{value: ownerShare}(
                abi.encodeWithSignature("receiveOwnerShare()")
            );
            _ownerOk;
        }
    }

    // ============ Abstract Functions (implemented by game contracts) ============

    function moduleCreateMatch(
        uint8 roundNumber,
        uint8 matchNumber,
        address player1,
        address player2
    ) public virtual;

    function moduleResetMatch(bytes32 matchId) public virtual;

    function moduleGetMatchResult(bytes32 matchId)
        public view virtual onlySelfCall
        returns (address winner, bool isDraw, MatchStatus status)
    {
        Match storage m = matches[matchId];
        return (m.winner, m.isDraw, m.status);
    }

    function moduleGetMatchPlayers(bytes32 matchId)
        public view virtual onlySelfCall
        returns (address player1, address player2)
    {
        Match storage matchData = matches[matchId];
        return (matchData.player1, matchData.player2);
    }

    function moduleSetMatchPlayer(bytes32 matchId, uint8 slot, address player) public virtual onlySelfCall {
        Match storage matchData = matches[matchId];
        if (slot == 0) {
            matchData.player1 = player;
        } else {
            matchData.player2 = player;
        }
    }

    function moduleInitializeMatchForPlay(bytes32 matchId) public virtual;

    function moduleCompleteMatchWithResult(bytes32 matchId, address winner, bool isDraw) public virtual onlySelfCall {
        Match storage m = matches[matchId];
        m.status = MatchStatus.Completed;
        m.winner = isDraw ? address(0) : winner;
        m.isDraw = isDraw;
    }

    function moduleHasCurrentPlayerTimedOut(bytes32 matchId) public view virtual onlySelfCall returns (bool) {
        Match storage m = matches[matchId];
        if (m.status != MatchStatus.InProgress) return false;
        uint256 elapsed = block.timestamp - m.lastMoveTime;
        uint256 currentPlayerTime = (m.currentTurn == m.player1)
            ? m.player1TimeRemaining
            : m.player2TimeRemaining;
        return elapsed >= currentPlayerTime;
    }

    function moduleIsMatchActive(bytes32 matchId) public view virtual onlySelfCall returns (bool) {
        Match storage matchData = matches[matchId];
        return matchData.player1 != address(0) && matchData.status != MatchStatus.Completed;
    }

    function moduleGetActiveMatchData(
        bytes32 matchId,
        uint8 roundNumber,
        uint8 matchNumber
    ) public view virtual onlySelfCall returns (CommonMatchData memory) {
        Match storage matchData = matches[matchId];
        address loser = address(0);
        if (!matchData.isDraw && matchData.winner != address(0)) {
            loser = (matchData.winner == matchData.player1)
                ? matchData.player2
                : matchData.player1;
        }
        return CommonMatchData({
            player1: matchData.player1,
            player2: matchData.player2,
            winner: matchData.winner,
            loser: loser,
            status: matchData.status,
            isDraw: matchData.isDraw,
            startTime: matchData.startTime,
            lastMoveTime: matchData.lastMoveTime,
            roundNumber: roundNumber,
            matchNumber: matchNumber,
            isCached: false
        });
    }

    function _registerPlayerProfileEnrollment(address player, uint256 entryFee) internal {
        (bool regOk, ) = factory.call(
            abi.encodeWithSignature("registerPlayer(address,uint256)", player, entryFee)
        );
        regOk;
    }

    function _recordPlayerProfileResult(address reg, address player) internal {
        bool won = (tournament.winner == player);
        uint256 prize = tournament.prizePool;
        uint256 payout = playerPrizes[player];
        PayoutReason payoutReason = playerPayoutReasons[player];

        if (tournament.completionReason == TournamentResolutionReason.SoloEnrollCancelled) {
            prize = 0;
            payoutReason = PayoutReason.Cancelation;
        }

        // Keep a cap so profile writes can't dominate conclusion gas, but leave
        // enough headroom for the registry validation path plus profile SSTOREs.
        (bool recorded, ) = reg.call{gas: 400_000}(
            abi.encodeWithSignature(
                "recordResult(address,address,bool,uint256,uint256,uint8,uint8)",
                player,
                address(this),
                won,
                prize,
                payout,
                uint8(payoutReason),
                uint8(tournament.completionReason)
            )
        );
        recorded;
    }

    /**
     * @dev Generic fingerprint for game-owned state. Infrastructure should use
     * this hook instead of directly depending on packedBoard/packedState/moves.
     */
    function _getGameStateHash(bytes32 matchId) internal view virtual returns (bytes32) {
        Match storage m = matches[matchId];
        return keccak256(abi.encodePacked(m.packedBoard, m.packedState, m.moves));
    }

    function initializeRound(uint8 roundNumber) public payable virtual;

    // ============ Public Enrollment ============

    function enrollInTournament() external payable virtual notConcluded {
        TournamentStatus oldStatus = tournament.status;

        // Register player on factory — routes to PlayerRegistry (best effort)
        // Do this before the heavier enrollment delegatecall so first-time
        // profile creation has enough gas to deploy and initialize the clone.
        (bool regOk, ) = factory.call(
            abi.encodeWithSignature("registerPlayer(address,uint256)", msg.sender, tierConfig.entryFee)
        );
        regOk; // intentionally ignore

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreEnroll()")
        );
        require(success, "Enrollment failed");

        _mixEntropy(
            ENTROPY_ENROLL,
            keccak256(abi.encodePacked(
                msg.sender,
                tournament.enrolledCount,
                tournament.totalEntryFeesAccrued
            ))
        );

        if (oldStatus == TournamentStatus.Enrolling &&
            tournament.status == TournamentStatus.InProgress) {
            initializeRound(0);
            emit TournamentStarted(address(this), tournament.enrolledCount);
        }

        emit PlayerEnrolled(msg.sender, address(this));
    }

    /**
     * @dev Enroll a specific player on their behalf. Only callable by the factory.
     * Used by createInstance() to auto-enroll the creator without changing msg.sender context.
     */
    function enrollOnBehalf(address player) external payable notConcluded {
        require(msg.sender == factory, "Only factory");
        TournamentStatus oldStatus = tournament.status;

        // Register player on factory — routes to PlayerRegistry (best effort)
        // Do this before the heavier enrollment delegatecall so first-time
        // profile creation has enough gas to deploy and initialize the clone.
        (bool regOk, ) = factory.call(
            abi.encodeWithSignature("registerPlayer(address,uint256)", player, tierConfig.entryFee)
        );
        regOk;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreEnrollOnBehalf(address)", player)
        );
        require(success, "Enrollment failed");

        _mixEntropy(
            ENTROPY_ENROLL,
            keccak256(abi.encodePacked(
                player,
                tournament.enrolledCount,
                tournament.totalEntryFeesAccrued
            ))
        );

        if (oldStatus == TournamentStatus.Enrolling &&
            tournament.status == TournamentStatus.InProgress) {
            initializeRound(0);
            emit TournamentStarted(address(this), tournament.enrolledCount);
        }

        emit PlayerEnrolled(player, address(this));
    }

    function forceStartTournament() external virtual notConcluded {
        TournamentStatus oldStatus = tournament.status;

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreForceStart()")
        );
        require(success, "Force start failed");

        TournamentStatus newStatus = tournament.status;
        if (oldStatus != TournamentStatus.Enrolling) return;

        if (newStatus == TournamentStatus.InProgress) {
            initializeRound(0);
            emit TournamentStarted(address(this), tournament.enrolledCount);
            return;
        }

        if (newStatus == TournamentStatus.Concluded) {
            _handleTournamentConclusion();
        }
    }

    function cancelTournament() external virtual notConcluded {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreCancelTournament()")
        );
        require(success, "Cancel failed");
        _handleTournamentConclusion();
    }

    function resetEnrollmentWindow() external virtual notConcluded {
        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreResetEnrollmentWindow()")
        );
        require(success, "Reset failed");
    }

    function canForceStartTournament() external view returns (bool) {
        return tournament.status == TournamentStatus.Enrolling &&
            isEnrolled[msg.sender] &&
            block.timestamp >= tournament.enrollmentTimeout.escalation1Start &&
            tournament.enrolledCount >= 2;
    }

    function canCancelTournament() external view returns (bool) {
        return tournament.status == TournamentStatus.Enrolling &&
            isEnrolled[msg.sender] &&
            tournament.enrolledCount == 1;
    }

    function canResetEnrollmentWindow() external view returns (bool) {
        return tournament.status == TournamentStatus.Enrolling &&
            isEnrolled[msg.sender] &&
            tournament.enrolledCount == 1;
    }

    /**
     * @dev Rescue any ETH stuck on a concluded instance (e.g. failed prize or owner-share transfer).
     * Only callable by the factory owner.
     */
    function rescueStuckFunds(address to) external {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSignature("owner()"));
        require(ok && abi.decode(ret, (address)) == msg.sender, "Not factory owner");
        require(tournament.status == TournamentStatus.Concluded, "Not concluded");
        uint256 balance = address(this).balance;
        require(balance > 0, "Nothing to rescue");
        (bool sent, ) = payable(to).call{value: balance}("");
        require(sent, "Transfer failed");
    }

    function claimAbandonedPool() external notConcluded {
        bool claimerWasEnrolled = isEnrolled[msg.sender];

        (bool success, ) = MODULE_CORE.delegatecall(
            abi.encodeWithSignature("coreClaimAbandonedPool()")
        );
        require(success, "Claim failed");

        if (!claimerWasEnrolled) {
            _registerPlayerProfileEnrollment(msg.sender, 0);
        }

        _handleTournamentConclusion();
    }

    // ============ Escalation: Claim Timeout Win ============

    function claimTimeoutWin(uint8 roundNumber, uint8 matchNumber) external nonReentrant notConcluded {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.InProgress, "MA");
        require(msg.sender == matchData.player1 || msg.sender == matchData.player2, "NP");
        require(msg.sender != matchData.currentTurn, "OT");

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 opponentTimeRemaining = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;

        require(elapsed >= opponentTimeRemaining, "TO");

        (bool markSuccess, ) = MODULE_ESCALATION.delegatecall(
            abi.encodeWithSignature(
                "markMatchStalled(bytes32,uint256)",
                matchId, block.timestamp
            )
        );
        require(markSuccess, "MS");

        _completeMatchInternal(roundNumber, matchNumber, msg.sender, false, MatchCompletionReason.Timeout);
    }

    // ============ Escalation Availability Views ============

    function isMatchEscL2Available(uint8 roundNumber, uint8 matchNumber) external view returns (bool) {
        if (tournament.status != TournamentStatus.InProgress) return false;

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (matchData.player1 == address(0) || matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;
        if (elapsed < currentPlayerTime) return false;

        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            uint256 timeoutAt = matchData.lastMoveTime + tierConfig.timeouts.matchTimePerPlayer;
            return block.timestamp >= timeoutAt + tierConfig.timeouts.matchLevel2Delay;
        }
        return block.timestamp >= timeout.escalation1Start;
    }

    function isMatchEscL3Available(uint8 roundNumber, uint8 matchNumber) external view returns (bool) {
        if (tournament.status != TournamentStatus.InProgress) return false;

        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage matchData = matches[matchId];

        if (matchData.player1 == address(0) || matchData.status != MatchStatus.InProgress) return false;

        uint256 elapsed = block.timestamp - matchData.lastMoveTime;
        uint256 currentPlayerTime = (matchData.currentTurn == matchData.player1)
            ? matchData.player1TimeRemaining
            : matchData.player2TimeRemaining;
        if (elapsed < currentPlayerTime) return false;

        MatchTimeoutState storage timeout = matchTimeouts[matchId];
        if (!timeout.isStalled) {
            uint256 timeoutAt = matchData.lastMoveTime + tierConfig.timeouts.matchTimePerPlayer;
            return block.timestamp >= timeoutAt + tierConfig.timeouts.matchLevel3Delay;
        }
        return block.timestamp >= timeout.escalation2Start;
    }

    function isPlayerInAdvancedRound(uint8 stalledRoundNumber, address player) external view returns (bool) {
        if (!isEnrolled[player]) return false;

        for (uint8 r = 0; r <= stalledRoundNumber; r++) {
            Round storage round = rounds[r];
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                Match storage matchData = matches[matchId];
                if (
                    matchData.status == MatchStatus.Completed &&
                    matchData.winner == player &&
                    !matchData.isDraw
                ) {
                    return true;
                }
            }
        }

        for (uint8 r = stalledRoundNumber + 1; r < tierConfig.totalRounds; r++) {
            Round storage round = rounds[r];
            if (!round.initialized) continue;
            for (uint8 m = 0; m < round.totalMatches; m++) {
                bytes32 matchId = _getMatchId(r, m);
                Match storage matchData = matches[matchId];
                if (matchData.player1 == player || matchData.player2 == player) return true;
            }
        }
        return false;
    }

    // ============ Permanent Record View Functions ============

    function getInstanceInfo() external view returns (
        bytes32 tierKey,
        uint8 playerCount,
        uint256 entryFee,
        address instanceCreator,
        uint256 createdAt,
        uint256 startTime,
        TournamentStatus status,
        uint8 enrolledCount,
        uint256 totalEntryFeesAccrued,
        address winner,
        TournamentResolutionReason completionReason,
        TournamentResolutionCategory completionCategory,
        uint256 prizeAwarded,
        address prizeRecipient
    ) {
        return (
            tierConfig.tierKey,
            tierConfig.playerCount,
            tierConfig.entryFee,
            creator,
            tournament.createdAt,
            tournament.startTime,
            tournament.status,
            tournament.enrolledCount,
            tournament.totalEntryFeesAccrued,
            tournament.winner,
            tournament.completionReason,
            tournament.completionCategory,
            tournament.prizeAwarded,
            tournament.prizeRecipient
        );
    }

    function getPlayers() external view returns (address[] memory) {
        return enrolledPlayers;
    }

    function getBracket() external view returns (
        uint8 totalRounds,
        uint8[] memory matchCounts,
        uint8[] memory completedCounts
    ) {
        totalRounds = tournament.actualTotalRounds;
        matchCounts = new uint8[](totalRounds);
        completedCounts = new uint8[](totalRounds);
        for (uint8 r = 0; r < totalRounds; r++) {
            matchCounts[r] = rounds[r].totalMatches;
            completedCounts[r] = rounds[r].completedMatches;
        }
    }

    function getMatch(uint8 roundNumber, uint8 matchNumber) external view returns (
        address player1,
        address player2,
        address matchWinner,
        bool isDraw,
        MatchStatus status,
        uint256 startTime,
        uint256 lastMoveTime,
        string memory moves,
        MatchCompletionReason completionReason,
        MatchCompletionCategory completionCategory
    ) {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        Match storage m = matches[matchId];
        return (
            m.player1,
            m.player2,
            m.winner,
            m.isDraw,
            m.status,
            m.startTime,
            m.lastMoveTime,
            m.moves,
            m.completionReason,
            m.completionCategory
        );
    }

    function getMatchMoves(uint8 roundNumber, uint8 matchNumber) external view returns (string memory) {
        bytes32 matchId = _getMatchId(roundNumber, matchNumber);
        return matches[matchId].moves;
    }

    function getPrizeDistribution() external view returns (
        address[] memory players,
        uint256[] memory amounts
    ) {
        players = enrolledPlayers;
        amounts = new uint256[](players.length);
        for (uint256 i = 0; i < players.length; i++) {
            amounts[i] = playerPrizes[players[i]];
        }
    }

    function getPlayerResult(address player) external view returns (
        bool participated,
        uint256 prizeWon,
        bool isWinner,
        uint256 payout,
        PayoutReason payoutReason
    ) {
        participated = isEnrolled[player];
        prizeWon = playerPrizes[player];
        isWinner = (tournament.winner == player);
        payout = playerPrizes[player];
        payoutReason = playerPayoutReasons[player];
    }
}
