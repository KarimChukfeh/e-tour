import hre from "hardhat";
import fs from 'fs';

async function main() {
  const [deployer, user1] = await hre.ethers.getSigners();
  const config = JSON.parse(fs.readFileSync('/Users/karim/Documents/workspace/zero-trust/tic-tac-react/src/v2/ABIs/localhost-tictac-factory.json', 'utf8'));
  
  const factoryAddr = config.factory.TicTacChainFactory;
  const factory = await hre.ethers.getContractAt("TicTacChainFactory", factoryAddr);
  
  const entryFee = hre.ethers.parseEther("0.001");
  
  console.log("Creating instance...");
  const tx = await factory.connect(user1).createInstance(
    2, entryFee, 120, 120, 15,
    { value: entryFee }
  );
  const receipt = await tx.wait();
  
  const deployedEvent = receipt.logs.find(log => {
    try {
      const parsed = factory.interface.parseLog(log);
      return parsed && parsed.name === 'InstanceDeployed';
    } catch { return false; }
  });
  
  if (deployedEvent) {
    const parsed = factory.interface.parseLog(deployedEvent);
    const instanceAddr = parsed.args.instance;
    console.log("Instance created:", instanceAddr);
    
    const instance = await hre.ethers.getContractAt("TicTacInstance", instanceAddr);
    
    console.log("\n=== Checking Instance State ===");
    const moduleCore = await instance.MODULE_CORE();
    const moduleMAtches = await instance.MODULE_MATCHES();
    const factoryAddr2 = await instance.factory();
    const creatorAddr = await instance.creator();
    
    console.log("MODULE_CORE:    ", moduleCore);
    console.log("MODULE_MATCHES: ", moduleMAtches);
    console.log("factory:        ", factoryAddr2);
    console.log("creator:        ", creatorAddr);
    console.log("Expected Core:  ", config.modules.ETourInstance_Core);
    
    const tierConfig = await instance.tierConfig();
    console.log("\ntierConfig.entryFee:", hre.ethers.formatEther(tierConfig.entryFee), "ETH");
    console.log("tierConfig.playerCount:", tierConfig.playerCount);
    
    console.log("\n=== Checking Enrollment ===");
    const isEnrolled = await instance.isEnrolled(user1.address);
    const enrolledCount = (await instance.tournament()).enrolledCount;
    const players = await instance.getPlayers();
    console.log("user1 enrolled:", isEnrolled);
    console.log("enrolledCount:", enrolledCount.toString());
    console.log("players:", players);
  }
}

main().catch(console.error);
