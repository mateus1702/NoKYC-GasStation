import "./load-env.js";
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
import {
  USDC_ADDRESS,
  DEFAULT_TRANSFER_TARGET,
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
} from "./funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.TOOLS_BUNDLER_URL ?? `${PAYMASTER_URL.replace(/\/$/, "")}/bundler/rpc`;
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const VULN_FUND_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "10", 6);

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

function logAaInfra() {
  console.log("AA Infrastructure:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("");
}

async function getUSDCBalance(address: Address): Promise<bigint> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });

  return await usdc.read.balanceOf([address]);
}

async function submitUnstableGasOperation(account: { address: Address }, operationType: string, iteration: number) {
  console.log(`   Submitting ${operationType} operation #${iteration}...`);

  const initialBalance = await getUSDCBalance(account.address);

  let callData: `0x${string}`;
  let targetAddress: Address;

  switch (operationType) {
    case 'massive_approval':
      callData = encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [DEFAULT_TRANSFER_TARGET, parseUnits("1000000000", 6) * BigInt(iteration)],
      });
      targetAddress = USDC_ADDRESS;
      break;

    case 'complex_transfer':
      callData = encodeFunctionData({
        abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
        functionName: "transfer",
        args: [DEFAULT_TRANSFER_TARGET, parseUnits("1", 6) + BigInt(iteration * 1000000)],
      });
      targetAddress = USDC_ADDRESS;
      break;

    default:
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

    return { txHash, usdcCharged, success: true, error: null as string | null };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`   ${operationType} #${iteration}: FAILED - ${msg}`);

    const finalBalance = await getUSDCBalance(account.address);
    const usdcDeducted = initialBalance - finalBalance;

    return { txHash: null as `0x${string}` | null, usdcCharged: usdcDeducted, success: false, error: msg };
  }
}

async function main() {
  logAaInfra();
  console.log("Confirming Gas Estimation Attacks Vulnerability");
  console.log("   Testing: Operations with unstable gas profiles should cause failures/variance");

  try {
    console.log("1. Setting up test account...");
    const account = await toSimpleSmartAccount({
      client: publicClient,
      owner,
      entryPoint: { address: entryPoint07Address, version: "0.7" },
    });

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
      console.log(`   Funding ${account.address} with ${VULN_FUND_AMOUNT} USDC...`);
      await fundAccountWithUSDC(
        account.address,
        VULN_FUND_AMOUNT,
        usdc,
        publicClient,
        testClient
      );
      const after = await usdc.read.balanceOf([account.address]);
      console.log(`   USDC balance after fund: ${after}`);
      if (after < MIN_USDC_BALANCE) {
        console.error("Failed to fund account with USDC");
        process.exit(1);
      }
    }

    const initialUSDC = await getUSDCBalance(account.address);
    console.log(`   Initial USDC balance: ${initialUSDC}`);

    let paymasterAddress = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
    if (!paymasterAddress) {
      const base = PAYMASTER_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/paymaster-address`);
      if (!res.ok) {
        console.error("Could not get paymaster address. Set TOOLS_PAYMASTER_ADDRESS or ensure paymaster-api is running.");
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

    console.log("3. Executing gas estimation attack simulation...");
    const operations: { txHash: `0x${string}` | null; usdcCharged: bigint; success: boolean; error: string | null }[] = [];

    const operationTypes = [
      'massive_approval', 'complex_transfer', 'massive_approval', 'complex_transfer',
      'massive_approval', 'complex_transfer', 'massive_approval', 'complex_transfer'
    ];

    for (let i = 0; i < operationTypes.length; i++) {
      const result = await submitUnstableGasOperation(account, operationTypes[i], i + 1);
      operations.push(result);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log("4. Analyzing results...");
    const successfulOps = operations.filter(op => op.success);
    const failedOps = operations.filter(op => !op.success);
    const totalCharged = operations.reduce((sum, op) => sum + op.usdcCharged, 0n);

    const costs = operations.map(op => op.usdcCharged).filter(cost => cost > 0n);
    const minCost = costs.length > 0 ? costs.reduce((min, cost) => cost < min ? cost : min, costs[0]) : 0n;
    const maxCost = costs.length > 0 ? costs.reduce((max, cost) => cost > max ? cost : max, costs[0]) : 0n;
    const costVariance = maxCost - minCost;

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

    const hasFailures = failedOps.length > 0;
    const hasHighVariance = variancePercent > 50;

    if (operations.length >= 5 && (hasFailures || hasHighVariance)) {
      const failureRate = (failedOps.length * 100) / operations.length;
      console.log(`PASS: Gas estimation attacks confirmed: ${failedOps.length}/${operations.length} operations failed (${failureRate}%) or had cost variance >${variancePercent}%`);
      process.exit(0);
    } else {
      console.log(`FAIL: Gas estimation attacks not confirmed: ${failedOps.length} failures, ${variancePercent}% variance`);
      process.exit(1);
    }

  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

main();
