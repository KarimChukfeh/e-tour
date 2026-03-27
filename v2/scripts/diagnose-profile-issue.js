// scripts/diagnose-profile-issue.js
// Run this against your deployed contracts to diagnose why one player has no history
//
// Usage:
//   node scripts/diagnose-profile-issue.js <factoryAddress> <player1Address> <player2Address>
//
// Or set env vars:
//   FACTORY=0x... PLAYER1=0x... PLAYER2=0x... npx hardhat run scripts/diagnose-profile-issue.js --network localhost

import hre from "hardhat";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main() {
    const factoryAddr = process.env.FACTORY || process.argv[2];
    const player1Addr = process.env.PLAYER1 || process.argv[3];
    const player2Addr = process.env.PLAYER2 || process.argv[4];

    if (!factoryAddr || !player1Addr || !player2Addr) {
        console.error("Usage: FACTORY=0x... PLAYER1=0x... PLAYER2=0x... npx hardhat run scripts/diagnose-profile-issue.js --network localhost");
        process.exit(1);
    }

    console.log("\n" + "=".repeat(80));
    console.log("PROFILE ISSUE DIAGNOSTICS");
    console.log("=".repeat(80));
    console.log("Network:  ", hre.network.name);
    console.log("Factory:  ", factoryAddr);
    console.log("Player 1: ", player1Addr);
    console.log("Player 2: ", player2Addr);
    console.log("=".repeat(80) + "\n");

    const factory = await hre.ethers.getContractAt("contracts/TicTacChainFactory.sol:TicTacChainFactory", factoryAddr);

    // Get registry address
    const registryAddr = await factory.PLAYER_REGISTRY();
    console.log("PlayerRegistry:", registryAddr);
    const registry = await hre.ethers.getContractAt("contracts/PlayerRegistry.sol:PlayerRegistry", registryAddr);

    // Check factory authorization
    console.log("\n--- STEP 1: Factory Authorization ---");
    const isAuthorized = await registry.authorizedFactories(factoryAddr);
    console.log("registry.authorizedFactories(factory):", isAuthorized);
    if (!isAuthorized) {
        console.log("❌ PROBLEM: Factory is NOT authorized in registry!");
        console.log("   This means NO profiles will be created for ANY players.");
        console.log("   FIX: Call registry.authorizeFactory(factoryAddress) as registry owner");
        return;
    }
    console.log("✅ Factory is authorized");

    // Diagnose Player 1
    console.log("\n" + "=".repeat(80));
    console.log("PLAYER 1:", player1Addr);
    console.log("=".repeat(80));

    await diagnosePlayer(factory, registry, player1Addr);

    // Diagnose Player 2
    console.log("\n" + "=".repeat(80));
    console.log("PLAYER 2:", player2Addr);
    console.log("=".repeat(80));

    await diagnosePlayer(factory, registry, player2Addr);

    console.log("\n" + "=".repeat(80));
    console.log("DIAGNOSIS COMPLETE");
    console.log("=".repeat(80) + "\n");
}

async function diagnosePlayer(factory, registry, playerAddr) {
    const gameType = await factory.gameType();

    console.log("\n--- Step 1: factory.players() mapping ---");
    const fromMapping = await factory.players(playerAddr);
    console.log("factory.players(player):", fromMapping);
    if (fromMapping === ZERO_ADDRESS) {
        console.log("⚠️  Player not in factory.players() mapping");
    } else {
        console.log("✅ Found in factory.players()");
    }

    console.log("\n--- Step 2: factory.getPlayerProfile() ---");
    const fromGetter = await factory.getPlayerProfile(playerAddr);
    console.log("factory.getPlayerProfile(player):", fromGetter);
    if (fromGetter === ZERO_ADDRESS) {
        console.log("❌ PROBLEM: getPlayerProfile returns zero address!");
    } else {
        console.log("✅ getPlayerProfile works");
    }

    console.log("\n--- Step 3: registry.getProfile(player, gameType) ---");
    const fromRegistry = await registry.getProfile(playerAddr, gameType);
    console.log("registry.getProfile(player, gameType):", fromRegistry);
    if (fromRegistry === ZERO_ADDRESS) {
        console.log("❌ PROBLEM: Player has NO profile in registry!");
        console.log("   This player was never enrolled, or enrollment failed.");
        return;
    } else {
        console.log("✅ Profile exists in registry");
    }

    console.log("\n--- Step 4: Check profile contract data ---");
    const profile = await hre.ethers.getContractAt("contracts/PlayerProfile.sol:PlayerProfile", fromRegistry);

    try {
        const owner = await profile.owner();
        console.log("profile.owner():", owner);
        if (owner.toLowerCase() !== playerAddr.toLowerCase()) {
            console.log("⚠️  WARNING: Profile owner doesn't match player!");
        }

        const enrollmentCount = await profile.getEnrollmentCount();
        console.log("profile.getEnrollmentCount():", enrollmentCount.toString());

        if (enrollmentCount === 0n) {
            console.log("❌ PROBLEM: Profile exists but has ZERO enrollments!");
            console.log("   This should never happen - enrollment creates the profile.");
        } else {
            console.log("✅ Profile has", enrollmentCount.toString(), "enrollment(s)");

            const enrollments = await profile.getEnrollments(0, 10);
            console.log("\n--- Enrollment Records ---");
            for (let i = 0; i < enrollments.length; i++) {
                const e = enrollments[i];
                console.log(`  [${i}] Instance: ${e.instance}`);
                console.log(`      EntryFee:  ${hre.ethers.formatEther(e.entryFee)} ETH`);
                console.log(`      GameType:  ${e.gameType.toString()}`);
                console.log(`      Concluded: ${e.concluded}`);
                console.log(`      Won:       ${e.won}`);
                console.log(`      Prize:     ${hre.ethers.formatEther(e.prize)} ETH`);
            }
        }

        const stats = await profile.getStats();
        console.log("\n--- Player Stats ---");
        console.log("  Total Played:      ", stats.totalPlayed.toString());
        console.log("  Total Wins:        ", stats.totalWins.toString());
        console.log("  Total Losses:      ", stats.totalLosses.toString());
        console.log("  Total Net Earnings:", hre.ethers.formatEther(stats.totalNetEarnings), "ETH");

    } catch (error) {
        console.log("❌ ERROR reading profile data:", error.message);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("\n❌ Diagnostic failed:", err);
        process.exit(1);
    });
