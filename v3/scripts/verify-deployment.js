import hre from "hardhat";
import {
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

const dryRun = process.env.DRY_RUN === "1";
const { file, manifest } = loadDeploymentManifest(
    hre.network.name
);
const modules = manifest.modules ?? {};
const profile = manifest.playerProfile ?? {};
const session = manifest.sessionAuthorization ?? {};
const aa = manifest.accountAbstraction ?? {};
const factories = manifest.factories ?? {};
const implementations = manifest.implementations ?? {};

const core = requiredAddress(
    modules.ETourInstance_Core,
    "modules.ETourInstance_Core"
);
const matches = requiredAddress(
    modules.ETourInstance_Matches,
    "modules.ETourInstance_Matches"
);
const prizes = requiredAddress(
    modules.ETourInstance_Prizes,
    "modules.ETourInstance_Prizes"
);
const escalation = requiredAddress(
    modules.ETourInstance_Escalation,
    "modules.ETourInstance_Escalation"
);
const chessRules = requiredAddress(
    modules.ChessRulesModule,
    "modules.ChessRulesModule"
);
const profileImplementation = requiredAddress(
    profile.PlayerProfileImpl,
    "playerProfile.PlayerProfileImpl"
);
const playerRegistry = requiredAddress(
    profile.PlayerRegistry,
    "playerProfile.PlayerRegistry"
);
const sessionRegistry = requiredAddress(
    session.SessionKeyRegistry,
    "sessionAuthorization.SessionKeyRegistry"
);
const entryPoint = requiredAddress(
    aa.entryPoint,
    "accountAbstraction.entryPoint"
);
const accountFactory = requiredAddress(
    aa.sessionAccountFactory,
    "accountAbstraction.sessionAccountFactory"
);
const paymaster = requiredAddress(
    aa.sessionPaymaster,
    "accountAbstraction.sessionPaymaster"
);
const ticTacFactory = requiredAddress(
    factories.TicTacChainFactory,
    "factories.TicTacChainFactory"
);
const connectFourFactory = requiredAddress(
    factories.ConnectFourFactory,
    "factories.ConnectFourFactory"
);
const chessFactory = requiredAddress(
    factories.ChessOnChainFactory,
    "factories.ChessOnChainFactory"
);

const plan = [
    ["contracts/modules/ETourInstance_Core.sol:ETourInstance_Core", core, []],
    ["contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches", matches, []],
    ["contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes", prizes, []],
    ["contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation", escalation, []],
    ["contracts/modules/ChessRulesModule.sol:ChessRulesModule", chessRules, []],
    ["contracts/PlayerProfile.sol:PlayerProfile", profileImplementation, []],
    ["contracts/PlayerRegistry.sol:PlayerRegistry", playerRegistry, [profileImplementation]],
    ["contracts/SessionKeyRegistry.sol:SessionKeyRegistry", sessionRegistry, [playerRegistry]],
    [
        "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
        accountFactory,
        [entryPoint],
    ],
    [
        "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster",
        paymaster,
        [entryPoint, sessionRegistry, accountFactory],
    ],
    ["contracts/TicTacInstance.sol:TicTacInstance", requiredAddress(implementations.TicTacInstance, "implementations.TicTacInstance"), []],
    ["contracts/ConnectFourInstance.sol:ConnectFourInstance", requiredAddress(implementations.ConnectFourInstance, "implementations.ConnectFourInstance"), []],
    ["contracts/ChessInstance.sol:ChessInstance", requiredAddress(implementations.ChessInstance, "implementations.ChessInstance"), []],
    [
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        ticTacFactory,
        [core, matches, prizes, escalation, playerRegistry, sessionRegistry],
    ],
    [
        "contracts/ConnectFourFactory.sol:ConnectFourFactory",
        connectFourFactory,
        [core, matches, prizes, escalation, playerRegistry, sessionRegistry],
    ],
    [
        "contracts/ChessOnChainFactory.sol:ChessOnChainFactory",
        chessFactory,
        [core, matches, prizes, escalation, chessRules, playerRegistry, sessionRegistry],
    ],
];

console.log(
    JSON.stringify(
        {
            network: hre.network.name,
            manifest: file,
            dryRun,
            canonicalEntryPoint: entryPoint,
            contracts: plan.map(([contract, address, constructorArguments]) => ({
                contract,
                address,
                constructorArguments,
            })),
        },
        null,
        2
    )
);

if (!dryRun) {
    if (!process.env.ARBISCAN_API_KEY) {
        throw new Error("ARBISCAN_API_KEY is required");
    }
    for (const [contract, address, constructorArguments] of plan) {
        try {
            await hre.run("verify:verify", {
                address,
                constructorArguments,
                contract,
            });
        } catch (error) {
            const message = String(error?.message ?? error);
            if (
                /already verified|source code already verified/i.test(
                    message
                )
            ) {
                console.log(`${address} is already verified`);
                continue;
            }
            throw error;
        }
    }
}
