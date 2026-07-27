// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETourFactory.sol";
import "./ConnectFourInstance.sol";

/**
 * @title ConnectFourFactory
 * @dev Factory contract for Connect Four tournament instances.
 */
contract ConnectFourFactory is ETourFactory {

    constructor(
        address moduleCore,
        address moduleMatches,
        address modulePrizes,
        address moduleEscalation,
        address playerRegistry
    ) ETourFactory(
        address(new ConnectFourInstance()),
        moduleCore,
        moduleMatches,
        modulePrizes,
        moduleEscalation,
        playerRegistry
    ) { }

    function _gameType() internal pure override returns (uint8) {
        return 1;
    }
}
