/**
 * One-shot Valkey seed: writes non-secret tier-1 config from process.env into namespaced hashes.
 */
import { Redis } from "ioredis";
import {
  CONFIG_BOOTSTRAP_DONE_KEY,
  CONFIG_BOOTSTRAP_LOCK_KEY,
  type ConfigServiceId,
  configHashKey,
  isSecretEnvKey,
  REDIS_CONFIG_KEYS_BY_SERVICE,
} from "@project4/shared";

function prefixedKey(prefix: string, logicalKey: string): string {
  return `${prefix}${logicalKey}`;
}

/** Build field maps per service from env (hybrid: never secrets). Exported for unit tests. */
export function buildConfigSeedFromEnv(env: NodeJS.ProcessEnv): Record<ConfigServiceId, Record<string, string>> {
  const out = {} as Record<ConfigServiceId, Record<string, string>>;
  for (const service of Object.keys(REDIS_CONFIG_KEYS_BY_SERVICE) as ConfigServiceId[]) {
    out[service] = {};
    for (const envKey of REDIS_CONFIG_KEYS_BY_SERVICE[service]) {
      if (isSecretEnvKey(envKey)) continue;
      const v = env[envKey];
      if (v !== undefined && v !== "") {
        out[service][envKey] = v;
      }
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RunConfigBootstrapOptions {
  /** Override env (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Idempotent bootstrap: if sentinel is set, no-op. Otherwise acquire lock, HSET all hashes, set sentinel, release lock.
 */
export async function runConfigBootstrap(options?: RunConfigBootstrapOptions): Promise<void> {
  const env = options?.env ?? process.env;
  const url = env.VALKEY_URL?.trim();
  const prefix = env.VALKEY_KEY_PREFIX?.trim();
  if (!url) throw new Error("[config-bootstrap] VALKEY_URL is required");
  if (!prefix) throw new Error("[config-bootstrap] VALKEY_KEY_PREFIX is required");

  const client = new Redis(url, { maxRetriesPerRequest: 3 });
  const doneKey = prefixedKey(prefix, CONFIG_BOOTSTRAP_DONE_KEY);
  const lockKey = prefixedKey(prefix, CONFIG_BOOTSTRAP_LOCK_KEY);

  try {
    const done = await client.get(doneKey);
    if (done === "1") {
      return;
    }

    const lockOk = await client.set(lockKey, "1", "EX", 120, "NX");
    if (lockOk !== "OK") {
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const d = await client.get(doneKey);
        if (d === "1") return;
      }
      throw new Error("[config-bootstrap] timed out waiting for another bootstrap to finish");
    }

    try {
      const seed = buildConfigSeedFromEnv(env);
      const multi = client.multi();
      for (const service of Object.keys(seed) as ConfigServiceId[]) {
        const fields = seed[service];
        const logical = configHashKey(service);
        const redisKey = prefixedKey(prefix, logical);
        if (Object.keys(fields).length > 0) {
          multi.hset(redisKey, fields);
        }
      }
      multi.set(doneKey, "1");
      const execResult = await multi.exec();
      if (!execResult) {
        throw new Error("[config-bootstrap] MULTI/EXEC returned no result");
      }
      for (const row of execResult) {
        const err = row[0];
        if (err) throw new Error(`[config-bootstrap] MULTI/EXEC failed: ${String(err)}`);
      }
    } finally {
      await client.del(lockKey);
    }
  } finally {
    await client.quit();
  }
}
