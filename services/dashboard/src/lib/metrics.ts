/**
 * Server-side metrics aggregation for Project4 AA dashboard.
 * Reads Redis, RPC, health endpoints. Fail-soft per section.
 */
import { readFile } from "node:fs/promises";
import Redis from "ioredis";
import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const ENTRYPOINT_ADDRESS = process.env.DASHBOARD_ENTRYPOINT_ADDRESS!.toLowerCase();
const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE!;
const PAYMASTER_ADDRESS_ENV = (process.env.PAYMASTER_ADDRESS || "").trim().toLowerCase();
const TREASURY_ADDRESS = process.env.DASHBOARD_TREASURY_ADDRESS!.toLowerCase();
const RPC_URL = process.env.DASHBOARD_RPC_URL!;
const VALKEY_URL = process.env.VALKEY_URL!;
const VALKEY_KEY_PREFIX = process.env.VALKEY_KEY_PREFIX!;
const PAYMASTER_API_URL = process.env.PAYMASTER_API_URL!;
const BUNDLER_URL = process.env.DASHBOARD_BUNDLER_URL!;
const USDC_ADDRESS = process.env.DASHBOARD_USDC_ADDRESS!.toLowerCase();
const ALTO_UTILITY_KEY = process.env.DASHBOARD_ALTO_UTILITY_KEY!.trim();
const ALTO_EXECUTOR_KEYS = process.env.DASHBOARD_ALTO_EXECUTOR_KEYS!.split(",").map((k) => k.trim()).filter(Boolean);

const PRICING_SPENT = `${VALKEY_KEY_PREFIX}pricing:total_usdc_spent_e6`;
const PRICING_GAS = `${VALKEY_KEY_PREFIX}pricing:total_gas_returned_wei`;
const INV_ETH = `${VALKEY_KEY_PREFIX}inv:eth_wei`;
const INV_COST = `${VALKEY_KEY_PREFIX}inv:cost_usdc_e6`;

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

export interface MetricValue {
  raw: string;
  formatted: string;
  unit: string;
  formattedUnit?: string;
}

export interface MetricsPayload {
  paymasterAddress: { status: "ok" | "error"; value?: string; error?: string };
  entryPointDeposit: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  workerNativeReserve: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  workerUsdcReserve: {
    status: "ok" | "error";
    value?: MetricValue;
    error?: string;
  };
  pricing: {
    status: "ok" | "error";
    totalUsdcSpentE6?: MetricValue;
    totalGasReturnedWei?: MetricValue;
    unitCostUsdcPerWei?: MetricValue;
    usdcPer1MGas?: MetricValue;
    error?: string;
  };
  workerConfig: {
    status: "ok";
    pollIntervalMs: number;
    swapUsdcE6: MetricValue;
    minEntryPointWei: MetricValue;
    capEntryPointWei: MetricValue;
    minWorkerWei: MetricValue;
    capWorkerWei: MetricValue;
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
    redis: "ok" | "error";
  };
}

function weiToMetric(wei: bigint, symbol = "MATIC"): MetricValue {
  const formatted = Number(wei) / 1e18;
  return {
    raw: wei.toString(),
    formatted: formatted >= 1 ? formatted.toFixed(4) : formatted.toFixed(6),
    unit: "wei",
    formattedUnit: symbol,
  };
}

function usdcE6ToMetric(e6: bigint): MetricValue {
  const formatted = Number(e6) / 1_000_000;
  return {
    raw: e6.toString(),
    formatted: formatted >= 1 ? formatted.toFixed(2) : formatted.toFixed(6),
    unit: "usdc_e6",
    formattedUnit: "USDC",
  };
}

/** For unit cost: raw is usdc_e6*1e18/eth_wei; formatted = raw/1e6 = USDC per 1 ETH */
function unitCostToMetric(v: bigint): MetricValue {
  const formatted = Number(v) / 1e6;
  return {
    raw: v.toString(),
    formatted: formatted >= 1 ? formatted.toFixed(2) : formatted.toFixed(6),
    unit: "usdc_e6*1e18/wei",
    formattedUnit: "USDC/ETH",
  };
}

function key(name: string): string {
  return `${VALKEY_KEY_PREFIX}${name}`;
}

export async function collectMetrics(): Promise<MetricsPayload> {
  const payload: MetricsPayload = {
    paymasterAddress: { status: "error", error: "not fetched" },
    entryPointDeposit: { status: "error", error: "not fetched" },
    workerNativeReserve: { status: "error", error: "not set" },
    workerUsdcReserve: { status: "error", error: "not set" },
    pricing: { status: "error", error: "not fetched" },
    workerConfig: {
      status: "ok",
      pollIntervalMs: Number(process.env.DASHBOARD_POLL_INTERVAL_MS || "0"),
      swapUsdcE6: usdcE6ToMetric(BigInt(process.env.DASHBOARD_WORKER_SWAP_USDC_E6 || "0")),
      minEntryPointWei: weiToMetric(BigInt(process.env.DASHBOARD_MIN_ENTRYPOINT_DEPOSIT_WEI || "0")),
      capEntryPointWei: weiToMetric(BigInt(process.env.DASHBOARD_CAP_ENTRYPOINT_BALANCE_WEI || "0")),
      minWorkerWei: weiToMetric(BigInt(process.env.DASHBOARD_MIN_WORKER_DEPOSIT_WEI || "0")),
      capWorkerWei: weiToMetric(BigInt(process.env.DASHBOARD_CAP_WORKER_BALANCE_WEI || "0")),
    },
    bundlerUtilityBalance: { status: "error", error: "not set" },
    bundlerExecutorBalances: { status: "error", items: [], error: "not set" },
    health: { paymasterApi: "error", bundler: "error", redis: "error" },
  };

  // Paymaster address: env override > file > fetch from API (for local dev)
  if (PAYMASTER_ADDRESS_ENV) {
    payload.paymasterAddress = { status: "ok", value: PAYMASTER_ADDRESS_ENV };
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

  if (!RPC_URL) {
    payload.entryPointDeposit = { status: "error", error: "RPC_URL required (set in .env)" };
    payload.workerNativeReserve = { status: "error", error: "RPC_URL required (set in .env)" };
    payload.workerUsdcReserve = { status: "error", error: "RPC_URL required (set in .env)" };
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
        value: weiToMetric(balance),
      };
    } catch (e) {
      payload.entryPointDeposit = { status: "error", error: (e as Error).message };
    }
  }

  // Worker native reserve (needs TREASURY_ADDRESS)
  if (TREASURY_ADDRESS) {
    try {
      const balance = await client.getBalance({ address: TREASURY_ADDRESS as `0x${string}` });
      payload.workerNativeReserve = { status: "ok", value: weiToMetric(balance) };
    } catch (e) {
      payload.workerNativeReserve = { status: "error", error: (e as Error).message };
    }
  }

  // Worker USDC reserve (needs TREASURY_ADDRESS and USDC_ADDRESS)
  if (TREASURY_ADDRESS && USDC_ADDRESS) {
    try {
      const balance = (await client.readContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [TREASURY_ADDRESS as `0x${string}`],
      })) as bigint;
      payload.workerUsdcReserve = { status: "ok", value: usdcE6ToMetric(balance) };
    } catch (e) {
      payload.workerUsdcReserve = { status: "error", error: (e as Error).message };
    }
  }

  // Bundler utility balance (derive address from ALTO_UTILITY_PRIVATE_KEY) — display in ETH
  if (ALTO_UTILITY_KEY) {
    try {
      const account = privateKeyToAccount(ALTO_UTILITY_KEY as `0x${string}`);
      const balance = await client.getBalance({ address: account.address });
      payload.bundlerUtilityBalance = {
        status: "ok",
        address: account.address,
        value: weiToMetric(balance, "ETH"),
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
        items.push({ address: account.address, value: weiToMetric(balance, "ETH") });
      }
      payload.bundlerExecutorBalances = { status: "ok", items };
    } catch (e) {
      payload.bundlerExecutorBalances = { status: "error", items: [], error: (e as Error).message };
    }
  }
  }

  // Redis pricing totals (new keys first, fallback to legacy)
  if (!VALKEY_URL) {
    payload.pricing = { status: "error", error: "VALKEY_URL required (set in .env)" };
  } else try {
    const redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    const spentStr = await redis.get(key(PRICING_SPENT));
    const gasStr = await redis.get(key(PRICING_GAS));
    let totalUsdcSpentE6 = spentStr ? BigInt(spentStr) : 0n;
    let totalGasReturnedWei = gasStr ? BigInt(gasStr) : 0n;
    if (totalUsdcSpentE6 === 0n || totalGasReturnedWei === 0n) {
      const ethStr = await redis.get(key(INV_ETH));
      const costStr = await redis.get(key(INV_COST));
      totalUsdcSpentE6 = costStr ? BigInt(costStr) : totalUsdcSpentE6;
      totalGasReturnedWei = ethStr ? BigInt(ethStr) : totalGasReturnedWei;
    }
    redis.quit();

    const unitCostUsdcPerWei = totalGasReturnedWei > 0n ? (totalUsdcSpentE6 * 10n ** 18n) / totalGasReturnedWei : 0n;
    const usdcPer1MGas = unitCostUsdcPerWei > 0n ? (unitCostUsdcPerWei * 1_000_000n) / 10n ** 18n : 0n;

    payload.pricing = {
      status: "ok",
      totalUsdcSpentE6: usdcE6ToMetric(totalUsdcSpentE6),
      totalGasReturnedWei: weiToMetric(totalGasReturnedWei),
      unitCostUsdcPerWei: unitCostToMetric(unitCostUsdcPerWei),
      usdcPer1MGas: usdcE6ToMetric(usdcPer1MGas),
    };
    payload.health.redis = "ok";
  } catch (e) {
    payload.pricing = { status: "error", error: (e as Error).message };
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
  if (payload.health.redis === "error" && VALKEY_URL) {
    try {
      const redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
      await redis.ping();
      redis.quit();
      payload.health.redis = "ok";
    } catch {
      /* remain error */
    }
  }

  return payload;
}
