import type { ConfigServiceId } from "./config-constants.js";

/** Normalized dashboard tier-1 config after resolving alias keys (POLL_INTERVAL_MS vs DASHBOARD_POLL_INTERVAL_MS, etc.). */
export interface DashboardRedisConfig {
  DASHBOARD_RPC_URL: string;
  PAYMASTER_API_URL: string;
  DASHBOARD_BUNDLER_URL: string;
  DASHBOARD_ENTRYPOINT_ADDRESS: string;
  /** Legacy optional; fee USDC settles on the paymaster contract after deploy. */
  DASHBOARD_TREASURY_ADDRESS?: string;
  DASHBOARD_USDC_ADDRESS: string;
  DASHBOARD_USEROPS_BLOCK_RANGE: string;
  /** Resolved from DASHBOARD_POLL_INTERVAL_MS or POLL_INTERVAL_MS */
  POLL_INTERVAL_MS: string;
  /** Resolved from DASHBOARD_REFILL_SWAP_USDC_E6 / REFILL_SWAP_USDC_E6 / legacy WORKER_SWAP keys */
  DASHBOARD_REFILL_SWAP_USDC_E6: string;
  DASHBOARD_MIN_ENTRYPOINT_DEPOSIT_WEI: string;
  DASHBOARD_CAP_ENTRYPOINT_BALANCE_WEI: string;
  /** Native watch thresholds for refill-style automation (legacy: MIN_/CAP_WORKER_*). */
  DASHBOARD_MIN_PAYMASTER_NATIVE_WATCH_WEI: string;
  DASHBOARD_CAP_PAYMASTER_NATIVE_WATCH_WEI: string;
  PAYMASTER_CONTRACT_TREASURY_ADDRESS?: string;
  PAYMASTER_ADDRESS?: string;
}

export interface LoadStrictRedisConfigOptions {
  /** Override optional key set (default: OPTIONAL_REDIS_CONFIG_KEYS). */
  optionalKeys?: Set<string>;
}

export type { ConfigServiceId };
