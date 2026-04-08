/**
 * Redis-backed app configuration: sentinel keys and hash names.
 * Operational keys (pricing, inventory) use the same VALKEY_KEY_PREFIX; config lives under `config:*`.
 */

export type ConfigServiceId =
  | "paymaster-api"
  | "dashboard"
  | "bundler"
  | "contract-deployer"
  | "shared";

/** Appended to VALKEY_KEY_PREFIX — full key e.g. `project4:config:bootstrap:done` */
export const CONFIG_BOOTSTRAP_DONE_KEY = "config:bootstrap:done";

/** Lock key for atomic bootstrap (SET NX) */
export const CONFIG_BOOTSTRAP_LOCK_KEY = "config:bootstrap:lock";

/** Per-service config hashes: `config:paymaster-api`, `config:dashboard`, etc. */
export function configHashKey(service: ConfigServiceId): string {
  return `config:${service}`;
}
