// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPlayerProfile.sol";

/**
 * @title PlayerProfile
 * @dev Per-player contract deployed as an EIP-1167 clone by PlayerRegistry.
 *
 * Stores a player's full tournament history and running stats across all game types.
 * Results are pushed automatically when a tournament concludes — no manual sync needed.
 *
 * ACCESS CONTROL:
 * - Only the PlayerRegistry that created this profile can call recordEnrollment/recordResult.
 * - The profile owner has no privileged write access (read-only from their perspective).
 *
 * STORAGE NOTE:
 * Uses initialize() instead of constructor (EIP-1167 proxy pattern).
 * Never reorder existing storage variables.
 */
contract PlayerProfile is IPlayerProfile {

    // ============ Errors ============

    error AlreadyInitialized();
    error Unauthorized();
    error InvalidPagination();

    // ============ Events ============

    event EnrollmentRecorded(address indexed instance, uint8 gameType, uint256 entryFee);
    event ResultRecorded(address indexed instance, bool won, uint256 prize);

    // ============ State ============

    bool private _initialized;

    address public override owner;
    address public registry;

    EnrollmentRecord[] private _enrollments;

    // instance address → index+1 in _enrollments (0 = not found)
    mapping(address => uint256) private _enrollmentIndex;

    PlayerStats private _stats;

    // ============ Initializer ============

    function initialize(address _owner, address _registry) external override {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        owner = _owner;
        registry = _registry;
    }

    // ============ Write Functions (registry only) ============

    /**
     * @dev Record a new tournament enrollment.
     * Called by PlayerRegistry when a player enrolls in any instance.
     */
    function recordEnrollment(
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external override {
        if (msg.sender != registry) revert Unauthorized();

        // Idempotent: ignore duplicate enrollment calls for the same instance
        if (_enrollmentIndex[instance] != 0) return;

        _enrollments.push(EnrollmentRecord({
            instance:   instance,
            gameType:   gameType,
            enrolledAt: uint64(block.timestamp),
            entryFee:   entryFee,
            concluded:  false,
            won:        false,
            prize:      0
        }));

        _enrollmentIndex[instance] = _enrollments.length; // store index+1

        emit EnrollmentRecorded(instance, gameType, entryFee);
    }

    /**
     * @dev Record the result of a concluded tournament.
     * Called by PlayerRegistry when an instance concludes.
     * Idempotent: if already recorded, does nothing.
     */
    function recordResult(
        address instance,
        bool won,
        uint256 prize
    ) external override {
        if (msg.sender != registry) revert Unauthorized();

        uint256 idx1 = _enrollmentIndex[instance];
        if (idx1 == 0) return; // no enrollment record — skip silently
        EnrollmentRecord storage r = _enrollments[idx1 - 1];
        if (r.concluded) return; // already recorded — idempotent

        r.concluded = true;
        r.won       = won;
        r.prize     = prize;

        // Update running stats
        _stats.totalPlayed++;
        if (won) {
            _stats.totalWins++;
        } else {
            _stats.totalLosses++;
        }
        // Net earnings: prize received minus entry fee paid
        _stats.totalNetEarnings += int256(prize) - int256(r.entryFee);

        emit ResultRecorded(instance, won, prize);
    }

    // ============ View Functions ============

    function getStats() external view override returns (PlayerStats memory) {
        return _stats;
    }

    function getEnrollmentCount() external view override returns (uint256) {
        return _enrollments.length;
    }

    /**
     * @dev Paginated enrollment history, newest-first.
     * @param offset Number of records to skip from the most recent.
     * @param limit  Max records to return. Pass 0 for all remaining.
     */
    function getEnrollments(uint256 offset, uint256 limit)
        external view override
        returns (EnrollmentRecord[] memory result)
    {
        uint256 total = _enrollments.length;
        if (offset >= total) return new EnrollmentRecord[](0);

        uint256 available = total - offset;
        uint256 count = (limit == 0 || limit > available) ? available : limit;

        result = new EnrollmentRecord[](count);
        // Return newest-first: index from end
        for (uint256 i = 0; i < count; i++) {
            result[i] = _enrollments[total - 1 - offset - i];
        }
    }

    /**
     * @dev Get a single enrollment record by instance address.
     * Returns a zero-value record if not found (check enrolledAt != 0).
     */
    function getEnrollmentByInstance(address instance)
        external view
        returns (EnrollmentRecord memory)
    {
        uint256 idx1 = _enrollmentIndex[instance];
        if (idx1 == 0) return EnrollmentRecord(address(0), 0, 0, 0, false, false, 0);
        return _enrollments[idx1 - 1];
    }
}
