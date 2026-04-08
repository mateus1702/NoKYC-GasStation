/**
 * Shared setup for sponsored SimpleAccount UserOps against Project4 paymaster + Alto bundler.
 * Used by simulations (and can replace duplicated logic in smoke tests later).
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
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import {
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
  USDC_ADDRESS,
} from "./usdc-whale-funding.js";

const ENTRY_POINT_DEPOSIT_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable",
]);

const DUMMY_CALL_TARGET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as Address;

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

interface SponsorPayload {
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
  estimatedBaseCostUsdcE6?: string;
  estimatedReferralUsdcE6?: string;
  estimatedTotalCostUsdcE6?: string;
  estimatedNormalGasUnits?: string;
  estimatedDeployGasUnits?: string;
  estimatedGas?: string;
  validUntil?: string;
}

function stringifyRpcBody(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
}

async function requestSponsorPayload(
  paymasterUrl: string,
  userOp: Record<string, unknown>,
  entryPointAddress: string
): Promise<SponsorPayload> {
  const body = stringifyRpcBody({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_sponsorUserOperation",
    params: [userOp, entryPointAddress],
  });
  const res = await fetch(paymasterUrl, {
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

export function createPolygonForkChain(rpcUrl: string) {
  return defineChain({
    id: 137,
    name: "Polygon Fork",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function createLocalChainClients(rpcUrl: string) {
  const localChain = createPolygonForkChain(rpcUrl);
  const publicClient = createPublicClient({ chain: localChain, transport: http(rpcUrl) });
  const testClient = createTestClient({
    chain: localChain,
    transport: http(rpcUrl),
    mode: "anvil",
  });
  return { localChain, publicClient, testClient };
}

export async function resolvePaymasterAddress(paymasterUrl: string): Promise<Address> {
  const base = paymasterUrl.replace(/\/$/, "");
  const fromEnv = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
  if (fromEnv) return fromEnv;
  const res = await fetch(`${base}/paymaster-address`);
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

export async function ensurePaymasterEntryPointDeposit(
  rpcUrl: string,
  localChain: ReturnType<typeof createPolygonForkChain>,
  publicClient: ReturnType<typeof createPublicClient>,
  testClient: ReturnType<typeof createTestClient>,
  paymasterAddress: Address
): Promise<void> {
  const ep = entryPoint07Address;
  const epDepositMinWei = BigInt(process.env.TOOLS_PAYMASTER_EP_MIN_WEI ?? "1000000000000000000");
  const epDepositTopupWei = BigInt(process.env.TOOLS_PAYMASTER_EP_TOPUP_WEI ?? "5000000000000000000");
  const epFunderPrivateKey =
    process.env.TOOLS_EP_DEPOSIT_FUNDER_PRIVATE_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  const bal = await publicClient.readContract({
    address: ep,
    abi: ENTRY_POINT_DEPOSIT_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  if (bal >= epDepositMinWei) return;

  const funder = privateKeyToAccount(asHexKey(epFunderPrivateKey));
  await testClient.setBalance({
    address: funder.address,
    value: epDepositTopupWei + parseUnits("1", 18),
  });

  const wallet = createWalletClient({
    account: funder,
    chain: localChain,
    transport: http(rpcUrl),
  });

  const hash = await wallet.writeContract({
    address: ep,
    abi: ENTRY_POINT_DEPOSIT_ABI,
    functionName: "depositTo",
    args: [paymasterAddress],
    value: epDepositTopupWei,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    `EntryPoint deposit for paymaster below ${epDepositMinWei} wei; deposited ${epDepositTopupWei} wei (tx ${hash})`
  );
}

export async function logAltoBundlerNativeBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  bundlerMinNativeWei: bigint
): Promise<void> {
  const rows = parseAltoBundlerKeyRows();
  if (rows.length === 0) {
    console.log("Alto bundler EOAs: (none — set ALTO_UTILITY_PRIVATE_KEY / ALTO_EXECUTOR_PRIVATE_KEYS)");
    console.log("");
    return;
  }
  console.log("Alto bundler EOA native balances (before any Anvil top-up):");
  console.log(`  threshold for top-up: ${formatEther(bundlerMinNativeWei)} native (TOOLS_BUNDLER_MIN_NATIVE)`);
  for (const { label, pk } of rows) {
    const address = privateKeyToAccount(pk).address;
    const wei = await publicClient.getBalance({ address });
    const ok = wei >= bundlerMinNativeWei ? "ok" : "LOW";
    console.log(`  [${ok}] ${label}: ${address}  ${formatEther(wei)} (${wei} wei)`);
  }
  console.log("");
}

export async function ensureAltoBundlerNativeTopUp(
  publicClient: ReturnType<typeof createPublicClient>,
  testClient: ReturnType<typeof createTestClient>,
  bundlerMinNativeWei: bigint
): Promise<void> {
  const rows = parseAltoBundlerKeyRows();
  for (const { pk } of rows) {
    const addr = privateKeyToAccount(pk).address;
    const bal = await publicClient.getBalance({ address: addr });
    if (bal < bundlerMinNativeWei) {
      await testClient.setBalance({ address: addr, value: bundlerMinNativeWei });
      console.log(`Topped up bundler EOA ${addr}`);
    }
  }
}

export async function triggerOperationalRefill(paymasterUrl: string): Promise<void> {
  const secret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
  if (!secret) {
    throw new Error("PAYMASTER_API_REFILL_TRIGGER_SECRET required to trigger operational refill");
  }
  const res = await fetch(`${paymasterUrl.replace(/\/$/, "")}/operational-refill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Operational refill failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const out = json as { ok?: boolean; result?: { status?: string; reason?: string } };
  const status = out.result?.status;
  const reason = out.result?.reason;
  const acceptableSkippedReasons = new Set(["all_targets_satisfied", "all_above_min_native"]);
  const skippedOkay =
    status === "skipped" && typeof reason === "string" && acceptableSkippedReasons.has(reason);
  const completed = status === "completed" || skippedOkay;
  if (!completed) {
    throw new Error(`Operational refill not completed: ${JSON.stringify(out)}`);
  }
}

async function postRefillAuthorized(paymasterUrl: string, path: string): Promise<void> {
  const secret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
  if (!secret) {
    throw new Error("PAYMASTER_API_REFILL_TRIGGER_SECRET required for refill/anvil-dev endpoints");
  }
  const res = await fetch(`${paymasterUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const out = json as { ok?: boolean; error?: string };
  if (!out.ok) {
    throw new Error(`POST ${path} not ok: ${JSON.stringify(out)}`);
  }
}

export async function seedPaymasterForRefill(paymasterUrl: string): Promise<void> {
  await postRefillAuthorized(paymasterUrl, "/anvil-dev/fund-native");
  await postRefillAuthorized(paymasterUrl, "/anvil-dev/fund-usdc");
}

export async function ensurePaymasterUsdcSeeded(
  paymasterAddress: Address,
  publicClient: ReturnType<typeof createPublicClient>,
  testClient: ReturnType<typeof createTestClient>,
  minimumUsdcE6: bigint = 1_000_000n
): Promise<void> {
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });
  const bal = await usdc.read.balanceOf([paymasterAddress]);
  if (bal >= minimumUsdcE6) return;
  console.log(
    `Paymaster USDC balance is low (${bal}). Funding paymaster directly via whale impersonation fallback...`
  );
  await fundAccountWithUSDC(paymasterAddress, minimumUsdcE6, usdc, publicClient, testClient);
}

export type CommonDappFeeContext = {
  smartAccountAddress: Address;
  ownerAddress: Address;
  paymasterAddress: Address;
  sendCommonDappUserOp: () => Promise<CommonDappUserOpReport>;
};

export type PricingSnapshot = {
  gasUnitsProcessed: bigint;
  usdcSpentForGasE6: bigint;
  gasBoughtWei: bigint;
  /** Raw (pre-amplifier) USDC micro-units per 1 wei: (usdcSpentForGasE6 * 1e18) / gasBoughtWei */
  derivedUsdcPerWeiE6Raw: bigint | null;
};

export type CommonDappUserOpReport = {
  hash: `0x${string}`;
  fee: bigint;
  pricingBefore: PricingSnapshot;
  pricingAfter: PricingSnapshot;
  sponsor: {
    estimatedBaseCostUsdcE6?: string;
    estimatedTotalCostUsdcE6?: string;
    estimatedGas?: string;
    /** Implied signed rate: estimatedBaseCostUsdcE6 * 1e18 / (estimatedGas * gasPriceWei at send time). */
    selectedUsdcPerWeiE6?: string;
    sourceGuess: "counters" | "live_quote_or_min";
  };
};

export type PrepareCommonDappFeeOptions = {
  owner: PrivateKeyAccount;
  rpcUrl: string;
  paymasterUrl: string;
  bundlerUrl: string;
  /** USDC amount to transfer from whale when balance is low (6 decimals). */
  fundingAmount?: bigint;
  /** Fund smart account when balance is below this (6 decimals). */
  minUsdcToFund?: bigint;
};

const PAYMASTER_PRICING_ABI = parseAbi([
  "function getPricingCounters() view returns (uint256 gasUnitsProcessed, uint256 usdcSpentForGasE6, uint256 gasBoughtWei)",
]);

function deriveUsdcPerWeiRawFromCounters(snapshot: {
  usdcSpentForGasE6: bigint;
  gasBoughtWei: bigint;
}): bigint | null {
  const { usdcSpentForGasE6: U, gasBoughtWei: B } = snapshot;
  if (U <= 0n || B <= 0n) return null;
  const raw = (U * 10n ** 18n) / B;
  return raw > 0n ? raw : null;
}

/**
 * Builds clients, resolves paymaster, tops up EntryPoint, triggers refill/swap to seed realistic pricing counters,
 * and funds USDC via whale impersonation,
 * and returns `sendCommonDappUserOp` (USDC approve paymaster + empty external call), matching the integrated-tests smoke.
 */
export async function prepareCommonDappFeeContext(
  options: PrepareCommonDappFeeOptions
): Promise<CommonDappFeeContext> {
  const {
    owner,
    rpcUrl,
    paymasterUrl,
    bundlerUrl,
    fundingAmount = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6),
    minUsdcToFund = MIN_USDC_BALANCE,
  } = options;

  const pmBase = paymasterUrl.replace(/\/$/, "");
  const bundlerMinNativeWei = parseUnits(process.env.TOOLS_BUNDLER_MIN_NATIVE ?? "2", 18);

  const { localChain, publicClient, testClient } = createLocalChainClients(rpcUrl);

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });

  const paymasterAddress = await resolvePaymasterAddress(pmBase);

  await ensurePaymasterEntryPointDeposit(rpcUrl, localChain, publicClient, testClient, paymasterAddress);

  await logAltoBundlerNativeBalances(publicClient, bundlerMinNativeWei);
  console.log("Funding paymaster native + USDC via anvil-dev endpoints...");
  await seedPaymasterForRefill(pmBase);
  await ensurePaymasterUsdcSeeded(paymasterAddress, publicClient, testClient);
  console.log("Triggering operational refill before first UserOp (no direct bundler top-up)...");
  await triggerOperationalRefill(pmBase);
  await logAltoBundlerNativeBalances(publicClient, bundlerMinNativeWei);

  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address, uint256) returns (bool)",
    ]),
    client: publicClient,
  });

  const paymasterPricing = getContract({
    address: paymasterAddress,
    abi: PAYMASTER_PRICING_ABI,
    client: publicClient,
  });

  const balanceBefore = await usdc.read.balanceOf([account.address]);
  if (balanceBefore < minUsdcToFund) {
    console.log("Funding smart account with USDC (whale impersonation)...");
    await fundAccountWithUSDC(account.address, fundingAmount, usdc, publicClient, testClient);
  }

  const paymasterGasPriceClient = createPimlicoClient({
    entryPoint: { address: entryPoint07Address, version: "0.7" },
    transport: http(pmBase),
  });

  let lastSponsorEstimatedBaseCostUsdcE6: string | undefined;
  let lastSponsorEstimatedTotalCostUsdcE6: string | undefined;
  let lastSponsorEstimatedGas: string | undefined;

  const counterPaymaster = {
    getPaymasterData: async (parameters: Record<string, unknown>) => {
      const { entryPointAddress, context: _ctx, ...partialUserOp } = parameters;
      void _ctx;
      const payload = await requestSponsorPayload(
        pmBase,
        partialUserOp,
        String(entryPointAddress)
      );
      lastSponsorEstimatedBaseCostUsdcE6 = payload.estimatedBaseCostUsdcE6;
      lastSponsorEstimatedTotalCostUsdcE6 = payload.estimatedTotalCostUsdcE6;
      lastSponsorEstimatedGas = payload.estimatedGas;
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
    bundlerTransport: http(bundlerUrl),
    paymaster: counterPaymaster,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await paymasterGasPriceClient.getUserOperationGasPrice()).fast,
    },
  });

  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress, parseUnits("1000000", 6)],
  });

  const readPricingSnapshot = async (): Promise<PricingSnapshot> => {
    const [gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei] = await paymasterPricing.read.getPricingCounters();
    const derivedUsdcPerWeiE6Raw = deriveUsdcPerWeiRawFromCounters({
      usdcSpentForGasE6,
      gasBoughtWei,
    });
    return { gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei, derivedUsdcPerWeiE6Raw };
  };

  const sendCommonDappUserOp = async (): Promise<CommonDappUserOpReport> => {
    lastSponsorEstimatedBaseCostUsdcE6 = undefined;
    lastSponsorEstimatedTotalCostUsdcE6 = undefined;
    lastSponsorEstimatedGas = undefined;
    const pricingBefore = await readPricingSnapshot();
    const gasPriceWei = await publicClient.getGasPrice();
    const before = await usdc.read.balanceOf([account.address]);
    const txHash = await smartAccountClient.sendTransaction({
      calls: [
        { to: USDC_ADDRESS, value: 0n, data: approveData },
        { to: DUMMY_CALL_TARGET, value: 0n },
      ],
    });
    const after = await usdc.read.balanceOf([account.address]);
    const pricingAfter = await readPricingSnapshot();

    const quoteMaxWei =
      lastSponsorEstimatedGas && BigInt(lastSponsorEstimatedGas) > 0n
        ? BigInt(lastSponsorEstimatedGas) * gasPriceWei
        : 0n;
    const selectedUsdcPerWeiE6 =
      lastSponsorEstimatedBaseCostUsdcE6 && quoteMaxWei > 0n
        ? ((BigInt(lastSponsorEstimatedBaseCostUsdcE6) * 10n ** 18n) / quoteMaxWei).toString()
        : undefined;

    const sourceGuess = pricingBefore.derivedUsdcPerWeiE6Raw !== null ? "counters" : "live_quote_or_min";

    return {
      hash: txHash,
      fee: before - after,
      pricingBefore,
      pricingAfter,
      sponsor: {
        estimatedBaseCostUsdcE6: lastSponsorEstimatedBaseCostUsdcE6,
        estimatedTotalCostUsdcE6: lastSponsorEstimatedTotalCostUsdcE6,
        estimatedGas: lastSponsorEstimatedGas,
        selectedUsdcPerWeiE6,
        sourceGuess,
      },
    };
  };

  return {
    smartAccountAddress: account.address,
    ownerAddress: owner.address,
    paymasterAddress,
    sendCommonDappUserOp,
  };
}
