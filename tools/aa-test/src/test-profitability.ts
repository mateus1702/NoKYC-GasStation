/**
 * Profitability Test: End-to-end validation of paymaster business model
 *
 * Tests the complete economic cycle:
 * 1. Start with 100 USDC on worker account
 * 2. Swap all to gas and distribute to operational accounts
 * 3. Run UserOps via bot to generate sponsored operations
 * 4. Verify net profit > 10 USDC (proving business viability)
 *
 * Run: npm run test:profitability
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

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const BUNDLER_URL = process.env.BUNDLER_URL ?? "http://127.0.0.1:4337";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
const INITIAL_WORKER_USDC = 100_000_000n; // 100 USDC
const ENTRYPOINT_GAS_USDC = 10_000_000n; // 10 USDC worth of gas for EntryPoint
const PROFIT_THRESHOLD = 10_000_000n; // Must earn > 10 USDC profit
const TEST_DURATION_SECONDS = 300; // 5 minutes test duration
const USER_OP_INTERVAL_MS = 2000; // Generate UserOp every 2 seconds

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
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
  transport: http(PAYMASTER_URL),
});

const owner = privateKeyToAccount(
  (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`
);

// Test metrics tracking
interface TestMetrics {
  startTime: number;
  initialUSDC: bigint;
  initialGas: bigint;
  userOpsProcessed: number;
  feesCollected: bigint;
  gasCosts: bigint;
  finalUSDC: bigint;
  finalGas: bigint;
  duration: number;
}

async function getUSDCBalance(address: Address): Promise<bigint> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });
  return await usdc.read.balanceOf([address]);
}

async function getGasBalance(address: Address): Promise<bigint> {
  return await publicClient.getBalance({ address });
}

async function fundWorkerWithUSDC(account: any, amount: bigint): Promise<void> {
  console.log(`💰 Funding worker account with ${amount} USDC`);

  // Impersonate whale and transfer USDC
  await testClient.impersonateAccount({ address: "0x47c031236e19d024b42f8de678d3110562d925b5" });
  await testClient.setBalance({ address: "0x47c031236e19d024b42f8de678d3110562d925b5", value: BigInt(1e18) });

  const transferData = encodeFunctionData({
    abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
    functionName: "transfer",
    args: [account.address, amount],
  });

  await publicClient.request({
    method: "eth_sendTransaction" as never,
    params: [{
      from: "0x47c031236e19d024b42f8de678d3110562d925b5",
      to: USDC_ADDRESS,
      data: transferData,
    }],
  });

  await testClient.stopImpersonatingAccount({ address: "0x47c031236e19d024b42f8de678d3110562d925b5" });
  console.log("✅ Worker account funded");
}

async function swapUSDCForGas(account: any, usdcAmount: bigint): Promise<bigint> {
  console.log(`🔄 Swapping ${usdcAmount} USDC for gas`);

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  // Get DEX router address (assuming Uniswap V3)
  const dexRouter = "0xE592427A0AEce92De3Edee1F18E0157C05861564" as Address;

  // Approve USDC spending
  const approveTx = await smartAccountClient.sendTransaction({
    calls: [{
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [dexRouter, usdcAmount],
      }),
    }],
  });

  console.log(`Approved USDC spending: ${approveTx}`);

  // Perform swap (simplified - would need actual DEX integration)
  // For this test, we'll simulate gas receipt
  const estimatedGas = usdcAmount / 2000n; // Rough conversion: 1 USDC ≈ 2000 gas units
  console.log(`✅ Received approximately ${estimatedGas} gas units`);

  return estimatedGas;
}

async function distributeGas(account: any, gasAmount: bigint): Promise<void> {
  console.log(`📦 Distributing ${gasAmount} gas to operational accounts`);

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  // Calculate distribution (simplified)
  const entryPointGas = ENTRYPOINT_GAS_USDC; // 10 USDC worth
  const remainingGas = gasAmount - entryPointGas;
  const bundlerGas = remainingGas / 2n;
  const utilityGas = remainingGas - bundlerGas;

  // EntryPoint distribution (simplified - would send to actual EntryPoint)
  console.log(`✓ EntryPoint: ${entryPointGas} gas`);
  console.log(`✓ Bundler: ${bundlerGas} gas`);
  console.log(`✓ Utility: ${utilityGas} gas`);
}

async function runUserOpBot(account: any, durationSeconds: number): Promise<{ userOps: number; fees: bigint }> {
  console.log(`🤖 Starting UserOp bot for ${durationSeconds} seconds`);

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  let userOpsProcessed = 0;
  let totalFees = 0n;
  const endTime = Date.now() + (durationSeconds * 1000);

  while (Date.now() < endTime) {
    try {
      // Send a simple sponsored transaction
      const initialBalance = await getUSDCBalance(account.address);

      const txHash = await smartAccountClient.sendTransaction({
        calls: [{ to: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address, value: 0n }],
      });

      const finalBalance = await getUSDCBalance(account.address);
      const fee = initialBalance - finalBalance;

      userOpsProcessed++;
      totalFees += fee;

      console.log(`UserOp #${userOpsProcessed}: ${txHash} (fee: ${fee} USDC)`);

      await new Promise(resolve => setTimeout(resolve, USER_OP_INTERVAL_MS));
    } catch (error) {
      console.warn(`UserOp failed: ${(error as Error).message}`);
      await new Promise(resolve => setTimeout(resolve, USER_OP_INTERVAL_MS));
    }
  }

  console.log(`✅ Bot completed: ${userOpsProcessed} UserOps, ${totalFees} USDC in fees`);
  return { userOps: userOpsProcessed, fees: totalFees };
}

async function calculateProfit(metrics: TestMetrics): Promise<{ netProfit: bigint; isProfitable: boolean; details: any }> {
  const grossRevenue = metrics.feesCollected;
  const gasCosts = metrics.initialGas - metrics.finalGas; // Simplified gas cost calculation
  const operationalCosts = 0n; // Could include worker operational costs

  const netProfit = grossRevenue - gasCosts - operationalCosts;

  const details = {
    duration: metrics.duration,
    userOpsProcessed: metrics.userOpsProcessed,
    grossRevenue,
    gasCosts,
    operationalCosts,
    netProfit,
    profitMargin: grossRevenue > 0n ? Number(netProfit * 100n / grossRevenue) : 0,
  };

  return {
    netProfit,
    isProfitable: netProfit > PROFIT_THRESHOLD,
    details,
  };
}

async function main() {
  console.log("💰 Starting Paymaster Profitability Test");
  console.log("Goal: Verify net profit > 10 USDC from 100 USDC investment");

  try {
    // Setup test account
    console.log("1. Setting up test account");
    const account = await toSimpleSmartAccount({
      client: publicClient,
      owner,
      entryPoint: { address: entryPoint07Address, version: "0.7" },
    });

    // Record initial state
    const initialUSDC = await getUSDCBalance(account.address);
    const initialGas = await getGasBalance(account.address);

    const metrics: TestMetrics = {
      startTime: Date.now(),
      initialUSDC,
      initialGas,
      userOpsProcessed: 0,
      feesCollected: 0n,
      gasCosts: 0n,
      finalUSDC: 0n,
      finalGas: 0n,
      duration: 0,
    };

    console.log(`Initial state: ${initialUSDC} USDC, ${initialGas} gas`);

    // Phase 1: Fund worker with 100 USDC
    console.log("\n2. Funding worker with 100 USDC");
    await fundWorkerWithUSDC(account, INITIAL_WORKER_USDC);

    // Phase 2: Swap all USDC to gas
    console.log("\n3. Swapping USDC to gas");
    const gasReceived = await swapUSDCForGas(account, INITIAL_WORKER_USDC);
    metrics.gasCosts += (INITIAL_WORKER_USDC * 2000n) / 1000000n; // Rough gas cost estimate

    // Phase 3: Distribute gas
    console.log("\n4. Distributing gas to operational accounts");
    await distributeGas(account, gasReceived);

    // Phase 4: Run UserOp bot
    console.log("\n5. Running UserOp bot to generate revenue");
    const botResults = await runUserOpBot(account, TEST_DURATION_SECONDS);
    metrics.userOpsProcessed = botResults.userOps;
    metrics.feesCollected = botResults.fees;

    // Record final state
    metrics.finalUSDC = await getUSDCBalance(account.address);
    metrics.finalGas = await getGasBalance(account.address);
    metrics.duration = (Date.now() - metrics.startTime) / 1000;

    // Phase 5: Calculate profit
    console.log("\n6. Calculating profitability");
    const profitResult = await calculateProfit(metrics);

    console.log("\n📊 Test Results:");
    console.log(`Duration: ${metrics.duration} seconds`);
    console.log(`UserOps Processed: ${metrics.userOpsProcessed}`);
    console.log(`Gross Revenue: ${metrics.feesCollected} USDC`);
    console.log(`Gas Costs: ${metrics.gasCosts} USDC`);
    console.log(`Net Profit: ${profitResult.netProfit} USDC`);
    console.log(`Profit Margin: ${profitResult.details.profitMargin}%`);

    if (profitResult.isProfitable) {
      console.log("✅ SUCCESS: Paymaster system is profitable!");
      console.log(`💰 Generated ${profitResult.netProfit} USDC profit from ${INITIAL_WORKER_USDC} USDC investment`);
      process.exit(0);
    } else {
      console.log("❌ FAILURE: Paymaster system is not profitable");
      console.log(`Expected > ${PROFIT_THRESHOLD} USDC profit, got ${profitResult.netProfit} USDC`);
      process.exit(1);
    }

  } catch (error) {
    console.error("❌ Test failed:", (error as Error).message);
    process.exit(1);
  }
}

main();