/**
 * One-off: Polygon mainnet native balance for Alto utility + executor EOAs (from .env keys).
 * Run from repo root: npx tsx integrated-tests/scripts/check-alto-balances-polygon.mts
 */
import { config } from "dotenv";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createPublicClient, formatEther, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
config({ path: join(root, ".env") });

function asHexKey(pk: string): `0x${string}` {
  const t = pk.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as `0x${string}`;
}

/** Use PRODUCTION_RPC_URL for Polygon mainnet; public fallback if unset. */
const rpcUrl =
  process.env.PRODUCTION_RPC_URL?.trim() ||
  "https://polygon-bor-rpc.publicnode.com";

const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

const rows: { label: string; address: `0x${string}` }[] = [];
const u = process.env.ALTO_UTILITY_PRIVATE_KEY?.trim();
if (u) {
  rows.push({ label: "ALTO utility", address: privateKeyToAccount(asHexKey(u)).address });
}
const executors = process.env.ALTO_EXECUTOR_PRIVATE_KEYS?.split(",") ?? [];
executors.forEach((k, i) => {
  const t = k.trim();
  if (t) rows.push({ label: `executor ${i}`, address: privateKeyToAccount(asHexKey(t)).address });
});

console.log("Chain: Polygon (137)");
console.log("RPC:", rpcUrl);
if (rows.length === 0) {
  console.log("No ALTO_UTILITY_PRIVATE_KEY / ALTO_EXECUTOR_PRIVATE_KEYS in .env");
  process.exit(1);
}
for (const r of rows) {
  const wei = await client.getBalance({ address: r.address });
  console.log(`${r.label}: ${r.address}  ${formatEther(wei)} POL`);
}
