import hre from "hardhat";
import fs from 'fs';

async function main() {
  const config = JSON.parse(fs.readFileSync('/Users/karim/Documents/workspace/zero-trust/tic-tac-react/src/v2/ABIs/localhost-tictac-factory.json', 'utf8'));
  
  const factoryAddr = config.factory.TicTacChainFactory;
  const factory = await hre.ethers.getContractAt("TicTacChainFactory", factoryAddr);
  
  console.log("Factory:", factoryAddr);
  console.log("Implementation:", config.implementation.TicTacInstance);
  console.log("Core Module:", config.modules.ETourInstance_Core);
  
  // Get the implementation's MODULE_CORE
  const impl = await hre.ethers.getContractAt("TicTacInstance", config.implementation.TicTacInstance);
  const coreFromImpl = await impl.MODULE_CORE();
  console.log("MODULE_CORE from impl:", coreFromImpl);
  console.log("Expected MODULE_CORE:", config.modules.ETourInstance_Core);
  console.log("Match:", coreFromImpl === config.modules.ETourInstance_Core);
}

main().catch(console.error);
