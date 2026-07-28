import { expect } from "chai";
import {
    loadFixture,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const ZERO = hre.ethers.ZeroAddress;

async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function deployHost(playerRegistry, sessionRegistry, authorize = true) {
    const factory = await deploy(
        "contracts/test-helpers/SessionRegistryHarnesses.sol:SessionFactoryHarness",
        [await playerRegistry.getAddress(), await sessionRegistry.getAddress()]
    );
    if (authorize) {
        await playerRegistry.authorizeFactory(await factory.getAddress());
    }
    const host = await deploy(
        "contracts/test-helpers/SessionHostHarness.sol:SessionHostHarness",
        [await factory.getAddress(), await sessionRegistry.getAddress()]
    );
    await factory.setInstance(await host.getAddress(), true);
    return { factory, host };
}

async function fixture() {
    const [owner, primary, otherPrimary, executor1, executor2, executor3, outsider] =
        await hre.ethers.getSigners();
    const profile = await deploy("contracts/PlayerProfile.sol:PlayerProfile");
    const playerRegistry = await deploy(
        "contracts/PlayerRegistry.sol:PlayerRegistry",
        [await profile.getAddress()]
    );
    const registry = await deploy(
        "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
        [await playerRegistry.getAddress()]
    );
    const first = await deployHost(playerRegistry, registry);
    const second = await deployHost(playerRegistry, registry);
    await first.host.setEnrolled(primary.address, true);
    await first.host.setEnrolled(otherPrimary.address, true);
    await second.host.setEnrolled(primary.address, true);
    await second.host.setEnrolled(otherPrimary.address, true);

    return {
        owner,
        primary,
        otherPrimary,
        executor1,
        executor2,
        executor3,
        outsider,
        playerRegistry,
        registry,
        first,
        second,
    };
}

async function register(host, primary, executor) {
    return host.registerSession(primary.address, executor.address ?? executor);
}

describe("SessionKeyRegistry", function () {
    this.timeout(60_000);

    it("has a fixed one-hour TTL and no privileged mutation API", async function () {
        const { registry } = await loadFixture(fixture);
        expect(await registry.SESSION_TTL()).to.equal(3600n);
        const functions = registry.interface.fragments
            .filter((fragment) => fragment.type === "function")
            .map((fragment) => fragment.name);
        for (const forbidden of [
            "owner",
            "transferOwnership",
            "setSession",
            "extendSession",
            "pause",
        ]) {
            expect(functions).not.to.include(forbidden);
        }
    });

    it("registers an enrolled primary with timestamps, generation, reverse binding, and event", async function () {
        const { primary, executor1, registry, first } =
            await loadFixture(fixture);
        const instance = await first.host.getAddress();
        const tx = await register(first.host, primary, executor1);
        const block = await hre.ethers.provider.getBlock(
            (await tx.wait()).blockNumber
        );

        await expect(tx)
            .to.emit(registry, "SessionRegistered")
            .withArgs(
                instance,
                primary.address,
                executor1.address,
                BigInt(block.timestamp) + 3600n,
                1n
            );
        const session = await registry.getSession(instance, primary.address);
        expect(session.executor).to.equal(executor1.address);
        expect(session.issuedAt).to.equal(BigInt(block.timestamp));
        expect(session.validUntil).to.equal(BigInt(block.timestamp) + 3600n);
        expect(session.generation).to.equal(1n);
        expect(await registry.getExecutorBinding(executor1.address)).to.deep.equal(
            [instance, primary.address, 1n]
        );
        expect(
            await registry.isSessionActive(
                instance,
                primary.address,
                executor1.address
            )
        ).to.equal(true);
        expect(
            await registry.resolveSession(instance, executor1.address)
        ).to.deep.equal([
            primary.address,
            BigInt(block.timestamp) + 3600n,
            1n,
        ]);
    });

    it("rejects zero addresses, primary-as-executor, un-enrolled players, and invalid hosts", async function () {
        const {
            primary,
            executor1,
            outsider,
            registry,
            playerRegistry,
            first,
        } = await loadFixture(fixture);

        await expect(
            first.host.registerSession(ZERO, executor1.address)
        ).to.be.revertedWithCustomError(registry, "ZeroAddress");
        await expect(
            first.host.registerSession(primary.address, ZERO)
        ).to.be.revertedWithCustomError(registry, "ZeroAddress");
        await expect(
            first.host.registerSession(primary.address, primary.address)
        ).to.be.revertedWithCustomError(registry, "ExecutorIsPrimary");
        await expect(
            first.host.registerSession(outsider.address, executor1.address)
        ).to.be.revertedWithCustomError(registry, "PlayerNotEnrolled");

        const untrackedHost = await deploy(
            "contracts/test-helpers/SessionHostHarness.sol:SessionHostHarness",
            [await first.factory.getAddress(), await registry.getAddress()]
        );
        await untrackedHost.setEnrolled(primary.address, true);
        await expect(
            untrackedHost.registerSession(primary.address, executor1.address)
        ).to.be.revertedWithCustomError(registry, "InvalidSessionHost");

        const unauthorized = await deployHost(
            playerRegistry,
            registry,
            false
        );
        await unauthorized.host.setEnrolled(primary.address, true);
        await expect(
            unauthorized.host.registerSession(
                primary.address,
                executor1.address
            )
        ).to.be.revertedWithCustomError(registry, "InvalidSessionHost");
    });

    it("rejects duplicate active sessions and globally live executor reuse", async function () {
        const {
            primary,
            otherPrimary,
            executor1,
            executor2,
            registry,
            first,
            second,
        } = await loadFixture(fixture);
        await register(first.host, primary, executor1);

        await expect(
            register(first.host, primary, executor2)
        ).to.be.revertedWithCustomError(registry, "SessionAlreadyActive");
        await expect(
            register(first.host, otherPrimary, executor1)
        ).to.be.revertedWithCustomError(registry, "ExecutorAlreadyBound");
        await expect(
            register(second.host, primary, executor1)
        ).to.be.revertedWithCustomError(registry, "ExecutorAlreadyBound");
    });

    it("uses strict expiry immediately before and exactly at validUntil", async function () {
        const { primary, executor1, registry, first } =
            await loadFixture(fixture);
        await register(first.host, primary, executor1);
        const instance = await first.host.getAddress();
        const session = await registry.getSession(instance, primary.address);

        await time.setNextBlockTimestamp(session.validUntil - 1n);
        await hre.network.provider.send("evm_mine");
        expect(
            await registry.isSessionActive(
                instance,
                primary.address,
                executor1.address
            )
        ).to.equal(true);

        await time.setNextBlockTimestamp(session.validUntil);
        await hre.network.provider.send("evm_mine");
        expect(
            await registry.isSessionActive(
                instance,
                primary.address,
                executor1.address
            )
        ).to.equal(false);
        expect(
            await registry.resolveSession(instance, executor1.address)
        ).to.deep.equal([ZERO, 0n, 0n]);
    });

    it("refreshes atomically, invalidates the old executor, and increments generation", async function () {
        const {
            primary,
            executor1,
            executor2,
            outsider,
            registry,
            first,
        } = await loadFixture(fixture);
        const instance = await first.host.getAddress();
        await register(first.host, primary, executor1);

        await expect(
            registry
                .connect(outsider)
                .refreshSession(instance, executor2.address)
        ).to.be.revertedWithCustomError(registry, "PlayerNotEnrolled");
        await expect(
            registry
                .connect(primary)
                .refreshSession(instance, executor1.address)
        ).to.be.revertedWithCustomError(registry, "SameExecutor");

        const tx = await registry
            .connect(primary)
            .refreshSession(instance, executor2.address);
        await expect(tx)
            .to.emit(registry, "SessionRefreshed")
            .withArgs(
                instance,
                primary.address,
                executor1.address,
                executor2.address,
                await time
                    .latest()
                    .then((timestamp) => BigInt(timestamp) + 3600n),
                2n
            );
        const session = await registry.getSession(instance, primary.address);
        expect(session.executor).to.equal(executor2.address);
        expect(session.generation).to.equal(2n);
        expect(
            await registry.getExecutorBinding(executor1.address)
        ).to.deep.equal([ZERO, ZERO, 0n]);
        expect(
            await registry.resolveSession(instance, executor1.address)
        ).to.deep.equal([ZERO, 0n, 0n]);
        expect(
            await registry.resolveSession(instance, executor2.address)
        ).to.deep.equal([
            primary.address,
            session.validUntil,
            2n,
        ]);
    });

    it("rejects refresh to another live binding", async function () {
        const {
            primary,
            otherPrimary,
            executor1,
            executor2,
            registry,
            first,
        } = await loadFixture(fixture);
        const instance = await first.host.getAddress();
        await register(first.host, primary, executor1);
        await register(first.host, otherPrimary, executor2);
        await expect(
            registry
                .connect(primary)
                .refreshSession(instance, executor2.address)
        ).to.be.revertedWithCustomError(registry, "ExecutorAlreadyBound");
    });

    it("revokes atomically, cleans the reverse binding, and increments generation", async function () {
        const {
            primary,
            executor1,
            outsider,
            registry,
            first,
        } = await loadFixture(fixture);
        const instance = await first.host.getAddress();
        await register(first.host, primary, executor1);
        await expect(
            registry.connect(outsider).revokeSession(instance)
        ).to.be.revertedWithCustomError(registry, "PlayerNotEnrolled");

        await expect(registry.connect(primary).revokeSession(instance))
            .to.emit(registry, "SessionRevoked")
            .withArgs(instance, primary.address, executor1.address, 2n);
        expect(
            await registry.getSession(instance, primary.address)
        ).to.deep.equal([ZERO, 0n, 0n, 2n]);
        expect(
            await registry.getExecutorBinding(executor1.address)
        ).to.deep.equal([ZERO, ZERO, 0n]);
        await expect(
            registry.connect(primary).revokeSession(instance)
        ).to.be.revertedWithCustomError(registry, "NoSession");
    });

    it("rejects refresh after conclusion but permits explicit revocation cleanup", async function () {
        const { primary, executor1, executor2, registry, first } =
            await loadFixture(fixture);
        const instance = await first.host.getAddress();
        await register(first.host, primary, executor1);
        await first.host.setConcluded(true);

        expect(
            await registry.isSessionActive(
                instance,
                primary.address,
                executor1.address
            )
        ).to.equal(false);
        await expect(
            registry
                .connect(primary)
                .refreshSession(instance, executor2.address)
        ).to.be.revertedWithCustomError(registry, "InstanceConcluded");
        await registry.connect(primary).revokeSession(instance);
        expect(
            await registry.getExecutorBinding(executor1.address)
        ).to.deep.equal([ZERO, ZERO, 0n]);
    });

    it("allows one primary to use distinct executors in distinct instances", async function () {
        const { primary, executor1, executor2, registry, first, second } =
            await loadFixture(fixture);
        await register(first.host, primary, executor1);
        await register(second.host, primary, executor2);
        expect(
            await registry.isSessionActive(
                await first.host.getAddress(),
                primary.address,
                executor1.address
            )
        ).to.equal(true);
        expect(
            await registry.isSessionActive(
                await second.host.getAddress(),
                primary.address,
                executor2.address
            )
        ).to.equal(true);
    });

    it("reclaims expired bindings and preserves uniqueness through randomized transitions", async function () {
        const {
            primary,
            otherPrimary,
            executor1,
            registry,
            first,
            second,
        } = await loadFixture(fixture);
        const firstAddress = await first.host.getAddress();
        const secondAddress = await second.host.getAddress();
        await register(first.host, primary, executor1);
        const original = await registry.getSession(
            firstAddress,
            primary.address
        );
        await time.increaseTo(original.validUntil);
        await register(second.host, otherPrimary, executor1);
        expect(
            await registry.resolveSession(firstAddress, executor1.address)
        ).to.deep.equal([ZERO, 0n, 0n]);
        expect(
            await registry.resolveSession(secondAddress, executor1.address)
        ).to.not.deep.equal([ZERO, 0n, 0n]);

        let expectedGeneration = original.generation;
        const executors = [];
        for (let i = 0; i < 24; i++) {
            executors.push(
                hre.ethers.getAddress(
                    `0x${hre.ethers
                        .keccak256(hre.ethers.toUtf8Bytes(`executor-${i}`))
                        .slice(-40)}`
                )
            );
        }
        for (let i = 0; i < executors.length; i++) {
            if (i === 0) {
                await registry
                    .connect(primary)
                    .refreshSession(firstAddress, executors[i]);
            } else if (i % 5 === 0) {
                await registry.connect(primary).revokeSession(firstAddress);
                expectedGeneration++;
                await registry
                    .connect(primary)
                    .refreshSession(firstAddress, executors[i]);
            } else {
                await registry
                    .connect(primary)
                    .refreshSession(firstAddress, executors[i]);
            }
            expectedGeneration++;

            const session = await registry.getSession(
                firstAddress,
                primary.address
            );
            expect(session.executor).to.equal(executors[i]);
            expect(session.generation).to.equal(expectedGeneration);
            let liveBindings = 0;
            for (const executor of executors.slice(0, i + 1)) {
                const binding = await registry.getExecutorBinding(executor);
                if (binding.player !== ZERO) liveBindings++;
            }
            expect(liveBindings).to.equal(1);
        }
    });
});
