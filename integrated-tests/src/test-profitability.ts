/**
 * Profitability Test: End-to-end validation of paymaster business model
 *
 * Tests the complete economic cycle:
 * 1. Fund account with USDC
 * 2. Run sponsored UserOps to generate revenue
 * 3. Verify fees collected (quick e2e, ~minutes)
 *
 * Run: npm run test:profitability
 * For long-run soak: npm run test:profitability:soak
 */
import "./load-env.js";
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
  fundAccountWithUSDC,
  FUNDING_AMOUNT,
  MIN_USDC_BALANCE,
} from "./funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000";
const BUNDLER_URL =
  process.env.TOOLS_BUNDLER_URL ?? `${PAYMASTER_URL.replace(/\/$/, "")}/bundler/rpc`;
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const TEST_DURATION_SECONDS = 60;
const USER_OP_INTERVAL_MS = 3000;

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

async function main() {
  console.log("AA Infrastructure:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("");

  console.log("Profitability test: running UserOp bot for", TEST_DURATION_SECONDS, "seconds");

  try {
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
        FUNDING_AMOUNT,
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

    let userOpsProcessed = 0;
    let totalFees = 0n;
    const endTime = Date.now() + TEST_DURATION_SECONDS * 1000;

    while (Date.now() < endTime) {
      try {
        const before = await usdc.read.balanceOf([account.address]);
        await smartAccountClient.sendTransaction({
          calls: [{ to: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address, value: 0n }],
        });
        const after = await usdc.read.balanceOf([account.address]);
        const fee = before - after;
        userOpsProcessed++;
        totalFees += fee;
        console.log(`  UserOp #${userOpsProcessed}: fee ${fee}`);
      } catch (e) {
        console.warn("UserOp failed:", (e as Error).message);
      }
      await new Promise(r => setTimeout(r, USER_OP_INTERVAL_MS));
    }

    console.log("");
    console.log("Results:");
    console.log("  UserOps processed:", userOpsProcessed);
    console.log("  Total fees collected:", totalFees.toString(), "USDC (e6)");

    if (userOpsProcessed > 0 && totalFees > 0n) {
      console.log("PASS: Profitability test completed; fees were charged.");
      process.exit(0);
    } else {
      console.error("FAIL: No fees collected or no UserOps processed");
      process.exit(1);
    }
  } catch (error) {
    console.error("Test failed:", (error as Error).message);
    process.exit(1);
  }
}

main();
