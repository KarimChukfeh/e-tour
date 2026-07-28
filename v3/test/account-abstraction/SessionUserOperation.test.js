import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
    loadFixture,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";
import {
    ENTRY_POINT_ADDRESS,
    LOCAL_SIMPLE_ACCOUNT_FACTORY,
    accountAbstractionArtifacts,
    deployLocalAccountAbstraction,
} from "../../scripts/lib/account-abstraction-deployment.js";
import { LocalBundler, BundlerSimulationError } from "../../sdk/local-bundler.js";
import {
    buildInitCode,
    buildPaymasterAndData,
    buildPackedUserOperation,
    encodeAccountExecute,
    estimateUserOperationGas,
    getUserOperationNonce,
    getUserOperationReceipt,
    hashUserOperation,
    packUint128Pair,
    signUserOperation,
    submitUserOperation,
    toRpcUserOperation,
} from "../../sdk/user-operation.js";

const ZERO = hre.ethers.ZeroAddress;
const ENTRY_FEE = hre.ethers.parseEther("0.0001");
const ENROLLMENT_WINDOW = 2n * 60n;
const MATCH_TIME = 2n * 60n;
const MOVE_INCREMENT = 15n;
const MATCH_ID = hre.ethers.solidityPackedKeccak256(
    ["uint8", "uint8"],
    [0, 0]
);
const CREATOR_SALT = 1001n;
const JOINER_SALT = 2002n;
const gasCapture = {};

function captureGas(name, result) {
    gasCapture[name] = {
        userOperationGasUsed: BigInt(
            result.receipt.actualGasUsed
        ).toString(),
        entryPointTransactionGasUsed:
            result.receipt.receipt.gasUsed.toString(),
        bundlerTotalGasEstimate: BigInt(
            result.estimate.totalGasEstimate
        ).toString(),
    };
}

after(function () {
    if (!process.env.AA_GAS_FILE) return;
    const output = path.resolve(
        process.cwd(),
        process.env.AA_GAS_FILE
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
        output,
        `${JSON.stringify(
            {
                schemaVersion: 1,
                generatedAt: new Date().toISOString(),
                entryPointVersion: "0.8",
                chainId: "412346",
                gas: gasCapture,
            },
            null,
            2
        )}\n`
    );
});

async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function protocolFixture() {
    const [deployer, creator, joiner, bundlerSigner] =
        await hre.ethers.getSigners();
    const aa = await deployLocalAccountAbstraction(hre, {
        signer: deployer,
    });
    const [core, matches, prizes, escalation, profile] =
        await Promise.all([
            deploy(
                "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
            ),
            deploy(
                "contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches"
            ),
            deploy(
                "contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes"
            ),
            deploy(
                "contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation"
            ),
            deploy("contracts/PlayerProfile.sol:PlayerProfile"),
        ]);
    const playerRegistry = await deploy(
        "contracts/PlayerRegistry.sol:PlayerRegistry",
        [await profile.getAddress()]
    );
    const sessionRegistry = await deploy(
        "contracts/SessionKeyRegistry.sol:SessionKeyRegistry",
        [await playerRegistry.getAddress()]
    );
    const sessionAccountFactory = await deploy(
        "contracts/account-abstraction/ETourSessionAccountFactory.sol:ETourSessionAccountFactory",
        [ENTRY_POINT_ADDRESS]
    );
    const factory = await deploy(
        "contracts/TicTacChainFactory.sol:TicTacChainFactory",
        [
            await core.getAddress(),
            await matches.getAddress(),
            await prizes.getAddress(),
            await escalation.getAddress(),
            await playerRegistry.getAddress(),
            await sessionRegistry.getAddress(),
        ]
    );
    await playerRegistry.authorizeFactory(await factory.getAddress());
    const paymaster = await deploy(
        "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster",
        [
            ENTRY_POINT_ADDRESS,
            await sessionRegistry.getAddress(),
            await sessionAccountFactory.getAddress(),
        ]
    );
    await paymaster.setFactoryAllowed(await factory.getAddress(), true);
    await paymaster.deposit({
        value: hre.ethers.parseEther("0.5"),
    });

    const browserOwners = {
        [creator.address]: hre.ethers.Wallet.createRandom(),
        [joiner.address]: hre.ethers.Wallet.createRandom(),
    };
    const accountSalts = {
        [creator.address]: CREATOR_SALT,
        [joiner.address]: JOINER_SALT,
    };
    const sessionAccounts = {};
    for (const primary of [creator, joiner]) {
        sessionAccounts[primary.address] =
            await sessionAccountFactory["getAddress(address,uint256)"](
                browserOwners[primary.address].address,
                accountSalts[primary.address]
            );
    }

    const createTx = await factory.connect(creator).createInstance(
        2,
        ENTRY_FEE,
        ENROLLMENT_WINDOW,
        MATCH_TIME,
        MOVE_INCREMENT,
        sessionAccounts[creator.address],
        { value: ENTRY_FEE }
    );
    const createReceipt = await createTx.wait();
    const deployment = createReceipt.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === "InstanceDeployed");
    const instance = await hre.ethers.getContractAt(
        "contracts/TicTacInstance.sol:TicTacInstance",
        deployment.args.instance
    );
    await instance.connect(joiner).enrollInTournament(
        sessionAccounts[joiner.address],
        { value: ENTRY_FEE }
    );

    for (const account of Object.values(sessionAccounts)) {
        await deployer.sendTransaction({
            to: account,
            value: hre.ethers.parseEther("0.05"),
        });
    }

    return {
        aa,
        deployer,
        creator,
        joiner,
        bundlerSigner,
        browserOwners,
        accountSalts,
        sessionAccounts,
        playerRegistry,
        sessionRegistry,
        sessionAccountFactory,
        paymaster,
        factory,
        instance,
        bundler: new LocalBundler({
            entryPoint: aa.entryPoint,
            bundlerSigner,
        }),
    };
}

function descriptorForPrimary(env, primary) {
    return {
        primary,
        owner: env.browserOwners[primary],
        account: env.sessionAccounts[primary],
        salt: env.accountSalts[primary],
    };
}

async function descriptorForCurrentTurn(env) {
    const match = await env.instance.matches(MATCH_ID);
    return descriptorForPrimary(env, match.currentTurn);
}

async function buildMoveOperation(
    env,
    descriptor,
    cell,
    {
        signingOwner = descriptor.owner,
        signingEntryPoint = ENTRY_POINT_ADDRESS,
        signingChainId = 412346n,
        forceInitCode,
        paymaster,
        paymasterVerificationGasLimit = 300_000n,
        paymasterPostOpGasLimit = 50_000n,
        verificationGasLimit = 2_000_000n,
        callGasLimit = 2_000_000n,
        preVerificationGas = 100_000n,
        value = 0n,
        target,
        gameCall,
    } = {}
) {
    const code = await hre.ethers.provider.getCode(descriptor.account);
    const initCode =
        forceInitCode ??
        (code === "0x"
            ? buildInitCode(
                  await env.sessionAccountFactory.getAddress(),
                  descriptor.owner.address,
                  descriptor.salt
              )
            : "0x");
    const moveData =
        gameCall ??
        env.instance.interface.encodeFunctionData("makeMove", [
            0,
            0,
            cell,
        ]);
    const callData = encodeAccountExecute(
        target ?? (await env.instance.getAddress()),
        moveData,
        value
    );
    const nonce = await getUserOperationNonce(
        env.aa.entryPoint,
        descriptor.account
    );
    const unsigned = buildPackedUserOperation({
        sender: descriptor.account,
        nonce,
        initCode,
        callData,
        verificationGasLimit,
        callGasLimit,
        preVerificationGas,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 1_000_000_000n,
        paymasterAndData: paymaster
            ? buildPaymasterAndData(paymaster, {
                  verificationGasLimit:
                      paymasterVerificationGasLimit,
                  postOpGasLimit: paymasterPostOpGasLimit,
              })
            : "0x",
    });
    const signed = await signUserOperation(
        unsigned,
        signingOwner,
        signingEntryPoint,
        signingChainId
    );
    return {
        unsigned,
        signed,
        rpc: toRpcUserOperation(signed),
        initCode,
        nonce,
    };
}

async function sendMove(env, descriptor, cell, options) {
    const operation = await buildMoveOperation(
        env,
        descriptor,
        cell,
        options
    );
    const estimate = await estimateUserOperationGas(
        env.bundler,
        operation.rpc,
        ENTRY_POINT_ADDRESS
    );
    const hash = await submitUserOperation(
        env.bundler,
        operation.rpc,
        ENTRY_POINT_ADDRESS
    );
    const receipt = await getUserOperationReceipt(
        env.bundler,
        hash
    );
    return { ...operation, estimate, hash, receipt };
}

function parseEvent(receipt, contract, eventName) {
    return receipt.logs
        .map((log) => {
            try {
                return contract.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((event) => event?.name === eventName);
}

async function expectBundlerValidationFailure(promise) {
    try {
        await promise;
        expect.fail("expected bundler validation failure");
    } catch (error) {
        expect(error).to.be.instanceOf(BundlerSimulationError);
        expect(error.kind).to.equal("validation");
        expect(error.code).to.equal(-32500);
        return error;
    }
}

describe("V3 ERC-4337 session executor", function () {
    this.timeout(120_000);

    it("pins the official EntryPoint and deterministic SimpleAccount factory", async function () {
        const env = await loadFixture(protocolFixture);
        expect(await env.aa.entryPoint.getAddress()).to.equal(
            ENTRY_POINT_ADDRESS
        );
        expect(await env.aa.accountFactory.getAddress()).to.equal(
            LOCAL_SIMPLE_ACCOUNT_FACTORY
        );
        expect(await hre.ethers.provider.getCode(ENTRY_POINT_ADDRESS))
            .to.not.equal("0x");
        expect(
            await hre.ethers.provider.getCode(
                await env.aa.accountFactory.accountImplementation()
            )
        ).to.not.equal("0x");
        expect(await env.aa.accountFactory.senderCreator()).to.equal(
            await env.aa.entryPoint.senderCreator()
        );
        await expect(
            env.aa.accountFactory.createAccount(
                env.browserOwners[env.creator.address].address,
                999n
            )
        ).to.be.revertedWith("only callable from SenderCreator");
    });

    it("registers counterfactual executors before either account is deployed", async function () {
        const env = await loadFixture(protocolFixture);
        const instanceAddress = await env.instance.getAddress();
        for (const primary of [env.creator.address, env.joiner.address]) {
            const account = env.sessionAccounts[primary];
            expect(await hre.ethers.provider.getCode(account)).to.equal(
                "0x"
            );
            expect(
                await env.sessionRegistry.isSessionActive(
                    instanceAddress,
                    primary,
                    account
                )
            ).to.equal(true);
            expect(await env.instance.isEnrolled(account)).to.equal(false);
            expect(
                await env.instance.resolveGameplayPlayer(account)
            ).to.equal(primary);
        }
    });

    it("deploys a first-use account and executes a legal move through the EntryPoint", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const expectedHash = hashUserOperation(
            (
                await buildMoveOperation(env, descriptor, 0)
            ).unsigned,
            ENTRY_POINT_ADDRESS,
            412346n
        );
        const result = await sendMove(env, descriptor, 0);
        captureGas("selfFundedFirstUserOperation", result);

        expect(result.hash).to.equal(expectedHash);
        expect(result.hash).to.equal(
            await env.aa.entryPoint.getUserOpHash(result.signed)
        );
        expect(result.receipt.success).to.equal(true);
        expect(BigInt(result.estimate.totalGasEstimate)).to.be.greaterThan(
            0n
        );
        expect(await hre.ethers.provider.getCode(descriptor.account))
            .to.not.equal("0x");

        const account = new hre.ethers.Contract(
            descriptor.account,
            (
                await hre.artifacts.readArtifact(
                    "contracts/account-abstraction/ETourSessionAccount.sol:ETourSessionAccount"
                )
            ).abi,
            env.deployer
        );
        expect(await account.owner()).to.equal(descriptor.owner.address);
        expect(await account.ENTRY_POINT()).to.equal(
            ENTRY_POINT_ADDRESS
        );

        const deployed = parseEvent(
            result.receipt.receipt,
            env.aa.entryPoint,
            "AccountDeployed"
        );
        expect(deployed.args.sender).to.equal(descriptor.account);
        const move = parseEvent(
            result.receipt.receipt,
            env.instance,
            "MoveMade"
        );
        expect(move.args.player).to.equal(descriptor.primary);
        expect(move.args.executor).to.equal(descriptor.account);
    });

    it("tracks ERC-7769 operation receipts and omits deployment after first use", async function () {
        const env = await loadFixture(protocolFixture);
        const first = await descriptorForCurrentTurn(env);
        await sendMove(env, first, 0);
        const second = await descriptorForCurrentTurn(env);
        await sendMove(env, second, 3);
        const third = await descriptorForCurrentTurn(env);
        expect(third.account).to.equal(first.account);

        const result = await sendMove(env, third, 1);
        captureGas("selfFundedLaterUserOperation", result);
        expect(result.initCode).to.equal("0x");
        expect(result.nonce).to.equal(1n);
        expect(
            parseEvent(
                result.receipt.receipt,
                env.aa.entryPoint,
                "AccountDeployed"
            )
        ).to.equal(undefined);

        const tracked = await env.bundler.request({
            method: "eth_getUserOperationByHash",
            params: [result.hash],
        });
        expect(tracked.transactionHash).to.equal(
            result.receipt.receipt.hash
        );
        expect(tracked.userOperation.sender).to.equal(third.account);
        expect(result.receipt.entryPoint).to.equal(ENTRY_POINT_ADDRESS);
    });

    it("rejects wrong browser owners and leaves counterfactual state untouched", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const wrongOwner = hre.ethers.Wallet.createRandom();
        const operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { signingOwner: wrongOwner }
        );
        const boardBefore = await env.instance.getBoard(0, 0);

        await expectBundlerValidationFailure(
            estimateUserOperationGas(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
        expect(await hre.ethers.provider.getCode(descriptor.account))
            .to.equal("0x");
        expect(await env.instance.getBoard(0, 0)).to.deep.equal(
            boardBefore
        );
    });

    it("binds signatures to the configured chain and EntryPoint", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const canonical = await buildMoveOperation(
            env,
            descriptor,
            0
        );
        const wrongEntryPoint = await buildMoveOperation(
            env,
            descriptor,
            0,
            {
                signingEntryPoint:
                    "0x0000000000000000000000000000000000004337",
            }
        );
        const wrongChain = await buildMoveOperation(
            env,
            descriptor,
            0,
            { signingChainId: 42161n }
        );

        expect(canonical.signed.signature).to.not.equal(
            wrongEntryPoint.signed.signature
        );
        expect(canonical.signed.signature).to.not.equal(
            wrongChain.signed.signature
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                wrongEntryPoint.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                wrongChain.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                canonical.rpc,
                "0x0000000000000000000000000000000000004337"
            )
        );
    });

    it("rejects replayed nonces without replaying game state", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const operation = await buildMoveOperation(
            env,
            descriptor,
            0
        );
        const hash = await submitUserOperation(
            env.bundler,
            operation.rpc,
            ENTRY_POINT_ADDRESS
        );
        expect(
            (
                await getUserOperationReceipt(env.bundler, hash)
            ).success
        ).to.equal(true);
        const boardAfter = await env.instance.getBoard(0, 0);

        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
        expect(await env.instance.getBoard(0, 0)).to.deep.equal(
            boardAfter
        );
        expect(
            await getUserOperationNonce(
                env.aa.entryPoint,
                descriptor.account
            )
        ).to.equal(1n);
    });

    it("distinguishes accepted game reverts from bundler validation failures", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const boardBefore = await env.instance.getBoard(0, 0);
        const result = await sendMove(env, descriptor, 9);

        expect(result.receipt.success).to.equal(false);
        expect(result.receipt.revertReason).to.equal("IC");
        expect(result.receipt.revertData).to.not.equal(null);
        expect(await hre.ethers.provider.getCode(descriptor.account))
            .to.not.equal("0x");
        expect(await env.instance.getBoard(0, 0)).to.deep.equal(
            boardBefore
        );
        expect(
            await getUserOperationNonce(
                env.aa.entryPoint,
                descriptor.account
            )
        ).to.equal(1n);
    });

    it("reports account wrapper execution reverts without mutating the game", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const initCode = buildInitCode(
            await env.sessionAccountFactory.getAddress(),
            descriptor.owner.address,
            descriptor.salt
        );
        const nonce = await getUserOperationNonce(
            env.aa.entryPoint,
            descriptor.account
        );
        const unsigned = buildPackedUserOperation({
            sender: descriptor.account,
            nonce,
            initCode,
            callData: "0xdeadbeef",
        });
        const signed = await signUserOperation(
            unsigned,
            descriptor.owner,
            ENTRY_POINT_ADDRESS,
            412346n
        );
        const boardBefore = await env.instance.getBoard(0, 0);
        const hash = await submitUserOperation(
            env.bundler,
            toRpcUserOperation(signed),
            ENTRY_POINT_ADDRESS
        );
        const receipt = await getUserOperationReceipt(
            env.bundler,
            hash
        );

        expect(receipt.success).to.equal(false);
        expect(receipt.revertReason).to.equal(null);
        expect(await env.instance.getBoard(0, 0)).to.deep.equal(
            boardBefore
        );
    });

    it("completes terminal settlement while retaining primary identity", async function () {
        const env = await loadFixture(protocolFixture);
        const firstPrimary = (
            await env.instance.matches(MATCH_ID)
        ).currentTurn;
        const sequence = [0, 3, 1, 4, 2];
        for (const cell of sequence) {
            const descriptor = await descriptorForCurrentTurn(env);
            const result = await sendMove(env, descriptor, cell);
            expect(result.receipt.success).to.equal(true);
            if (cell === 2) {
                captureGas("selfFundedTerminalUserOperation", result);
            }
        }

        const match = await env.instance.matches(MATCH_ID);
        expect(match.winner).to.equal(firstPrimary);
        expect(await env.instance.isConcluded()).to.equal(true);
        expect(
            await env.instance.playerPrizes(firstPrimary)
        ).to.be.greaterThan(0n);
        for (const account of Object.values(env.sessionAccounts)) {
            expect(await env.instance.playerPrizes(account)).to.equal(0n);
            expect(await env.playerRegistry.getProfile(account, 0))
                .to.equal(ZERO);
        }
    });

    it("keeps PackedUserOperation structs outside every game ABI", async function () {
        const games = [
            "contracts/TicTacInstance.sol:TicTacInstance",
            "contracts/ConnectFourInstance.sol:ConnectFourInstance",
            "contracts/ChessInstance.sol:ChessInstance",
        ];
        for (const game of games) {
            const artifact = await hre.artifacts.readArtifact(game);
            const serialized = JSON.stringify(artifact.abi);
            expect(serialized).to.not.include("PackedUserOperation");
            expect(serialized).to.not.include("UserOperation");
        }
    });
});

describe("V3 on-chain session sponsorship policy", function () {
    this.timeout(120_000);

    async function sponsoredMove(
        env,
        descriptor,
        cell,
        options = {}
    ) {
        return sendMove(env, descriptor, cell, {
            paymaster: await env.paymaster.getAddress(),
            ...options,
        });
    }

    it("sponsors first-use deployment and terminal settlement without charging the account", async function () {
        const env = await loadFixture(protocolFixture);
        const paymasterBefore = await env.paymaster.getDeposit();
        const accountBalances = {};
        for (const account of Object.values(env.sessionAccounts)) {
            accountBalances[account] =
                await hre.ethers.provider.getBalance(account);
        }
        const firstPrimary = (
            await env.instance.matches(MATCH_ID)
        ).currentTurn;

        for (const [index, cell] of [0, 3, 1, 4, 2].entries()) {
            const descriptor = await descriptorForCurrentTurn(env);
            const result = await sponsoredMove(
                env,
                descriptor,
                cell
            );
            expect(result.receipt.success).to.equal(true);
            if (index === 0) {
                captureGas("sponsoredFirstUserOperation", result);
            } else if (index === 2) {
                captureGas("sponsoredLaterUserOperation", result);
            } else if (index === 4) {
                captureGas(
                    "sponsoredTerminalUserOperation",
                    result
                );
            }
        }

        expect(await env.instance.isConcluded()).to.equal(true);
        expect(
            (await env.instance.matches(MATCH_ID)).winner
        ).to.equal(firstPrimary);
        expect(
            await env.instance.playerPrizes(firstPrimary)
        ).to.be.greaterThan(0n);
        expect(await env.paymaster.getDeposit()).to.be.lessThan(
            paymasterBefore
        );
        for (const account of Object.values(env.sessionAccounts)) {
            expect(
                await hre.ethers.provider.getBalance(account)
            ).to.equal(accountBalances[account]);
            expect(await env.instance.playerPrizes(account)).to.equal(
                0n
            );
        }
    });

    it("charges deliberately reverting moves to the paymaster and reports the game reason", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const depositBefore = await env.paymaster.getDeposit();
        const accountBefore =
            await hre.ethers.provider.getBalance(descriptor.account);
        const boardBefore = await env.instance.getBoard(0, 0);

        const result = await sponsoredMove(env, descriptor, 9);
        captureGas("sponsoredRevertingUserOperation", result);
        expect(result.receipt.success).to.equal(false);
        expect(result.receipt.revertReason).to.equal("IC");
        expect(await env.paymaster.getDeposit()).to.be.lessThan(
            depositBefore
        );
        expect(
            await hre.ethers.provider.getBalance(descriptor.account)
        ).to.equal(accountBefore);
        expect(await env.instance.getBoard(0, 0)).to.deep.equal(
            boardBefore
        );
    });

    it("rejects nonzero value, unknown selectors, and non-instance targets", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const paymaster = await env.paymaster.getAddress();

        for (const options of [
            { value: 1n },
            { gameCall: "0xdeadbeef" },
            {
                gameCall: hre.ethers.concat([
                    env.instance.interface.encodeFunctionData(
                        "makeMove",
                        [0, 0, 0]
                    ),
                    hre.ethers.ZeroHash,
                ]),
            },
            { target: env.deployer.address },
        ]) {
            const operation = await buildMoveOperation(
                env,
                descriptor,
                0,
                { paymaster, ...options }
            );
            await expectBundlerValidationFailure(
                submitUserOperation(
                    env.bundler,
                    operation.rpc,
                    ENTRY_POINT_ADDRESS
                )
            );
        }
        expect(await hre.ethers.provider.getCode(descriptor.account))
            .to.equal("0x");
    });

    it("rejects paused, unapproved-factory, and over-budget operations", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const paymaster = await env.paymaster.getAddress();

        await env.paymaster.setPaused(true);
        let operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { paymaster }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );

        await env.paymaster.setPaused(false);
        await env.paymaster.setFactoryAllowed(
            await env.factory.getAddress(),
            false
        );
        operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { paymaster }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );

        await env.paymaster.setFactoryAllowed(
            await env.factory.getAddress(),
            true
        );
        operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            {
                paymaster,
                verificationGasLimit: 2_500_001n,
            }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
    });

    it("rejects expired, revoked, and rotated-away session accounts", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        const primarySigner =
            descriptor.primary === env.creator.address
                ? env.creator
                : env.joiner;

        await env.sessionRegistry
            .connect(primarySigner)
            .revokeSession(await env.instance.getAddress());
        let operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { paymaster: await env.paymaster.getAddress() }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );

        const replacementOwner = hre.ethers.Wallet.createRandom();
        const replacementSalt = 3033n;
        const replacementAccount =
            await env.sessionAccountFactory[
                "getAddress(address,uint256)"
            ](replacementOwner.address, replacementSalt);
        await env.sessionRegistry
            .connect(primarySigner)
            .refreshSession(
                await env.instance.getAddress(),
                replacementAccount
            );
        operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { paymaster: await env.paymaster.getAddress() }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );

        const replacement = {
            primary: descriptor.primary,
            owner: replacementOwner,
            account: replacementAccount,
            salt: replacementSalt,
        };
        expect(
            (
                await sponsoredMove(env, replacement, 0)
            ).receipt.success
        ).to.equal(true);

        const next = await descriptorForCurrentTurn(env);
        await time.increase(60n * 60n + 1n);
        operation = await buildMoveOperation(env, next, 3, {
            paymaster: await env.paymaster.getAddress(),
        });
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );
    });

    it("rejects senders that were not created by the pinned account factory", async function () {
        const env = await loadFixture(protocolFixture);
        const fakeSender = hre.ethers.Wallet.createRandom().address;
        const fake = buildPackedUserOperation({
            sender: fakeSender,
            nonce: 0n,
            callData: encodeAccountExecute(
                await env.instance.getAddress(),
                env.instance.interface.encodeFunctionData(
                    "makeMove",
                    [0, 0, 0]
                )
            ),
            paymasterAndData: buildPaymasterAndData(
                await env.paymaster.getAddress()
            ),
        });
        const entryPointSigner =
            await hre.ethers.getImpersonatedSigner(
                ENTRY_POINT_ADDRESS
            );

        await expect(
            env.paymaster
                .connect(entryPointSigner)
                .validatePaymasterUserOp.staticCall(
                    fake,
                    hre.ethers.ZeroHash,
                    1n
                )
        ).to.be.revertedWithCustomError(
            env.paymaster,
            "InvalidAccount"
        );
    });

    it("rejects malformed wrappers, paymaster data, and every gas/cost bound", async function () {
        const env = await loadFixture(protocolFixture);
        const descriptor = await descriptorForCurrentTurn(env);
        await sendMove(env, descriptor, 0);
        const paymasterAddress = await env.paymaster.getAddress();
        const operation = await buildMoveOperation(
            env,
            descriptor,
            1,
            { paymaster: paymasterAddress }
        );
        const entryPointSigner =
            await hre.ethers.getImpersonatedSigner(
                ENTRY_POINT_ADDRESS
            );
        const policy = env.paymaster.connect(entryPointSigner);
        const validate = (userOp, maxCost = 1n) =>
            policy.validatePaymasterUserOp.staticCall(
                userOp,
                hre.ethers.ZeroHash,
                maxCost
            );

        await expect(
            validate({
                ...operation.signed,
                callData: "0xdeadbeef",
            })
        ).to.be.revertedWithCustomError(
            env.paymaster,
            "InvalidExecutionWrapper"
        );
        await expect(
            validate({
                ...operation.signed,
                paymasterAndData: hre.ethers.concat([
                    paymasterAddress,
                    hre.ethers.toBeHex(1n, 16),
                ]),
            })
        ).to.be.revertedWithCustomError(
            env.paymaster,
            "MalformedPaymasterData"
        );

        const excessiveGasOperations = [
            {
                ...operation.signed,
                accountGasLimits: packUint128Pair(
                    2_500_001n,
                    2_000_000n
                ),
            },
            {
                ...operation.signed,
                accountGasLimits: packUint128Pair(
                    2_000_000n,
                    4_000_001n
                ),
            },
            {
                ...operation.signed,
                preVerificationGas: 200_001n,
            },
            {
                ...operation.signed,
                paymasterAndData: buildPaymasterAndData(
                    paymasterAddress,
                    { verificationGasLimit: 500_001n }
                ),
            },
            {
                ...operation.signed,
                paymasterAndData: buildPaymasterAndData(
                    paymasterAddress,
                    { postOpGasLimit: 100_001n }
                ),
            },
        ];
        for (const excessive of excessiveGasOperations) {
            await expect(validate(excessive))
                .to.be.revertedWithCustomError(
                    env.paymaster,
                    "GasLimitExceeded"
                );
        }
        await expect(
            validate(
                operation.signed,
                hre.ethers.parseEther("0.02") + 1n
            )
        ).to.be.revertedWithCustomError(
            env.paymaster,
            "MaxCostExceeded"
        );
    });

    it("keeps primary-wallet gameplay available when sponsorship has no funds", async function () {
        const env = await loadFixture(protocolFixture);
        const deposit = await env.paymaster.getDeposit();
        await env.paymaster.withdrawTo(env.deployer.address, deposit);
        expect(await env.paymaster.getDeposit()).to.equal(0n);

        const descriptor = await descriptorForCurrentTurn(env);
        const operation = await buildMoveOperation(
            env,
            descriptor,
            0,
            { paymaster: await env.paymaster.getAddress() }
        );
        await expectBundlerValidationFailure(
            submitUserOperation(
                env.bundler,
                operation.rpc,
                ENTRY_POINT_ADDRESS
            )
        );

        const primarySigner =
            descriptor.primary === env.creator.address
                ? env.creator
                : env.joiner;
        await expect(
            env.instance.connect(primarySigner).makeMove(0, 0, 0)
        ).to.emit(env.instance, "MoveMade");
    });

    it("isolates paymaster funds from tournament escrow accounting", async function () {
        const env = await loadFixture(protocolFixture);
        const instanceBalance =
            await hre.ethers.provider.getBalance(
                await env.instance.getAddress()
            );
        const tournament = await env.instance.tournament();
        const paymasterDeposit = await env.paymaster.getDeposit();

        expect(instanceBalance).to.equal(ENTRY_FEE * 2n);
        expect(tournament.totalEntryFeesAccrued).to.equal(
            ENTRY_FEE * 2n
        );
        expect(paymasterDeposit).to.equal(
            hre.ethers.parseEther("0.5")
        );
        expect(
            await hre.ethers.provider.getBalance(
                await env.paymaster.getAddress()
            )
        ).to.equal(0n);
    });
});
