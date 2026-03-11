import "./load-env.js";
/**
 * Long-running profitability soak test.
 *
 * Validates realized margin against local AA containers over hours.
 * - Warmup period
 * - Sustained UserOp generation for configurable duration
 * - Periodic metrics snapshots
 * - Final profitability assertion (revenue, optional margin from Redis pricing)
 *
 * Run: npm run test:profitability:soak
 *
 * Env:
 *   SOAK_DURATION_MINUTES  - Duration in minutes (default: 60)
 *   SOAK_PROFIT_THRESHOLD_USDC_E6 - Min revenue to pass (default: 1000000 = 1 USDC)
 *   SOAK_WARMUP_OPS - Warmup UserOps before main phase (default: 3)
 *   SOAK_INTERVAL_MS - Delay between UserOps (default: 5000)
 *   SOAK_SNAPSHOT_INTERVAL_SECONDS - Log summary interval (default: 300 = 5 min)
 *   TOOLS_SOAK_FUND_AMOUNT - USDC to fund account (default: 500, or TOOLS_USDC_FUND_AMOUNT)
 */
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { toSimpleSmartAccount } from "permissionless/accounts";
import {
  createPublicClient,
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
import { privateKeyToAccount } from "viem/accounts";
import { computeProfitability, readTotalsState } from "@project4/shared";
import {
  USDC_ADDRESS,
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
} from "./funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.TOOLS_BUNDLER_URL ?? `${PAYMASTER_URL.replace(/\/$/, "")}/bundler/rpc`;
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const SOAK_FUND_AMOUNT = parseUnits(
  process.env.TOOLS_SOAK_FUND_AMOUNT ?? process.env.TOOLS_USDC_FUND_AMOUNT ?? "500",
  6
);

const DURATION_MINUTES = Number(process.env.TOOLS_SOAK_DURATION_MINUTES ?? "60");
const PROFIT_THRESHOLD_E6 = BigInt(process.env.TOOLS_SOAK_PROFIT_THRESHOLD_USDC_E6 ?? "1000000");
const WARMUP_OPS = Number(process.env.TOOLS_SOAK_WARMUP_OPS ?? "3");
const INTERVAL_MS = Number(process.env.TOOLS_SOAK_INTERVAL_MS ?? "5000");
const SNAPSHOT_INTERVAL_SEC = Number(process.env.TOOLS_SOAK_SNAPSHOT_INTERVAL_SECONDS ?? "300");
const REVENUE_ADDRESS = (process.env.TOOLS_SOAK_REVENUE_ADDRESS ?? process.env.TOOLS_DASHBOARD_REVENUE_ADDRESS ?? process.env.TOOLS_WORKER_REVENUE_ADDRESS ?? "").toLowerCase();

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

async function getUSDCBalance(address: Address): Promise<bigint> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });
  return usdc.read.balanceOf([address]);
}

async function getEntryPointBalance(paymasterAddress: Address): Promise<bigint> {
  const bal = await publicClient.readContract({
    address: ENTRYPOINT_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  return bal as bigint;
}

async function main() {
  console.log("Soak Test Configuration:");
  console.log("  Duration:", DURATION_MINUTES, "minutes");
  console.log("  Profit threshold:", PROFIT_THRESHOLD_E6.toString(), "USDC (e6)");
  console.log("  Warmup ops:", WARMUP_OPS);
  console.log("  Interval:", INTERVAL_MS, "ms");
  console.log("  Snapshot every:", SNAPSHOT_INTERVAL_SEC, "s");
  console.log("");

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
      SOAK_FUND_AMOUNT,
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

  await smartAccountClient.sendTransaction({
    calls: [{ to: USDC_ADDRESS, value: 0n, data: approveData }],
  });

  let revenueStart = 0n;
  let epStart = 0n;
  let totalsStart: { totalUsdcSpentE6: bigint; totalGasReturnedWei: bigint; unitCostUsdcPerWei: bigint } | null = null;

  if (REVENUE_ADDRESS) {
    revenueStart = await getUSDCBalance(REVENUE_ADDRESS as Address);
  }
  if (paymasterAddress) {
    epStart = await getEntryPointBalance(paymasterAddress);
  }
  try {
    const state = await readTotalsState();
    if (state.unitCostUsdcPerWei > 0n) {
      totalsStart = {
        totalUsdcSpentE6: state.totalUsdcSpentE6,
        totalGasReturnedWei: state.totalGasReturnedWei,
        unitCostUsdcPerWei: state.unitCostUsdcPerWei,
      };
    }
  } catch {
    console.warn("Could not read Redis pricing; margin check will be skipped.");
  }

  console.log("Warmup phase...");
  for (let i = 0; i < WARMUP_OPS; i++) {
    try {
      await smartAccountClient.sendTransaction({
        calls: [{ to: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address, value: 0n }],
      });
    } catch (e) {
      console.warn("Warmup op failed:", (e as Error).message);
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  const startTime = Date.now();
  const endTime = startTime + DURATION_MINUTES * 60 * 1000;
  let lastSnapshot = startTime;
  let opsCount = 0;
  let totalFees = 0n;

  console.log("Main phase started.");

  while (Date.now() < endTime) {
    try {
      const before = await getUSDCBalance(account.address);
      await smartAccountClient.sendTransaction({
        calls: [{ to: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address, value: 0n }],
      });
      const after = await getUSDCBalance(account.address);
      totalFees += before - after;
      opsCount++;
    } catch (e) {
      console.warn("UserOp failed:", (e as Error).message);
    }

    if (Date.now() - lastSnapshot >= SNAPSHOT_INTERVAL_SEC * 1000) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`[${elapsed}s] Ops: ${opsCount}, Revenue (fees): ${totalFees}`);
      lastSnapshot = Date.now();
    }

    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  let revenueEnd = 0n;
  let epEnd = 0n;
  let totalsEnd: typeof totalsStart = null;

  if (REVENUE_ADDRESS) {
    revenueEnd = await getUSDCBalance(REVENUE_ADDRESS as Address);
  }
  if (paymasterAddress) {
    epEnd = await getEntryPointBalance(paymasterAddress);
  }
  try {
    const state = await readTotalsState();
    if (state.unitCostUsdcPerWei > 0n) {
      totalsEnd = {
        totalUsdcSpentE6: state.totalUsdcSpentE6,
        totalGasReturnedWei: state.totalGasReturnedWei,
        unitCostUsdcPerWei: state.unitCostUsdcPerWei,
      };
    }
  } catch {
    /* ignore */
  }

  const revenueDelta = REVENUE_ADDRESS ? revenueEnd - revenueStart : totalFees;
  const epDelta = paymasterAddress ? epStart - epEnd : 0n;

  console.log("");
  console.log("Soak Test Results:");
  console.log("  Duration:", Math.floor((Date.now() - startTime) / 1000), "s");
  console.log("  UserOps:", opsCount);
  console.log("  Revenue (fees tracked):", totalFees.toString(), "USDC (e6)");
  if (REVENUE_ADDRESS) {
    console.log("  Revenue (treasury delta):", revenueDelta.toString(), "USDC (e6)");
  }
  if (paymasterAddress) {
    console.log("  EntryPoint deposit delta:", epDelta.toString(), "wei");
  }
  const gasSoldWei = epDelta > 0n ? epDelta : 0n;
  if (totalsEnd && totalsEnd.unitCostUsdcPerWei > 0n && gasSoldWei > 0n) {
    const res = computeProfitability({
      revenueUsdcE6: totalFees,
      gasSoldWei,
      unitCostUsdcPerWei: totalsEnd.unitCostUsdcPerWei,
    });
    console.log("  COGS (est.):", res.cogsUsdcE6.toString());
    console.log("  Profit (est.):", res.profitUsdcE6.toString());
    console.log("  Margin (est.):", res.marginBps.toString(), "bps");
    console.log("  Profitable:", res.isProfitable);
  }

  if (totalFees >= PROFIT_THRESHOLD_E6) {
    console.log("PASS: Soak test completed; revenue threshold met.");
    process.exit(0);
  } else {
    console.error("FAIL: Revenue", totalFees.toString(), "< threshold", PROFIT_THRESHOLD_E6.toString());
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Soak test failed:", (e as Error).message);
  process.exit(1);
});
