/**
 * Project4 Worker Service - Automated gas and USDC management for ERC-4337 paymaster operations
 *
 * This service manages the operational funding requirements for:
 * - EntryPoint contract deposits
 * - Bundler executor accounts
 * - Worker account gas reserves
 * - Revenue collection and redistribution
 *
 * Key responsibilities:
 * 1. Bootstrap distribution of initial funds from bootstrap account
 * 2. Continuous monitoring of account balances
 * 3. Automated gas refills via DEX swaps
 * 4. USDC transfers from revenue to worker accounts
 */
import { createPublicClient, createTestClient, createWalletClient, http as viemHttp, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { applyTotalsSwap, getBigInt as redisGetBigInt } from "@project4/shared";
import { createServer } from "http";
import { readFile } from "fs/promises";

// =========================================
// Configuration Constants (from environment variables)
// =========================================

/** How often to check account balances in seconds */
const WORKER_MONITORING_INTERVAL_SECONDS = Number(process.env.WORKER_MONITORING_INTERVAL_SECONDS);

/** Minimum bootstrap account USDC balance required for initial distribution */
const MIN_BOOTSTRAP_USDC = BigInt(process.env.WORKER_MIN_BOOTSTRAP_USDC!);

/** Minimum bootstrap account gas balance required for initial distribution */
const MIN_BOOTSTRAP_GAS = BigInt(process.env.WORKER_MIN_BOOTSTRAP_GAS!);

/** Minimum worker account USDC balance to maintain */
const MIN_WORKER_USDC = BigInt(process.env.WORKER_MIN_WORKER_USDC!);

/** Target minimum gas value per operational account expressed in USDC (6 decimals). */
const MIN_GAS_LIMIT_USDC = BigInt(process.env.WORKER_MIN_GAS_LIMIT_USDC!);

/** Worker-specific RPC URL */
const WORKER_RPC_URL = process.env.WORKER_RPC_URL;

/** Worker-specific USDC contract address */
const WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS = process.env.WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS;

/** Worker-specific treasury private key */
const WORKER_TREASURY_PRIVATE_KEY = process.env.WORKER_TREASURY_PRIVATE_KEY;

/** Worker-specific EntryPoint contract address */
const WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS = process.env.WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS;
const WORKER_PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE?.trim();

/** Worker-specific Uniswap V3 router address */
const WORKER_UNISWAP_V3_ROUTER = process.env.WORKER_UNISWAP_V3_ROUTER;

/** Worker-specific wrapped native token address */
const WORKER_WRAPPED_NATIVE_TOKEN = process.env.WORKER_WRAPPED_NATIVE_TOKEN;

/** Worker-specific Uniswap pool fee */
const WORKER_UNISWAP_POOL_FEE = process.env.WORKER_UNISWAP_POOL_FEE;

/** Uniswap V3 QuoterV2 address on Polygon (used for read-only swap quotes). */
const UNISWAP_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;

// =========================================
// Environment Variables
// =========================================

/** Bootstrap account private key for initial fund distribution */
const WORKER_BOOTSTRAP_PRIVATE_KEY = process.env.WORKER_BOOTSTRAP_PRIVATE_KEY;

/** Revenue account private key for collecting paymaster fees */
const WORKER_REVENUE_PRIVATE_KEY = process.env.WORKER_REVENUE_PRIVATE_KEY;

/** Revenue account address (derived from WORKER_REVENUE_PRIVATE_KEY) */
const WORKER_REVENUE_ADDRESS = privateKeyToAccount(
  (WORKER_REVENUE_PRIVATE_KEY!.startsWith("0x") ? WORKER_REVENUE_PRIVATE_KEY! : `0x${WORKER_REVENUE_PRIVATE_KEY!}`) as `0x${string}`
).address;

/** Bundler account addresses derived from private keys */
const ALTO_UTILITY_PRIVATE_KEY = process.env.ALTO_UTILITY_PRIVATE_KEY?.trim();
const ALTO_EXECUTOR_PRIVATE_KEYS = process.env.ALTO_EXECUTOR_PRIVATE_KEYS?.split(",").map(k => k.trim()).filter(Boolean) ?? [];

// Derive all bundler addresses from private keys
const WORKER_BUNDLER_ADDRESSES: `0x${string}`[] = [];
if (ALTO_UTILITY_PRIVATE_KEY) {
  try {
    const utilityAccount = privateKeyToAccount(ALTO_UTILITY_PRIVATE_KEY as `0x${string}`);
    WORKER_BUNDLER_ADDRESSES.push(utilityAccount.address);
  } catch (e) {
    console.warn("[worker] Failed to derive utility account address:", (e as Error).message);
  }
}
for (const executorKey of ALTO_EXECUTOR_PRIVATE_KEYS) {
  try {
    const executorAccount = privateKeyToAccount(executorKey as `0x${string}`);
    // Avoid duplicates (utility key might be same as first executor key)
    if (!WORKER_BUNDLER_ADDRESSES.includes(executorAccount.address)) {
      WORKER_BUNDLER_ADDRESSES.push(executorAccount.address);
    }
  } catch (e) {
    console.warn(`[worker] Failed to derive executor account address for key ${executorKey}:`, (e as Error).message);
  }
}

const PRICING_TOTAL_USDC_E6_KEY = "pricing:total_usdc_spent_e6";
const PRICING_TOTAL_GAS_WEI_KEY = "pricing:total_gas_returned_wei";
const SWAP_MIN_OUT_BPS = 9500n; // 95% of live quote as slippage floor
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
let cachedPaymasterAddress: `0x${string}` | null = null;

type DistributionTarget = {
  name: string;
  address: `0x${string}`;
  target: bigint;
  kind: "native" | "entrypoint-deposit";
  paymasterAddress?: `0x${string}`;
};

type GasDeficit = {
  name: string;
  address: `0x${string}`;
  currentGas: bigint;
  neededGas: bigint;
  kind: "native" | "entrypoint-deposit";
  paymasterAddress?: `0x${string}`;
};

function parseAddress(raw: string, source: string): `0x${string}` {
  const trimmed = raw.trim();
  if (!ADDRESS_REGEX.test(trimmed)) {
    throw new Error(`[worker] Invalid address in ${source}: ${raw}`);
  }
  return trimmed as `0x${string}`;
}

async function resolvePaymasterAddress(): Promise<`0x${string}`> {
  if (cachedPaymasterAddress) return cachedPaymasterAddress;

  if (!WORKER_PAYMASTER_ADDRESS_FILE) {
    throw new Error(
      "[worker] CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE is required to fund EntryPoint deposit"
    );
  }

  try {
    const raw = (await readFile(WORKER_PAYMASTER_ADDRESS_FILE, "utf8")).trim();
    cachedPaymasterAddress = parseAddress(raw, "CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE");
    return cachedPaymasterAddress;
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(
      `[worker] Failed to read paymaster address file at ${WORKER_PAYMASTER_ADDRESS_FILE}: ${message}`
    );
  }
}

/**
 * Validates that all required environment variables are provided
 * @throws Error if any required environment variables are missing
 */
function validateEnvironmentVariables(): void {
  const requiredVars = [
    { name: 'WORKER_BOOTSTRAP_PRIVATE_KEY', value: WORKER_BOOTSTRAP_PRIVATE_KEY },
    { name: 'WORKER_REVENUE_PRIVATE_KEY', value: WORKER_REVENUE_PRIVATE_KEY },
    { name: 'WORKER_MONITORING_INTERVAL_SECONDS', value: process.env.WORKER_MONITORING_INTERVAL_SECONDS },
    { name: 'WORKER_MIN_BOOTSTRAP_USDC', value: process.env.WORKER_MIN_BOOTSTRAP_USDC },
    { name: 'WORKER_MIN_BOOTSTRAP_GAS', value: process.env.WORKER_MIN_BOOTSTRAP_GAS },
    { name: 'WORKER_MIN_WORKER_USDC', value: process.env.WORKER_MIN_WORKER_USDC },
    { name: 'WORKER_MIN_GAS_LIMIT_USDC', value: process.env.WORKER_MIN_GAS_LIMIT_USDC },
    { name: 'WORKER_RPC_URL', value: WORKER_RPC_URL },
    { name: 'WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS', value: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS },
    { name: 'WORKER_TREASURY_PRIVATE_KEY', value: WORKER_TREASURY_PRIVATE_KEY },
    { name: 'WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS', value: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS },
    { name: 'CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE', value: WORKER_PAYMASTER_ADDRESS_FILE },
    { name: 'WORKER_UNISWAP_V3_ROUTER', value: WORKER_UNISWAP_V3_ROUTER },
    { name: 'WORKER_WRAPPED_NATIVE_TOKEN', value: WORKER_WRAPPED_NATIVE_TOKEN },
    { name: 'WORKER_UNISWAP_POOL_FEE', value: WORKER_UNISWAP_POOL_FEE },
    { name: 'ALTO_UTILITY_PRIVATE_KEY', value: ALTO_UTILITY_PRIVATE_KEY },
    { name: 'ALTO_EXECUTOR_PRIVATE_KEYS', value: process.env.ALTO_EXECUTOR_PRIVATE_KEYS },
  ];

  const missingVars = requiredVars.filter(v => !v.value);

  if (missingVars.length > 0) {
    console.error("❌ Missing required environment variables:");
    missingVars.forEach(v => console.error(`   - ${v.name}`));
    console.error("\nPlease set all required environment variables in your .env file.");
    process.exit(1);
  }

  // Validate WORKER_MONITORING_INTERVAL_SECONDS is a valid number
  const interval = Number(process.env.WORKER_MONITORING_INTERVAL_SECONDS);
  if (isNaN(interval) || interval <= 0) {
    console.error("❌ WORKER_MONITORING_INTERVAL_SECONDS must be a positive number");
    process.exit(1);
  }

  // Validate BigInt environment variables
  const bigIntVars = [
    { name: 'WORKER_MIN_BOOTSTRAP_USDC', value: process.env.WORKER_MIN_BOOTSTRAP_USDC },
    { name: 'WORKER_MIN_BOOTSTRAP_GAS', value: process.env.WORKER_MIN_BOOTSTRAP_GAS },
    { name: 'WORKER_MIN_WORKER_USDC', value: process.env.WORKER_MIN_WORKER_USDC },
    { name: 'WORKER_MIN_GAS_LIMIT_USDC', value: process.env.WORKER_MIN_GAS_LIMIT_USDC },
  ];

  for (const bigIntVar of bigIntVars) {
    try {
      BigInt(bigIntVar.value!);
    } catch (e) {
      console.error(`❌ ${bigIntVar.name} must be a valid BigInt number`);
      process.exit(1);
    }
  }

  // File is mandatory because worker now always resolves paymaster from deployment output.
  if (!WORKER_PAYMASTER_ADDRESS_FILE) {
    console.error("❌ CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE must be set");
    process.exit(1);
  }
}

const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** ERC-4337 EntryPoint interface for deposit operations */
const ENTRYPOINT_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "depositTo", inputs: [{ name: "account", type: "address" }], outputs: [] },
] as const;

/** Uniswap V3 SwapRouter interface for DEX operations */
const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [{
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "exactOutputSingle",
    inputs: [{
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountOut", type: "uint256" },
        { name: "amountInMaximum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** WETH interface for unwrap operations */
const WETH_ABI = [
  { type: "function", name: "withdraw", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

/** Uniswap V3 QuoterV2 interface for read-only live pricing. */
const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * Calculates the gas cost from a transaction receipt
 * @param receipt Transaction receipt with gasUsed and effectiveGasPrice
 * @returns Gas cost in wei
 */
function gasCostFromReceipt(receipt: { gasUsed: bigint; effectiveGasPrice?: bigint }): bigint {
  const price = receipt.effectiveGasPrice ?? 0n;
  return receipt.gasUsed * price;
}

/** Formats wei to ETH string with 6 decimals for logs */
function formatWeiAsEth(wei: bigint): string {
  const eth = wei / 10n ** 18n;
  const frac = ((wei % (10n ** 18n)) / 10n ** 12n).toString().padStart(6, "0");
  return `${eth}.${frac} ETH`;
}

/** Formats USDC (6 decimals) for logs */
function formatUsdcE6(usdcE6: bigint): string {
  const whole = usdcE6 / 10n ** 6n;
  const frac = (usdcE6 % (10n ** 6n)).toString().padStart(6, "0");
  return `${whole}.${frac} USDC`;
}

/** Shortens address for compact logs */
function shortAddress(address: `0x${string}`): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

/** Add swap result to cumulative pricing totals (all paid USDC / all received gas). */
async function recordSwapForPricing(usdcInE6: bigint, gasOutWei: bigint): Promise<void> {
  if (usdcInE6 <= 0n || gasOutWei <= 0n) return;
  try {
    await applyTotalsSwap(usdcInE6, gasOutWei);
    console.log(
      `[worker] Recorded swap for pricing: in=${formatUsdcE6(usdcInE6)}, out=${formatWeiAsEth(gasOutWei)}`
    );
  } catch (error) {
    console.warn(`[worker] Failed to record swap for pricing: ${(error as Error).message}`);
  }
}

/** Fetches a live USDC->WMATIC quote from Uniswap QuoterV2 for a given USDC input amount. */
async function fetchLiveGasQuoteWeiForUsdc(amountInUsdcE6: bigint): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });
  const quote = (await publicClient.readContract({
    address: UNISWAP_QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      tokenOut: WORKER_WRAPPED_NATIVE_TOKEN! as `0x${string}`,
      amountIn: amountInUsdcE6,
      fee: Number(WORKER_UNISWAP_POOL_FEE!),
      sqrtPriceLimitX96: 0n,
    }],
  })) as readonly [bigint, bigint, number, bigint];
  const amountOutWei = quote[0];
  if (amountOutWei <= 0n) {
    throw new Error(`Uniswap quote returned zero output for amountIn=${formatUsdcE6(amountInUsdcE6)}`);
  }
  return amountOutWei;
}

/** Fetches a live USDC->WMATIC quote for WORKER_MIN_GAS_LIMIT_USDC. */
async function fetchLiveMinGasQuoteWei(): Promise<bigint> {
  return fetchLiveGasQuoteWeiForUsdc(MIN_GAS_LIMIT_USDC);
}

/**
 * Derives min gas limit per account from target USDC value and swap quotes.
 * - In local/anvil mode, always uses a fresh live quote.
 * - In non-local mode, uses cached swap quote unless forceLiveQuote=true.
 */
async function getMinGasLimitWei(forceLiveQuote = false): Promise<bigint> {
  const isLocalEnvironment =
    WORKER_RPC_URL?.includes("localhost") ||
    WORKER_RPC_URL?.includes("127.0.0.1") ||
    WORKER_RPC_URL?.includes("anvil");

  if (!forceLiveQuote && !isLocalEnvironment) {
    try {
      const totalUsdc = await redisGetBigInt(PRICING_TOTAL_USDC_E6_KEY);
      const totalGas = await redisGetBigInt(PRICING_TOTAL_GAS_WEI_KEY);
      if (totalUsdc > 0n && totalGas > 0n) {
        const derivedMinGasWei = (MIN_GAS_LIMIT_USDC * totalGas) / totalUsdc;
        if (derivedMinGasWei > 0n) return derivedMinGasWei;
      }
    } catch (error) {
      console.warn(`[worker] Failed to read pricing totals from Redis: ${(error as Error).message}`);
    }
  }
  const quotedMinGasWei = await fetchLiveMinGasQuoteWei();
  if (forceLiveQuote) {
    console.log(
      `[worker] Live quote for gas threshold: ${formatUsdcE6(MIN_GAS_LIMIT_USDC)} -> ${formatWeiAsEth(quotedMinGasWei)}`
    );
  } else if (isLocalEnvironment) {
    console.log(
      `[worker] Local mode: fetched live Uniswap quote: ${formatUsdcE6(MIN_GAS_LIMIT_USDC)} -> ${formatWeiAsEth(quotedMinGasWei)}`
    );
  } else {
    console.log(
      `[worker] No cached swap quote, fetched live Uniswap quote: ${formatUsdcE6(MIN_GAS_LIMIT_USDC)} -> ${formatWeiAsEth(quotedMinGasWei)}`
    );
  }
  return quotedMinGasWei;
}

// =========================================
// Core Functions
// =========================================


/**
 * Verifies that the bootstrap account has sufficient funds for initial distribution
 * Checks both USDC and gas balances against minimum requirements
 * @returns Promise<boolean> True if bootstrap account is properly funded
 */
async function verifyBootstrapFunding(): Promise<boolean> {

  const bootstrapAccount = privateKeyToAccount(
    (WORKER_BOOTSTRAP_PRIVATE_KEY!.startsWith("0x") ? WORKER_BOOTSTRAP_PRIVATE_KEY! : `0x${WORKER_BOOTSTRAP_PRIVATE_KEY!}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const bootstrapUSDC = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [bootstrapAccount.address],
  })) as bigint;

  const bootstrapGas = await publicClient.getBalance({ address: bootstrapAccount.address });

  const hasMinUSDC = bootstrapUSDC >= MIN_BOOTSTRAP_USDC;
  const hasMinGas = bootstrapGas >= MIN_BOOTSTRAP_GAS;

  if (!hasMinUSDC || !hasMinGas) {
    console.error("❌ Bootstrap account insufficiently funded!");
    console.error(`   Address: ${bootstrapAccount.address}`);
    console.error(`   Required USDC: ${MIN_BOOTSTRAP_USDC}, has: ${bootstrapUSDC}`);
    console.error(`   Required gas: ${MIN_BOOTSTRAP_GAS}, has: ${bootstrapGas}`);
    console.error("   Fund bootstrap account and restart worker");
    return false;
  }

  console.log("✅ Bootstrap account properly funded");
  console.log(`   Address: ${bootstrapAccount.address}`);
  console.log(`   USDC: ${bootstrapUSDC}`);
  console.log(`   Gas: ${bootstrapGas}`);
  return true;
}

/**
 * Checks whether operational accounts are already funded above the current threshold.
 * Used at startup to make bootstrap distribution idempotent across restarts.
 */
async function areOperationalAccountsFunded(): Promise<boolean> {
  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const paymasterAddress = await resolvePaymasterAddress();
  const minGasLimitWei = await getMinGasLimitWei(true);

  const entryPointDeposit = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS! as `0x${string}`,
    abi: ENTRYPOINT_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  })) as bigint;

  if (entryPointDeposit < minGasLimitWei) {
    console.log(
      `[worker] EntryPoint deposit below threshold: ${formatWeiAsEth(entryPointDeposit)} < ${formatWeiAsEth(minGasLimitWei)}`
    );
    return false;
  }

  // De-duplicate when revenue and worker are the same address.
  const workerAddr = workerAccount.address.toLowerCase();
  const revenueAddr = WORKER_REVENUE_ADDRESS.toLowerCase();
  const accounts: { name: string; address: `0x${string}` }[] = [
    { name: "worker", address: workerAccount.address },
    ...(workerAddr !== revenueAddr ? [{ name: "revenue", address: WORKER_REVENUE_ADDRESS }] : []),
  ];

  WORKER_BUNDLER_ADDRESSES.forEach((address, index) => {
    accounts.push({ name: `bundler-${index}`, address });
  });

  for (const account of accounts) {
    const gasBalance = await publicClient.getBalance({ address: account.address });
    if (gasBalance < minGasLimitWei) {
      console.log(
        `[worker] ${account.name} below threshold: ${formatWeiAsEth(gasBalance)} < ${formatWeiAsEth(minGasLimitWei)}`
      );
      return false;
    }
  }

  return true;
}



/**
 * Performs the initial distribution of funds from bootstrap account to all operational accounts
 *
 * Process:
 * 1. Swaps USDC for gas via DEX
 * 2. Distributes gas to EntryPoint, Bundler, Worker, and Revenue accounts
 * 3. Transfers minimum USDC to worker account
 *
 * @throws Error if swap fails or insufficient gas received
 */
async function performBootstrapDistribution(): Promise<void> {
  const bootstrapAccount = privateKeyToAccount(
    (WORKER_BOOTSTRAP_PRIVATE_KEY!.startsWith("0x") ? WORKER_BOOTSTRAP_PRIVATE_KEY! : `0x${WORKER_BOOTSTRAP_PRIVATE_KEY!}`) as `0x${string}`
  );

  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const walletClient = createWalletClient({
    account: bootstrapAccount,
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });
  const paymasterAddress = await resolvePaymasterAddress();

  console.log("[worker] Bootstrap performing initial gas distribution...");

  // Calculate gas needed for all operational accounts
  // Bootstrap target is 2x refill threshold per account to avoid immediate re-refills.
  const minGasLimitWei = await getMinGasLimitWei();
  const gasNeededPerAccount = 2n * minGasLimitWei;
  const totalAccounts = 3 + WORKER_BUNDLER_ADDRESSES.length; // EntryPoint + Worker + Revenue + all bundler accounts
  const totalGasNeeded = gasNeededPerAccount * BigInt(totalAccounts);

  // Use the current bootstrap USDC balance to avoid hardcoded assumptions.
  const bootstrapUsdcBalance = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [bootstrapAccount.address],
  })) as bigint;

  // Cap USDC spent on gas swap to 2x WORKER_MIN_GAS_LIMIT_USDC per target account.
  const maxUsdcCap = 2n * MIN_GAS_LIMIT_USDC * BigInt(totalAccounts);
  const maxUsdcToSpend = bootstrapUsdcBalance < maxUsdcCap ? bootstrapUsdcBalance : maxUsdcCap;
  if (maxUsdcToSpend <= 0n) {
    throw new Error(`Bootstrap account has no USDC available for gas swap, got ${formatUsdcE6(bootstrapUsdcBalance)}`);
  }
  const quotedGasOutWei = await fetchLiveGasQuoteWeiForUsdc(maxUsdcToSpend);
  const amountOutMinimum = quotedGasOutWei * SWAP_MIN_OUT_BPS / 10_000n;

  console.log(
    `[worker] Bootstrap swap plan: amountIn=${formatUsdcE6(maxUsdcToSpend)}, quoteOut=${formatWeiAsEth(quotedGasOutWei)}, minOut=${formatWeiAsEth(amountOutMinimum)}`
  );
  console.log(
    `[worker] Targets: accounts=${totalAccounts}, threshold=${formatWeiAsEth(minGasLimitWei)}, perAccount=${formatWeiAsEth(gasNeededPerAccount)} (2x threshold), totalNeeded=${formatWeiAsEth(totalGasNeeded)}`
  );

  try {
    // Snapshot balances right before swap
    const initialGasBalance = await publicClient.getBalance({ address: bootstrapAccount.address });
    const initialUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [bootstrapAccount.address],
    })) as bigint;

    // Approve USDC spending for DEX (approve maximum we might spend)
    const approveHash = await walletClient.writeContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [WORKER_UNISWAP_V3_ROUTER! as `0x${string}`, maxUsdcToSpend],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`[worker] Approve tx confirmed: ${approveHash}`);

  // Perform swap with fixed input (2x MIN_GAS_LIMIT_USDC per account cap) and quote-based slippage floor
    const swapHash = await walletClient.writeContract({
      address: WORKER_UNISWAP_V3_ROUTER! as `0x${string}`,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS!,
        tokenOut: WORKER_WRAPPED_NATIVE_TOKEN!,
        fee: BigInt(WORKER_UNISWAP_POOL_FEE!),
        recipient: bootstrapAccount.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300), // 5 minutes
        amountIn: maxUsdcToSpend,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }],
    });

    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    console.log(`[worker] Swap tx confirmed: ${swapHash}`);
    const gasSpentOnSwap = gasCostFromReceipt(swapReceipt);

    // Calculate actual USDC spent
    const finalUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [bootstrapAccount.address],
    })) as bigint;
    const actualUsdcSpent = initialUsdcBalance - finalUsdcBalance;

    // Unwrap received WMATIC to native MATIC for gas distribution
    const wmaticBalance = (await publicClient.readContract({
      address: WORKER_WRAPPED_NATIVE_TOKEN! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [bootstrapAccount.address],
    })) as bigint;

    let gasSpentOnUnwrap = 0n;
    if (wmaticBalance > 0n) {
      const unwrapHash = await walletClient.writeContract({
        address: WORKER_WRAPPED_NATIVE_TOKEN! as `0x${string}`,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [wmaticBalance],
      });
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });
      gasSpentOnUnwrap = gasCostFromReceipt(unwrapReceipt);
      console.log(`[worker] Unwrap tx confirmed: ${unwrapHash} (${formatWeiAsEth(wmaticBalance)} WMATIC → MATIC)`);
    }

    // Calculate gas received from swap (before distribution), minus swap and unwrap tx costs
    const gasBalanceAfterSwap = await publicClient.getBalance({ address: bootstrapAccount.address });
    const gasReceivedFromSwap = gasBalanceAfterSwap - initialGasBalance + gasSpentOnSwap + gasSpentOnUnwrap;

    console.log(
      `[worker] Swap result: spent=${formatUsdcE6(actualUsdcSpent)} USDC, initialGas=${formatWeiAsEth(initialGasBalance)}, afterSwap=${formatWeiAsEth(gasBalanceAfterSwap)}, swapTxGasCost=${formatWeiAsEth(gasSpentOnSwap)}, receivedFromSwap=${formatWeiAsEth(gasReceivedFromSwap)}`
    );

    if (gasReceivedFromSwap < totalGasNeeded) {
      console.warn(
        `[worker] Bootstrap gas is below one-pass target: got=${formatWeiAsEth(gasReceivedFromSwap)}, target=${formatWeiAsEth(totalGasNeeded)}. Continuing with partial distribution; monitoring will top up.`
      );
    }

    // Distribute gas to operational accounts with best-effort partial funding.
    console.log("[worker] Distributing gas to operational accounts...");
    let gasSpentOnDistributions = 0n;
    const distributionTargets: DistributionTarget[] = [
      {
        name: "entryPointDeposit",
        address: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS! as `0x${string}`,
        target: gasNeededPerAccount,
        kind: "entrypoint-deposit",
        paymasterAddress,
      },
      ...WORKER_BUNDLER_ADDRESSES.map((address, index) => ({
        name: `bundler-${index}`,
        address,
        target: gasNeededPerAccount,
        kind: "native" as const,
      })),
      {
        name: "worker",
        address: workerAccount.address,
        target: gasNeededPerAccount,
        kind: "native",
      },
      {
        name: "revenue",
        address: WORKER_REVENUE_ADDRESS,
        target: gasNeededPerAccount,
        kind: "native",
      },
    ];
    const reserveForTxFees = BigInt(2e15); // Keep ~0.002 ETH to avoid failing last txs.
    for (const target of distributionTargets) {
      const currentBootstrapGas = await publicClient.getBalance({ address: bootstrapAccount.address });
      const availableForTransfer = currentBootstrapGas > reserveForTxFees ? currentBootstrapGas - reserveForTxFees : 0n;
      if (availableForTransfer <= 0n) {
        console.warn("[worker] Bootstrap gas depleted for transfers; stopping distribution early");
        break;
      }
      const transferAmount = availableForTransfer < target.target ? availableForTransfer : target.target;
      if (transferAmount <= 0n) continue;
      let receipt: { gasUsed: bigint; effectiveGasPrice?: bigint };
      if (target.kind === "entrypoint-deposit") {
        const depositHash = await walletClient.writeContract({
          address: target.address,
          abi: ENTRYPOINT_ABI,
          functionName: "depositTo",
          args: [target.paymasterAddress!],
          value: transferAmount,
        });
        receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      } else {
        const transferHash = await walletClient.sendTransaction({
          to: target.address,
          value: transferAmount,
        });
        receipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
      }
      gasSpentOnDistributions += gasCostFromReceipt(receipt);
      const fullyFunded = transferAmount === target.target;
      console.log(
        `[worker] ✓ ${target.name} funded: ${shortAddress(target.address)} +${formatWeiAsEth(transferAmount)}${fullyFunded ? "" : " (partial)"}`
      );
    }

    // Transfer all remaining USDC to worker
    const remainingUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [bootstrapAccount.address],
    })) as bigint;

    if (remainingUsdcBalance > 0n) {
      console.log(`[worker] Transferring remaining USDC: ${formatUsdcE6(remainingUsdcBalance)} -> ${shortAddress(workerAccount.address)}`);
      const usdcTransferHash = await walletClient.writeContract({
        address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [workerAccount.address, remainingUsdcBalance],
      });
      const usdcTransferReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcTransferHash });
      gasSpentOnDistributions += gasCostFromReceipt(usdcTransferReceipt);
      console.log(`[worker] ✓ Worker USDC funded: +${formatUsdcE6(remainingUsdcBalance)}`);
    } else {
      console.log(`[worker] No remaining USDC to transfer to worker`);
    }

    const gasReceived = gasReceivedFromSwap - gasSpentOnDistributions;
    await recordSwapForPricing(actualUsdcSpent, gasReceived);

    console.log("[worker] Bootstrap distribution complete!");

  } catch (error) {
    console.error("[worker] Bootstrap distribution failed:", (error as Error).message);
    throw error;
  }
}

/**
 * Orchestrates the complete initial setup process
 *
 * Steps:
 * 1. Fund bootstrap account (for local development)
 * 2. Verify bootstrap account has sufficient funds
 * 3. Perform initial distribution to all operational accounts
 */
async function fundBootstrapFromWhale(): Promise<void> {
  console.log("🐋 Local development: Auto-funding bootstrap account");

  const bootstrapAccount = privateKeyToAccount(
    (WORKER_BOOTSTRAP_PRIVATE_KEY!.startsWith("0x") ? WORKER_BOOTSTRAP_PRIVATE_KEY! : `0x${WORKER_BOOTSTRAP_PRIVATE_KEY!}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const testClient = createTestClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
    mode: "anvil",
  });

  try {
    // Step 1: Always top up bootstrap gas first (with small buffer), even if no whale is available.
    const anvilAccount = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`;
    await testClient.impersonateAccount({ address: anvilAccount });
    const bootstrapGasTarget = MIN_BOOTSTRAP_GAS + parseEther("0.005");
    await testClient.setBalance({ address: bootstrapAccount.address, value: bootstrapGasTarget });
    await testClient.stopImpersonatingAccount({ address: anvilAccount });

    // If bootstrap already has enough USDC, no whale transfer is needed.
    const bootstrapUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [bootstrapAccount.address],
    })) as bigint;
    if (bootstrapUsdcBalance >= MIN_BOOTSTRAP_USDC) {
    console.log("✅ Bootstrap gas topped up; USDC already sufficient");
    console.log(`   Bootstrap address: ${bootstrapAccount.address}`);
    console.log(`   Bootstrap USDC balance: ${formatUsdcE6(bootstrapUsdcBalance)}`);
      return;
    }

    // Step 2: Find a whale with enough USDC to cover only the deficit.
    const usdcNeeded = MIN_BOOTSTRAP_USDC - bootstrapUsdcBalance;
    const whaleCandidates = [
      "0x47c031236e19d024b42f8de678d3110562d925b5",
      "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
      "0xF977814e90dA44bFA03b6295A0616a897441aceC",
      "0x28C6c06298d514Db089934071355E5743bf21d60",
    ];
    let whale: `0x${string}` | undefined;
    for (const candidate of whaleCandidates) {
      try {
        const candidateBal = (await publicClient.readContract({
          address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [candidate],
        })) as bigint;
        if (candidateBal >= usdcNeeded) {
          whale = candidate as `0x${string}`;
          break;
        }
      } catch {
        // Continue to next candidate
      }
    }
    if (!whale) {
      console.error(`[worker] No whale account has enough USDC for bootstrap funding (needed: ${usdcNeeded})`);
      return;
    }
    console.log(`[worker] Whale selected: ${shortAddress(whale)} (needed ${formatUsdcE6(usdcNeeded)})`);

    // Step 3: Fund whale gas and transfer missing USDC.
    await testClient.impersonateAccount({ address: anvilAccount });
    await testClient.setBalance({ address: whale, value: parseEther("100") });
    await testClient.stopImpersonatingAccount({ address: anvilAccount });

    await testClient.impersonateAccount({ address: whale });

    // Create a wallet client for the impersonated whale account
    const whaleWalletClient = createWalletClient({
      account: { address: whale, type: "json-rpc" },
      chain: polygon,
      transport: viemHttp(WORKER_RPC_URL!),
    });

    // Transfer only the USDC deficit from whale to bootstrap.
    const usdcTransferHash = await whaleWalletClient.writeContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [bootstrapAccount.address, usdcNeeded],
    });

    // Wait for the transaction to be mined
    await publicClient.waitForTransactionReceipt({ hash: usdcTransferHash });

    await testClient.stopImpersonatingAccount({ address: whale });

    console.log("✅ Bootstrap funded with gas + USDC");
    console.log(`   Bootstrap address: ${bootstrapAccount.address}`);
    console.log(`   Whale used: ${whale}`);
  } catch (err) {
    console.error("[worker] Bootstrap funding failed:", (err as Error).message);
  }
}

async function performInitialSetup(): Promise<void> {
  console.log("[worker] Starting initial setup...");

  // Skip bootstrap flow entirely on restart if all operational accounts are already funded.
  const alreadyFunded = await areOperationalAccountsFunded();
  if (alreadyFunded) {
    console.log("[worker] Operational accounts already funded, skipping bootstrap distribution");
    console.log("[worker] Initial setup complete");
    return;
  }

  // Fund bootstrap from whales if running locally
  const isLocalEnvironment = WORKER_RPC_URL?.includes('localhost') || WORKER_RPC_URL?.includes('127.0.0.1') || WORKER_RPC_URL?.includes('anvil');
  if (isLocalEnvironment) {
    await fundBootstrapFromWhale();
  }

  // Verify bootstrap funding. In local mode, attempt one recovery pass before stopping.
  let isBootstrapFunded = await verifyBootstrapFunding();
  if (!isBootstrapFunded && isLocalEnvironment) {
    console.warn("[worker] Bootstrap verification failed after first auto-funding attempt; retrying once...");
    await fundBootstrapFromWhale();
    isBootstrapFunded = await verifyBootstrapFunding();
  }
  if (!isBootstrapFunded) {
    console.error("🛑 Worker stopping due to insufficient bootstrap funding");
    if (isLocalEnvironment) {
      console.error("   Local development: Bootstrap should have been funded automatically");
    } else {
      console.error("   Please fund the bootstrap account with at least:");
      console.error(`   - ${MIN_BOOTSTRAP_USDC} USDC`);
      console.error(`   - ${MIN_BOOTSTRAP_GAS} gas`);
    }
    process.exit(1);
  }

  // Perform bootstrap distribution to all operational accounts
  await performBootstrapDistribution();

  console.log("[worker] Initial setup complete");
}

/**
 * Checks worker USDC balance and transfers from revenue account if below minimum
 * Ensures worker has sufficient USDC for gas swap operations
 */
async function checkWorkerUSDC(): Promise<void> {
  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const workerUSDC = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [workerAccount.address],
  })) as bigint;

  if (workerUSDC <= MIN_WORKER_USDC) {
    console.log(`⚠️  Worker USDC low (${formatUsdcE6(workerUSDC)}), transferring from revenue`);
    await transferUSDCFromRevenue(MIN_WORKER_USDC - workerUSDC + 10_000_000n); // 10 USDC buffer
  }
}

/**
 * Checks gas balances for all operational accounts (EntryPoint, Bundler, Worker, Revenue)
 * Identifies accounts that need gas refills and triggers gas distribution
 */
async function checkGasBalances(): Promise<void> {
  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );
  const paymasterAddress = await resolvePaymasterAddress();

  // Check all native-gas accounts (EntryPoint is tracked via deposit for paymaster).
  const accounts: { name: string; address: `0x${string}` }[] = [
    { name: 'worker', address: workerAccount.address },
    { name: 'revenue', address: WORKER_REVENUE_ADDRESS }
  ];

  // Add all bundler addresses
  WORKER_BUNDLER_ADDRESSES.forEach((address, index) => {
    accounts.push({ name: `bundler-${index}`, address });
  });

  const gasDeficits: GasDeficit[] = [];
  const minGasLimitWei = await getMinGasLimitWei();
  const entryPointDeposit = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS! as `0x${string}`,
    abi: ENTRYPOINT_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  })) as bigint;
  if (entryPointDeposit <= minGasLimitWei) {
    gasDeficits.push({
      name: "entryPointDeposit",
      address: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS! as `0x${string}`,
      currentGas: entryPointDeposit,
      neededGas: minGasLimitWei - entryPointDeposit + BigInt(1e15),
      kind: "entrypoint-deposit",
      paymasterAddress,
    });
  }

  for (const account of accounts) {
    const gasBalance = await publicClient.getBalance({ address: account.address });
    if (gasBalance <= minGasLimitWei) {
      gasDeficits.push({
        name: account.name,
        address: account.address,
        currentGas: gasBalance,
        neededGas: minGasLimitWei - gasBalance + BigInt(1e15), // 0.001 ETH buffer
        kind: "native",
      });
    }
  }

  if (gasDeficits.length > 0) {
    console.log(`⚠️  ${gasDeficits.length} accounts need gas refill`);
    for (const deficit of gasDeficits) {
      console.log(
        `   - ${deficit.name} ${shortAddress(deficit.address)} current=${formatWeiAsEth(deficit.currentGas)} needed=${formatWeiAsEth(deficit.neededGas)}`
      );
    }
    await performGasRefill(gasDeficits);
  } else {
    console.log("[worker] Gas balances healthy for all tracked accounts");
  }
}

/**
 * Transfers USDC from the revenue account to the worker account
 * Used to replenish worker funds for gas swap operations
 * @param amount Amount of USDC to transfer
 */
async function transferUSDCFromRevenue(amount: bigint): Promise<void> {

  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );

  const revenueAccount = privateKeyToAccount(
    (WORKER_REVENUE_PRIVATE_KEY!.startsWith("0x") ? WORKER_REVENUE_PRIVATE_KEY! : `0x${WORKER_REVENUE_PRIVATE_KEY!}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  // Check if revenue account has sufficient USDC balance
  const revenueUsdcBalance = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [revenueAccount.address],
  })) as bigint;

  if (revenueUsdcBalance < amount) {
    throw new Error(`Insufficient USDC in revenue account: has ${formatUsdcE6(revenueUsdcBalance)}, need ${formatUsdcE6(amount)}`);
  }

  const walletClient = createWalletClient({
    account: revenueAccount,
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  // Transfer USDC from revenue to worker
  const hash = await walletClient.writeContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [workerAccount.address, amount],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`💸 Transferred ${formatUsdcE6(amount)} from revenue to worker`);
}

/**
 * Performs gas refill operations for accounts with insufficient balances
 * Swaps USDC for gas via DEX and distributes to deficit accounts
 * @param deficits Array of objects with {name, address, currentGas, neededGas}
 */
async function performGasRefill(deficits: GasDeficit[]): Promise<void> {
  const treasuryPrivateKey = WORKER_TREASURY_PRIVATE_KEY!;
  const workerAccount = privateKeyToAccount(
    (treasuryPrivateKey.startsWith("0x") ? treasuryPrivateKey : `0x${treasuryPrivateKey}`) as `0x${string}`
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  const walletClient = createWalletClient({
    account: workerAccount,
    chain: polygon,
    transport: viemHttp(WORKER_RPC_URL!),
  });

  // Calculate total gas deficit across all accounts
  const totalGasNeeded = deficits.reduce((sum: bigint, d) => sum + d.neededGas, 0n);

  // Check worker USDC balance and cap to 2x WORKER_MIN_GAS_LIMIT_USDC per deficit account.
  const workerUSDCBalance = (await publicClient.readContract({
    address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [workerAccount.address],
  })) as bigint;

  const maxUsdcCap = 2n * MIN_GAS_LIMIT_USDC * BigInt(deficits.length);
  const maxUsdcToSpend = workerUSDCBalance < maxUsdcCap ? workerUSDCBalance : maxUsdcCap;

  if (maxUsdcToSpend <= 0n) {
    console.warn("[worker] No USDC available for gas refill");
    return;
  }
  const quotedGasOutWei = await fetchLiveGasQuoteWeiForUsdc(maxUsdcToSpend);
  const amountOutMinimum = quotedGasOutWei * SWAP_MIN_OUT_BPS / 10_000n;

  console.log(
    `[worker] Refill swap plan: amountIn=${formatUsdcE6(maxUsdcToSpend)}, quoteOut=${formatWeiAsEth(quotedGasOutWei)}, minOut=${formatWeiAsEth(amountOutMinimum)}`
  );

  try {
    const initialGasBalance = await publicClient.getBalance({ address: workerAccount.address });
    const initialUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [workerAccount.address],
    })) as bigint;

    // Approve USDC spending
    const approveHash = await walletClient.writeContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [WORKER_UNISWAP_V3_ROUTER! as `0x${string}`, maxUsdcToSpend],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`[worker] Refill approve tx confirmed: ${approveHash}`);

    // Perform swap with fixed input and quote-based slippage floor
    const swapHash = await walletClient.writeContract({
      address: WORKER_UNISWAP_V3_ROUTER! as `0x${string}`,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS!,
        tokenOut: WORKER_WRAPPED_NATIVE_TOKEN!,
        fee: BigInt(WORKER_UNISWAP_POOL_FEE!),
        recipient: workerAccount.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        amountIn: maxUsdcToSpend,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }],
    });

    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const gasSpentOnSwap = gasCostFromReceipt(swapReceipt);
    console.log(`[worker] Refill swap tx confirmed: ${swapHash}`);

    // Unwrap received WMATIC to native MATIC for gas distribution
    let gasSpentOnUnwrap = 0n;
    const wmaticBalance = (await publicClient.readContract({
      address: WORKER_WRAPPED_NATIVE_TOKEN! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [workerAccount.address],
    })) as bigint;
    if (wmaticBalance > 0n) {
      const unwrapHash = await walletClient.writeContract({
        address: WORKER_WRAPPED_NATIVE_TOKEN! as `0x${string}`,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [wmaticBalance],
      });
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });
      gasSpentOnUnwrap = gasCostFromReceipt(unwrapReceipt);
      console.log(`[worker] Refill unwrap tx confirmed: ${unwrapHash} (${formatWeiAsEth(wmaticBalance)} WMATIC → MATIC)`);
    }

    const finalUsdcBalance = (await publicClient.readContract({
      address: WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS! as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [workerAccount.address],
    })) as bigint;
    const gasBalanceAfterSwap = await publicClient.getBalance({ address: workerAccount.address });
    const actualUsdcSpent = initialUsdcBalance - finalUsdcBalance;
    const gasReceivedFromSwap = gasBalanceAfterSwap - initialGasBalance + gasSpentOnSwap + gasSpentOnUnwrap;

    console.log(`[worker] Swap complete, distributing gas to ${deficits.length} accounts`);

    // Distribute gas to deficit accounts and track gas spent on distribution txs
    let gasSpentOnDistributions = 0n;
    for (const deficit of deficits) {
      const gasAmount = deficit.neededGas;
      let receipt: { gasUsed: bigint; effectiveGasPrice?: bigint };
      if (deficit.kind === "entrypoint-deposit") {
        const depositHash = await walletClient.writeContract({
          address: deficit.address,
          abi: ENTRYPOINT_ABI,
          functionName: "depositTo",
          args: [deficit.paymasterAddress!],
          value: gasAmount,
        });
        receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      } else {
        const transferHash = await walletClient.sendTransaction({
          to: deficit.address,
          value: gasAmount,
        });
        receipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
      }
      gasSpentOnDistributions += gasCostFromReceipt(receipt);
      console.log(`[worker] ✓ ${deficit.name} ${shortAddress(deficit.address)}: +${formatWeiAsEth(gasAmount)}`);
    }

    const gasReceived = gasReceivedFromSwap - gasSpentOnDistributions;
    await recordSwapForPricing(actualUsdcSpent, gasReceived);

    console.log("[worker] Gas refill cycle complete");

  } catch (error) {
    console.error("[worker] Gas refill failed:", (error as Error).message);
  }
}

/**
 * Starts the continuous monitoring loop that checks account balances periodically
 * Uses recursive setTimeout to ensure cycles never overlap - waits for current cycle to complete
 */
async function startMonitoringLoop(): Promise<void> {
  console.log(`[worker] Starting monitoring loop every ${WORKER_MONITORING_INTERVAL_SECONDS} seconds`);
  let cycle = 0;

  const runMonitoringCycle = async (): Promise<void> => {
    cycle += 1;
    const startedAt = Date.now();
    try {
      console.log(`🔍 Worker monitoring cycle #${cycle} started`);

      // Check worker USDC balance
      await checkWorkerUSDC();

      // Check all gas balances
      await checkGasBalances();

      const elapsedMs = Date.now() - startedAt;
      console.log(`✅ Monitoring cycle #${cycle} complete (${elapsedMs}ms)`);
    } catch (err) {
      console.error("[worker] Monitoring cycle error:", (err as Error).message);
    } finally {
      // Schedule next cycle after current one completes (prevents overlapping)
      setTimeout(runMonitoringCycle, WORKER_MONITORING_INTERVAL_SECONDS * 1000);
    }
  };

  // Start the first monitoring cycle
  runMonitoringCycle();
}

/**
 * Main worker process entry point
 * Orchestrates the complete worker lifecycle:
 * 1. Validates environment configuration
 * 2. Performs initial bootstrap distribution
 * 3. Starts continuous monitoring loop
 * 4. Keeps process alive indefinitely
 */
async function main(): Promise<void> {
  console.log("[worker] Starting Project4 Worker Service");

  // Validate all required environment variables are set
  validateEnvironmentVariables();

  // Initialize and distribute bootstrap funds
  await performInitialSetup();

  // Start health check server
  const healthServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "ready" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const HEALTH_PORT = 8080;
  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[worker] Health check server listening on port ${HEALTH_PORT}`);
  });

  // Cleanup health server on process exit
  const cleanup = () => {
    console.log("[worker] Shutting down health server...");
    healthServer.close(() => {
      console.log("[worker] Health server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Start continuous balance monitoring
  await startMonitoringLoop();

  console.log("[worker] Initialization complete, monitoring active");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
