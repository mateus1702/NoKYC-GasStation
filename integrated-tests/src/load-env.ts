/**
 * Load .env before any test runs.
 * Uses project root .env only so integrated tests share the same keys as the running stack.
 * For full-stack tests, start Valkey and run config-bootstrap so tier-1 keys exist under `config:*`
 * (paymaster-api, dashboard, bundler, contract-deployer).
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", "..", ".env") });

// Integrated tests run on host, not inside Docker network.
// Translate common Docker service hostnames to localhost for local execution.
const HOST_REPLACEMENTS: Array<[string, string]> = [
  ["anvil:8545", "127.0.0.1:8545"],
  ["paymaster-api:3000", "127.0.0.1:3000"],
  ["bundler-alto:4337", "127.0.0.1:4337"],
  ["valkey:6379", "127.0.0.1:6379"],
  ["redis:6379", "127.0.0.1:6379"],
];

const URL_ENV_KEYS = [
  "VALKEY_URL",
  "TOOLS_RPC_URL",
  "TOOLS_PAYMASTER_URL",
  "TOOLS_BUNDLER_URL",
  "PAYMASTER_API_URL",
  "DASHBOARD_BUNDLER_URL",
  "DASHBOARD_RPC_URL",
] as const;

for (const key of URL_ENV_KEYS) {
  const current = process.env[key];
  if (!current) continue;
  let next = current;
  for (const [from, to] of HOST_REPLACEMENTS) {
    next = next.replaceAll(from, to);
  }
  process.env[key] = next;
}

// Gas estimation must hit the bundler JSON-RPC on the host-mapped port. Defaulting to
// paymaster-api /bundler/rpc breaks when the API container's upstream BUNDLER_URL is
// http://127.0.0.1:4337 (localhost = container self, not Alto).
if (!process.env.TOOLS_BUNDLER_URL?.trim()) {
  process.env.TOOLS_BUNDLER_URL = "http://127.0.0.1:4337";
}
