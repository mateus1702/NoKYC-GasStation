/**
 * Rebuilds the top-of-.env EOA comment block and inline Alto "fund this address" comments
 * from actual private key values.
 * Run: npx tsx integrated-tests/scripts/sync-env-address-comments.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultEnvPath = join(root, ".env");

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function asHexPk(raw: string): Hex | null {
  const t = raw.trim();
  if (!t) return null;
  const h = (t.startsWith("0x") ? t : `0x${t}`) as Hex;
  return h.length === 66 ? h : null;
}

function addr(pk: string | undefined): string | null {
  const h = pk ? asHexPk(pk) : null;
  if (!h) return null;
  try {
    return privateKeyToAccount(h).address;
  } catch {
    return null;
  }
}

/** Rewrite address comments + refill watch + inline Alto fund hints for the given .env path. */
export function syncEnvAddressComments(envPath: string): void {
  const raw = readFileSync(envPath, "utf8");
  const env = parseEnv(raw);

  const signerAddr = addr(env.PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY);
  const utilAddr = addr(env.ALTO_UTILITY_PRIVATE_KEY);
  const execPks = (env.ALTO_EXECUTOR_PRIVATE_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const execAddrs = execPks.map((pk, i) => ({ i, a: addr(pk) })).filter((x): x is { i: number; a: string } => x.a != null);
  const refillOwnerAddr =
    addr(env.PAYMASTER_REFILL_OWNER_PRIVATE_KEY) ?? addr(env.CONTRACT_DEPLOYER_PRIVATE_KEY);
  const toolsAddr = addr(env.TOOLS_PRIVATE_KEY);

  const altoFundLine =
    utilAddr && execAddrs.length > 0
      ? `# ALTO_TRANSFER_TARGETS (comma-separated, native gas) -> ${[utilAddr, ...execAddrs.map((e) => e.a)].join(",")}`
      : "# ALTO_TRANSFER_TARGETS -> (set ALTO_UTILITY_PRIVATE_KEY and ALTO_EXECUTOR_PRIVATE_KEYS)";

  const header = `# =============================================================================
# EOA addresses derived from private keys below (sync: npx tsx integrated-tests/scripts/sync-env-address-comments.mts)
# =============================================================================
# PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY     -> ${signerAddr ?? "(invalid or missing key)"}
# ALTO_UTILITY / DASHBOARD_ALTO_UTILITY_KEY -> ${utilAddr ?? "(invalid or missing key)"}
${execAddrs.map(({ i, a }) => `# ALTO_EXECUTOR_PRIVATE_KEYS [${i}]            -> ${a}`).join("\n")}
${altoFundLine}
# PAYMASTER_REFILL_OWNER_PRIVATE_KEY (or CONTRACT_DEPLOYER) -> ${refillOwnerAddr ?? "(invalid or missing key)"}
# TOOLS_PRIVATE_KEY                         -> ${toolsAddr ?? "(invalid or missing key)"}
# CONTRACT_DEPLOYER_PRIVATE_KEY             -> ${env.CONTRACT_DEPLOYER_PRIVATE_KEY?.trim() ? addr(env.CONTRACT_DEPLOYER_PRIVATE_KEY) ?? "(invalid)" : "(empty; Anvil mnemonic deployer)"}
# ---
# Fund native gas to Alto EOAs above (utility + executors) for bundler submission.
# After key changes: set paymaster verifier on-chain; operational refill uses PAYMASTER_REFILL_OWNER_PRIVATE_KEY (must match paymaster owner()).
# =============================================================================

`;

  const withoutOld = raw.replace(
    /^# =+\n# EOA addresses[\s\S]*?# =+\n\n/m,
    ""
  );

  let out = withoutOld;

  if (!out.includes("You cannot send POL/MATIC \"to a private key\"")) {
    out = out.replace(
      /# -----------------------------------------------------------------------------\r?\n# BUNDLER \(Alto\) - ERC-4337 UserOp Bundling Service\r?\n# -----------------------------------------------------------------------------\r?\n/,
      `# -----------------------------------------------------------------------------\n# BUNDLER (Alto) - ERC-4337 UserOp Bundling Service\n# -----------------------------------------------------------------------------\n# You cannot send POL/MATIC "to a private key". Keys only sign. Send native gas to each EOA address shown on the lines below.\n`
    );
  }

  if (utilAddr) {
    const utilLines = `# Send native gas (POL/MATIC) to this EOA address: ${utilAddr}\n# Private key for Alto utility account (signs / submits; not a receive address)\n`;
    if (/# Send native gas \(POL\/MATIC\) to this EOA address:/.test(out)) {
      out = out.replace(
        /# Send native gas \(POL\/MATIC\) to this EOA address: [^\r\n]+\r?\n# Private key for Alto utility account[^\r\n]+\r?\n/,
        utilLines
      );
    } else {
      out = out.replace(
        /# Private key for Alto utility account \(submits userops, receives gas refunds\)\r?\n/,
        utilLines
      );
    }
  }

  if (execAddrs.length > 0) {
    const execLines =
      execAddrs.map(({ i, a }) => `# Send native gas to executor [${i}] EOA: ${a}`).join("\n") +
      "\n# Comma-separated private keys for executor accounts (sign batches; not receive addresses)\n";
    if (/^# Send native gas to executor \[0\] EOA:/m.test(out)) {
      out = out.replace(
        /^# Send native gas to executor \[\d+\] EOA: [^\r\n]+\r?\n(?:# Send native gas to executor \[\d+\] EOA: [^\r\n]+\r?\n)*# Comma-separated private keys for executor accounts[^\r\n]+\r?\n/m,
        execLines
      );
    } else {
      out = out.replace(
        /# Comma-separated private keys for executor accounts \(submit batches, receive gas\)\r?\n/,
        `${execAddrs.map(({ i, a }) => `# Send native gas to executor [${i}] EOA: ${a}`).join("\n")}\n# Comma-separated private keys for executor accounts (sign batches; not receive addresses)\n`
      );
    }
  }

  writeFileSync(envPath, header + out, "utf8");
}

const isMain = typeof process !== "undefined" && /sync-env-address-comments\.mts$/.test(process.argv[1] ?? "");
if (isMain) {
  syncEnvAddressComments(defaultEnvPath);
  console.log("Synced address comments in", defaultEnvPath);
}
