// scripts/deploy-modules.js
// Helper script to deploy ETour modules

import hre from "hardhat";

/**
 * Deploy all ETour modules and return their addresses
 * @returns {Promise<Object>} Object containing all module addresses
 */
export async function deployModules() {
    console.log("=" .repeat(60));
    console.log("Deploying ETour Modules...");
    console.log("=" .repeat(60));

    // Deploy ETour_Core
    console.log("Deploying ETour_Core...");
    const ETour_Core = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
    const moduleCore = await ETour_Core.deploy();
    await moduleCore.waitForDeployment();
    const moduleCoreAddress = await moduleCore.getAddress();
    console.log("✅ ETour_Core deployed to:", moduleCoreAddress);

    // Deploy ETour_Matches
    console.log("Deploying ETour_Matches...");
    const ETour_Matches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
    const moduleMatches = await ETour_Matches.deploy();
    await moduleMatches.waitForDeployment();
    const moduleMatchesAddress = await moduleMatches.getAddress();
    console.log("✅ ETour_Matches deployed to:", moduleMatchesAddress);

    // Deploy ETour_Prizes
    console.log("Deploying ETour_Prizes...");
    const ETour_Prizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
    const modulePrizes = await ETour_Prizes.deploy();
    await modulePrizes.waitForDeployment();
    const modulePrizesAddress = await modulePrizes.getAddress();
    console.log("✅ ETour_Prizes deployed to:", modulePrizesAddress);

    // Deploy ETour_Raffle
    console.log("Deploying ETour_Raffle...");
    const ETour_Raffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
    const moduleRaffle = await ETour_Raffle.deploy();
    await moduleRaffle.waitForDeployment();
    const moduleRaffleAddress = await moduleRaffle.getAddress();
    console.log("✅ ETour_Raffle deployed to:", moduleRaffleAddress);

    // Deploy ETour_Escalation
    console.log("Deploying ETour_Escalation...");
    const ETour_Escalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");
    const moduleEscalation = await ETour_Escalation.deploy();
    await moduleEscalation.waitForDeployment();
    const moduleEscalationAddress = await moduleEscalation.getAddress();
    console.log("✅ ETour_Escalation deployed to:", moduleEscalationAddress);

    console.log("");
    console.log("✅ All modules deployed successfully!");
    console.log("");

    return {
        core: moduleCoreAddress,
        matches: moduleMatchesAddress,
        prizes: modulePrizesAddress,
        raffle: moduleRaffleAddress,
        escalation: moduleEscalationAddress
    };
}

// Allow running standalone
if (import.meta.url === `file://${process.argv[1]}`) {
    deployModules()
        .then((addresses) => {
            console.log("=" .repeat(60));
            console.log("Module Addresses:");
            console.log("=" .repeat(60));
            console.log("ETour_Core:       ", addresses.core);
            console.log("ETour_Matches:    ", addresses.matches);
            console.log("ETour_Prizes:     ", addresses.prizes);
            console.log("ETour_Raffle:     ", addresses.raffle);
            console.log("ETour_Escalation: ", addresses.escalation);
            console.log("");
            process.exit(0);
        })
        .catch((error) => {
            console.error("❌ Module deployment failed:", error);
            process.exit(1);
        });
}
