import "./load-env.js";
/**
 * Smoke: sponsored UserOp (SimpleAccount) with USDC fee charged in Project4Paymaster postOp.
 *
 * Run: npm run test:project4:fee (repo root) or npm test in this workspace.
 * Env: TOOLS_RPC_URL, TOOLS_PAYMASTER_URL, TOOLS_BUNDLER_URL, TOOLS_PAYMASTER_ADDRESS (optional),
 *      TOOLS_TEST_OWNER_PRIVATE_KEY (smart account owner),
 *      ALTO_UTILITY_PRIVATE_KEY / ALTO_EXECUTOR_PRIVATE_KEYS (logged before run; Anvil top-up if low),
 *      TOOLS_PAYMASTER_EP_MIN_WEI / TOOLS_PAYMASTER_EP_TOPUP_WEI / TOOLS_EP_DEPOSIT_FUNDER_PRIVATE_KEY (EntryPoint paymaster deposit),
 *      TOOLS_RUN_UNTIL_EMPTY=true — loop until USDC below TOOLS_MIN_USDC_TO_CONTINUE.
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
  formatEther,
  getContract,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { fundAccountWithUSDC, MIN_USDC_BALANCE, USDC_ADDRESS } from "./funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BUNDLER_URL = process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const TEST_OWNER_PRIVATE_KEY =
  process.env.TOOLS_TEST_OWNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const FUNDING_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6);
const RUN_UNTIL_EMPTY = process.env.TOOLS_RUN_UNTIL_EMPTY === "true";
const MIN_USDC_TO_CONTINUE = BigInt(process.env.TOOLS_MIN_USDC_TO_CONTINUE ?? "100000");
const BUNDLER_MIN_NATIVE_WEI = parseUnits(process.env.TOOLS_BUNDLER_MIN_NATIVE ?? "2", 18);

/** Min EntryPoint balance (wei) for paymaster before we top up (AA31 if too low). */
const EP_DEPOSIT_MIN_WEI = BigInt(process.env.TOOLS_PAYMASTER_EP_MIN_WEI ?? "1000000000000000000");
/** Wei sent via EntryPoint.depositTo(paymaster) when below min (Anvil/local only). */
const EP_DEPOSIT_TOPUP_WEI = BigInt(process.env.TOOLS_PAYMASTER_EP_TOPUP_WEI ?? "5000000000000000000");
/** EOA that pays ETH into EntryPoint for the paymaster (default Anvil account #0). */
const EP_FUNDER_PRIVATE_KEY =
  process.env.TOOLS_EP_DEPOSIT_FUNDER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ENTRY_POINT_DEPOSIT_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable",
]);

const localChain = defineChain({
  id: 137,
  name: "Polygon Fork",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function asHexKey(k: string): `0x${string}` {
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}

function parsePrivateKeysCsv(value: string | undefined): (`0x${string}`)[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => asHexKey(v));
}

/** Alto utility + executor keys with stable labels for balance logging. */
function parseAltoBundlerKeyRows(): { label: string; pk: `0x${string}` }[] {
  const rows: { label: string; pk: `0x${string}` }[] = [];
  const utilPks = parsePrivateKeysCsv(process.env.ALTO_UTILITY_PRIVATE_KEY);
  utilPks.forEach((pk, i) => {
    rows.push({
      label: utilPks.length > 1 ? `ALTO utility ${i}` : "ALTO utility",
      pk,
    });
  });
  const execPks = parsePrivateKeysCsv(process.env.ALTO_EXECUTOR_PRIVATE_KEYS);
  execPks.forEach((pk, i) => {
    rows.push({ label: `ALTO executor ${i}`, pk });
  });
  return rows;
}

async function logAltoBundlerNativeBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  rows: { label: string; pk: `0x${string}` }[]
): Promise<void> {
  if (rows.length === 0) {
    console.log("Alto bundler EOAs: (none — set ALTO_UTILITY_PRIVATE_KEY / ALTO_EXECUTOR_PRIVATE_KEYS)");
    console.log("");
    return;
  }
  console.log("Alto bundler EOA native balances (before any Anvil top-up):");
  console.log(`  threshold for top-up: ${formatEther(BUNDLER_MIN_NATIVE_WEI)} native (TOOLS_BUNDLER_MIN_NATIVE)`);
  for (const { label, pk } of rows) {
    const address = privateKeyToAccount(pk).address;
    const wei = await publicClient.getBalance({ address });
    const ok = wei >= BUNDLER_MIN_NATIVE_WEI ? "ok" : "LOW";
    console.log(`  [${ok}] ${label}: ${address}  ${formatEther(wei)} (${wei} wei)`);
  }
  console.log("");
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

async function ensurePaymasterEntryPointDeposit(
  publicClient: ReturnType<typeof createPublicClient>,
  testClient: ReturnType<typeof createTestClient>,
  paymasterAddress: Address
): Promise<void> {
  const ep = entryPoint07Address;
  const bal = await publicClient.readContract({
    address: ep,
    abi: ENTRY_POINT_DEPOSIT_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  if (bal >= EP_DEPOSIT_MIN_WEI) return;

  const funder = privateKeyToAccount(asHexKey(EP_FUNDER_PRIVATE_KEY));
  await testClient.setBalance({
    address: funder.address,
    value: EP_DEPOSIT_TOPUP_WEI + parseUnits("1", 18),
  });

  const wallet = createWalletClient({
    account: funder,
    chain: localChain,
    transport: http(RPC_URL),
  });

  const hash = await wallet.writeContract({
    address: ep,
    abi: ENTRY_POINT_DEPOSIT_ABI,
    functionName: "depositTo",
    args: [paymasterAddress],
    value: EP_DEPOSIT_TOPUP_WEI,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    `EntryPoint deposit for paymaster below ${EP_DEPOSIT_MIN_WEI} wei; deposited ${EP_DEPOSIT_TOPUP_WEI} wei (tx ${hash})`
  );
}

async function resolvePaymasterAddress(): Promise<Address> {
  const fromEnv = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
  if (fromEnv) return fromEnv;
  const res = await fetch(`${PAYMASTER_URL}/paymaster-address`);
  if (!res.ok) {
    throw new Error(
      "Could not get paymaster address. Set TOOLS_PAYMASTER_ADDRESS or ensure paymaster-api is running."
    );
  }
  const json = (await res.json()) as { paymasterAddress?: string };
  const addr = json.paymasterAddress as Address | undefined;
  if (!addr) throw new Error("API did not return paymaster address");
  return addr;
}

async function main() {
  const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
  const testClient = createTestClient({
    chain: localChain,
    transport: http(RPC_URL),
    mode: "anvil",
  });

  const owner = privateKeyToAccount(asHexKey(TEST_OWNER_PRIVATE_KEY));

  console.log("AA smoke (counter sponsor + bundler estimate):");
  console.log("  RPC:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("");

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });
  console.log("SimpleAccount:", account.address);

  const paymasterAddress = await resolvePaymasterAddress();
  console.log("Paymaster:", paymasterAddress);

  await ensurePaymasterEntryPointDeposit(publicClient, testClient, paymasterAddress);

  const altoBundlerRows = parseAltoBundlerKeyRows();
  await logAltoBundlerNativeBalances(publicClient, altoBundlerRows);

  for (const { pk } of altoBundlerRows) {
    const addr = privateKeyToAccount(pk).address;
    const bal = await publicClient.getBalance({ address: addr });
    if (bal < BUNDLER_MIN_NATIVE_WEI) {
      await testClient.setBalance({ address: addr, value: BUNDLER_MIN_NATIVE_WEI });
      console.log(`Topped up bundler EOA ${addr}`);
    }
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
    console.log("Funding smart account with USDC...");
    await fundAccountWithUSDC(account.address, FUNDING_AMOUNT, usdc, publicClient, testClient);
  }

  const paymasterGasPriceClient = createPimlicoClient({
    entryPoint: { address: entryPoint07Address, version: "0.7" },
    transport: http(PAYMASTER_URL),
  });

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
      estimateFeesPerGas: async () =>
        (await paymasterGasPriceClient.getUserOperationGasPrice()).fast,
    },
  });

  const dummyTo = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address;
  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress, parseUnits("1000000", 6)],
  });

  const sendOneUserOp = async (): Promise<{ hash: `0x${string}`; fee: bigint }> => {
    const before = await usdc.read.balanceOf([account.address]);
    const txHash = await smartAccountClient.sendTransaction({
      calls: [
        { to: USDC_ADDRESS, value: 0n, data: approveData },
        { to: dummyTo, value: 0n },
      ],
    });
    const after = await usdc.read.balanceOf([account.address]);
    return { hash: txHash, fee: before - after };
  };

  if (RUN_UNTIL_EMPTY) {
    console.log("Loop until USDC below threshold (TOOLS_RUN_UNTIL_EMPTY)...");
    let balance = await usdc.read.balanceOf([account.address]);
    let opCount = 0;
    let totalFee = 0n;
    while (balance >= MIN_USDC_TO_CONTINUE) {
      try {
        const { hash, fee } = await sendOneUserOp();
        opCount++;
        totalFee += fee;
        balance = await usdc.read.balanceOf([account.address]);
        console.log(`  #${opCount} hash=${hash} fee=${fee} balance=${balance}`);
        if (balance < MIN_USDC_TO_CONTINUE) break;
      } catch (e) {
        console.error("UserOp failed:", (e as Error).message);
        break;
      }
    }
    console.log(`Done. UserOps: ${opCount}, total USDC fee: ${totalFee}`);
    if (opCount === 0) {
      console.error("No UserOps sent.");
      process.exit(1);
    }
  } else {
    console.log("Sending one sponsored UserOp (approve + empty call)...");
    const { hash, fee } = await sendOneUserOp();
    console.log("Tx hash:", hash);
    if (fee <= 0n) {
      console.error("Expected USDC fee > 0");
      process.exit(1);
    }
    console.log("USDC fee (6 decimals):", fee.toString());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
