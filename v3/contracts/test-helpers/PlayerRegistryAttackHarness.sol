// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* solhint-disable func-visibility, immutable-vars-naming, use-natspec */

interface IRegistryAttackTarget {
    function recordEnrollment(
        address player,
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external;

    function recordResult(
        address player,
        address instance,
        bool won,
        uint256 prize,
        uint256 payout,
        uint8 payoutReason,
        uint8 tournamentResolutionReason
    ) external;

    function recordMatchOutcome(
        address player,
        address instance,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 outcome,
        uint8 category
    ) external;
}

/**
 * @dev Adversarial helper that can impersonate an instance's factory() getter
 * without being a clone recognized by that factory.
 */
contract PlayerRegistryAttackHarness {
    address public immutable factory;

    constructor(address parentFactory) {
        factory = parentFactory;
    }

    function forwardEnrollment(
        address registry,
        address player,
        address instance,
        uint8 gameType,
        uint256 entryFee
    ) external {
        IRegistryAttackTarget(registry).recordEnrollment(
            player,
            instance,
            gameType,
            entryFee
        );
    }

    function forwardResult(
        address registry,
        address player,
        address instance,
        bool won,
        uint256 prize,
        uint256 payout,
        uint8 payoutReason,
        uint8 tournamentResolutionReason
    ) external {
        IRegistryAttackTarget(registry).recordResult(
            player,
            instance,
            won,
            prize,
            payout,
            payoutReason,
            tournamentResolutionReason
        );
    }

    function forwardMatchOutcome(
        address registry,
        address player,
        address instance,
        uint8 roundNumber,
        uint8 matchNumber,
        uint8 outcome,
        uint8 category
    ) external {
        IRegistryAttackTarget(registry).recordMatchOutcome(
            player,
            instance,
            roundNumber,
            matchNumber,
            outcome,
            category
        );
    }
}
