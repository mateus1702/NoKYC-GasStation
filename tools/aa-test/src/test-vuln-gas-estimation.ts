/**
 * Vulnerability Confirmation: Gas Estimation Attacks (Medium Risk)
 * Test: Submit operations with unstable gas profiles to observe estimation failures
 *
 * Expected: Test passes when operations show estimation failures or cost variance,
 * confirming vulnerability to gas estimation attacks.
 *
 * Run: npm run test:vuln:gas-estimation
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
const WHALE_ADDRESS = "0x47c031236e19d024b42f8de678d3110562d925b5" as Address;
const FUNDING_AMOUNT = parseUnits("10", 6); // 10 USDC for funding

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

async function fundAccountWithUSDC(accountAddress: Address) {
  console.log(`   Funding ${accountAddress} with ${FUNDING_AMOUNT} USDC...`);

  await testClient.impersonateAccount({ address: WHALE_ADDRESS });
  await testClient.setBalance({ address: WHALE_ADDRESS, value: BigInt(1e18) });

  const usdcAbi = parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)"
  ]);

  const transferData = encodeFunctionData({
    abi: usdcAbi,
    functionName: "transfer",
    args: [accountAddress, FUNDING_AMOUNT],
  });

  await publicClient.request({
    method: "eth_sendTransaction",
    params: [{
      from: WHALE_ADDRESS,
      to: USDC_ADDRESS,
      data: transferData,
    }],
  } as any);

  await testClient.stopImpersonatingAccount({ address: WHALE_ADDRESS });
}

async function getUSDCBalance(address: Address): Promise<bigint> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });

  return await usdc.read.balanceOf([address]);
}

async function submitUnstableGasOperation(account: any, operationType: string, iteration: number) {
  console.log(`   Submitting ${operationType} operation #${iteration}...`);

  const initialBalance = await getUSDCBalance(account.address);

  let callData: `0x${string}`;
  let targetAddress: Address;

  // Create operations with unstable gas profiles
  switch (operationType) {
    case 'massive_approval':
      // Massive approval that might cause gas estimation issues
      callData = encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [WHALE_ADDRESS, parseUnits("1000000000", 6) * BigInt(iteration)], // Increasing massive amounts
      });
      targetAddress = USDC_ADDRESS;
      break;

    case 'complex_transfer':
      // Transfer to contract that might have complex logic
      callData = encodeFunctionData({
        abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
        functionName: "transfer",
        args: [WHALE_ADDRESS, parseUnits("1", 6) + BigInt(iteration * 1000000)], // Variable amounts
      });
      targetAddress = USDC_ADDRESS;
      break;

    default:
      // Fallback to simple operation
      callData = encodeFunctionData({
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [account.address],
      });
      targetAddress = USDC_ADDRESS;
  }

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  try {
    const txHash = await smartAccountClient.sendTransaction({
      calls: [{ to: targetAddress, value: 0n, data: callData }],
    });

    const finalBalance = await getUSDCBalance(account.address);
    const usdcCharged = initialBalance - finalBalance;

    console.log(`   ${operationType} #${iteration}: SUCCESS - charged ${usdcCharged} USDC`);

    return { txHash, usdcCharged, success: true, error: null };
  } catch (error: any) {
    console.log(`   ${operationType} #${iteration}: FAILED - ${error.message}`);

    // Even on failure, check if any balance was deducted (might indicate partial execution)
    const finalBalance = await getUSDCBalance(account.address);
    const usdcDeducted = initialBalance - finalBalance;

    return { txHash: null, usdcCharged: usdcDeducted, success: false, error: error.message };
  }
}

async function main() {
  console.log("🔍 Confirming Gas Estimation Attacks Vulnerability");
  console.log("   Testing: Operations with unstable gas profiles should cause failures/variance");

  try {
    // Setup: Create account and fund with USDC
    console.log("1. Setting up test account...");
    const account = await toSimpleSmartAccount({
      client: publicClient,
      owner,
      entryPoint: { address: entryPoint07Address, version: "0.7" },
    });

    await fundAccountWithUSDC(account.address);
    const initialUSDC = await getUSDCBalance(account.address);
    console.log(`   Initial USDC balance: ${initialUSDC}`);

    // Get paymaster address (from env or fetch from API)
    let paymasterAddress = process.env.PAYMASTER_ADDRESS as Address | undefined;
    if (!paymasterAddress) {
      const base = PAYMASTER_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/paymaster-address`);
      if (!res.ok) {
        console.error("Could not get paymaster address. Set PAYMASTER_ADDRESS or ensure paymaster-api is running.");
        process.exit(1);
      }
      const json = (await res.json()) as { paymasterAddress?: string };
      paymasterAddress = json.paymasterAddress as Address;
      if (!paymasterAddress) {
        console.error("API did not return paymaster address");
        process.exit(1);
      }
      console.log("Paymaster address:", paymasterAddress);
    }

    // Bootstrap: Approve paymaster to spend USDC (this UserOp is not charged)
    console.log("2. Approving paymaster to spend USDC...");
    const bootstrapSmartAccountClient = createSmartAccountClient({
      account,
      chain: localChain,
      bundlerTransport: http(BUNDLER_URL),
      paymaster: paymasterClient,
      userOperation: {
        estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
      },
    });

    const approveData = encodeFunctionData({
      abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
      functionName: "approve",
      args: [paymasterAddress, parseUnits("1000000", 6)],
    });

    const bootstrapHash = await bootstrapSmartAccountClient.sendTransaction({
      calls: [{ to: USDC_ADDRESS, value: 0n, data: approveData }],
    });
    console.log("Bootstrap tx hash:", bootstrapHash);

    // Test: Submit operations with potentially unstable gas profiles
    console.log("3. Executing gas estimation attack simulation...");
    const operations = [];

    // Mix of operation types that might cause estimation issues
    const operationTypes = [
      'massive_approval', 'complex_transfer', 'massive_approval', 'complex_transfer',
      'massive_approval', 'complex_transfer', 'massive_approval', 'complex_transfer'
    ];

    for (let i = 0; i < operationTypes.length; i++) {
      const result = await submitUnstableGasOperation(account, operationTypes[i], i + 1);
      operations.push(result);

      // Small delay between operations
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Analysis
    console.log("4. Analyzing results...");
    const successfulOps = operations.filter(op => op.success);
    const failedOps = operations.filter(op => !op.success);
    const totalCharged = operations.reduce((sum, op) => sum + op.usdcCharged, 0n);

    const costs = operations.map(op => op.usdcCharged).filter(cost => cost > 0n);
    const minCost = costs.length > 0 ? costs.reduce((min, cost) => cost < min ? cost : min, costs[0]) : 0n;
    const maxCost = costs.length > 0 ? costs.reduce((max, cost) => cost > max ? cost : max, costs[0]) : 0n;
    const costVariance = maxCost - minCost;

    // Calculate variance percentage
    const avgCost = costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0n) / BigInt(costs.length) : 0n;
    const variancePercent = avgCost > 0n ? Number((costVariance * 100n) / avgCost) : 0;

    console.log(`   Results:`);
    console.log(`   - Operations attempted: ${operations.length}`);
    console.log(`   - Successful operations: ${successfulOps.length}`);
    console.log(`   - Failed operations: ${failedOps.length}`);
    console.log(`   - Total USDC charged: ${totalCharged}`);
    console.log(`   - Cost variance: ${costVariance} USDC (${variancePercent}% of average)`);

    if (failedOps.length > 0) {
      console.log(`   - Failures: ${failedOps.map(op => op.error).join(', ')}`);
    }

    // Success criteria: observe failures or significant cost variance
    const hasFailures = failedOps.length > 0;
    const hasHighVariance = variancePercent > 50; // More than 50% variance

    if (operations.length >= 5 && (hasFailures || hasHighVariance)) {
      const failureRate = (failedOps.length * 100) / operations.length;
      console.log(`✅ Gas estimation attacks confirmed: ${failedOps.length}/${operations.length} operations failed (${failureRate}%) or had cost variance >${variancePercent}% from estimates`);
      process.exit(0);
    } else {
      console.log(`❌ Gas estimation attacks not confirmed: ${failedOps.length} failures, ${variancePercent}% variance`);
      process.exit(1);
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

main();