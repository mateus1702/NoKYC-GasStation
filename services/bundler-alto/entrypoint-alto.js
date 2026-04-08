#!/usr/bin/env node
/**
 * Load tier-1 config from Valkey, then generate alto-config.json from env vars, then run Alto.
 * Env: RPC_URL, PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS, ALTO_UTILITY_PRIVATE_KEY, ALTO_EXECUTOR_PRIVATE_KEYS, etc.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadBundlerConfigFromRedis } from "./preload-config.mjs";

await loadBundlerConfigFromRedis();

// Override RPC_URL with service-specific one
if (process.env.ALTO_RPC_URL) {
  process.env.RPC_URL = process.env.ALTO_RPC_URL;
}

if (!process.env.RPC_URL?.trim()) throw new Error("RPC_URL required (set in .env or Redis config:bundler)");
if (!process.env.PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS?.trim()) {
  throw new Error("PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS required (set in .env or Redis config:bundler)");
}
if (!process.env.ALTO_UTILITY_PRIVATE_KEY?.trim()) throw new Error("ALTO_UTILITY_PRIVATE_KEY required (set in .env)");
if (!process.env.ALTO_EXECUTOR_PRIVATE_KEYS?.trim()) throw new Error("ALTO_EXECUTOR_PRIVATE_KEYS required (set in .env)");
const maxBlockRangeRaw = (process.env.ALTO_MAX_BLOCK_RANGE || "").trim();
if (maxBlockRangeRaw && !/^\d+$/.test(maxBlockRangeRaw)) {
  throw new Error("ALTO_MAX_BLOCK_RANGE must be an integer (set in .env)");
}

const config = {
  "network-name": (process.env.ALTO_NETWORK_NAME || "").trim() || "polygon",
  "log-environment": (process.env.ALTO_LOG_ENV || "").trim() || "production",
  entrypoints: process.env.PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS.trim(),
  "api-version": "v1,v2",
  "rpc-url": process.env.RPC_URL.trim(),
  "min-balance": (process.env.ALTO_MIN_BALANCE || "").trim() || "0",
  "utility-private-key": process.env.ALTO_UTILITY_PRIVATE_KEY.trim(),
  "executor-private-keys": process.env.ALTO_EXECUTOR_PRIVATE_KEYS.trim(),
  "max-block-range": Number(maxBlockRangeRaw || "1024"),
  "safe-mode": false,
  port: 4337,
  "log-level": (process.env.ALTO_LOG_LEVEL || "").trim() || "info"
};

const configPath = "/tmp/alto-config.json";
writeFileSync(configPath, JSON.stringify(config));
// Verify parseable (catches env-var injection of invalid chars)
JSON.parse(readFileSync(configPath, "utf8"));

const cliPath = "src/lib/cli/alto.js";
const proc = spawn("node", [cliPath, "run", "--config", configPath], {
  stdio: "inherit",
  cwd: "/app",
});
proc.on("exit", (code) => process.exit(code ?? 0));
