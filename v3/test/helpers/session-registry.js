import hre from "hardhat";

export async function deploySessionRegistry(playerRegistry) {
    const factory = await hre.ethers.getContractFactory(
        "contracts/SessionKeyRegistry.sol:SessionKeyRegistry"
    );
    const registry = await factory.deploy(
        await playerRegistry.getAddress()
    );
    await registry.waitForDeployment();
    return registry;
}
