import hre from "hardhat";
import {
    deployLocalAccountAbstraction,
} from "./lib/account-abstraction-deployment.js";

async function main() {
    if (!["hardhat", "localhost"].includes(hre.network.name)) {
        throw new Error(
            "This bootstrap is only for the local Hardhat/Anvil environment"
        );
    }
    const deployment = await deployLocalAccountAbstraction(hre, {
        writeManifest: true,
    });
    console.log(
        JSON.stringify(
            {
                network: deployment.network,
                chainId: deployment.chainId,
                entryPoint: deployment.entryPoint.target,
                simpleAccountFactory:
                    deployment.accountFactory.target,
                simpleAccountImplementation:
                    deployment.simpleAccountImplementation,
                senderCreator: deployment.senderCreator,
            },
            null,
            2
        )
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
