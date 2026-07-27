# V3 Copied-Baseline Compiler Warnings

Captured on 2026-07-27 from a clean V3 compile using:

- Node.js `22.21.0`
- Hardhat `2.27.0`
- `@nomicfoundation/hardhat-ethers` `3.1.2`
- Solidity `0.8.20`
- optimizer enabled with 1 run
- `viaIR: true`

The copied baseline compiles successfully but emits 42 warnings:

| Warning category | Count | Location |
|---|---:|---|
| Unreachable code | 11 | `ETourInstance_Base.sol` and OpenZeppelin `ReentrancyGuard.sol` |
| Unused function parameter | 4 | `ETourInstance_Base.sol` |
| Function mutability can be restricted to `pure` | 27 | V2-style delegatecall module stubs |

## Unreachable-code locations

- `ETourInstance_Base.sol`: lines 636, 659, 667, 669, 822, 928, 967, 986, 1137, and 1140.
- `@openzeppelin/contracts/utils/ReentrancyGuard.sol`: line 61.

## Unused-parameter locations

- `ETourInstance_Base.sol`: parameters at lines 888–891.

## Mutability-warning distribution

- `ETourInstance_Core.sol`: 7.
- `ETourInstance_Escalation.sol`: 7.
- `ETourInstance_Matches.sol`: 6.
- `ETourInstance_Prizes.sol`: 7.

These are baseline evidence, not accepted final-state warnings. The V3 plan already
requires removing the inherited module stubs and eliminating or explicitly
resolving every unreachable-code warning before release.
