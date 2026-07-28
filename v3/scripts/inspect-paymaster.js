import { createRequire } from "module";
import hre from "hardhat";
import {
    loadDeploymentManifest,
} from "./lib/deployment-manifest.js";

const require = createRequire(import.meta.url);
const entryPointArtifact = require(
    "@account-abstraction/contracts/artifacts/EntryPoint.json"
);
const { manifest } = loadDeploymentManifest(hre.network.name);
const entryPointAddress =
    manifest.accountAbstraction?.entryPoint;
const paymasterAddress =
    manifest.accountAbstraction?.sessionPaymaster;
if (!entryPointAddress || !paymasterAddress) {
    throw new Error(
        "deployment manifest has no EntryPoint/paymaster addresses"
    );
}

const entryPoint = new hre.ethers.Contract(
    entryPointAddress,
    entryPointArtifact.abi,
    hre.ethers.provider
);
const paymaster = await hre.ethers.getContractAt(
    "contracts/account-abstraction/ETourSessionPaymaster.sol:ETourSessionPaymaster",
    paymasterAddress
);
const [deposit, depositInfo, nativeBalance, paused, owner] =
    await Promise.all([
        paymaster.getDeposit(),
        entryPoint.getDepositInfo(paymasterAddress),
        hre.ethers.provider.getBalance(paymasterAddress),
        paymaster.paused(),
        paymaster.owner(),
    ]);
const threshold = BigInt(
    process.env.PAYMASTER_ALERT_THRESHOLD_WEI ??
        hre.ethers.parseEther("0.05")
);
const latestBlock = await hre.ethers.provider.getBlockNumber();
const lookback = Number(
    process.env.PAYMASTER_LOOKBACK_BLOCKS ?? "50000"
);
const fromBlock = Math.max(
    Number(manifest.blockNumber ?? 0),
    latestBlock - lookback
);
const events = await entryPoint.queryFilter(
    entryPoint.filters.UserOperationEvent(),
    fromBlock,
    latestBlock
);
const transactionCache = new Map();
let sponsoredOperationCount = 0;
let sponsoredSpend = 0n;
for (const event of events) {
    let transaction = transactionCache.get(event.transactionHash);
    if (!transaction) {
        transaction =
            await hre.ethers.provider.getTransaction(
                event.transactionHash
            );
        transactionCache.set(event.transactionHash, transaction);
    }
    if (!transaction) continue;
    let parsed;
    try {
        parsed = entryPoint.interface.parseTransaction({
            data: transaction.data,
            value: transaction.value,
        });
    } catch {
        continue;
    }
    if (parsed?.name !== "handleOps") continue;
    for (const operation of parsed.args.ops) {
        if (
            operation.paymasterAndData
                .slice(0, 42)
                .toLowerCase() !== paymasterAddress.toLowerCase()
        ) {
            continue;
        }
        if (
            (await entryPoint.getUserOpHash(operation)) ===
            event.args.userOpHash
        ) {
            sponsoredOperationCount += 1;
            sponsoredSpend += event.args.actualGasCost;
            break;
        }
    }
}
const spendThreshold = process.env.PAYMASTER_SPEND_ALERT_WEI
    ? BigInt(process.env.PAYMASTER_SPEND_ALERT_WEI)
    : null;
const abnormalSpend =
    spendThreshold !== null && sponsoredSpend > spendThreshold;
const report = {
    network: hre.network.name,
    chainId: (
        await hre.ethers.provider.getNetwork()
    ).chainId.toString(),
    entryPoint: entryPointAddress,
    paymaster: paymasterAddress,
    owner,
    paused,
    depositWei: deposit.toString(),
    nativeBalanceWei: nativeBalance.toString(),
    staked: depositInfo.staked,
    stakeWei: depositInfo.stake.toString(),
    unstakeDelaySec:
        depositInfo.unstakeDelaySec.toString(),
    withdrawTime: depositInfo.withdrawTime.toString(),
    spendWindow: { fromBlock, toBlock: latestBlock },
    sponsoredOperationCount,
    sponsoredSpendWei: sponsoredSpend.toString(),
    averageSponsoredCostWei:
        sponsoredOperationCount === 0
            ? "0"
            : (
                  sponsoredSpend /
                  BigInt(sponsoredOperationCount)
              ).toString(),
    spendAlertThresholdWei:
        spendThreshold?.toString() ?? null,
    abnormalSpend,
    alertThresholdWei: threshold.toString(),
    status:
        paused || deposit < threshold || abnormalSpend
            ? "attention-required"
            : "healthy",
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== "healthy") process.exitCode = 2;
