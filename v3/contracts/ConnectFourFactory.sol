// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ConnectFourInstance.sol";

/**
 * @title ConnectFourFactory
 * @dev Factory contract for Connect Four tournament instances.
 */
contract ConnectFourFactory is ETourFactory {

    /**
     * @notice Initializes the connect four factory constructor.
     * @param moduleCore The module core address.
     * @param moduleMatches The module matches address.
     * @param modulePrizes The module prizes address.
     * @param moduleEscalation The module escalation address.
     * @param playerRegistry The player registry address.
     * @param sessionRegistry The session registry address.
     */
    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry,
        address sessionRegistry
    ) ETourFactory(
        address(new ConnectFourInstance()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry,
        sessionRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 1;
    }
}
