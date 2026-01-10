import hre from "hardhat";
import { expect } from "chai";

describe("Chess Advanced Draw Rules", function () {
    let chess;
    let whitePlayer, blackPlayer;
    const ENTRY_FEE = hre.ethers.parseEther("0.003"); // Chess uses 0.01 ETH for tier 0

    // PieceType enum values matching the contract
    const PieceType = {
        None: 0,
        Pawn: 1,
        Knight: 2,
        Bishop: 3,
        Rook: 4,
        Queen: 5,
        King: 6
    };

    beforeEach(async function () {
        [, whitePlayer, blackPlayer] = await hre.ethers.getSigners();

        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy();
    });
});
