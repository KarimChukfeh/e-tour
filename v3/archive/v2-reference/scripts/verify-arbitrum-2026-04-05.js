#!/usr/bin/env node

"use strict";

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "v2", "hardhat.config.js");

const SHARED_MODULES = {
  core: "0xA3FD255d2AcA64A1cf2EADb86745b1fD57284cbC",
  matches: "0x90a75Be8Fb9f36665053a889C37E5E168C9385d2",
  prizes: "0x3DE67419cC996d41ae5B397E0c7065dD2bB49A07",
  escalation: "0xfBc63d14288055fD5990cAccf0a93C8Dc5482FEC",
};

const DEPLOYMENTS = {
  ticTac: {
    source: "v2/deployments/TicTacChainFactory-ABI.json",
    deployedAt: "2026-04-05T09:19:30.568Z",
    playerProfileImpl: "0xA527D18D65e9857ac9A92F80534ed85752BA2931",
    playerRegistry: "0x0DfACcA93A63d6C2392c325b5323B01FAc600796",
    instance: "0xdF6DCF15d292441aE080437Fd05f24af1b29C34F",
    factory: "0xbB37b8A1580abb5A4ac45D483b11Ddc22976b10b",
  },
  connectFour: {
    source: "v2/deployments/ConnectFourFactory-ABI.json",
    deployedAt: "2026-04-05T09:20:03.783Z",
    playerProfileImpl: "0x08cD9eDf5ff6119AAB38624AdEa1b2A98B6f2728",
    playerRegistry: "0xF4Aaa91aFB1A41a92a7A82A704D739C54197a5a2",
    instance: "0xc6f1924ADBD504518d28629A3f6233a898aE7F5a",
    factory: "0x44De941fBe070F922259c7D08B082259377539bB",
  },
  chess: {
    source: "v2/deployments/ChessOnChainFactory-ABI.json",
    deployedAt: "2026-04-05T09:19:51.694Z",
    chessRules: "0x0abdEb248F4786E47dd0ba6fDc9B05E52d900C45",
    playerProfileImpl: "0x51136B31BB2379b26Fb3Fe50299F801cdF72D6D1",
    playerRegistry: "0x5836309C786dA68705538355CF414FcFBEd99b6e",
    instance: "0x247e94807A466458940e2e0be463c171211407Fe",
    factory: "0x6DA319B2B7Aa0e0776Fa87f800430A0ce58AB3a5",
  },
};

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  return {
    output: `${result.stdout || ""}${result.stderr || ""}`.trimEnd(),
    status: result.status || 0,
  };
}

function runVerify(address, args = []) {
  let contract;
  let constructorArgs = args;

  if (!Array.isArray(args) && args && typeof args === "object") {
    contract = args.contract;
    constructorArgs = args.args || [];
  }

  console.log("");
  console.log(`Verifying ${address}`);

  const verifyArgs = [
    "hardhat",
    "verify",
    "--config",
    CONFIG_PATH,
    "--network",
    "arbitrum",
  ];

  if (contract) {
    verifyArgs.push("--contract", contract);
  }

  verifyArgs.push(address, ...constructorArgs);

  const result = runCommand("npx", verifyArgs);

  if (result.output) {
    console.log(result.output);
  }

  if (result.status === 0) {
    return;
  }

  const alreadyVerified = [
    "Already Verified",
    "already verified",
    "Contract source code already verified",
  ];

  if (alreadyVerified.some((message) => result.output.includes(message))) {
    console.log(`Continuing: ${address} is already verified.`);
    return;
  }

  process.exit(result.status || 1);
}

function main() {
  if (!process.env.ARBISCAN_API_KEY) {
    console.error("ARBISCAN_API_KEY is not set.");
    console.error("Export it first, for example:");
    console.error("  export ARBISCAN_API_KEY=your_arbiscan_api_key");
    process.exit(1);
  }

  console.log(`Using project root: ${ROOT_DIR}`);
  console.log("Source ABI snapshots:");
  for (const deployment of Object.values(DEPLOYMENTS)) {
    console.log(`  ${deployment.source} (${deployment.deployedAt})`);
  }

  console.log("Compiling v2 contracts...");
  const compileResult = runCommand("npx", [
    "hardhat",
    "compile",
    "--config",
    CONFIG_PATH,
  ]);

  if (compileResult.output) {
    console.log(compileResult.output);
  }

  if (compileResult.status !== 0) {
    process.exit(compileResult.status);
  }

  console.log("");
  console.log("Shared instance modules");
  runVerify(SHARED_MODULES.core);
  runVerify(SHARED_MODULES.matches);
  runVerify(SHARED_MODULES.prizes);
  runVerify(SHARED_MODULES.escalation);

  console.log("");
  console.log("TicTac");
  runVerify(DEPLOYMENTS.ticTac.playerProfileImpl);
  runVerify(DEPLOYMENTS.ticTac.playerRegistry, [DEPLOYMENTS.ticTac.playerProfileImpl]);
  runVerify(DEPLOYMENTS.ticTac.instance);
  runVerify(DEPLOYMENTS.ticTac.factory, {
    contract: "contracts/TicTacChainFactory.sol:TicTacChainFactory",
    args: [
      SHARED_MODULES.core,
      SHARED_MODULES.matches,
      SHARED_MODULES.prizes,
      SHARED_MODULES.escalation,
      DEPLOYMENTS.ticTac.playerRegistry,
    ],
  });

  console.log("");
  console.log("ConnectFour");
  runVerify(DEPLOYMENTS.connectFour.playerProfileImpl);
  runVerify(DEPLOYMENTS.connectFour.playerRegistry, [DEPLOYMENTS.connectFour.playerProfileImpl]);
  runVerify(DEPLOYMENTS.connectFour.instance);
  runVerify(DEPLOYMENTS.connectFour.factory, {
    contract: "contracts/ConnectFourFactory.sol:ConnectFourFactory",
    args: [
      SHARED_MODULES.core,
      SHARED_MODULES.matches,
      SHARED_MODULES.prizes,
      SHARED_MODULES.escalation,
      DEPLOYMENTS.connectFour.playerRegistry,
    ],
  });

  console.log("");
  console.log("Chess");
  runVerify(DEPLOYMENTS.chess.chessRules);
  runVerify(DEPLOYMENTS.chess.playerProfileImpl);
  runVerify(DEPLOYMENTS.chess.playerRegistry, [DEPLOYMENTS.chess.playerProfileImpl]);
  runVerify(DEPLOYMENTS.chess.instance);
  runVerify(DEPLOYMENTS.chess.factory, {
    contract: "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
    args: [
      SHARED_MODULES.core,
      SHARED_MODULES.matches,
      SHARED_MODULES.prizes,
      SHARED_MODULES.escalation,
      DEPLOYMENTS.chess.chessRules,
      DEPLOYMENTS.chess.playerRegistry,
    ],
  });

  console.log("");
  console.log("Verification run complete.");
}

main();
