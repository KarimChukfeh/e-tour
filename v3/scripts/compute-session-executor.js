import hre from "hardhat";
import {
    environmentAddress,
    loadDeploymentManifest,
    requiredAddress,
} from "./lib/deployment-manifest.js";

const { file, manifest } = loadDeploymentManifest(
    hre.network.name
);
const factoryAddress = requiredAddress(
    manifest.accountAbstraction?.sessionAccountFactory,
    "manifest accountAbstraction.sessionAccountFactory"
);
const owner = environmentAddress("SESSION_OWNER");
const salt = BigInt(process.env.SESSION_SALT ?? "");
const factory = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
    factoryAddress
);
const executor =
    await factory["getAddress(address,uint256)"](owner, salt);

console.log(
    JSON.stringify(
        {
            network: hre.network.name,
            manifest: file,
            factory: factoryAddress,
            owner,
            salt: salt.toString(),
            executor,
            deployed:
                (await hre.ethers.provider.getCode(executor)) !==
                "0x",
        },
        null,
        2
    )
);
