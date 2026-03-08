/**
 * Test: Sponsored UserOp with SimpleAccount charging variable USDC (Redis inventory).
 * Uses Project4Paymaster + paymaster-api (Redis variable pricing).
 *
 * Prereqs: docker compose up (anvil, contract-deployer, bundler-alto, paymaster-api, valkey, worker)
 * Run: pnpm test:project4:fee (from tools/aa-test)
 *
 * Options (env):
 *   RUN_UNTIL_EMPTY=true  - Keep sending UserOps until USDC balance is empty
 *   MIN_USDC_TO_CONTINUE  - Min balance (e6) to continue loop (default: 100000 = 0.1 USDC)
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
const FUNDING_WHALE = process.env.USDC_WHALE as Address | undefined;
const FUNDING_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6);
const DEFAULT_WHALE_CANDIDATES = [
  "0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055",
  "0xb75f972af41d6ff0bcc6b2613b832632de1e418b",
  "0x815937a75074e0df3419973c629221c82121a082",
  "0xffa8db7b38579e6a2d14f9b347a9ace4d044cd54",
] as Address[];
const FUNDING_WHALE_CANDIDATES = (
  process.env.USDC_WHALE_CANDIDATES?.split(",")
    .map((x) => x.trim())
    .filter(Boolean) ?? []
) as Address[];

const RUN_UNTIL_EMPTY = process.env.TOOLS_RUN_UNTIL_EMPTY === "true";
const MIN_USDC_TO_CONTINUE = BigInt(process.env.TOOLS_MIN_USDC_TO_CONTINUE ?? "100000"); // 0.1 USDC

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
  console.log("Creating SimpleAccount...");
  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
  });

  console.log("SimpleAccount address:", account.address);

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

  // Fund smart account with USDC via whale impersonation (Anvil fork)
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address, uint256) returns (bool)",
    ]),
    client: publicClient,
  });

  const balanceBefore = await usdc.read.balanceOf([account.address]);
  console.log("USDC balance before:", balanceBefore.toString());

  if (balanceBefore < parseUnits("1", 6)) {
    const candidateWhales: Address[] = [
      ...(FUNDING_WHALE ? [FUNDING_WHALE] : []),
      ...FUNDING_WHALE_CANDIDATES,
      ...DEFAULT_WHALE_CANDIDATES,
    ].filter((addr, idx, arr) => arr.findIndex((x) => x.toLowerCase() === addr.toLowerCase()) === idx);

    if (candidateWhales.length === 0) {
      console.error("No whale candidates configured.");
      process.exit(1);
    }

    let whale: Address | undefined;
    let whaleBefore = 0n;
    for (const candidate of candidateWhales) {
      const candidateBal = await usdc.read.balanceOf([candidate]);
      if (candidateBal >= FUNDING_AMOUNT) {
        whale = candidate;
        whaleBefore = candidateBal;
        break;
      }
    }

    if (!whale) {
      console.error("No configured whale has enough USDC at current fork block.");
      process.exit(1);
    }

    console.log("Funding with whale:", whale);

    await testClient.impersonateAccount({ address: whale });
    await testClient.setBalance({ address: whale, value: BigInt(1e18) });

    const transferData = encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [account.address, FUNDING_AMOUNT],
    });

    const transferHash = await publicClient.request({
      method: "eth_sendTransaction" as never,
      params: [
        {
          from: whale,
          to: USDC_ADDRESS,
          data: transferData,
          gas: "0x186A0",
        },
      ],
    });

    const transferReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferHash as `0x${string}`,
    });

    await testClient.stopImpersonatingAccount({ address: whale });

    const balanceAfterTransfer = await usdc.read.balanceOf([account.address]);
    console.log("USDC balance after fund:", balanceAfterTransfer.toString());

    if (balanceAfterTransfer < parseUnits("1", 6)) {
      if (whaleBefore < FUNDING_AMOUNT) {
        console.error("Whale has insufficient USDC at current fork block.");
      } else if (transferReceipt.status !== "success") {
        console.error("USDC transfer transaction reverted.");
      } else {
        console.error("Funding transfer did not increase smart account USDC balance.");
      }
      console.error("Failed to fund account with USDC.");
      process.exit(1);
    }
  }

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => {
        return (await paymasterClient.getUserOperationGasPrice()).fast;
      },
    },
  });


  console.log("Paymaster address:", paymasterAddress);

  // Step 1: Bootstrap - approve paymaster to spend USDC (this UserOp is not charged)
  console.log("Step 1: Approving paymaster to spend USDC...");
  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress, parseUnits("1000000", 6)],
  });

  const bootstrapHash = await smartAccountClient.sendTransaction({
    calls: [{ to: USDC_ADDRESS, value: 0n, data: approveData }],
  });
  console.log("Bootstrap tx hash:", bootstrapHash);

  let balanceAfterBootstrap = await usdc.read.balanceOf([account.address]);
  console.log("USDC balance after bootstrap:", balanceAfterBootstrap.toString());

  const to = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address;
  let opCount = 0;
  let totalFeeCharged = 0n;

  const sendOneUserOp = async (): Promise<{ hash: `0x${string}`; fee: bigint }> => {
    const before = await usdc.read.balanceOf([account.address]);
    const txHash = await smartAccountClient.sendTransaction({
      calls: [{ to, value: 0n }],
    });
    const after = await usdc.read.balanceOf([account.address]);
    const fee = before - after;
    return { hash: txHash, fee };
  };

  if (RUN_UNTIL_EMPTY) {
    console.log("Step 2: Sending UserOps until USDC is empty (RUN_UNTIL_EMPTY=true)...");
    let balance = balanceAfterBootstrap;
    while (balance >= MIN_USDC_TO_CONTINUE) {
      try {
        const { hash, fee } = await sendOneUserOp();
        opCount++;
        totalFeeCharged += fee;
        balance = await usdc.read.balanceOf([account.address]);
        console.log(`  UserOp #${opCount} hash=${hash} fee=${fee} balance=${balance}`);
        if (balance < MIN_USDC_TO_CONTINUE) {
          console.log("USDC balance below threshold, stopping.");
          break;
        }
      } catch (e) {
        console.error("UserOp failed (likely insufficient USDC):", (e as Error).message);
        break;
      }
    }
    console.log(`Done. Sent ${opCount} UserOps, total USDC charged: ${totalFeeCharged}`);
    if (opCount === 0) {
      console.error("No UserOps were sent.");
      process.exit(1);
    }
  } else {
    // Single UserOp
    console.log("Step 2: Sending sponsored UserOp (variable USDC fee)...");
    const { hash, fee } = await sendOneUserOp();
    console.log("Transaction hash:", hash);
    if (fee <= 0n) {
      console.error("Expected USDC to be charged but balance did not decrease");
      process.exit(1);
    }
    console.log("USDC fee charged:", fee.toString(), "(6 decimals)");
    console.log("Done. UserOp was sponsored and variable USDC was charged.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
