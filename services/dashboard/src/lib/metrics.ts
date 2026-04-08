/**
 * Server-side metrics for NoKYC-GasStation dashboard.
 * Reads RPC, health endpoints. No aggregation; snapshot data only. Fail-soft per section.
 */
import { readFile } from "node:fs/promises";
import {
  computeUsdcPerWeiE6FromCounters,
  configHashKey,
  getRedis,
  key,
  loadDashboardRedisConfig,
} from "@project4/shared";
import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE || "";
const PAYMASTER_ADDRESS_ENV = (process.env.PAYMASTER_ADDRESS || "").trim().toLowerCase();
const ALTO_UTILITY_KEY = (process.env.DASHBOARD_ALTO_UTILITY_KEY || "").trim();
const ALTO_EXECUTOR_KEYS = (process.env.DASHBOARD_ALTO_EXECUTOR_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
const REFILL_OWNER_KEY = (process.env.DASHBOARD_REFILL_OWNER_KEY || process.env.PAYMASTER_REFILL_OWNER_PRIVATE_KEY || "").trim();

const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Matches paymaster `getPricingCounters` (see paymaster-api sponsor paymasterAbi). */
const PAYMASTER_PRICING_COUNTERS_ABI = [
  {
    type: "function",
    name: "getPricingCounters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "gasUnitsProcessed", type: "uint256" },
      { name: "usdcSpentForGasE6", type: "uint256" },
      { name: "gasBoughtWei", type: "uint256" },
    ],
  },
] as const;

export interface MetricValue {
  raw: string;
  formatted: string;
  unit: string;
  formattedUnit?: string;
  address?: string;
}

export interface MetricsPayload {
  paymasterAddress: { status: "ok" | "error"; value?: string; error?: string };
  entryPointDeposit: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  /** Native balance on the paymaster contract address (often small; EntryPoint deposit is primary gas backing). */
  paymasterContractNativeReserve: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  /** USDC held by the paymaster contract (postOp fee sink when treasury is set to self). */
  paymasterContractUsdcReserve: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  refillOwnerNativeBalance: {
    status: "ok" | "error";
    address?: string;
    value?: MetricValue;
    error?: string;
  };
  refillOwnerUsdcBalance: {
    status: "ok" | "error";
    address?: string;
    value?: MetricValue;
    error?: string;
  };
  bundlerUtilityBalance: {
    status: "ok" | "error";
    address?: string;
    value?: MetricValue;
    error?: string;
  };
  bundlerExecutorBalances: {
    status: "ok" | "error";
    items: { address: string; value: MetricValue }[];
    error?: string;
  };
  health: {
    paymasterApi: "ok" | "error";
    bundler: "ok" | "error";
  };
  gasPriceWei: {
    status: "ok" | "error";
    value?: MetricValue;
    /** Paymaster API reports chain RPC gas price. */
    source?: "rpc";
    error?: string;
  };
  /** On-chain procurement counters + Redis pricing params (see paymaster-api sponsor payloads). */
  paymasterGasUnitsProcessed: { status: "ok" | "error"; value?: MetricValue; error?: string };
  paymasterGasBoughtWei: { status: "ok" | "error"; value?: MetricValue; error?: string };
  paymasterUsdcSpentForGasE6: { status: "ok" | "error"; value?: MetricValue; error?: string };
  /**
   * Runtime USDC (e6) per gas unit at current RPC gas price:
   * `(usdcPerWeiE6 * gasPriceWei) / 1e18`, matching sponsor pricing.
   */
  paymasterUsdcPerGas: { status: "ok" | "error"; value?: MetricValue; error?: string };
  paymasterAmplifierBps: { status: "ok" | "error"; value?: MetricValue; error?: string };
  paymasterServiceFeeBps: { status: "ok" | "error"; value?: MetricValue; error?: string };
}

function weiToMetric(wei: bigint, symbol = "MATIC", address?: string): MetricValue {
  const formatted = Number(wei) / 1e18;
  return {
    raw: wei.toString(),
    formatted: formatted.toFixed(7),
    unit: "wei",
    formattedUnit: symbol,
    address,
  };
}

function usdcE6ToMetric(e6: bigint, address?: string): MetricValue {
  const formatted = Number(e6) / 1_000_000;
  return {
    raw: e6.toString(),
    formatted: formatted.toFixed(7),
    unit: "usdc_e6",
    formattedUnit: "USDC",
    address,
  };
}

/** Export for unit tests. */
export function gasUnitsToMetricValue(gasUnits: bigint): MetricValue {
  return {
    raw: gasUnits.toString(),
    formatted: gasUnits.toLocaleString("en-US"),
    unit: "gas",
  };
}

/** USDC (e6) per gas unit — export for unit tests. */
export function usdcPerGasE6ToMetricValue(e6: bigint): MetricValue {
  const n = Number(e6) / 1_000_000;
  let formatted: string;
  if (!Number.isFinite(n)) formatted = "0";
  else if (n === 0) formatted = "0";
  else if (Math.abs(n) < 1e-8) formatted = n.toExponential(4);
  else formatted = n.toFixed(10);

  return {
    raw: e6.toString(),
    formatted,
    unit: "usdc_e6_per_gas",
    formattedUnit: "USDC/gas",
  };
}

/**
 * Runtime USDC (micro) per gas unit from effective USDC-per-wei and RPC gas price.
 * Matches `baseChargeUsdcE6 ≈ (gasUsed * gasPrice * usdcPerWeiE6) / 1e18` at snapshot gas price.
 */
export function deriveRuntimeUsdcPerGasE6(usdcPerWeiE6: bigint, gasPriceWei: bigint): bigint {
  if (gasPriceWei <= 0n) return 0n;
  return (usdcPerWeiE6 * gasPriceWei) / 10n ** 18n;
}

/** Basis points as percent — export for unit tests. */
export function bpsToMetricValue(bps: bigint): MetricValue {
  return {
    raw: bps.toString(),
    formatted: (Number(bps) / 100).toFixed(2),
    unit: "bps",
    formattedUnit: "%",
  };
}

async function readPaymasterApiPricingFromRedis(): Promise<
  | { ok: true; raw: Record<string, string> }
  | { ok: false; error: string }
> {
  try {
    const redis = getRedis();
    const hashKey = key(configHashKey("paymaster-api"));
    const raw = await redis.hgetall(hashKey);
    return { ok: true, raw: raw as Record<string, string> };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Map paymaster API /gas-price response to metrics gasPriceWei field.
 * Export for unit testing.
 */
export function mapGasPriceApiResponse(
  ok: boolean,
  json: { gasPriceWei?: string; source?: string } | null
): MetricsPayload["gasPriceWei"] {
  if (!ok) return { status: "error", error: "API request failed" };
  if (json == null) return { status: "error", error: "Empty response" };
  const wei = json.gasPriceWei != null ? BigInt(json.gasPriceWei) : 0n;
  const gwei = Number(wei) / 1e9;
  return {
    status: "ok",
    value: {
      raw: wei.toString(),
      formatted: gwei.toFixed(2),
      unit: "wei",
      formattedUnit: "gwei",
    },
    source: "rpc",
  };
}

export async function collectMetrics(): Promise<MetricsPayload> {
  let cfg: Awaited<ReturnType<typeof loadDashboardRedisConfig>>;
  try {
    cfg = await loadDashboardRedisConfig();
  } catch (e) {
    const msg = (e as Error).message;
    const pricingErr = { status: "error" as const, error: msg };
    return {
      paymasterAddress: { status: "error", error: msg },
      entryPointDeposit: { status: "error", error: msg },
      paymasterContractNativeReserve: { status: "error", error: msg },
      paymasterContractUsdcReserve: { status: "error", error: msg },
      refillOwnerNativeBalance: { status: "error", error: msg },
      refillOwnerUsdcBalance: { status: "error", error: msg },
      bundlerUtilityBalance: { status: "error", error: msg },
      bundlerExecutorBalances: { status: "error", items: [], error: msg },
      health: { paymasterApi: "error", bundler: "error" },
      gasPriceWei: { status: "error", error: msg },
      paymasterGasUnitsProcessed: pricingErr,
      paymasterGasBoughtWei: pricingErr,
      paymasterUsdcSpentForGasE6: pricingErr,
      paymasterUsdcPerGas: pricingErr,
      paymasterAmplifierBps: pricingErr,
      paymasterServiceFeeBps: pricingErr,
    };
  }

  const ENTRYPOINT_ADDRESS = cfg.DASHBOARD_ENTRYPOINT_ADDRESS.toLowerCase();
  const RPC_URL = cfg.DASHBOARD_RPC_URL;
  const PAYMASTER_API_URL = cfg.PAYMASTER_API_URL;
  const BUNDLER_URL = cfg.DASHBOARD_BUNDLER_URL;
  const USDC_ADDRESS = cfg.DASHBOARD_USDC_ADDRESS.toLowerCase();

  let pricingCounters: {
    gasUnitsProcessed: bigint;
    usdcSpentForGasE6: bigint;
    gasBoughtWei: bigint;
  } | null = null;
  /** From Redis `PAYMASTER_API_FALLBACK_USDC_PER_GAS_UNIT_E6` when available; else default 50. */
  let fallbackUsdcPerGasUnitE6 = 50n;

  const payload: MetricsPayload = {
    paymasterAddress: { status: "error", error: "not fetched" },
    entryPointDeposit: { status: "error", error: "not fetched" },
    paymasterContractNativeReserve: { status: "error", error: "not set" },
    paymasterContractUsdcReserve: { status: "error", error: "not set" },
    refillOwnerNativeBalance: { status: "error", error: "not set" },
    refillOwnerUsdcBalance: { status: "error", error: "not set" },
    bundlerUtilityBalance: { status: "error", error: "not set" },
    bundlerExecutorBalances: { status: "error", items: [], error: "not set" },
    health: { paymasterApi: "error", bundler: "error" },
    gasPriceWei: { status: "error", error: "not fetched" },
    paymasterGasUnitsProcessed: { status: "error", error: "not fetched" },
    paymasterGasBoughtWei: { status: "error", error: "not fetched" },
    paymasterUsdcSpentForGasE6: { status: "error", error: "not fetched" },
    paymasterUsdcPerGas: { status: "error", error: "not fetched" },
    paymasterAmplifierBps: { status: "error", error: "not fetched" },
    paymasterServiceFeeBps: { status: "error", error: "not fetched" },
  };

  // Paymaster address: env override > Redis PAYMASTER_ADDRESS > file > fetch from API (for local dev)
  if (PAYMASTER_ADDRESS_ENV) {
    payload.paymasterAddress = { status: "ok", value: PAYMASTER_ADDRESS_ENV };
  } else if (cfg.PAYMASTER_ADDRESS?.trim()) {
    payload.paymasterAddress = { status: "ok", value: cfg.PAYMASTER_ADDRESS.trim().toLowerCase() };
  } else if (PAYMASTER_ADDRESS_FILE) {
    try {
      const raw = (await readFile(PAYMASTER_ADDRESS_FILE, "utf8")).trim().toLowerCase();
      payload.paymasterAddress = { status: "ok", value: raw || undefined };
      if (!raw) payload.paymasterAddress = { status: "error", error: "File empty" };
    } catch (e) {
      // Fallback: fetch from paymaster API (e.g. when running outside Docker)
      if (PAYMASTER_API_URL) {
        try {
          const res = await fetch(`${PAYMASTER_API_URL.replace(/\/$/, "")}/paymaster-address`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const json = (await res.json()) as { paymasterAddress?: string };
            const addr = (json.paymasterAddress || "").trim().toLowerCase();
            if (addr) payload.paymasterAddress = { status: "ok", value: addr };
            else payload.paymasterAddress = { status: "error", error: "API returned no address" };
          } else {
            payload.paymasterAddress = { status: "error", error: `Paymaster file unreadable and API failed: ${res.status}` };
          }
        } catch (apiErr) {
          payload.paymasterAddress = { status: "error", error: `File: ${(e as Error).message}; API: ${(apiErr as Error).message}` };
        }
      } else {
        payload.paymasterAddress = { status: "error", error: (e as Error).message };
      }
    }
  } else {
    payload.paymasterAddress = { status: "error", error: "PAYMASTER_ADDRESS, CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE, or PAYMASTER_API_URL required (set in .env)" };
  }

  const rpcMissing = "RPC_URL required (set in .env)";
  if (!RPC_URL) {
    payload.entryPointDeposit = { status: "error", error: rpcMissing };
    payload.paymasterContractNativeReserve = { status: "error", error: rpcMissing };
    payload.paymasterContractUsdcReserve = { status: "error", error: rpcMissing };
    payload.refillOwnerNativeBalance = { status: "error", error: rpcMissing };
    payload.refillOwnerUsdcBalance = { status: "error", error: rpcMissing };
    const rpcErr = { status: "error" as const, error: rpcMissing };
    payload.paymasterGasUnitsProcessed = rpcErr;
    payload.paymasterGasBoughtWei = rpcErr;
    payload.paymasterUsdcSpentForGasE6 = rpcErr;
    payload.paymasterUsdcPerGas = rpcErr;
    payload.paymasterAmplifierBps = rpcErr;
    payload.paymasterServiceFeeBps = rpcErr;
  } else {
  const client = createPublicClient({
    chain: polygon,
    transport: viemHttp(RPC_URL),
  });

  // EntryPoint deposit (needs paymaster address)
  if (payload.paymasterAddress.status === "ok" && payload.paymasterAddress.value) {
    try {
      const balance = (await client.readContract({
        address: ENTRYPOINT_ADDRESS as `0x${string}`,
        abi: ENTRYPOINT_ABI,
        functionName: "balanceOf",
        args: [payload.paymasterAddress.value as `0x${string}`],
      })) as bigint;
      payload.entryPointDeposit = {
        status: "ok",
        value: weiToMetric(balance, "MATIC", payload.paymasterAddress.value),
      };
    } catch (e) {
      payload.entryPointDeposit = { status: "error", error: (e as Error).message };
    }
  }

  const pm = payload.paymasterAddress.status === "ok" ? payload.paymasterAddress.value : undefined;
  if (pm) {
    try {
      const balance = await client.getBalance({ address: pm as `0x${string}` });
      payload.paymasterContractNativeReserve = {
        status: "ok",
        value: weiToMetric(balance, "MATIC", pm),
      };
    } catch (e) {
      payload.paymasterContractNativeReserve = { status: "error", error: (e as Error).message };
    }
  } else {
    payload.paymasterContractNativeReserve = {
      status: "error",
      error: "Paymaster address not resolved",
    };
  }

  if (pm && USDC_ADDRESS) {
    try {
      const balance = (await client.readContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [pm as `0x${string}`],
      })) as bigint;
      payload.paymasterContractUsdcReserve = { status: "ok", value: usdcE6ToMetric(balance, pm) };
    } catch (e) {
      payload.paymasterContractUsdcReserve = { status: "error", error: (e as Error).message };
    }
  } else {
    payload.paymasterContractUsdcReserve = {
      status: "error",
      error: pm ? "USDC address missing" : "Paymaster address not resolved",
    };
  }

  if (REFILL_OWNER_KEY) {
    try {
      const account = privateKeyToAccount(REFILL_OWNER_KEY as `0x${string}`);
      const nativeBalance = await client.getBalance({ address: account.address });
      payload.refillOwnerNativeBalance = {
        status: "ok",
        address: account.address,
        value: weiToMetric(nativeBalance, "MATIC", account.address),
      };
      if (USDC_ADDRESS) {
        try {
          const usdcBalance = (await client.readContract({
            address: USDC_ADDRESS as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [account.address],
          })) as bigint;
          payload.refillOwnerUsdcBalance = {
            status: "ok",
            address: account.address,
            value: usdcE6ToMetric(usdcBalance, account.address),
          };
        } catch (e) {
          payload.refillOwnerUsdcBalance = { status: "error", error: (e as Error).message };
        }
      } else {
        payload.refillOwnerUsdcBalance = { status: "error", error: "USDC address missing" };
      }
    } catch (e) {
      const msg = (e as Error).message;
      payload.refillOwnerNativeBalance = { status: "error", error: msg };
      payload.refillOwnerUsdcBalance = { status: "error", error: msg };
    }
  } else {
    payload.refillOwnerNativeBalance = { status: "error", error: "DASHBOARD_REFILL_OWNER_KEY not configured" };
    payload.refillOwnerUsdcBalance = { status: "error", error: "DASHBOARD_REFILL_OWNER_KEY not configured" };
  }

  // Bundler utility balance (derive address from ALTO_UTILITY_PRIVATE_KEY) — display in ETH
  if (ALTO_UTILITY_KEY) {
    try {
      const account = privateKeyToAccount(ALTO_UTILITY_KEY as `0x${string}`);
      const balance = await client.getBalance({ address: account.address });
      payload.bundlerUtilityBalance = {
        status: "ok",
        address: account.address,
        value: weiToMetric(balance, "ETH", account.address),
      };
    } catch (e) {
      payload.bundlerUtilityBalance = { status: "error", error: (e as Error).message };
    }
  }

  // Bundler executor balances (derive addresses from ALTO_EXECUTOR_PRIVATE_KEYS) — display in ETH
  if (ALTO_EXECUTOR_KEYS.length > 0) {
    try {
      const items: { address: string; value: MetricValue }[] = [];
      for (const pk of ALTO_EXECUTOR_KEYS) {
        const account = privateKeyToAccount(pk as `0x${string}`);
        const balance = await client.getBalance({ address: account.address });
        items.push({ address: account.address, value: weiToMetric(balance, "ETH", account.address) });
      }
      payload.bundlerExecutorBalances = { status: "ok", items };
    } catch (e) {
      payload.bundlerExecutorBalances = { status: "error", items: [], error: (e as Error).message };
    }
  }

  if (pm) {
    try {
      const c = await client.readContract({
        address: pm as `0x${string}`,
        abi: PAYMASTER_PRICING_COUNTERS_ABI,
        functionName: "getPricingCounters",
      });
      const [gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei] = c as [bigint, bigint, bigint];
      pricingCounters = { gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei };
      payload.paymasterGasUnitsProcessed = {
        status: "ok",
        value: gasUnitsToMetricValue(gasUnitsProcessed),
      };
      payload.paymasterGasBoughtWei = {
        status: "ok",
        value: weiToMetric(gasBoughtWei, "MATIC", pm),
      };
      payload.paymasterUsdcSpentForGasE6 = {
        status: "ok",
        value: usdcE6ToMetric(usdcSpentForGasE6, pm),
      };
    } catch (e) {
      const msg = (e as Error).message;
      payload.paymasterGasUnitsProcessed = { status: "error", error: msg };
      payload.paymasterGasBoughtWei = { status: "error", error: msg };
      payload.paymasterUsdcSpentForGasE6 = { status: "error", error: msg };
    }
  } else {
    const msg = "Paymaster address not resolved";
    payload.paymasterGasUnitsProcessed = { status: "error", error: msg };
    payload.paymasterGasBoughtWei = { status: "error", error: msg };
    payload.paymasterUsdcSpentForGasE6 = { status: "error", error: msg };
  }

  const redisPricing = await readPaymasterApiPricingFromRedis();
  if (!redisPricing.ok) {
    const msg = redisPricing.error;
    payload.paymasterAmplifierBps = { status: "error", error: msg };
    payload.paymasterServiceFeeBps = { status: "error", error: msg };
  } else {
    const r = redisPricing.raw;
    const amplifierBps = BigInt((r.PAYMASTER_API_PRICING_AMPLIFIER_BPS ?? "").trim() || "10000");
    fallbackUsdcPerGasUnitE6 = BigInt((r.PAYMASTER_API_FALLBACK_USDC_PER_GAS_UNIT_E6 ?? "").trim() || "50");
    const serviceFeeRaw = (r.PAYMASTER_API_SERVICE_FEE_BPS ?? "").trim();

    payload.paymasterAmplifierBps = { status: "ok", value: bpsToMetricValue(amplifierBps) };

    if (!serviceFeeRaw) {
      payload.paymasterServiceFeeBps = {
        status: "error",
        error: "PAYMASTER_API_SERVICE_FEE_BPS missing in Redis",
      };
    } else {
      const serviceFeeBps = BigInt(serviceFeeRaw);
      payload.paymasterServiceFeeBps = { status: "ok", value: bpsToMetricValue(serviceFeeBps) };
    }
  }
  }

  // Gas price from paymaster API (chain RPC)
  if (PAYMASTER_API_URL) {
    try {
      const res = await fetch(`${PAYMASTER_API_URL.replace(/\/$/, "")}/gas-price`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const json = (await res.json()) as { gasPriceWei?: string; source?: string };
        payload.gasPriceWei = mapGasPriceApiResponse(true, json);
      } else {
        payload.gasPriceWei = { status: "error", error: `API ${res.status}` };
      }
    } catch (e) {
      payload.gasPriceWei = { status: "error", error: (e as Error).message };
    }
  } else {
    payload.gasPriceWei = { status: "error", error: "PAYMASTER_API_URL required" };
  }

  // Runtime USDC/gas: (usdcPerWeiE6 × gasPriceWei) / 1e18 — same basis as sponsor postOp charges.
  if (payload.gasPriceWei.status !== "ok" || !payload.gasPriceWei.value?.raw) {
    payload.paymasterUsdcPerGas = {
      status: "error",
      error: payload.gasPriceWei.error ?? "Gas price unavailable",
    };
  } else if (payload.paymasterAmplifierBps.status !== "ok" || !payload.paymasterAmplifierBps.value) {
    payload.paymasterUsdcPerGas = {
      status: "error",
      error: payload.paymasterAmplifierBps.error ?? "Pricing amplifier unavailable",
    };
  } else if (payload.paymasterServiceFeeBps.status !== "ok" || !payload.paymasterServiceFeeBps.value) {
    payload.paymasterUsdcPerGas = {
      status: "error",
      error: payload.paymasterServiceFeeBps.error ?? "Service fee unavailable",
    };
  } else {
    const amplifierBps = BigInt(payload.paymasterAmplifierBps.value.raw);
    const serviceFeeBps = BigInt(payload.paymasterServiceFeeBps.value.raw);
    const gasPriceWei = BigInt(payload.gasPriceWei.value.raw);

    const c = pricingCounters;
    let usdcPerWeiE6: bigint;
    if (c && c.usdcSpentForGasE6 > 0n && c.gasBoughtWei > 0n) {
      usdcPerWeiE6 = computeUsdcPerWeiE6FromCounters({
        totalUsdcSpentForGasE6: c.usdcSpentForGasE6,
        totalGasBoughtWei: c.gasBoughtWei,
        amplifierBps,
        serviceFeeBps,
        fallbackUsdcPerWeiE6: 1n,
      });
    } else {
      const rawFb =
        gasPriceWei > 0n ? (fallbackUsdcPerGasUnitE6 * 10n ** 18n) / gasPriceWei : 1n;
      usdcPerWeiE6 = computeUsdcPerWeiE6FromCounters({
        totalUsdcSpentForGasE6: 0n,
        totalGasBoughtWei: 0n,
        amplifierBps,
        serviceFeeBps,
        fallbackUsdcPerWeiE6: rawFb > 0n ? rawFb : 1n,
      });
    }

    const usdcPerGasE6 = deriveRuntimeUsdcPerGasE6(usdcPerWeiE6, gasPriceWei);
    payload.paymasterUsdcPerGas = {
      status: "ok",
      value: usdcPerGasE6ToMetricValue(usdcPerGasE6),
    };
  }

  // Health checks
  if (PAYMASTER_API_URL) {
    try {
      const res = await fetch(`${PAYMASTER_API_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
      payload.health.paymasterApi = res.ok ? "ok" : "error";
    } catch {
      /* remain error */
    }
  }
  if (BUNDLER_URL) {
    try {
      const res = await fetch(`${BUNDLER_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
      payload.health.bundler = res.ok ? "ok" : "error";
    } catch {
      /* remain error */
    }
  }

  return payload;
}
