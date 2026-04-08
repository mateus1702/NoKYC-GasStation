/**
 * Sweep native POL + USDC from all unique private keys listed in .env.prod-style vars to one address.
 * Usage (repo root): npx tsx integrated-tests/scripts/sweep-env-prod-to-address.mts [path/to/env]
 * Default env file: .env.prod
 *
 * Scans: CONTRACT_DEPLOYER_PRIVATE_KEY, ALTO_UTILITY_PRIVATE_KEY, ALTO_EXECUTOR_PRIVATE_KEYS,
 * PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY,
 * DASHBOARD_ALTO_UTILITY_KEY, DASHBOARD_ALTO_EXECUTOR_KEYS
 */
import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const envPath = process.argv[2] ?? join(root, ".env.prod");

config({ path: envPath });

const DEST = (process.argv[3] ?? "0xc0e19f7e14c6a476ff399743ba5cb37069e1b1e3").toLowerCase() as Address;

const KEY_ENV_NAMES = [
  "CONTRACT_DEPLOYER_PRIVATE_KEY",
  "ALTO_UTILITY_PRIVATE_KEY",
  "PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY",
  "DASHBOARD_ALTO_UTILITY_KEY",
] as const;

const CSV_KEY_ENVS = ["ALTO_EXECUTOR_PRIVATE_KEYS", "DASHBOARD_ALTO_EXECUTOR_KEYS"] as const;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

function normalizePk(raw: string): Hex | null {
  const t = raw.trim();
  if (!t || t.startsWith("#")) return null;
  const hex = (t.startsWith("0x") ? t : `0x${t}`) as Hex;
  if (hex.length !== 66) return null;
  return hex;
}

function collectKeys(): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  const add = (raw: string | undefined) => {
    const pk = raw ? normalizePk(raw) : null;
    if (!pk) return;
    const k = pk.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(pk);
  };
  for (const name of KEY_ENV_NAMES) {
    add(process.env[name]);
  }
  for (const name of CSV_KEY_ENVS) {
    const csv = process.env[name];
    if (!csv) continue;
    for (const part of csv.split(",")) add(part);
  }
  return out;
}

async function main() {
  const rpc = process.env.PRODUCTION_RPC_URL?.trim();
  if (!rpc) {
    console.error("PRODUCTION_RPC_URL missing in env file");
    process.exit(1);
  }
  const usdc = process.env.PAYMASTER_CONTRACT_USDC_ADDRESS?.trim() as Address | undefined;
  if (!usdc) {
    console.error("PAYMASTER_CONTRACT_USDC_ADDRESS missing in env file");
    process.exit(1);
  }

  const keys = collectKeys();
  if (keys.length === 0) {
    console.error("No private keys found");
    process.exit(1);
  }

  console.log("Env:", envPath);
  console.log("RPC:", rpc.replace(/\/[a-f0-9]{32,}/i, "/***"));
  console.log("USDC:", usdc);
  console.log("Destination:", DEST);
  console.log("Unique keys:", keys.length);

  const publicClient = createPublicClient({ chain: polygon, transport: http(rpc) });

  for (let i = 0; i < keys.length; i++) {
    const pk = keys[i]!;
    const account = privateKeyToAccount(pk);
    const addr = account.address;
    if (addr.toLowerCase() === DEST) {
      console.log(`\n[${i + 1}] ${addr} skip (is destination)`);
      continue;
    }

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpc),
    });

    console.log(`\n[${i + 1}] ${addr}`);

    const nativeBefore = await publicClient.getBalance({ address: addr });
    const usdcBefore = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    });

    console.log(`  Before: ${formatEther(nativeBefore)} POL, USDC raw ${usdcBefore.toString()} (6 decimals)`);

    if (usdcBefore > 0n) {
      try {
        const gas = await publicClient.estimateContractGas({
          address: usdc,
          abi: erc20Abi,
          functionName: "transfer",
          args: [DEST, usdcBefore],
          account: addr,
        });
        const fees = await publicClient.estimateFeesPerGas();
        const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 50n * 10n ** 9n;
        const need = gas * maxFee;
        if (nativeBefore < need) {
          console.log(`  USDC skip: need ~${formatEther(need)} POL for gas, have ${formatEther(nativeBefore)}`);
        } else {
          const hash = await walletClient.writeContract({
            address: usdc,
            abi: erc20Abi,
            functionName: "transfer",
            args: [DEST, usdcBefore],
            chain: polygon,
          });
          await publicClient.waitForTransactionReceipt({ hash });
          console.log(`  USDC sent, tx ${hash}`);
        }
      } catch (e) {
        console.error(`  USDC transfer failed:`, (e as Error).message);
      }
    }

    const nativeAfter = await publicClient.getBalance({ address: addr });
    const fees2 = await publicClient.estimateFeesPerGas();
    const maxFee2 = fees2.maxFeePerGas ?? fees2.gasPrice ?? 50n * 10n ** 9n;
    const gasNative = 21000n;
    const reserve = (gasNative * maxFee2 * 12n) / 10n; // 20% headroom on fee
    const sendVal = nativeAfter > reserve ? nativeAfter - reserve : 0n;
    if (sendVal <= 0n) {
      console.log(`  POL skip: insufficient for sweep (balance ${formatEther(nativeAfter)})`);
      continue;
    }
    try {
      const hash = await walletClient.sendTransaction({
        chain: polygon,
        to: DEST,
        value: sendVal,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  POL sent ${formatEther(sendVal)}, tx ${hash}`);
    } catch (e) {
      console.error(`  POL send failed:`, (e as Error).message);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
