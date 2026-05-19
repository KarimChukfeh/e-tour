#!/usr/bin/env node

"use strict";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(ROOT_DIR, "v2", "hardhat.config.js");
const DEPLOYMENT_PATH = path.join(ROOT_DIR, "v2", "deployments", "arbitrum-factory.json");

const ALREADY_VERIFIED_MESSAGES = [
  "Already Verified",
  "already verified",
  "Contract source code already verified",
];

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`Deployment file not found: ${DEPLOYMENT_PATH}`);
  }

  return JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
}

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

function runVerify({ label, address, contract, args = [] }) {
  console.log("");
  console.log(`Verifying ${label}: ${address}`);

  const verifyArgs = [
    "hardhat",
    "verify",
    "--config",
    CONFIG_PATH,
    "--network",
    "arbitrum",
    "--contract",
    contract,
    address,
    ...args,
  ];

  const result = runCommand("npx", verifyArgs);

  if (result.output) {
    console.log(result.output);
  }

  if (result.status === 0) {
    return;
  }

  if (ALREADY_VERIFIED_MESSAGES.some((message) => result.output.includes(message))) {
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

  const deployment = loadDeployment();

  if (deployment.network !== "arbitrum" || deployment.chainId !== "42161") {
    console.error("Deployment file is not for Arbitrum mainnet.");
    process.exit(1);
  }

  const modules = deployment.modules || {};
  const playerProfile = deployment.playerProfile || {};
  const factories = deployment.factories || {};
  const implementations = deployment.implementations || {};

  console.log(`Using project root: ${ROOT_DIR}`);
  console.log(`Using deployment file: ${DEPLOYMENT_PATH}`);
  if (deployment.timestamp) {
    console.log(`Deployment timestamp: ${deployment.timestamp}`);
  }
  if (deployment.blockNumber) {
    console.log(`Deployment block: ${deployment.blockNumber}`);
  }

  console.log("");
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

  runVerify({
    label: "ETourInstance_Core",
    address: modules.ETourInstance_Core,
    contract: "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core",
  });

  runVerify({
    label: "ETourInstance_MatchesResolution",
    address: modules.ETourInstance_MatchesResolution,
    contract: "contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution",
  });

  runVerify({
    label: "ETourInstance_Matches",
    address: modules.ETourInstance_Matches,
    contract: "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches",
    args: [modules.ETourInstance_MatchesResolution],
  });

  runVerify({
    label: "ETourInstance_Prizes",
    address: modules.ETourInstance_Prizes,
    contract: "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes",
  });

  runVerify({
    label: "ETourInstance_Escalation",
    address: modules.ETourInstance_Escalation,
    contract: "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation",
  });

  runVerify({
    label: "ChessRulesModule",
    address: modules.ChessRulesModule,
    contract: "contracts/modules/ChessRulesModule.sol:ChessRulesModule",
  });

  runVerify({
    label: "PlayerProfile",
    address: playerProfile.PlayerProfileImpl,
    contract: "contracts/PlayerProfile.sol:PlayerProfile",
  });

  runVerify({
    label: "PlayerRegistry",
    address: playerProfile.PlayerRegistry,
    contract: "contracts/PlayerRegistry.sol:PlayerRegistry",
    args: [playerProfile.PlayerProfileImpl],
  });

  runVerify({
    label: "TicTacToe",
    address: implementations.TicTacToe,
    contract: "contracts/TicTacToe.sol:TicTacToe",
  });

  runVerify({
    label: "TicTacToeFactory",
    address: factories.TicTacToeFactory,
    contract: "contracts/TicTacToeFactory.sol:TicTacToeFactory",
    args: [
      modules.ETourInstance_Core,
      modules.ETourInstance_Matches,
      modules.ETourInstance_Prizes,
      modules.ETourInstance_Escalation,
      playerProfile.PlayerRegistry,
    ],
  });

  runVerify({
    label: "ConnectFour",
    address: implementations.ConnectFour,
    contract: "contracts/ConnectFour.sol:ConnectFour",
  });

  runVerify({
    label: "ConnectFourFactory",
    address: factories.ConnectFourFactory,
    contract: "contracts/ConnectFourFactory.sol:ConnectFourFactory",
    args: [
      modules.ETourInstance_Core,
      modules.ETourInstance_Matches,
      modules.ETourInstance_Prizes,
      modules.ETourInstance_Escalation,
      playerProfile.PlayerRegistry,
    ],
  });

  runVerify({
    label: "Chess",
    address: implementations.Chess,
    contract: "contracts/Chess.sol:Chess",
  });

  runVerify({
    label: "ChessFactory",
    address: factories.ChessFactory,
    contract: "contracts/ChessFactory.sol:ChessFactory",
    args: [
      modules.ETourInstance_Core,
      modules.ETourInstance_Matches,
      modules.ETourInstance_Prizes,
      modules.ETourInstance_Escalation,
      modules.ChessRulesModule,
      playerProfile.PlayerRegistry,
    ],
  });

  console.log("");
  console.log("Verification run complete.");
}

main();
