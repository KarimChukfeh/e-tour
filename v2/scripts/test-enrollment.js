import hre from "hardhat";
import fs from 'fs';
const { ethers } = hre;

async function main() {
  const [deployer, user1] = await ethers.getSigners();

  // Get deployed addresses from localhost config
  const configPath = '/Users/karim/Documents/workspace/zero-trust/tic-tac-react/src/v2/ABIs/localhost-tictac-factory.json';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const factoryAddress = config.factory.TicTacChainFactory;
  const factory = await ethers.getContractAt("TicTacChainFactory", factoryAddress);

  console.log("Factory address:", factoryAddress);
  console.log("User1 address:", user1.address);

  const entryFee = ethers.parseEther("0.001");
  const playerCount = 2;
  const enrollmentWindow = 120; // 2 minutes
  const matchTimePerPlayer = 120; // 2 minutes
  const timeIncrementPerMove = 15; // 15 seconds

  console.log("\n=== Creating Instance ===");
  console.log("Entry fee:", ethers.formatEther(entryFee), "ETH");
  console.log("Player count:", playerCount);
  console.log("Enrollment window:", enrollmentWindow, "seconds");

  try {
    const tx = await factory.connect(user1).createInstance(
      playerCount,
      entryFee,
      enrollmentWindow,
      matchTimePerPlayer,
      timeIncrementPerMove,
      { value: entryFee }
    );

    console.log("Transaction sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);

    // Find InstanceDeployed event
    const deployedEvent = receipt.logs.find(log => {
      try {
        const parsed = factory.interface.parseLog(log);
        return parsed && parsed.name === 'InstanceDeployed';
      } catch {
        return false;
      }
    });

    if (deployedEvent) {
      const parsed = factory.interface.parseLog(deployedEvent);
      const instanceAddress = parsed.args.instance;
      console.log("\n=== Instance Created ===");
      console.log("Instance address:", instanceAddress);

      // Check if user1 is enrolled
      const instance = await ethers.getContractAt("ETourInstance_Base", instanceAddress);
      const isEnrolled = await instance.isEnrolled(user1.address);
      const enrolledCount = (await instance.tournament()).enrolledCount;
      const players = await instance.getPlayers();

      console.log("\n=== Enrollment Status ===");
      console.log("User1 enrolled:", isEnrolled);
      console.log("Total enrolled:", enrolledCount.toString());
      console.log("Enrolled players:", players);

      if (!isEnrolled) {
        console.log("\n❌ AUTO-ENROLLMENT FAILED!");
        console.log("User1 should have been auto-enrolled but wasn't.");

        // Try manual enrollment
        console.log("\n=== Attempting Manual Enrollment ===");
        try {
          const enrollTx = await instance.connect(user1).enrollInTournament({ value: entryFee });
          const enrollReceipt = await enrollTx.wait();
          console.log("✅ Manual enrollment transaction succeeded!");
          console.log("Gas used:", enrollReceipt.gasUsed.toString());

          // Check for PlayerEnrolled event
          const enrolledEvent = enrollReceipt.logs.find(log => {
            try {
              const parsed = instance.interface.parseLog(log);
              return parsed && parsed.name === 'PlayerEnrolled';
            } catch {
              return false;
            }
          });

          if (enrolledEvent) {
            console.log("✅ Found PlayerEnrolled event");
          } else {
            console.log("❌ No PlayerEnrolled event found - enrollment might have reverted internally");
          }

          const isNowEnrolled = await instance.isEnrolled(user1.address);
          const enrolledCountAfter = (await instance.tournament()).enrolledCount;
          const playersAfter = await instance.getPlayers();

          console.log("User1 enrolled after manual:", isNowEnrolled);
          console.log("Total enrolled after manual:", enrolledCountAfter.toString());
          console.log("Players after manual:", playersAfter);
        } catch (error) {
          console.log("❌ Manual enrollment transaction failed!");
          console.log("Error:", error.message);
          if (error.data) {
            console.log("Error data:", error.data);
          }
        }
      } else {
        console.log("\n✅ AUTO-ENROLLMENT SUCCESSFUL!");
      }
    } else {
      console.log("❌ Could not find InstanceDeployed event");
    }

  } catch (error) {
    console.log("\n❌ CREATE INSTANCE FAILED!");
    console.log("Error:", error.message);
    if (error.data) {
      console.log("Error data:", error.data);
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
