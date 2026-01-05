// Check if player tracking functions are in ABI
import { expect } from "chai";
import hre from "hardhat";

describe("Test ABI", function () {
    it("Should check if player tracking functions exist in TicTacChain ABI", async function () {
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        const abi = TicTacChain.interface;
        
        // Check for player tracking getter functions
        const functions = [
            "playerEnrollingTournaments",
            "playerActiveTournaments",
            "getPlayerEnrollingTournaments",
            "getPlayerActiveTournaments",
            "isPlayerInTournament"
        ];
        
        console.log("\n=== Checking TicTacChain ABI ===");
        functions.forEach(fname => {
            try {
                const fragment = abi.getFunction(fname);
                console.log(`✅ ${fname}: EXISTS`);
            } catch (error) {
                console.log(`❌ ${fname}: NOT FOUND`);
            }
        });
        
        // Also check PlayerTrackingModule
        const PlayerTrackingModule = await hre.ethers.getContractFactory("contracts/modules/PlayerTrackingModule.sol:PlayerTrackingModule");
        const moduleAbi = PlayerTrackingModule.interface;
        
        console.log("\n=== Checking PlayerTrackingModule ABI ===");
        functions.forEach(fname => {
            try {
                const fragment = moduleAbi.getFunction(fname);
                console.log(`✅ ${fname}: EXISTS`);
            } catch (error) {
                console.log(`❌ ${fname}: NOT FOUND`);
            }
        });
    });
});
