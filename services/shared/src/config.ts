/**
 * Strict Redis-backed tier-1 configuration loaders (hybrid: secrets remain in env).
 */
import { configHashKey, type ConfigServiceId } from "./config-constants.js";
import {
  isSecretEnvKey,
  OPTIONAL_REDIS_CONFIG_KEYS,
  REDIS_CONFIG_KEYS_BY_SERVICE,
} from "./config-manifest.js";
import type { DashboardRedisConfig, LoadStrictRedisConfigOptions } from "./config-types.js";
import { getRedis, key } from "./redis.js";

export type { DashboardRedisConfig, LoadStrictRedisConfigOptions } from "./config-types.js";

/** First non-empty value among ordered candidate keys. */
export function pickFirst(raw: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = raw[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Load all non-secret keys for a service from Redis hash `config:<service>`.
 * Missing required keys throw. Optional keys (see manifest) may be absent.
 */
export async function loadStrictRedisConfig(
  service: ConfigServiceId,
  options?: LoadStrictRedisConfigOptions
): Promise<Record<string, string>> {
  if (service === "shared") {
    return {};
  }

  const optional = options?.optionalKeys ?? OPTIONAL_REDIS_CONFIG_KEYS;
  const redis = getRedis();
  const hashLogical = configHashKey(service);
  const raw = await redis.hgetall(key(hashLogical));
  const expected = REDIS_CONFIG_KEYS_BY_SERVICE[service];
  const out: Record<string, string> = {};

  for (const envKey of expected) {
    if (isSecretEnvKey(envKey)) continue;
    const v = raw[envKey];
    if (v === undefined || v === "") {
      if (optional.has(envKey)) continue;
      throw new Error(`[config] Missing Redis config key ${service}/${envKey} (bootstrap seed or VALKEY)`);
    }
    out[envKey] = v;
  }
  return out;
}

/**
 * Dashboard: read hash `config:dashboard`; resolve alias pairs (POLL_INTERVAL_MS vs DASHBOARD_POLL_INTERVAL_MS, etc.).
 */
export async function loadDashboardRedisConfig(): Promise<DashboardRedisConfig> {
  const redis = getRedis();
  const raw = await redis.hgetall(key(configHashKey("dashboard")));
  const poll = pickFirst(raw, "DASHBOARD_POLL_INTERVAL_MS", "POLL_INTERVAL_MS");
  const swap = pickFirst(
    raw,
    "DASHBOARD_REFILL_SWAP_USDC_E6",
    "REFILL_SWAP_USDC_E6",
    "DASHBOARD_WORKER_SWAP_USDC_E6",
    "WORKER_SWAP_USDC_E6"
  );
  const minEp = pickFirst(raw, "DASHBOARD_MIN_ENTRYPOINT_DEPOSIT_WEI", "MIN_ENTRYPOINT_DEPOSIT_WEI");
  const capEp = pickFirst(raw, "DASHBOARD_CAP_ENTRYPOINT_BALANCE_WEI", "CAP_ENTRYPOINT_BALANCE_WEI");
  const minW = pickFirst(
    raw,
    "DASHBOARD_MIN_PAYMASTER_NATIVE_WATCH_WEI",
    "MIN_PAYMASTER_NATIVE_WATCH_WEI",
    "DASHBOARD_MIN_WORKER_DEPOSIT_WEI",
    "MIN_WORKER_DEPOSIT_WEI"
  );
  const capW = pickFirst(
    raw,
    "DASHBOARD_CAP_PAYMASTER_NATIVE_WATCH_WEI",
    "CAP_PAYMASTER_NATIVE_WATCH_WEI",
    "DASHBOARD_CAP_WORKER_BALANCE_WEI",
    "CAP_WORKER_BALANCE_WEI"
  );

  const requiredSingle: { k: string; v: string | undefined }[] = [
    { k: "DASHBOARD_RPC_URL", v: raw.DASHBOARD_RPC_URL },
    { k: "PAYMASTER_API_URL", v: raw.PAYMASTER_API_URL },
    { k: "DASHBOARD_BUNDLER_URL", v: raw.DASHBOARD_BUNDLER_URL },
    { k: "DASHBOARD_ENTRYPOINT_ADDRESS", v: raw.DASHBOARD_ENTRYPOINT_ADDRESS },
    { k: "DASHBOARD_USDC_ADDRESS", v: raw.DASHBOARD_USDC_ADDRESS },
    { k: "DASHBOARD_USEROPS_BLOCK_RANGE", v: raw.DASHBOARD_USEROPS_BLOCK_RANGE },
  ];
  for (const { k, v } of requiredSingle) {
    if (!v) throw new Error(`[config] Missing Redis dashboard/${k}`);
  }
  if (!poll) throw new Error("[config] Missing Redis dashboard/DASHBOARD_POLL_INTERVAL_MS or POLL_INTERVAL_MS");
  if (!swap) {
    throw new Error(
      "[config] Missing Redis dashboard refill swap USDC key (DASHBOARD_REFILL_SWAP_USDC_E6 / REFILL_SWAP_USDC_E6 or legacy WORKER_SWAP_USDC_E6)"
    );
  }
  if (!minEp || !capEp || !minW || !capW) {
    throw new Error(
      "[config] Missing Redis dashboard min/cap wei keys (entrypoint + paymaster native watch, or legacy WORKER names)"
    );
  }

  const treasury = raw.DASHBOARD_TREASURY_ADDRESS?.trim();

  return {
    DASHBOARD_RPC_URL: raw.DASHBOARD_RPC_URL!,
    PAYMASTER_API_URL: raw.PAYMASTER_API_URL!,
    DASHBOARD_BUNDLER_URL: raw.DASHBOARD_BUNDLER_URL!,
    DASHBOARD_ENTRYPOINT_ADDRESS: raw.DASHBOARD_ENTRYPOINT_ADDRESS!,
    ...(treasury ? { DASHBOARD_TREASURY_ADDRESS: treasury } : {}),
    DASHBOARD_USDC_ADDRESS: raw.DASHBOARD_USDC_ADDRESS!,
    DASHBOARD_USEROPS_BLOCK_RANGE: raw.DASHBOARD_USEROPS_BLOCK_RANGE!,
    POLL_INTERVAL_MS: poll,
    DASHBOARD_REFILL_SWAP_USDC_E6: swap,
    DASHBOARD_MIN_ENTRYPOINT_DEPOSIT_WEI: minEp,
    DASHBOARD_CAP_ENTRYPOINT_BALANCE_WEI: capEp,
    DASHBOARD_MIN_PAYMASTER_NATIVE_WATCH_WEI: minW,
    DASHBOARD_CAP_PAYMASTER_NATIVE_WATCH_WEI: capW,
    PAYMASTER_CONTRACT_TREASURY_ADDRESS: raw.PAYMASTER_CONTRACT_TREASURY_ADDRESS,
    PAYMASTER_ADDRESS: raw.PAYMASTER_ADDRESS,
  };
}
