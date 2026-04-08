import "../../src/load-env.js";
/**
 * Test: Sponsored UserOp with SimpleAccount; USDC fee from Project4Paymaster postOp
 * (on-chain pricing counters + caps via paymaster-api). Gas limits come from the bundler
 * estimate path; sponsorship uses pm_sponsorUserOperation for paymasterData only.
 *
 * Prereqs: stack up (anvil/fork RPC, contract-deployer, bundler-alto, paymaster-api, valkey, config-bootstrap).
 * Run: npm run test:project4:fee (from repo root or integrated-tests workspace)
 *
 * Env:
 *   TOOLS_RUN_UNTIL_EMPTY=true  — keep sending UserOps until balance below TOOLS_MIN_USDC_TO_CONTINUE
 */
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { toSimpleSmartAccount } from "permissionless/accounts";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getContract,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { fundAccountWithUSDC, MIN_USDC_BALANCE, USDC_ADDRESS } from "../../src/funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BUNDLER_URL = process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const ADMIN_PRIVATE_KEY =
  process.env.TOOLS_ADMIN_PRIVATE_KEY ??
  process.env.TOOLS_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_OWNER_PRIVATE_KEY =
  process.env.TOOLS_TEST_OWNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const FUNDING_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6);

const RUN_UNTIL_EMPTY = process.env.TOOLS_RUN_UNTIL_EMPTY === "true";
const MIN_USDC_TO_CONTINUE = BigInt(process.env.TOOLS_MIN_USDC_TO_CONTINUE ?? "100000");
const BUNDLER_MIN_NATIVE_WEI = parseUnits(process.env.TOOLS_BUNDLER_MIN_NATIVE ?? "2", 18);

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

const paymasterGasPriceClient = createPimlicoClient({
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
  transport: http(PAYMASTER_URL),
});

const owner = privateKeyToAccount(
  (TEST_OWNER_PRIVATE_KEY.startsWith("0x") ? TEST_OWNER_PRIVATE_KEY : `0x${TEST_OWNER_PRIVATE_KEY}`) as `0x${string}`
);
const adminOwner = privateKeyToAccount(
  (ADMIN_PRIVATE_KEY.startsWith("0x") ? ADMIN_PRIVATE_KEY : `0x${ADMIN_PRIVATE_KEY}`) as `0x${string}`
);

function parsePrivateKeysCsv(value: string | undefined): (`0x${string}`)[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`);
}

interface SponsorPayload {
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
}

function stringifyRpcBody(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
}

async function requestSponsorPayload(
  userOp: Record<string, unknown>,
  entryPointAddress: string
): Promise<SponsorPayload> {
  const body = stringifyRpcBody({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_sponsorUserOperation",
    params: [userOp, entryPointAddress],
  });

  const res = await fetch(PAYMASTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Paymaster request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { result?: SponsorPayload; error?: { message?: string } };
  if (json.error) throw new Error(`Paymaster error: ${json.error.message ?? "unknown error"}`);
  if (!json.result?.paymasterData) throw new Error("No paymasterData in response");
  return json.result;
}

async function main() {
  console.log("AA infrastructure (counter-based sponsor + bundler gas estimate):");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("");

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
  });

  console.log("SimpleAccount address:", account.address);

  let paymasterAddress = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
  if (!paymasterAddress) {
    const res = await fetch(`${PAYMASTER_URL}/paymaster-address`);
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
  }
  console.log("Paymaster address:", paymasterAddress);

  // Ensure Alto utility/executor EOAs have enough native gas on local Anvil.
  // Without this, bundler can accept the UserOp but fail to submit bundle txs.
  const bundlerPks = [
    ...parsePrivateKeysCsv(process.env.ALTO_UTILITY_PRIVATE_KEY),
    ...parsePrivateKeysCsv(process.env.ALTO_EXECUTOR_PRIVATE_KEYS),
  ];
  for (const pk of bundlerPks) {
    const addr = privateKeyToAccount(pk).address;
    const bal = await publicClient.getBalance({ address: addr });
    if (bal < BUNDLER_MIN_NATIVE_WEI) {
      await testClient.setBalance({ address: addr, value: BUNDLER_MIN_NATIVE_WEI });
      console.log(`Topped up bundler account ${addr} to ${BUNDLER_MIN_NATIVE_WEI.toString()} wei`);
    }
  }

  // Ensure on-chain paymaster gas caps are high enough for current bundler estimation.
  // Some local states may keep very low caps and cause AA33/TotalGasLimitExceeded during simulation.
  const paymasterAdminAbi = parseAbi([
    "function maxTotalGasNormal() view returns (uint256)",
    "function maxTotalGasDeploy() view returns (uint256)",
    "function setGasCapProfiles(uint256 maxTotalGasNormal_, uint256 maxTotalGasDeploy_)",
  ]);
  const minNormal = 30_000_000n;
  const minDeploy = 30_000_000n;
  const currentNormal = (await publicClient.readContract({
    address: paymasterAddress,
    abi: paymasterAdminAbi,
    functionName: "maxTotalGasNormal",
  })) as bigint;
  const currentDeploy = (await publicClient.readContract({
    address: paymasterAddress,
    abi: paymasterAdminAbi,
    functionName: "maxTotalGasDeploy",
  })) as bigint;
  if (currentNormal < minNormal || currentDeploy < minDeploy) {
    const adminWallet = createWalletClient({
      chain: localChain,
      account: adminOwner,
      transport: http(RPC_URL),
    });
    const tx = await adminWallet.writeContract({
      address: paymasterAddress,
      abi: paymasterAdminAbi,
      functionName: "setGasCapProfiles",
      args: [minNormal, minDeploy],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(
      "Updated paymaster gas caps:",
      `{ normal: ${minNormal.toString()}, deploy: ${minDeploy.toString()} }`
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
  console.log("USDC balance before fund check:", balanceBefore.toString());

  if (balanceBefore < MIN_USDC_BALANCE) {
    console.log("Funding smart account with USDC...");
    await fundAccountWithUSDC(account.address, FUNDING_AMOUNT, usdc, publicClient, testClient);
  }

  const counterPaymaster = {
    getPaymasterData: async (parameters: Record<string, unknown>) => {
      const { entryPointAddress, context: _ctx, ...partialUserOp } = parameters;
      void _ctx;
      const payload = await requestSponsorPayload(partialUserOp, String(entryPointAddress));
      return {
        paymaster: payload.paymaster as Address,
        paymasterData: payload.paymasterData as Hex,
        paymasterVerificationGasLimit: BigInt(payload.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: BigInt(payload.paymasterPostOpGasLimit),
      };
    },
  };

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: counterPaymaster,
    userOperation: {
      estimateFeesPerGas: async () => {
        return (await paymasterGasPriceClient.getUserOperationGasPrice()).fast;
      },
    },
  });

  const to = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address;
  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress, parseUnits("1000000", 6)],
  });

  let opCount = 0;
  let totalFeeCharged = 0n;

  const sendOneUserOp = async (): Promise<{ hash: `0x${string}`; fee: bigint }> => {
    const before = await usdc.read.balanceOf([account.address]);
    const txHash = await smartAccountClient.sendTransaction({
      calls: [
        { to: USDC_ADDRESS, value: 0n, data: approveData },
        { to, value: 0n },
      ],
    });
    const after = await usdc.read.balanceOf([account.address]);
    const fee = before - after;
    return { hash: txHash, fee };
  };

  const balanceAfterFund = await usdc.read.balanceOf([account.address]);

  if (RUN_UNTIL_EMPTY) {
    console.log("Sending UserOps until USDC is below threshold (TOOLS_RUN_UNTIL_EMPTY=true)...");
    let balance = balanceAfterFund;
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
    console.log("Sending sponsored UserOp (approve + call; USDC fee from postOp)...");
    const { hash, fee } = await sendOneUserOp();
    console.log("Transaction hash:", hash);
    if (fee <= 0n) {
      console.error("Expected USDC to be charged but balance did not decrease");
      process.exit(1);
    }
    console.log("USDC fee charged:", fee.toString(), "(6 decimals)");
    console.log("Done. UserOp was sponsored and USDC was charged.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
