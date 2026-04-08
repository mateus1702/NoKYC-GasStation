import "../../src/load-env.js";
/**
 * Profitability Refill Test:
 * Drives increasing UserOp gas usage and asserts worker gas refill occurs.
 *
 * Goals:
 * 1) Generate progressively higher gas demand (single-call -> multi-call UserOps)
 * 2) Observe EntryPoint deposit drawdown and at least N refill jumps
 * 3) Confirm fees are charged during the run
 *
 * Run: npm run test:profitability:refill
 */
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { toSimpleSmartAccount } from "permissionless/accounts";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  defineChain,
  encodeFunctionData,
  getContract,
  http,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  USDC_ADDRESS,
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
} from "../../src/funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const FUND_AMOUNT = parseUnits(
  process.env.TOOLS_REFILL_FUND_AMOUNT ?? process.env.TOOLS_SOAK_FUND_AMOUNT ?? process.env.TOOLS_USDC_FUND_AMOUNT ?? "1500",
  6
);

const DURATION_MINUTES = Number(process.env.TOOLS_REFILL_DURATION_MINUTES ?? "20");
const PROFIT_THRESHOLD_E6 = BigInt(process.env.TOOLS_REFILL_PROFIT_THRESHOLD_USDC_E6 ?? "100000");
const WARMUP_OPS = Number(process.env.TOOLS_REFILL_WARMUP_OPS ?? "3");
const INTERVAL_MS = Number(process.env.TOOLS_REFILL_INTERVAL_MS ?? "2500");
const SNAPSHOT_INTERVAL_SEC = Number(process.env.TOOLS_REFILL_SNAPSHOT_INTERVAL_SECONDS ?? "60");

const STAGE1_CALLS = Number(process.env.TOOLS_REFILL_STAGE1_CALLS ?? "1");
const STAGE2_CALLS = Number(process.env.TOOLS_REFILL_STAGE2_CALLS ?? "10");
const STAGE3_CALLS = Number(process.env.TOOLS_REFILL_STAGE3_CALLS ?? "25");
const STAGE1_END_RATIO = Number(process.env.TOOLS_REFILL_STAGE1_END_RATIO ?? "0.20");
const STAGE2_END_RATIO = Number(process.env.TOOLS_REFILL_STAGE2_END_RATIO ?? "0.60");

const BURN_LOOPS_STAGE1 = Number(process.env.TOOLS_REFILL_BURN_LOOPS_STAGE1 ?? "500");
const BURN_LOOPS_STAGE2 = Number(process.env.TOOLS_REFILL_BURN_LOOPS_STAGE2 ?? "2000");
const BURN_LOOPS_STAGE3 = Number(process.env.TOOLS_REFILL_BURN_LOOPS_STAGE3 ?? "5000");
const BURN_WRITES_STAGE1 = Number(process.env.TOOLS_REFILL_BURN_WRITES_STAGE1 ?? "4");
const BURN_WRITES_STAGE2 = Number(process.env.TOOLS_REFILL_BURN_WRITES_STAGE2 ?? "12");
const BURN_WRITES_STAGE3 = Number(process.env.TOOLS_REFILL_BURN_WRITES_STAGE3 ?? "24");
const GAS_BURNER_MODE = (process.env.TOOLS_REFILL_GAS_BURNER_MODE ?? "mixed").toLowerCase();

const MIN_REFILLS = Number(process.env.TOOLS_REFILL_MIN_REFILLS ?? "1");
const DEPOSIT_EPSILON_WEI = BigInt(process.env.TOOLS_REFILL_DEPOSIT_EPSILON_WEI ?? "100000000000000"); // 0.0001 ETH
const MIN_DRAWDOWN_WEI = BigInt(process.env.TOOLS_REFILL_MIN_DRAWDOWN_WEI ?? "1000000000000000"); // 0.001 ETH
const ACCOUNT_REFILL_EPSILON_WEI = BigInt(process.env.TOOLS_REFILL_ACCOUNT_EPSILON_WEI ?? "50000000000000"); // 0.00005 ETH

const TARGETS: Address[] = [
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "0x47c031236e19d024b42f8de678d3110562d925b5",
  "0xb75f972af41d6ff0bcc6b2613b832632de1e418b",
  "0x815937a75074e0df3419973c629221c82121a082",
  "0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055",
];

const localChain = defineChain({
  id: 137,
  name: "Polygon Fork",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const publicClient = createPublicClient({
  chain: localChain,
  transport: http(RPC_URL),
});

const testClient = createTestClient({
  chain: localChain,
  transport: http(RPC_URL),
  mode: "anvil",
});

const paymasterClient = createPimlicoClient({
  entryPoint: { address: entryPoint07Address, version: "0.7" },
  transport: http(PAYMASTER_URL),
});

const owner = privateKeyToAccount(
  (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`
);

interface TrackedAccount {
  label: string;
  address: Address;
}

function toKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

function parsePrivateKeys(csv?: string): `0x${string}`[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => toKey(x));
}

function toAddressFromPrivateKey(privateKey: `0x${string}`): Address {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  return account.address;
}

function buildTrackedGasAccounts(): TrackedAccount[] {
  const tracked: TrackedAccount[] = [];
  const utilityKey = process.env.ALTO_UTILITY_PRIVATE_KEY;
  const executorKeysCsv = process.env.ALTO_EXECUTOR_PRIVATE_KEYS;

  if (utilityKey) {
    tracked.push({
      label: "alto-utility",
      address: toAddressFromPrivateKey(toKey(utilityKey)),
    });
  }
  const executorKeys = parsePrivateKeys(executorKeysCsv);
  executorKeys.forEach((k, i) => {
    tracked.push({
      label: `alto-executor-${i}`,
      address: toAddressFromPrivateKey(k),
    });
  });

  const unique: TrackedAccount[] = [];
  for (const item of tracked) {
    if (!unique.some((u) => u.address.toLowerCase() === item.address.toLowerCase())) {
      unique.push(item);
    }
  }
  return unique;
}

async function getUSDCBalance(address: Address): Promise<bigint> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });
  return usdc.read.balanceOf([address]);
}

async function getEntryPointDeposit(paymasterAddress: Address): Promise<bigint> {
  const bal = await publicClient.readContract({
    address: ENTRYPOINT_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  return bal as bigint;
}

async function getTokenBalance(token: Address, owner: Address): Promise<bigint> {
  const bal = await publicClient.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [owner],
  });
  return bal as bigint;
}

function getCallsForProgress(progress: number): number {
  if (progress < STAGE1_END_RATIO) return STAGE1_CALLS;
  if (progress < STAGE2_END_RATIO) return STAGE2_CALLS;
  return STAGE3_CALLS;
}

function getBurnLoopsForProgress(progress: number): number {
  if (progress < STAGE1_END_RATIO) return BURN_LOOPS_STAGE1;
  if (progress < STAGE2_END_RATIO) return BURN_LOOPS_STAGE2;
  return BURN_LOOPS_STAGE3;
}

function getBurnWritesForProgress(progress: number): number {
  if (progress < STAGE1_END_RATIO) return BURN_WRITES_STAGE1;
  if (progress < STAGE2_END_RATIO) return BURN_WRITES_STAGE2;
  return BURN_WRITES_STAGE3;
}

function buildCalls(callCount: number): Array<{ to: Address; value: bigint; data?: `0x${string}` }> {
  const count = Math.max(1, callCount);
  const calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }> = [];
  for (let i = 0; i < count; i++) {
    calls.push({
      to: TARGETS[i % TARGETS.length],
      value: 0n,
    });
  }
  return calls;
}

function buildGasBurnerCalls(
  gasBurnerAddress: Address,
  burnLoops: number,
  burnWrites: number,
  callCount: number
): Array<{ to: Address; value: bigint; data: `0x${string}` }> {
  const count = Math.max(1, callCount);
  const calls: Array<{ to: Address; value: bigint; data: `0x${string}` }> = [];
  for (let i = 0; i < count; i++) {
    const data =
      GAS_BURNER_MODE === "storage"
        ? encodeFunctionData({
            abi: parseAbi(["function burnStorage(uint256 writes)"]),
            functionName: "burnStorage",
            args: [BigInt(Math.max(1, burnWrites))],
          })
        : GAS_BURNER_MODE === "compute"
          ? encodeFunctionData({
              abi: parseAbi(["function burnCompute(uint256 iterations)"]),
              functionName: "burnCompute",
              args: [BigInt(Math.max(1, burnLoops))],
            })
          : encodeFunctionData({
              abi: parseAbi(["function burnMixed(uint256 writes, uint256 iterations)"]),
              functionName: "burnMixed",
              args: [BigInt(Math.max(1, burnWrites)), BigInt(Math.max(1, burnLoops))],
            });
    calls.push({ to: gasBurnerAddress, value: 0n, data });
  }
  return calls;
}

async function main() {
  console.log("Profitability Refill Test Configuration:");
  console.log("  Duration:", DURATION_MINUTES, "minutes");
  console.log("  Profit threshold:", PROFIT_THRESHOLD_E6.toString(), "USDC (e6)");
  console.log("  Warmup ops:", WARMUP_OPS);
  console.log("  Interval:", INTERVAL_MS, "ms");
  console.log("  Snapshot every:", SNAPSHOT_INTERVAL_SEC, "s");
  console.log("  Stage calls:", `${STAGE1_CALLS} -> ${STAGE2_CALLS} -> ${STAGE3_CALLS}`);
  console.log("  GasBurner mode:", GAS_BURNER_MODE);
  console.log("  Burn loops:", `${BURN_LOOPS_STAGE1} -> ${BURN_LOOPS_STAGE2} -> ${BURN_LOOPS_STAGE3}`);
  console.log("  Burn writes:", `${BURN_WRITES_STAGE1} -> ${BURN_WRITES_STAGE2} -> ${BURN_WRITES_STAGE3}`);
  console.log("  Refill threshold:", `>= ${MIN_REFILLS} jumps (deposit epsilon ${DEPOSIT_EPSILON_WEI} wei)`);
  console.log("  Account refill epsilon:", ACCOUNT_REFILL_EPSILON_WEI.toString(), "wei");
  console.log("");

  const trackedAccounts = buildTrackedGasAccounts();
  if (trackedAccounts.length > 0) {
    console.log(
      "  Tracking gas accounts:",
      trackedAccounts.map((a) => `${a.label}:${a.address}`).join(", ")
    );
  } else {
    console.log("  Tracking gas accounts: none (ALTO_* private keys not set)");
  }

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });

  let paymasterAddress = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
  if (!paymasterAddress) {
    const res = await fetch(`${PAYMASTER_URL.replace(/\/$/, "")}/paymaster-address`);
    if (!res.ok) {
      console.error("Could not get paymaster address");
      process.exit(1);
    }
    const json = (await res.json()) as { paymasterAddress?: string };
    paymasterAddress = json.paymasterAddress as Address;
  }
  if (!paymasterAddress) {
    console.error("No paymaster address");
    process.exit(1);
  }

  let gasBurnerAddress: Address | null = null;
  const gasBurnerEnv = process.env.TOOLS_GAS_BURNER_ADDRESS?.trim();
  if (gasBurnerEnv) {
    gasBurnerAddress = gasBurnerEnv as Address;
    console.log("  GasBurner (env):", gasBurnerAddress);
  } else {
    try {
      const res = await fetch(`${PAYMASTER_URL.replace(/\/$/, "")}/gas-burner-address`);
      if (res.ok) {
        const json = (await res.json()) as { gasBurnerAddress?: string };
        if (json.gasBurnerAddress) {
          gasBurnerAddress = json.gasBurnerAddress as Address;
          console.log("  GasBurner (API):", gasBurnerAddress);
        }
      }
    } catch {
      // ignore
    }
  }
  if (!gasBurnerAddress) {
    console.log("  GasBurner: none (using fallback transfer calls)");
  }

  const workerKeyRaw =
    process.env.PAYMASTER_REFILL_OWNER_PRIVATE_KEY?.trim() ??
    process.env.CONTRACT_DEPLOYER_PRIVATE_KEY?.trim();
  const wrappedNativeTokenRaw =
    process.env.PAYMASTER_API_REFILL_WRAPPED_NATIVE?.trim() ?? process.env.WORKER_WRAPPED_NATIVE_TOKEN?.trim();
  const staleInjectWei = parseUnits(process.env.TOOLS_REFILL_STALE_WMATIC_INJECT_ETH ?? "0.02", 18);
  let staleCheckEnabled = false;
  let staleWorkerAddress: Address | null = null;
  let staleExpectedMinWmatic = 0n;
  let staleWmaticStart = 0n;

  if (workerKeyRaw && wrappedNativeTokenRaw) {
    try {
      const workerAccount = privateKeyToAccount(toKey(workerKeyRaw));
      const wrappedNativeToken = wrappedNativeTokenRaw as Address;
      const workerWalletClient = createWalletClient({
        account: workerAccount,
        chain: localChain,
        transport: http(RPC_URL),
      });
      const before = await getTokenBalance(wrappedNativeToken, workerAccount.address);
      const depositData = encodeFunctionData({
        abi: parseAbi(["function deposit() payable"]),
        functionName: "deposit",
      });
      const txHash = await workerWalletClient.sendTransaction({
        to: wrappedNativeToken,
        value: staleInjectWei,
        data: depositData,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      const after = await getTokenBalance(wrappedNativeToken, workerAccount.address);
      const injected = after - before;
      if (injected > 0n) {
        staleCheckEnabled = true;
        staleWorkerAddress = workerAccount.address;
        staleExpectedMinWmatic = before + injected;
        staleWmaticStart = before;
        console.log(
          `  Injected stale WMATIC for regression check: worker=${workerAccount.address} before=${before.toString()} injected=${injected.toString()} after=${after.toString()}`
        );
      } else {
        console.warn("  Stale WMATIC regression check disabled: could not inject positive WMATIC amount");
      }
    } catch (error) {
      console.warn(
        `  Stale WMATIC regression check disabled: ${(error as Error).message}`
      );
    }
  } else {
    console.log(
      "  Stale WMATIC regression check disabled (set PAYMASTER_REFILL_OWNER_PRIVATE_KEY or CONTRACT_DEPLOYER_PRIVATE_KEY + PAYMASTER_API_REFILL_WRAPPED_NATIVE)"
    );
  }

  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address, uint256) returns (bool)",
    ]),
    client: publicClient,
  });

  const balanceBefore = await usdc.read.balanceOf([account.address]);
  if (balanceBefore < MIN_USDC_BALANCE) {
    console.log("Funding account with USDC from whale...");
    await fundAccountWithUSDC(
      account.address,
      FUND_AMOUNT,
      usdc,
      publicClient,
      testClient
    );
    const after = await usdc.read.balanceOf([account.address]);
    console.log("USDC balance after fund:", after.toString());
    if (after < MIN_USDC_BALANCE) {
      console.error("Failed to fund account with USDC");
      process.exit(1);
    }
  }

  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress, parseUnits("1000000", 6)],
  });

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  console.log("Warmup phase...");
  for (let i = 0; i < WARMUP_OPS; i++) {
    try {
      const warmupCalls = Math.max(1, STAGE1_CALLS);
      const innerCalls = gasBurnerAddress
        // Keep GasBurner to a single inner call per UserOp to avoid call-packing limits.
        ? buildGasBurnerCalls(gasBurnerAddress, BURN_LOOPS_STAGE1, BURN_WRITES_STAGE1, 1)
        : buildCalls(warmupCalls);
      const calls = [
        { to: USDC_ADDRESS, value: 0n, data: approveData },
        ...innerCalls,
      ];
      await smartAccountClient.sendTransaction({ calls });
    } catch (e) {
      console.warn("Warmup op failed:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const startTime = Date.now();
  const endTime = startTime + DURATION_MINUTES * 60 * 1000;
  let lastSnapshot = startTime;

  const depositStart = await getEntryPointDeposit(paymasterAddress);
  let prevDeposit = depositStart;
  let minDepositSeen = depositStart;
  let maxDepositSeen = depositStart;
  let refillCount = 0;
  let refillCountDeposit = 0;
  let refillCountAccounts = 0;
  let refillTotalWei = 0n;

  const accountStart = new Map<string, bigint>();
  const accountPrev = new Map<string, bigint>();
  const accountMin = new Map<string, bigint>();
  for (const acct of trackedAccounts) {
    const bal = await publicClient.getBalance({ address: acct.address });
    accountStart.set(acct.address.toLowerCase(), bal);
    accountPrev.set(acct.address.toLowerCase(), bal);
    accountMin.set(acct.address.toLowerCase(), bal);
  }

  let opsCount = 0;
  let totalFees = 0n;
  let failedOps = 0;

  console.log("Main phase started.");

  while (Date.now() < endTime) {
    const progress = (Date.now() - startTime) / (DURATION_MINUTES * 60 * 1000);
    const stageCalls = getCallsForProgress(progress);
    const stageLoops = getBurnLoopsForProgress(progress);
    const stageWrites = getBurnWritesForProgress(progress);
    const innerCalls = gasBurnerAddress
      // Keep GasBurner to a single inner call per UserOp to avoid call-packing limits.
      ? buildGasBurnerCalls(gasBurnerAddress, stageLoops, stageWrites, 1)
      : buildCalls(stageCalls);
    const calls = [
      { to: USDC_ADDRESS, value: 0n, data: approveData },
      ...innerCalls,
    ];
    try {
      const before = await getUSDCBalance(account.address);
      await smartAccountClient.sendTransaction({ calls });
      const after = await getUSDCBalance(account.address);
      totalFees += before - after;
      opsCount++;
    } catch (e) {
      failedOps++;
      console.warn("UserOp failed:", (e as Error).message);
    }

    const currentDeposit = await getEntryPointDeposit(paymasterAddress);
    if (currentDeposit < minDepositSeen) minDepositSeen = currentDeposit;
    if (currentDeposit > maxDepositSeen) maxDepositSeen = currentDeposit;
    if (currentDeposit > prevDeposit + DEPOSIT_EPSILON_WEI) {
      const delta = currentDeposit - prevDeposit;
      refillCount++;
      refillCountDeposit++;
      refillTotalWei += delta;
      console.log(`[refill] detected #${refillCount}: +${delta.toString()} wei (deposit ${currentDeposit.toString()})`);
    }
    prevDeposit = currentDeposit;

    for (const acct of trackedAccounts) {
      const key = acct.address.toLowerCase();
      const prevBal = accountPrev.get(key) ?? 0n;
      const bal = await publicClient.getBalance({ address: acct.address });
      const minBal = accountMin.get(key) ?? bal;
      if (bal < minBal) accountMin.set(key, bal);
      if (bal > prevBal + ACCOUNT_REFILL_EPSILON_WEI) {
        const delta = bal - prevBal;
        refillCount++;
        refillCountAccounts++;
        refillTotalWei += delta;
        console.log(`[refill:${acct.label}] detected #${refillCount}: +${delta.toString()} wei (${bal.toString()})`);
      }
      accountPrev.set(key, bal);
    }

    if (Date.now() - lastSnapshot >= SNAPSHOT_INTERVAL_SEC * 1000) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(
        `[${elapsed}s] ops=${opsCount} failed=${failedOps} fees=${totalFees.toString()} ` +
        `deposit=${currentDeposit.toString()} refills=${refillCount} (dep=${refillCountDeposit}, acct=${refillCountAccounts})`
      );
      lastSnapshot = Date.now();
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const depositEnd = await getEntryPointDeposit(paymasterAddress);
  const drawdownWei = depositStart > minDepositSeen ? depositStart - minDepositSeen : 0n;
  const accountSummaries = trackedAccounts.map((acct) => {
    const key = acct.address.toLowerCase();
    const start = accountStart.get(key) ?? 0n;
    const min = accountMin.get(key) ?? start;
    const end = accountPrev.get(key) ?? start;
    return {
      label: acct.label,
      address: acct.address,
      start,
      min,
      end,
      drawdown: start > min ? start - min : 0n,
    };
  });

  console.log("");
  console.log("Profitability Refill Results:");
  console.log("  Duration:", Math.floor((Date.now() - startTime) / 1000), "s");
  console.log("  UserOps:", opsCount);
  console.log("  Failed UserOps:", failedOps);
  console.log("  Fees charged:", totalFees.toString(), "USDC (e6)");
  console.log("  EntryPoint deposit start:", depositStart.toString(), "wei");
  console.log("  EntryPoint deposit min:", minDepositSeen.toString(), "wei");
  console.log("  EntryPoint deposit end:", depositEnd.toString(), "wei");
  console.log("  Deposit drawdown:", drawdownWei.toString(), "wei");
  console.log("  Refill count:", refillCount, `(deposit=${refillCountDeposit}, accounts=${refillCountAccounts})`);
  console.log("  Refill total:", refillTotalWei.toString(), "wei");
  if (accountSummaries.length > 0) {
    console.log("  Tracked account balances:");
    for (const s of accountSummaries) {
      console.log(
        `    - ${s.label} ${s.address}: start=${s.start.toString()} min=${s.min.toString()} end=${s.end.toString()} drawdown=${s.drawdown.toString()}`
      );
    }
  }

  const errors: string[] = [];
  if (opsCount <= 0) errors.push("no successful UserOps");
  if (totalFees < PROFIT_THRESHOLD_E6) {
    errors.push(`fees ${totalFees.toString()} below threshold ${PROFIT_THRESHOLD_E6.toString()}`);
  }
  if (drawdownWei < MIN_DRAWDOWN_WEI) {
    errors.push(`deposit drawdown ${drawdownWei.toString()} below minimum ${MIN_DRAWDOWN_WEI.toString()}`);
  }
  if (refillCount < MIN_REFILLS) {
    errors.push(`refills ${refillCount} below minimum ${MIN_REFILLS}`);
  }
  if (staleCheckEnabled && staleWorkerAddress && wrappedNativeTokenRaw) {
    const wrappedNativeToken = wrappedNativeTokenRaw as Address;
    const staleWmaticEnd = await getTokenBalance(wrappedNativeToken, staleWorkerAddress);
    console.log(
      `  Worker WMATIC stale-check: start=${staleWmaticStart.toString()} expectedMin=${staleExpectedMinWmatic.toString()} end=${staleWmaticEnd.toString()}`
    );
    if (staleWmaticEnd < staleExpectedMinWmatic) {
      errors.push(
        `stale WMATIC was consumed (${staleWmaticEnd.toString()} < ${staleExpectedMinWmatic.toString()}); refill accounting may still unwrap pre-existing WMATIC`
      );
    }
  }

  if (errors.length > 0) {
    console.error("FAIL:", errors.join("; "));
    process.exit(1);
  }

  console.log("PASS: Increasing gas demand triggered refill and profitability checks passed.");
}

main().catch((e) => {
  console.error("Refill profitability test failed:", (e as Error).message);
  process.exit(1);
});

