/**
 * Regenerates private keys in repo root .env, then runs full address-comment sync
 * (top summary, ALTO_TRANSFER_TARGETS, inline fund-to lines).
 * Run: npx tsx integrated-tests/scripts/rotate-dotenv-keys.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { syncEnvAddressComments } from "./sync-env-address-comments.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(root, ".env");

function pkAddr(pk: Hex): string {
  return privateKeyToAccount(pk).address;
}

const signerPk = generatePrivateKey();
const utilPk = generatePrivateKey();
const ex1 = generatePrivateKey();
const ex2 = generatePrivateKey();
const ex3 = generatePrivateKey();
const refillOwnerPk = generatePrivateKey();
const toolsPk = generatePrivateKey();

const signerAddr = pkAddr(signerPk);

const rest = readFileSync(envPath, "utf8");
const withoutOldHeader = rest.replace(
  /^# =+\n# EOA addresses[\s\S]*?# =+\n\n/m,
  ""
);

let out = withoutOldHeader.replace(/^PAYMASTER_API_OPERATOR_PRIVATE_KEY=.*\n?/m, "");

function setVar(name: string, value: string) {
  const re = new RegExp(`^${name}=.*$`, "m");
  if (!re.test(out)) throw new Error(`Missing ${name} in .env`);
  out = out.replace(re, `${name}=${value}`);
}

setVar("PAYMASTER_CONTRACT_SIGNER_ADDRESS", signerAddr);
setVar("PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY", signerPk);
setVar("ALTO_UTILITY_PRIVATE_KEY", utilPk);
setVar("ALTO_EXECUTOR_PRIVATE_KEYS", `${ex1},${ex2},${ex3}`);
if (/^PAYMASTER_REFILL_OWNER_PRIVATE_KEY=/m.test(out)) {
  setVar("PAYMASTER_REFILL_OWNER_PRIVATE_KEY", refillOwnerPk);
} else {
  out += `\nPAYMASTER_REFILL_OWNER_PRIVATE_KEY=${refillOwnerPk}\n`;
}
setVar("DASHBOARD_ALTO_UTILITY_KEY", utilPk);
setVar("DASHBOARD_ALTO_EXECUTOR_KEYS", `${ex1},${ex2},${ex3}`);
setVar("TOOLS_PRIVATE_KEY", toolsPk);

writeFileSync(envPath, out, "utf8");
syncEnvAddressComments(envPath);
console.log("Rotated keys + synced all address comments in", envPath);
