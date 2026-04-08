import Redis from "ioredis";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE_NAME = "dashboard_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
const AUTH_NAMESPACE = "dashboard:auth";

type UserRole = "admin" | "viewer";

/** In Redis, value is the password hash only (64-char lowercase SHA256 hex). Legacy JSON blobs are still accepted. */
interface StoredUser {
  username: string;
  passwordHash: string;
  role: UserRole;
}

interface StoredSession {
  username: string;
  role: UserRole;
  expiresAt: number;
}

let redisClient: Redis | null = null;

function getRedisUrl(): string {
  return process.env.VALKEY_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379";
}

function getKeyPrefix(): string {
  return process.env.VALKEY_KEY_PREFIX || process.env.REDIS_KEY_PREFIX || "project4:";
}

function key(name: string): string {
  return `${getKeyPrefix()}${AUTH_NAMESPACE}:${name}`;
}

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(getRedisUrl(), {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 3000);
      },
    });
  }
  return redisClient;
}

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password, "utf8").digest("hex");
}

function hashesEqual(expectedHex: string, givenHex: string): boolean {
  const a = expectedHex.toLowerCase();
  const b = givenHex.toLowerCase();
  if (a.length !== b.length || a.length !== 64) return false;
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function initialAdminPasswordHash(): string {
  const envHash = process.env.DASHBOARD_ADMIN_PASSWORD_HASH?.trim().toLowerCase();
  if (envHash && /^[a-f0-9]{64}$/.test(envHash)) {
    return envHash;
  }
  return hashPassword("user");
}

function sessionKey(token: string): string {
  return key(`session:${token}`);
}

function userKey(username: string): string {
  return key(`user:${username.toLowerCase()}`);
}

export async function ensureDefaultAdminUser(): Promise<void> {
  const redis = getRedis();
  const k = userKey("admin");
  const exists = await redis.exists(k);
  if (exists) return;

  await redis.set(k, initialAdminPasswordHash());
}

function parseStoredCredential(raw: string, username: string): StoredUser | null {
  const normalized = username.toLowerCase();
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<StoredUser>;
      const h = typeof parsed.passwordHash === "string" ? parsed.passwordHash.trim().toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(h)) return null;
      const role: UserRole = parsed.role === "viewer" ? "viewer" : "admin";
      return {
        username: typeof parsed.username === "string" ? parsed.username.toLowerCase() : normalized,
        passwordHash: h,
        role,
      };
    } catch {
      return null;
    }
  }
  const h = trimmed.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(h)) return null;
  const role: UserRole = normalized === "admin" ? "admin" : "viewer";
  return { username: normalized, passwordHash: h, role };
}

async function getStoredUser(username: string): Promise<StoredUser | null> {
  const raw = await getRedis().get(userKey(username));
  if (!raw) return null;
  return parseStoredCredential(raw, username);
}

export async function verifyCredentials(username: string, password: string): Promise<StoredUser | null> {
  await ensureDefaultAdminUser();
  const user = await getStoredUser(username);
  if (!user) return null;
  const given = hashPassword(password);
  return hashesEqual(user.passwordHash, given) ? user : null;
}

export async function createSession(user: Pick<StoredUser, "username" | "role">): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const session: StoredSession = {
    username: user.username,
    role: user.role,
    expiresAt,
  };
  await getRedis().set(sessionKey(token), JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
  return token;
}

export async function getSession(token: string): Promise<StoredSession | null> {
  if (!token) return null;
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.expiresAt || parsed.expiresAt <= Date.now()) {
      await getRedis().del(sessionKey(token));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearSession(token: string): Promise<void> {
  if (!token) return;
  await getRedis().del(sessionKey(token));
}

export async function getSessionFromRequest(req: NextRequest): Promise<StoredSession | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value || "";
  if (!token) return null;
  return getSession(token);
}

