/**
 * Redis client for shared inventory state (Valkey-compatible)
 */
import { Redis } from "ioredis";

let client: Redis | null = null;

const VALKEY_URL = process.env.VALKEY_URL!;
const VALKEY_KEY_PREFIX = process.env.VALKEY_KEY_PREFIX!;

function createClient() {
  return new Redis(VALKEY_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 5) return null;
      return Math.min(times * 200, 3000);
    },
  });
}

export function getRedis(): ReturnType<typeof createClient> {
  if (!client) client = createClient();
  return client;
}

export function key(name: string): string {
  return `${VALKEY_KEY_PREFIX}${name}`;
}

export async function get(keyName: string): Promise<string | null> {
  const k = key(keyName);
  return getRedis().get(k);
}

export async function set(keyName: string, value: string): Promise<"OK" | null> {
  const k = key(keyName);
  return getRedis().set(k, value) as Promise<"OK" | null>;
}

export async function getNum(keyName: string): Promise<number> {
  const v = await get(keyName);
  if (v == null || v === "") return 0;
  return Number(v);
}

export async function setNum(keyName: string, value: number): Promise<"OK" | null> {
  return set(keyName, String(value));
}

export async function getBigInt(keyName: string): Promise<bigint> {
  const v = await get(keyName);
  if (v == null || v === "") return 0n;
  return BigInt(v);
}

export async function setBigInt(keyName: string, value: bigint): Promise<"OK" | null> {
  return set(keyName, value.toString());
}

/** Execute a Lua script atomically. Keys and args are passed through as-is; use key() for key names. */
export async function evalScript(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown> {
  return getRedis().eval(script, numKeys, ...keysAndArgs);
}
