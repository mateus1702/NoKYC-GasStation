#!/usr/bin/env node
/**
 * Prepares .env.local for dashboard when running outside Docker.
 * Reads project .env and substitutes Docker hostnames for localhost.
 * Usage: node scripts/prepare-dashboard-env.mjs (from project root)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const outPath = join(root, "services", "dashboard", ".env.local");

const HOST_REPLACEMENTS = [
  ["anvil:8545", "127.0.0.1:8545"],
  ["paymaster-api:3000", "127.0.0.1:3000"],
  ["bundler-alto:4337", "127.0.0.1:4337"],
  ["valkey:6379", "127.0.0.1:6379"],
  ["redis:6379", "127.0.0.1:6379"],
];

if (!existsSync(envPath)) {
  console.error("[prepare-dashboard-env] .env not found at", envPath);
  console.error("Run: cp .env.example .env");
  process.exit(1);
}

let content = readFileSync(envPath, "utf8");
for (const [from, to] of HOST_REPLACEMENTS) {
  content = content.replaceAll(from, to);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, "utf8");
console.log("[prepare-dashboard-env] Wrote", outPath);
