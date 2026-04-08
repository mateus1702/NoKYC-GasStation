/**
 * Operational refill: contract owner pulls USDC via withdrawUsdc, swaps USDC→WNATIVE, recordGasPurchase,
 * unwraps, then tops up EntryPoint deposit (paymaster), Alto utility, and executors.
 * Triggered from pm_sponsorUserOperation when any monitored balance is below min (Redis / default 10 ETH wei).
 */
import {
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configHashKey, getRedis, key } from "@project4/shared";
import { paymasterDebugLog } from "./debugLog.js";
import { RefillTriggerCoordinator } from "./refillTriggerCoordinator.js";

const REDIS_FIELD_REFILL_MIN_WEI = "PAYMASTER_API_REFILL_MIN_NATIVE_WEI";
const REDIS_FIELD_REFILL_ENTRYPOINT_MULTIPLIER_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_ENTRYPOINT_BPS";
const REDIS_FIELD_REFILL_PAYMASTER_NATIVE_MULTIPLIER_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS";
const REDIS_FIELD_REFILL_UTILITY_MULTIPLIER_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_UTILITY_BPS";
const REDIS_FIELD_REFILL_EXECUTOR_MULTIPLIER_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_EXECUTOR_BPS";

async function resolveLiveRefillPolicy(
  fallbackMinWei: bigint,
  fallbackMultipliers: RefillTargetMultipliersBps
): Promise<{ minNativeWei: bigint; targetMultipliersBps: RefillTargetMultipliersBps }> {
  let minNativeWei = fallbackMinWei;
  let targetMultipliersBps = fallbackMultipliers;
  if (!process.env.VALKEY_URL?.trim()) {
    return { minNativeWei, targetMultipliersBps };
  }
  try {
    const out = await getRedis().hmget(
      key(configHashKey("paymaster-api")),
      REDIS_FIELD_REFILL_MIN_WEI,
      REDIS_FIELD_REFILL_ENTRYPOINT_MULTIPLIER_BPS,
      REDIS_FIELD_REFILL_PAYMASTER_NATIVE_MULTIPLIER_BPS,
      REDIS_FIELD_REFILL_UTILITY_MULTIPLIER_BPS,
      REDIS_FIELD_REFILL_EXECUTOR_MULTIPLIER_BPS
    );
    const minRaw = out[0]?.trim();
    if (minRaw) {
      const parsed = BigInt(minRaw);
      if (parsed > 0n) minNativeWei = parsed;
    }
    targetMultipliersBps = {
      entrypoint: parsePositiveBpsOrFallback(out[1], fallbackMultipliers.entrypoint),
      paymasterNative: parsePositiveBpsOrFallback(out[2], fallbackMultipliers.paymasterNative),
      utility: parsePositiveBpsOrFallback(out[3], fallbackMultipliers.utility),
      executor: parsePositiveBpsOrFallback(out[4], fallbackMultipliers.executor),
    };
  } catch {
    /* Valkey unavailable or key missing */
  }
  return { minNativeWei, targetMultipliersBps };
}

const PAYMASTER_REFILL_ABI = [
  {
    type: "function",
    name: "withdrawUsdc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recordGasPurchase",
    stateMutability: "nonpayable",
    inputs: [
      { name: "usdcE6", type: "uint256" },
      { name: "nativeWei", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "depositTo",
    stateMutability: "payable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Uniswap V3 QuoterV2 — `amount` is exact desired `tokenOut` (here: wrapped native wei). */
const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
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

const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [
      {
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
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const WETH_ABI = [
  { type: "function", name: "withdraw", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

const DEFAULT_V3_FEE_CANDIDATES = [100, 500, 3000, 10000] as const;
const DEFAULT_POOL_FEE_CACHE_TTL_MS = 300_000;

type PoolFeeCacheEntry = { fee: number; expiresAt: number };
const poolFeeDiscoveryCache = new Map<string, PoolFeeCacheEntry>();

/** Parsed from env only; merge with paymaster address, entry point, min wei at runtime. */
export type RefillConfigEnvPartial = {
  rpcUrl: string;
  refillOwnerPrivateKey: `0x${string}`;
  utilityAddress: Address;
  executorAddresses: Address[];
  /** Uniswap V3 QuoterV2 — live `quoteExactOutputSingle` for USDC → wrapped native sizing. */
  quoterV2Address: Address;
  /** BPS added to quoter `amountIn` when sizing USDC withdraw (default 100 = 1%). */
  quoteSlippageBps: bigint;
  /** BPS subtracted from target wrapped-native when setting `amountOutMinimum` on swap (default 100). */
  swapSlippageBps: bigint;
  usdcAddress: Address;
  routerAddress: Address;
  wrappedNative: Address;
  /** When true (default), discover best fee tier by live quotes; when false, use `poolFeeFixed` only. */
  poolFeeAuto: boolean;
  /** Uniswap V3 fee tier used when `poolFeeAuto` is false (e.g. 500). */
  poolFeeFixed: number;
  /** Fee tiers to try when `poolFeeAuto` (best = lowest quoted USDC in, tie → lower fee). */
  v3FeeCandidates: readonly number[];
  /** In-memory TTL for auto-discovered fee (ms). */
  poolFeeCacheTtlMs: number;
  /** Debounce window for sponsor-triggered refill preflight scheduling (ms). */
  scheduleDebounceMs: number;
  /** Target native runway multipliers in bps (e.g. 20000 = 2.0x min). */
  targetMultipliersBps: RefillTargetMultipliersBps;
  swapDeadlineSeconds: number;
};

export type RefillRunnerConfig = RefillConfigEnvPartial & {
  paymasterAddress: Address;
  entryPointAddress: Address;
  minNativeWei: bigint;
};

export type RunRefillOptions = {
  /** Manual / dashboard: skip automatic “any below min” gate; still skips if aggregate deficit is zero. */
  force?: boolean;
};

export type RefillDistributionLeg = {
  kind: "entrypoint_deposit" | "paymaster_native" | "utility" | "executor";
  to: Address;
  weiPlanned: string;
  weiSent?: string;
  txHash?: string;
};

export type OperationalRefillResult = {
  status: "completed" | "skipped" | "failed";
  reason?: string;
  totalDeficitWei?: string;
  withdrawUsdcE6?: string;
  recordedNativeWei?: string;
  swapTxHash?: string;
  withdrawTxHash?: string;
  approveTxHash?: string;
  recordTxHash?: string;
  unwrapTxHash?: string;
  distribution?: RefillDistributionLeg[];
};

export type OperationalRefillEstimateResult = {
  status: "ready" | "not_needed" | "failed";
  reason?: string;
  minNativeWei?: string;
  totalDeficitWei?: string;
  requiredUsdcE6?: string;
  requiredUsdc?: string;
  paymasterUsdcBalanceE6?: string;
  shortfallUsdcE6?: string;
  poolFee?: number;
  poolFeeSource?: "cache" | "discovered" | "fixed";
  parties?: Array<{ key: string; deficitWei: string }>;
};

let lastRefillAt = 0;
const REFILL_COOLDOWN_MS = 60_000;
const DEFAULT_REFILL_SCHEDULE_DEBOUNCE_MS = 15_000;
let refillInFlight = false;

/** Extra native wei on aggregate deficit before quoting (covers rounding / partial tops). */
const DEFICIT_BUFFER_BPS = 500n;
/** Extra USDC (e6) to withdraw vs quoter `amountIn` (pool moves between quote and tx). */
const DEFAULT_QUOTE_SLIPPAGE_BPS = 100n;
/** Minimum wrapped-native out vs target (MEV / execution slippage). */
const DEFAULT_SWAP_SLIPPAGE_BPS = 100n;

const DEFAULT_MIN_NATIVE_WEI = 10n * 10n ** 18n;
const DEFAULT_TARGET_MULTIPLIER_ENTRYPOINT_BPS = 20_000n;
const DEFAULT_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS = 10_500n;
const DEFAULT_TARGET_MULTIPLIER_UTILITY_BPS = 15_000n;
const DEFAULT_TARGET_MULTIPLIER_EXECUTOR_BPS = 15_000n;

export type RefillTargetMultipliersBps = {
  entrypoint: bigint;
  paymasterNative: bigint;
  utility: bigint;
  executor: bigint;
};

export function mergeRefillRunnerConfig(
  partial: RefillConfigEnvPartial,
  merge: { paymasterAddress: Address; entryPointAddress: Address; minNativeWei: bigint }
): RefillRunnerConfig {
  return { ...partial, ...merge };
}

function buildChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: "refill-chain",
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

const GAS_FALLBACK_WITHDRAW_USDC = 400_000n;
const GAS_FALLBACK_APPROVE = 120_000n;
const GAS_FALLBACK_SWAP = 800_000n;
const GAS_FALLBACK_RECORD = 280_000n;
const GAS_FALLBACK_WETH_WITHDRAW = 120_000n;
const GAS_FALLBACK_SEND_NATIVE = 100_000n;
const GAS_FALLBACK_DEPOSIT_TO = 250_000n;

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Split `av` wei across parties in proportion to positive deficits, capping each at its deficit.
 * Sum(result) <= av. When `av` can fund at least 1 wei per leg, we pre-allocate that first, then
 * split the remainder proportionally — so EntryPoint cannot take 100% via integer rounding while
 * paymaster native / Alto keys get 0.
 */
export function allocateNativeAcrossDeficits(deficits: readonly bigint[], av: bigint): bigint[] {
  const n = deficits.length;
  const need = deficits.map((d) => (d > 0n ? d : 0n));
  const out = new Array<bigint>(n).fill(0n);
  let remaining = av;

  const idx = need.map((_, i) => i).filter((i) => need[i] > 0n);
  const k = BigInt(idx.length);
  if (k === 0n || remaining <= 0n) return out;

  if (remaining >= k) {
    for (const i of idx) {
      const add = bigMin(need[i], bigMin(1n, remaining));
      out[i] += add;
      need[i] -= add;
      remaining -= add;
    }
  } else {
    const sorted = [...idx].sort((a, b) => (need[b] > need[a] ? 1 : need[b] < need[a] ? -1 : 0));
    let base = remaining / k;
    let mod = remaining % k;
    for (const i of sorted) {
      let add = base;
      if (mod > 0n) {
        add += 1n;
        mod -= 1n;
      }
      add = bigMin(add, bigMin(need[i], remaining));
      out[i] += add;
      need[i] -= add;
      remaining -= add;
    }
    return out;
  }

  const S = need.reduce((a, b) => a + b, 0n);
  if (S === 0n || remaining <= 0n) return out;

  const raw = new Array<bigint>(n).fill(0n);
  const rems: { i: number; r: bigint }[] = [];
  let assigned = 0n;
  for (let i = 0; i < n; i++) {
    if (need[i] === 0n) continue;
    const prod = need[i] * remaining;
    const q = prod / S;
    const r = prod % S;
    const capped = q > need[i] ? need[i] : q;
    raw[i] = capped;
    assigned += capped;
    rems.push({ i, r });
  }

  let leftover = remaining - assigned;
  rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : 0));
  for (const { i } of rems) {
    if (leftover <= 0n) break;
    const room = need[i] - raw[i];
    if (room > 0n) {
      const add = leftover < room ? leftover : room;
      raw[i] += add;
      leftover -= add;
    }
  }

  for (let i = 0; i < n; i++) {
    out[i] += raw[i];
  }
  return out;
}

function parsePositiveBpsOrFallback(raw: string | null | undefined, fallback: bigint): bigint {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = BigInt(trimmed);
    return parsed >= 10000n && parsed <= 1_000_000n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function formatUsdcE6(usdcE6: bigint): string {
  const whole = usdcE6 / 1_000_000n;
  const frac = (usdcE6 % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function poolFeeCacheKey(chainId: number, quoter: Address, tIn: Address, tOut: Address): string {
  return `${chainId}:${quoter.toLowerCase()}:${tIn.toLowerCase()}:${tOut.toLowerCase()}`;
}

async function resolvePoolFeeForRefill(
  publicClient: PublicClient,
  cfg: RefillRunnerConfig,
  chainId: number,
  amountOutWei: bigint
): Promise<{ fee: number; source: "cache" | "discovered" | "fixed"; quotedUsdcInE6: bigint } | null> {
  if (!cfg.poolFeeAuto) {
    if (!Number.isFinite(cfg.poolFeeFixed) || cfg.poolFeeFixed <= 0) return null;
    const quotedFixed = await quoteUsdcInForWrappedNativeOut(publicClient, {
      quoterV2Address: cfg.quoterV2Address,
      tokenIn: cfg.usdcAddress,
      tokenOut: cfg.wrappedNative,
      poolFee: cfg.poolFeeFixed,
      amountOutWei,
    });
    if (quotedFixed == null) return null;
    return { fee: cfg.poolFeeFixed, source: "fixed", quotedUsdcInE6: quotedFixed };
  }

  const ckey = poolFeeCacheKey(chainId, cfg.quoterV2Address, cfg.usdcAddress, cfg.wrappedNative);
  const now = Date.now();
  const hit = poolFeeDiscoveryCache.get(ckey);
  if (hit && hit.expiresAt > now) {
    const cachedQuote = await quoteUsdcInForWrappedNativeOut(publicClient, {
      quoterV2Address: cfg.quoterV2Address,
      tokenIn: cfg.usdcAddress,
      tokenOut: cfg.wrappedNative,
      poolFee: hit.fee,
      amountOutWei,
    });
    if (cachedQuote == null) {
      poolFeeDiscoveryCache.delete(ckey);
    } else {
    paymasterDebugLog("refill", {
      step: "refill:pool_fee_cache_hit",
      fee: hit.fee,
      ttlRemainingMs: String(hit.expiresAt - now),
      quotedUsdcInE6: cachedQuote.toString(),
    });
      return { fee: hit.fee, source: "cache", quotedUsdcInE6: cachedQuote };
    }
  }

  let best: { fee: number; amountIn: bigint } | null = null;
  const candidates: Array<{ fee: number; quotedUsdcInE6?: string; ok: boolean }> = [];
  for (const fee of cfg.v3FeeCandidates) {
    const quoted = await quoteUsdcInForWrappedNativeOut(publicClient, {
      quoterV2Address: cfg.quoterV2Address,
      tokenIn: cfg.usdcAddress,
      tokenOut: cfg.wrappedNative,
      poolFee: fee,
      amountOutWei,
    });
    if (quoted == null) {
      candidates.push({ fee, ok: false });
      continue;
    }
    candidates.push({ fee, ok: true, quotedUsdcInE6: quoted.toString() });
    if (!best || quoted < best.amountIn || (quoted === best.amountIn && fee < best.fee)) {
      best = { fee, amountIn: quoted };
    }
  }
  if (!best) {
    paymasterDebugLog("refill", { step: "refill:pool_fee_discover_empty", mode: "quote_based", candidates });
    return null;
  }

  poolFeeDiscoveryCache.set(ckey, {
    fee: best.fee,
    expiresAt: now + cfg.poolFeeCacheTtlMs,
  });
  paymasterDebugLog("refill", {
    step: "refill:pool_fee_discovered",
    fee: best.fee,
    quotedUsdcInE6: best.amountIn.toString(),
    mode: "quote_based",
    candidates,
    cacheTtlMs: String(cfg.poolFeeCacheTtlMs),
  });
  return { fee: best.fee, source: "discovered", quotedUsdcInE6: best.amountIn };
}

async function quoteUsdcInForWrappedNativeOut(
  publicClient: PublicClient,
  params: {
    quoterV2Address: Address;
    tokenIn: Address;
    tokenOut: Address;
    poolFee: number;
    amountOutWei: bigint;
  }
): Promise<bigint | null> {
  if (params.amountOutWei <= 0n) return null;
  try {
    const out = (await publicClient.readContract({
      address: params.quoterV2Address,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactOutputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amount: params.amountOutWei,
          fee: params.poolFee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint];
    const amountIn = out[0];
    return amountIn > 0n ? amountIn : null;
  } catch (e) {
    paymasterDebugLog("refill", {
      step: "refill:quoter_failed",
      reason: (e as Error).message ?? String(e),
    });
    return null;
  }
}

async function quoteWrappedNativeOutForUsdcIn(
  publicClient: PublicClient,
  params: {
    quoterV2Address: Address;
    tokenIn: Address;
    tokenOut: Address;
    poolFee: number;
    amountInE6: bigint;
  }
): Promise<bigint | null> {
  if (params.amountInE6 <= 0n) return null;
  try {
    const out = (await publicClient.readContract({
      address: params.quoterV2Address,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInE6,
          fee: params.poolFee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint];
    const amountOut = out[0];
    return amountOut > 0n ? amountOut : null;
  } catch (e) {
    paymasterDebugLog("refill", {
      step: "refill:quoter_exact_input_failed",
      reason: (e as Error).message ?? String(e),
    });
    return null;
  }
}

async function gasForContractWrite(
  publicClient: PublicClient,
  account: Account,
  spec: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    value?: bigint;
  },
  fallback: bigint
): Promise<bigint> {
  try {
    const estimated = await publicClient.estimateContractGas({
      address: spec.address,
      abi: spec.abi as never,
      functionName: spec.functionName as never,
      args: spec.args as never,
      account,
      value: spec.value,
    });
    const buffered = estimated > 0n ? (estimated * 130n) / 100n : fallback;
    return bigMax(buffered, fallback);
  } catch {
    return fallback;
  }
}

type PartySnapshot = {
  key: string;
  deficitWei: bigint;
};

async function loadPartySnapshots(publicClient: PublicClient, c: RefillRunnerConfig): Promise<PartySnapshot[]> {
  const min = c.minNativeWei;
  const pm = c.paymasterAddress;
  const m = c.targetMultipliersBps;
  const deficitFor = (kind: "entrypoint_deposit" | "paymaster_native" | "utility" | "executor", current: bigint): bigint => {
    // Paymaster native balance is informational only in this architecture.
    // Refill sender is PAYMASTER_REFILL_OWNER_PRIVATE_KEY (EOA), so we do not allocate refill funds to paymaster native.
    if (kind === "paymaster_native") return 0n;
    if (current >= min) return 0n;
    const bps =
      kind === "entrypoint_deposit"
        ? m.entrypoint
        : kind === "utility"
            ? m.utility
            : m.executor;
    const targetWei = (min * bps) / 10000n;
    return targetWei > current ? targetWei - current : 0n;
  };

  const epBal = (await publicClient.readContract({
    address: c.entryPointAddress,
    abi: ENTRYPOINT_ABI,
    functionName: "balanceOf",
    args: [pm],
  })) as bigint;

  const pmNative = await publicClient.getBalance({ address: pm });
  const utilBal = await publicClient.getBalance({ address: c.utilityAddress });

  const parties: PartySnapshot[] = [
    { key: "entrypoint_deposit", deficitWei: deficitFor("entrypoint_deposit", epBal) },
    { key: "paymaster_native", deficitWei: deficitFor("paymaster_native", pmNative) },
    { key: "utility", deficitWei: deficitFor("utility", utilBal) },
  ];

  for (const ex of c.executorAddresses) {
    const b = await publicClient.getBalance({ address: ex });
    parties.push({ key: `executor:${ex}`, deficitWei: deficitFor("executor", b) });
  }

  return parties;
}

function totalDeficit(parties: PartySnapshot[]): bigint {
  return parties.reduce((s, p) => s + p.deficitWei, 0n);
}

async function anyPartyBelowMin(publicClient: PublicClient, c: RefillRunnerConfig): Promise<boolean> {
  const parties = await loadPartySnapshots(publicClient, c);
  return totalDeficit(parties) > 0n;
}

export async function estimateOperationalRefill(
  publicClient: PublicClient,
  cfg: RefillRunnerConfig
): Promise<OperationalRefillEstimateResult> {
  try {
    const live = await resolveLiveRefillPolicy(cfg.minNativeWei, cfg.targetMultipliersBps);
    const cfgRun: RefillRunnerConfig = {
      ...cfg,
      minNativeWei: live.minNativeWei,
      targetMultipliersBps: live.targetMultipliersBps,
    };

    const parties = await loadPartySnapshots(publicClient, cfgRun);
    const agg = totalDeficit(parties);
    const partyView = parties.map((p) => ({ key: p.key, deficitWei: p.deficitWei.toString() }));

    if (agg === 0n) {
      return {
        status: "not_needed",
        reason: "all_targets_satisfied",
        minNativeWei: cfgRun.minNativeWei.toString(),
        totalDeficitWei: "0",
        requiredUsdcE6: "0",
        requiredUsdc: "0",
        paymasterUsdcBalanceE6: "0",
        shortfallUsdcE6: "0",
        parties: partyView,
      };
    }

    const usdcBal = (await publicClient.readContract({
      address: cfgRun.usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [cfgRun.paymasterAddress],
    })) as bigint;

    const bufferedDeficit = (agg * (10000n + DEFICIT_BUFFER_BPS)) / 10000n;
    const feePick = await resolvePoolFeeForRefill(publicClient, cfgRun, await publicClient.getChainId(), bufferedDeficit);
    if (feePick == null) {
      return {
        status: "failed",
        reason: cfgRun.poolFeeAuto ? "no_quotable_uniswap_v3_pool" : "invalid_fixed_pool_fee",
        minNativeWei: cfgRun.minNativeWei.toString(),
        totalDeficitWei: agg.toString(),
        paymasterUsdcBalanceE6: usdcBal.toString(),
        parties: partyView,
      };
    }

    const quotedUsdcIn = feePick.quotedUsdcInE6;
    const slip = cfgRun.quoteSlippageBps;
    const requiredUsdcE6 = (quotedUsdcIn * (10000n + slip) + 9999n) / 10000n;
    const shortfallUsdcE6 = requiredUsdcE6 > usdcBal ? requiredUsdcE6 - usdcBal : 0n;

    return {
      status: "ready",
      minNativeWei: cfgRun.minNativeWei.toString(),
      totalDeficitWei: agg.toString(),
      requiredUsdcE6: requiredUsdcE6.toString(),
      requiredUsdc: formatUsdcE6(requiredUsdcE6),
      paymasterUsdcBalanceE6: usdcBal.toString(),
      shortfallUsdcE6: shortfallUsdcE6.toString(),
      poolFee: feePick.fee,
      poolFeeSource: feePick.source,
      parties: partyView,
    };
  } catch (e) {
    return { status: "failed", reason: (e as Error).message ?? String(e) };
  }
}

/**
 * Single refill attempt. Owner must match on-chain owner().
 */
export async function runOperationalRefill(
  publicClient: PublicClient,
  cfg: RefillRunnerConfig,
  options: RunRefillOptions = {}
): Promise<OperationalRefillResult> {
  const force = Boolean(options.force);

  const live = await resolveLiveRefillPolicy(cfg.minNativeWei, cfg.targetMultipliersBps);
  const cfgRun: RefillRunnerConfig = {
    ...cfg,
    minNativeWei: live.minNativeWei,
    targetMultipliersBps: live.targetMultipliersBps,
  };

  const parties = await loadPartySnapshots(publicClient, cfgRun);
  const agg = totalDeficit(parties);
  paymasterDebugLog("refill", {
    step: "refill:snapshot",
    totalDeficitWei: agg.toString(),
    minNativeWei: cfgRun.minNativeWei.toString(),
    targetMultipliersBps: {
      entrypoint: cfgRun.targetMultipliersBps.entrypoint.toString(),
      paymasterNative: cfgRun.targetMultipliersBps.paymasterNative.toString(),
      utility: cfgRun.targetMultipliersBps.utility.toString(),
      executor: cfgRun.targetMultipliersBps.executor.toString(),
    },
    parties: parties.map((p) => ({ key: p.key, deficitWei: p.deficitWei.toString() })),
  });

  if (agg === 0n) {
    const reason = force ? "all_targets_satisfied" : "all_targets_satisfied";
    paymasterDebugLog("refill", { step: "refill:run_skip", reason, force });
    return { status: "skipped", reason, totalDeficitWei: "0" };
  }

  if (!force && Date.now() - lastRefillAt < REFILL_COOLDOWN_MS) {
    paymasterDebugLog("refill", { step: "refill:run_skip", reason: "cooldown" });
    return { status: "skipped", reason: "cooldown" };
  }

  paymasterDebugLog("refill", { step: "refill:start", force, paymasterAddress: cfgRun.paymasterAddress });

  const chainId = await publicClient.getChainId();
  const chain = buildChain(Number(chainId), cfgRun.rpcUrl);
  const account = privateKeyToAccount(cfgRun.refillOwnerPrivateKey);
  const wallet = createWalletClient({ account, chain, transport: http(cfgRun.rpcUrl) });

  const distribution: RefillDistributionLeg[] = [];

  try {
    const usdcBal = (await publicClient.readContract({
      address: cfgRun.usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [cfgRun.paymasterAddress],
    })) as bigint;

    const bufferedDeficit = (agg * (10000n + DEFICIT_BUFFER_BPS)) / 10000n;

    const feePick = await resolvePoolFeeForRefill(publicClient, cfgRun, chainId, bufferedDeficit);
    if (feePick == null) {
      return {
        status: "failed",
        reason: cfgRun.poolFeeAuto ? "no_quotable_uniswap_v3_pool" : "invalid_fixed_pool_fee",
        totalDeficitWei: agg.toString(),
      };
    }
    const poolFeeUsed = feePick.fee;
    const quotedUsdcIn = feePick.quotedUsdcInE6;

    const slip = cfgRun.quoteSlippageBps;
    let withdrawUsdcAmountE6 = (quotedUsdcIn * (10000n + slip) + 9999n) / 10000n;
    if (withdrawUsdcAmountE6 > usdcBal) {
      withdrawUsdcAmountE6 = usdcBal;
    }

    const expectedOut = await quoteWrappedNativeOutForUsdcIn(publicClient, {
      quoterV2Address: cfgRun.quoterV2Address,
      tokenIn: cfgRun.usdcAddress,
      tokenOut: cfgRun.wrappedNative,
      poolFee: poolFeeUsed,
      amountInE6: withdrawUsdcAmountE6,
    });
    const swapSlip = cfgRun.swapSlippageBps;
    let amountOutMinimum: bigint;
    if (expectedOut == null) {
      // Some forks/providers can fail exact-input quotes despite exact-output succeeding.
      // Keep refill moving by allowing the swap, while logging this degraded safety mode.
      amountOutMinimum = 1n;
      paymasterDebugLog("refill", {
        step: "refill:amount_out_min_fallback",
        reason: "quoter_exact_input_failed",
        poolFee: String(poolFeeUsed),
        withdrawUsdcAmountE6: withdrawUsdcAmountE6.toString(),
      });
    } else {
      amountOutMinimum = bigMax((expectedOut * (10000n - swapSlip)) / 10000n, 1n);
    }

    paymasterDebugLog("refill", {
      step: "refill:usdc_sizing",
      poolFee: String(poolFeeUsed),
      poolFeeSource: feePick.source,
      quotedUsdcInE6: quotedUsdcIn.toString(),
      expectedOutWeiFromAmountIn: expectedOut?.toString() ?? null,
      withdrawUsdcAmountE6: withdrawUsdcAmountE6.toString(),
      amountOutMinimumWei: amountOutMinimum.toString(),
      paymasterUsdcBal: usdcBal.toString(),
      aggregateDeficitWei: agg.toString(),
    });

    if (withdrawUsdcAmountE6 <= 0n) {
      paymasterDebugLog("refill", { step: "refill:run_skip", reason: "zero_usdc_withdraw_amount" });
      return { status: "skipped", reason: "paymaster_usdc_balance_below_withdraw_amount", totalDeficitWei: agg.toString() };
    }

    const gasWithdraw = await gasForContractWrite(
      publicClient,
      account,
      {
        address: cfgRun.paymasterAddress,
        abi: PAYMASTER_REFILL_ABI,
        functionName: "withdrawUsdc",
        args: [account.address, withdrawUsdcAmountE6],
      },
      GAS_FALLBACK_WITHDRAW_USDC
    );
    const hashW = await wallet.writeContract({
      address: cfgRun.paymasterAddress,
      abi: PAYMASTER_REFILL_ABI,
      functionName: "withdrawUsdc",
      args: [account.address, withdrawUsdcAmountE6],
      gas: gasWithdraw,
    });
    paymasterDebugLog("refill", { step: "refill:withdraw_usdc_submitted", hash: hashW });
    await publicClient.waitForTransactionReceipt({ hash: hashW });

    const gasApprove = await gasForContractWrite(
      publicClient,
      account,
      {
        address: cfgRun.usdcAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [cfgRun.routerAddress, withdrawUsdcAmountE6],
      },
      GAS_FALLBACK_APPROVE
    );
    const approveHash = await wallet.writeContract({
      address: cfgRun.usdcAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [cfgRun.routerAddress, withdrawUsdcAmountE6],
      gas: gasApprove,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const swapArgs = [
      {
        tokenIn: cfgRun.usdcAddress,
        tokenOut: cfgRun.wrappedNative,
        fee: poolFeeUsed,
        recipient: account.address,
        amountIn: withdrawUsdcAmountE6,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ] as const;
    const gasSwap = await gasForContractWrite(
      publicClient,
      account,
      {
        address: cfgRun.routerAddress,
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: swapArgs,
      },
      GAS_FALLBACK_SWAP
    );
    const swapHash = await wallet.writeContract({
      address: cfgRun.routerAddress,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: swapArgs,
      gas: gasSwap,
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    if (swapReceipt.status !== "success") {
      return {
        status: "failed",
        reason: "swap_reverted",
        totalDeficitWei: agg.toString(),
        withdrawTxHash: hashW,
        approveTxHash: approveHash,
        swapTxHash: swapReceipt.transactionHash,
        withdrawUsdcE6: withdrawUsdcAmountE6.toString(),
      };
    }

    const wBal = (await publicClient.readContract({
      address: cfgRun.wrappedNative,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    if (wBal <= 0n) {
      return {
        status: "failed",
        reason: "zero_wrapped_native_after_swap",
        totalDeficitWei: agg.toString(),
        withdrawTxHash: hashW,
        approveTxHash: approveHash,
        swapTxHash: swapReceipt.transactionHash,
        withdrawUsdcE6: withdrawUsdcAmountE6.toString(),
      };
    }

    const gasRecord = await gasForContractWrite(
      publicClient,
      account,
      {
        address: cfgRun.paymasterAddress,
        abi: PAYMASTER_REFILL_ABI,
        functionName: "recordGasPurchase",
        args: [withdrawUsdcAmountE6, wBal],
      },
      GAS_FALLBACK_RECORD
    );
    const recordTx = await wallet.writeContract({
      address: cfgRun.paymasterAddress,
      abi: PAYMASTER_REFILL_ABI,
      functionName: "recordGasPurchase",
      args: [withdrawUsdcAmountE6, wBal],
      gas: gasRecord,
    });
    await publicClient.waitForTransactionReceipt({ hash: recordTx });

    const gasUnwrap = await gasForContractWrite(
      publicClient,
      account,
      {
        address: cfgRun.wrappedNative,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [wBal],
      },
      GAS_FALLBACK_WETH_WITHDRAW
    );
    const unwrapTx = await wallet.writeContract({
      address: cfgRun.wrappedNative,
      abi: WETH_ABI,
      functionName: "withdraw",
      args: [wBal],
      gas: gasUnwrap,
    });
    await publicClient.waitForTransactionReceipt({ hash: unwrapTx });

    const reserve = 2n * 10n ** 15n;
    const epDeficit = parties.find((p) => p.key === "entrypoint_deposit")!.deficitWei;
    const pmNatDeficit = parties.find((p) => p.key === "paymaster_native")!.deficitWei;
    const utilDeficit = parties.find((p) => p.key === "utility")!.deficitWei;
    const execDefs = parties.filter((p) => p.key.startsWith("executor:"));
    const sortedExec = [...execDefs].sort((a, b) => a.key.localeCompare(b.key));

    async function spendable(): Promise<bigint> {
      const bal = await publicClient.getBalance({ address: account.address });
      return bal > reserve ? bal - reserve : 0n;
    }

    const deficitVec = [epDeficit, utilDeficit, ...sortedExec.map((e) => e.deficitWei)];
    const avForSplit = await spendable();
    const plannedSends = allocateNativeAcrossDeficits(deficitVec, avForSplit);
    paymasterDebugLog("refill", {
      step: "refill:native_split",
      spendableWei: avForSplit.toString(),
      plannedWei: plannedSends.map((w) => w.toString()),
      deficitsWei: deficitVec.map((w) => w.toString()),
    });

    let si = 0;
    const epSend = plannedSends[si++];
    if (epDeficit > 0n) {
      if (epSend > 0n) {
        const gasD = await gasForContractWrite(
          publicClient,
          account,
          {
            address: cfgRun.entryPointAddress,
            abi: ENTRYPOINT_ABI,
            functionName: "depositTo",
            args: [cfgRun.paymasterAddress],
            value: epSend,
          },
          GAS_FALLBACK_DEPOSIT_TO
        );
        const txh = await wallet.writeContract({
          address: cfgRun.entryPointAddress,
          abi: ENTRYPOINT_ABI,
          functionName: "depositTo",
          args: [cfgRun.paymasterAddress],
          value: epSend,
          gas: gasD,
        });
        await publicClient.waitForTransactionReceipt({ hash: txh });
        distribution.push({
          kind: "entrypoint_deposit",
          to: cfgRun.paymasterAddress,
          weiPlanned: epDeficit.toString(),
          weiSent: epSend.toString(),
          txHash: txh,
        });
      } else {
        distribution.push({
          kind: "entrypoint_deposit",
          to: cfgRun.paymasterAddress,
          weiPlanned: epDeficit.toString(),
        });
      }
    }

    if (pmNatDeficit > 0n) {
      distribution.push({
        kind: "paymaster_native",
        to: cfgRun.paymasterAddress,
        weiPlanned: pmNatDeficit.toString(),
      });
    }

    const utilSend = plannedSends[si++];
    if (utilDeficit > 0n) {
      if (utilSend > 0n) {
        let sendGas = GAS_FALLBACK_SEND_NATIVE;
        try {
          const eg = await publicClient.estimateGas({ account, to: cfgRun.utilityAddress, value: utilSend });
          if (eg > 0n) sendGas = bigMax((eg * 130n) / 100n, 50_000n);
        } catch {
          /* fallback */
        }
        const txh = await wallet.sendTransaction({ to: cfgRun.utilityAddress, value: utilSend, gas: sendGas });
        await publicClient.waitForTransactionReceipt({ hash: txh });
        distribution.push({
          kind: "utility",
          to: cfgRun.utilityAddress,
          weiPlanned: utilDeficit.toString(),
          weiSent: utilSend.toString(),
          txHash: txh,
        });
      } else {
        distribution.push({
          kind: "utility",
          to: cfgRun.utilityAddress,
          weiPlanned: utilDeficit.toString(),
        });
      }
    }

    for (const ex of sortedExec) {
      const addr = ex.key.slice("executor:".length) as Address;
      const d = ex.deficitWei;
      const send = plannedSends[si++];
      if (d <= 0n) continue;
      if (send > 0n) {
        let sendGas = GAS_FALLBACK_SEND_NATIVE;
        try {
          const eg = await publicClient.estimateGas({ account, to: addr, value: send });
          if (eg > 0n) sendGas = bigMax((eg * 130n) / 100n, 50_000n);
        } catch {
          /* fallback */
        }
        const txh = await wallet.sendTransaction({ to: addr, value: send, gas: sendGas });
        await publicClient.waitForTransactionReceipt({ hash: txh });
        distribution.push({
          kind: "executor",
          to: addr,
          weiPlanned: d.toString(),
          weiSent: send.toString(),
          txHash: txh,
        });
      } else {
        distribution.push({ kind: "executor", to: addr, weiPlanned: d.toString() });
      }
    }

    lastRefillAt = Date.now();
    const result: OperationalRefillResult = {
      status: "completed",
      totalDeficitWei: agg.toString(),
      withdrawUsdcE6: withdrawUsdcAmountE6.toString(),
      recordedNativeWei: wBal.toString(),
      swapTxHash: swapReceipt.transactionHash,
      withdrawTxHash: hashW,
      approveTxHash: approveHash,
      recordTxHash: recordTx,
      unwrapTxHash: unwrapTx,
      distribution,
    };
    paymasterDebugLog("refill", { step: "refill:complete", status: result.status, distribution: result.distribution });
    console.log(JSON.stringify({ event: "refill_complete", ...result }));
    return result;
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.warn("[paymaster-api/refill]", message);
    paymasterDebugLog("refill", { step: "refill:run_catch_fail", reason: message });
    return { status: "failed", reason: message, distribution };
  }
}

/**
 * Fire-and-forget: if any monitored balance is below min, runs one refill (subject to cooldown).
 */
export function scheduleOperationalRefillIfNeeded(publicClient: PublicClient, cfg: RefillRunnerConfig | null): void {
  if (!cfg) {
    paymasterDebugLog("refill", { step: "refill:schedule_skipped", reason: "no_cfg" });
    return;
  }
  getRefillTriggerCoordinator(cfg.scheduleDebounceMs).trigger({ publicClient, cfg });
}

let refillTriggerCoordinator:
  | RefillTriggerCoordinator<{
      publicClient: PublicClient;
      cfg: RefillRunnerConfig;
    }>
  | null = null;
let refillTriggerCoordinatorDebounceMs = 0;

function getRefillTriggerCoordinator(debounceMs: number): RefillTriggerCoordinator<{
  publicClient: PublicClient;
  cfg: RefillRunnerConfig;
}> {
  if (refillTriggerCoordinator && refillTriggerCoordinatorDebounceMs === debounceMs) {
    return refillTriggerCoordinator;
  }
  refillTriggerCoordinatorDebounceMs = debounceMs;
  refillTriggerCoordinator = new RefillTriggerCoordinator<{
    publicClient: PublicClient;
    cfg: RefillRunnerConfig;
  }>({
    debounceMs,
    onSkip: (reason) => {
      if (reason === "debounced") {
        paymasterDebugLog("refill", { step: "refill:schedule_skipped", reason: "debounced" });
        return;
      }
      paymasterDebugLog("refill", { step: "refill:schedule_skipped", reason: "preflight_in_flight" });
    },
    onError: (e) => {
      paymasterDebugLog("refill", {
        step: "refill:schedule_error",
        error: (e as Error).message ?? String(e),
      });
      console.warn("[paymaster-api/refill]", (e as Error).message ?? String(e));
    },
    run: async ({ publicClient, cfg }) => {
      if (refillInFlight) {
        paymasterDebugLog("refill", { step: "refill:schedule_skipped", reason: "in_flight" });
        return;
      }
      const live = await resolveLiveRefillPolicy(cfg.minNativeWei, cfg.targetMultipliersBps);
      const cfgLive: RefillRunnerConfig = {
        ...cfg,
        minNativeWei: live.minNativeWei,
        targetMultipliersBps: live.targetMultipliersBps,
      };
      const below = await anyPartyBelowMin(publicClient, cfgLive);
      if (!below) {
        paymasterDebugLog("refill", { step: "refill:schedule_skipped", reason: "all_above_min_native" });
        return;
      }
      refillInFlight = true;
      paymasterDebugLog("refill", { step: "refill:schedule_start" });
      try {
        const r = await runOperationalRefill(publicClient, cfgLive, { force: false });
        paymasterDebugLog("refill", {
          step: "refill:schedule_done",
          status: r.status,
          reason: r.reason,
        });
        if (r.status === "failed") {
          console.warn("[paymaster-api/refill] automatic refill failed:", r.reason ?? r);
        }
      } finally {
        refillInFlight = false;
      }
    },
  });
  return refillTriggerCoordinator;
}

export function isRefillInFlight(): boolean {
  return refillInFlight;
}

export async function runOperationalRefillExclusive(
  publicClient: PublicClient,
  cfg: RefillRunnerConfig,
  options: RunRefillOptions = {}
): Promise<OperationalRefillResult> {
  if (refillInFlight) {
    paymasterDebugLog("refill", { step: "refill:exclusive_skipped", reason: "refill_already_in_flight" });
    return { status: "skipped", reason: "refill_already_in_flight" };
  }
  refillInFlight = true;
  paymasterDebugLog("refill", { step: "refill:exclusive_start", force: Boolean(options.force) });
  try {
    const out = await runOperationalRefill(publicClient, cfg, options);
    paymasterDebugLog("refill", {
      step: "refill:exclusive_end",
      status: out.status,
      reason: out.reason,
    });
    return out;
  } finally {
    refillInFlight = false;
  }
}

function normalizePk(pk: string): `0x${string}` {
  const t = pk.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as `0x${string}`;
}

function parseV3FeeCandidates(raw: string | undefined): readonly number[] {
  if (!raw?.trim()) return [...DEFAULT_V3_FEE_CANDIDATES];
  const parts = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1_000_000);
  return parts.length > 0 ? parts : [...DEFAULT_V3_FEE_CANDIDATES];
}

export function parseRefillConfigFromEnv(rpcUrl: string): RefillConfigEnvPartial | null {
  const ownerPk = process.env.PAYMASTER_REFILL_OWNER_PRIVATE_KEY?.trim();
  const utilPk = process.env.ALTO_UTILITY_PRIVATE_KEY?.trim();
  const execRaw = process.env.ALTO_EXECUTOR_PRIVATE_KEYS?.trim();
  const quoterRaw = process.env.PAYMASTER_API_REFILL_QUOTER_V2_ADDRESS?.trim();

  if (!ownerPk) {
    paymasterDebugLog("refill", { step: "refill:parse_env", configured: false, reason: "missing_refill_owner" });
    return null;
  }
  if (!utilPk || !execRaw) {
    paymasterDebugLog("refill", { step: "refill:parse_env", configured: false, reason: "missing_alto_keys" });
    return null;
  }
  if (!quoterRaw) {
    console.warn("[paymaster-api/refill] PAYMASTER_API_REFILL_QUOTER_V2_ADDRESS required for live Uniswap V3 quotes");
    paymasterDebugLog("refill", { step: "refill:parse_env", configured: false, reason: "missing_quoter_v2" });
    return null;
  }

  const usdc = process.env.PAYMASTER_API_REFILL_USDC_ADDRESS?.trim() as Address | undefined;
  const router = process.env.PAYMASTER_API_REFILL_ROUTER_ADDRESS?.trim() as Address | undefined;
  const wnative = process.env.PAYMASTER_API_REFILL_WRAPPED_NATIVE?.trim() as Address | undefined;
  const quoterV2Address = quoterRaw as Address;
  if (!usdc || !router || !wnative) {
    console.warn("[paymaster-api/refill] missing USDC/router/wnative env; refill disabled");
    paymasterDebugLog("refill", { step: "refill:parse_env", configured: false, reason: "missing_swap_env" });
    return null;
  }

  const utilityAddress = privateKeyToAccount(normalizePk(utilPk)).address;
  const executorAddresses = execRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pk) => privateKeyToAccount(normalizePk(pk)).address);

  const poolFeeAutoRaw = process.env.PAYMASTER_API_REFILL_POOL_FEE_AUTO?.trim()?.toLowerCase();
  const poolFeeAuto = poolFeeAutoRaw !== "false" && poolFeeAutoRaw !== "0";
  const poolFeeFixed = Number(process.env.PAYMASTER_API_REFILL_POOL_FEE ?? "500");

  const v3FeeCandidates = parseV3FeeCandidates(process.env.PAYMASTER_API_REFILL_V3_FEE_CANDIDATES);

  let poolFeeCacheTtlMs = DEFAULT_POOL_FEE_CACHE_TTL_MS;
  const ttlRaw = process.env.PAYMASTER_API_REFILL_POOL_FEE_CACHE_MS?.trim();
  if (ttlRaw) {
    const t = Number(ttlRaw);
    if (Number.isFinite(t) && t >= 5_000 && t <= 86_400_000) {
      poolFeeCacheTtlMs = t;
    }
  }

  const swapDeadlineSeconds = Number(process.env.PAYMASTER_API_REFILL_SWAP_DEADLINE_SECONDS ?? "300");
  let scheduleDebounceMs = DEFAULT_REFILL_SCHEDULE_DEBOUNCE_MS;
  const schedDebounceRaw = process.env.PAYMASTER_API_REFILL_SCHEDULE_DEBOUNCE_MS?.trim();
  if (schedDebounceRaw) {
    const d = Number(schedDebounceRaw);
    if (Number.isFinite(d) && d >= 0 && d <= 3_600_000) {
      scheduleDebounceMs = Math.floor(d);
    } else {
      paymasterDebugLog("refill", { step: "refill:parse_env", reason: "invalid_schedule_debounce_ms" });
    }
  }

  const targetMultipliersBps: RefillTargetMultipliersBps = {
    entrypoint: parsePositiveBpsOrFallback(
      process.env.PAYMASTER_API_REFILL_TARGET_MULTIPLIER_ENTRYPOINT_BPS,
      DEFAULT_TARGET_MULTIPLIER_ENTRYPOINT_BPS
    ),
    paymasterNative: parsePositiveBpsOrFallback(
      process.env.PAYMASTER_API_REFILL_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS,
      DEFAULT_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS
    ),
    utility: parsePositiveBpsOrFallback(
      process.env.PAYMASTER_API_REFILL_TARGET_MULTIPLIER_UTILITY_BPS,
      DEFAULT_TARGET_MULTIPLIER_UTILITY_BPS
    ),
    executor: parsePositiveBpsOrFallback(
      process.env.PAYMASTER_API_REFILL_TARGET_MULTIPLIER_EXECUTOR_BPS,
      DEFAULT_TARGET_MULTIPLIER_EXECUTOR_BPS
    ),
  };

  let quoteSlippageBps = DEFAULT_QUOTE_SLIPPAGE_BPS;
  const qSlipRaw = process.env.PAYMASTER_API_REFILL_QUOTE_SLIPPAGE_BPS?.trim();
  if (qSlipRaw) {
    try {
      const q = BigInt(qSlipRaw);
      if (q >= 0n && q < 5000n) quoteSlippageBps = q;
    } catch {
      paymasterDebugLog("refill", { step: "refill:parse_env", reason: "invalid_quote_slippage_bps" });
    }
  }

  let swapSlippageBps = DEFAULT_SWAP_SLIPPAGE_BPS;
  const sSlipRaw = process.env.PAYMASTER_API_REFILL_SWAP_SLIPPAGE_BPS?.trim();
  if (sSlipRaw) {
    try {
      const s = BigInt(sSlipRaw);
      if (s >= 0n && s < 5000n) swapSlippageBps = s;
    } catch {
      paymasterDebugLog("refill", { step: "refill:parse_env", reason: "invalid_swap_slippage_bps" });
    }
  }

  paymasterDebugLog("refill", {
    step: "refill:parse_env",
    configured: true,
    executorCount: executorAddresses.length,
  });

  return {
    rpcUrl,
    refillOwnerPrivateKey: normalizePk(ownerPk),
    utilityAddress,
    executorAddresses,
    quoterV2Address,
    quoteSlippageBps,
    swapSlippageBps,
    usdcAddress: usdc,
    routerAddress: router,
    wrappedNative: wnative,
    poolFeeAuto,
    poolFeeFixed,
    v3FeeCandidates,
    poolFeeCacheTtlMs,
    scheduleDebounceMs,
    targetMultipliersBps,
    swapDeadlineSeconds,
  };
}

export { DEFAULT_MIN_NATIVE_WEI };
