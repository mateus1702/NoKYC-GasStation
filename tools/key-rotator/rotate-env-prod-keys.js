#!/usr/bin/env node

/**
 * Rotates sensitive keys in .env.prod and validates each generated
 * address is a plain EOA on the target RPC (eth_getCode == 0x).
 *
 * Usage:
 *   node tools/key-rotator/rotate-env-prod-keys.js --env .env.prod --rpc https://polygon-rpc.com
 *   node tools/key-rotator/rotate-env-prod-keys.js
 */

const fs = require("fs");
const path = require("path");
const { Wallet, JsonRpcProvider } = require("ethers");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--env") args.env = argv[++i];
    else if (token === "--rpc") args.rpc = argv[++i];
    else if (token === "--max-attempts") args.maxAttempts = Number(argv[++i]);
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function showHelp() {
  console.log(`
Rotate .env.prod keys and validate EOA addresses.

Usage:
  node tools/key-rotator/rotate-env-prod-keys.js [options]

Options:
  --env <path>           Path to env file (default: .env.prod in project root)
  --rpc <url>            RPC URL used for EOA validation (default: PRODUCTION_RPC_URL from env file)
  --max-attempts <n>     Max generation attempts per wallet (default: 25)
  --help, -h             Show this help
`);
}

async function isPlainEoa(provider, address) {
  const code = await provider.getCode(address);
  const normalized = String(code || "").toLowerCase();
  return normalized === "0x" || normalized === "0x0";
}

async function generateValidWallet(provider, label, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const wallet = Wallet.createRandom();
    const eoa = await isPlainEoa(provider, wallet.address);
    if (eoa) {
      return wallet;
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `Could not generate plain EOA for ${label} within ${maxAttempts} attempts`
      );
    }
  }
  throw new Error(`Unexpected generation failure for ${label}`);
}

function parseKeyValueLines(lines) {
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function splitCsvKeys(value, fallbackCount) {
  if (!value || !value.trim()) {
    return new Array(fallbackCount).fill("x");
  }
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : new Array(fallbackCount).fill("x");
}

function updateEnvLines(lines, replacements, commentUpdates) {
  const output = [];
  const seen = new Set();

  for (const line of lines) {
    let replaced = false;

    for (const [prefix, newLine] of Object.entries(commentUpdates)) {
      if (line.startsWith(prefix)) {
        output.push(newLine);
        replaced = true;
        break;
      }
    }
    if (replaced) continue;

    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) {
      output.push(line);
      continue;
    }

    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      output.push(`${key}=${replacements[key]}`);
      seen.add(key);
    } else {
      output.push(line);
    }
  }

  // Append any missing keys to keep file complete.
  const missing = Object.keys(replacements).filter((k) => !seen.has(k));
  if (missing.length) {
    output.push("");
    output.push("# --- Added by key-rotator ---");
    for (const key of missing) {
      output.push(`${key}=${replacements[key]}`);
    }
  }

  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const defaultEnvPath = path.resolve(process.cwd(), ".env.prod");
  const envPath = path.resolve(process.cwd(), args.env || defaultEnvPath);
  const maxAttempts = Number.isFinite(args.maxAttempts) && args.maxAttempts > 0 ? args.maxAttempts : 25;

  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }

  const original = fs.readFileSync(envPath, "utf8");
  const lines = original.split(/\r?\n/);
  const env = parseKeyValueLines(lines);

  const rpcUrl = (args.rpc || env.PRODUCTION_RPC_URL || "").trim();
  if (!rpcUrl) {
    throw new Error("RPC URL not provided. Use --rpc or set PRODUCTION_RPC_URL in env file.");
  }

  // Preserve existing executor counts if present.
  const altoExecCount = splitCsvKeys(env.ALTO_EXECUTOR_PRIVATE_KEYS, 3).length;
  const dashboardExecCount = splitCsvKeys(env.DASHBOARD_ALTO_EXECUTOR_KEYS, altoExecCount).length;
  const combinedExecCount = Math.max(altoExecCount, dashboardExecCount);

  console.log(`Using RPC: ${rpcUrl}`);

  const provider = new JsonRpcProvider(rpcUrl);
  try {
    await provider.getBlockNumber();
  } catch (e) {
    throw new Error(`RPC unreachable or invalid: ${e.message}`);
  }

  console.log("Generating and validating fresh EOAs...");

  const deployer = await generateValidWallet(provider, "CONTRACT_DEPLOYER_PRIVATE_KEY", maxAttempts);
  const signer = await generateValidWallet(provider, "PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY", maxAttempts);
  const altoUtility = await generateValidWallet(provider, "ALTO_UTILITY_PRIVATE_KEY", maxAttempts);
  const altoExecutors = [];
  for (let i = 0; i < combinedExecCount; i += 1) {
    altoExecutors.push(await generateValidWallet(provider, `ALTO_EXECUTOR_PRIVATE_KEYS[${i}]`, maxAttempts));
  }

  const replacements = {
    CONTRACT_DEPLOYER_PRIVATE_KEY: deployer.privateKey,
    PAYMASTER_REFILL_OWNER_PRIVATE_KEY: deployer.privateKey,
    PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY: signer.privateKey,
    PAYMASTER_CONTRACT_SIGNER_ADDRESS: signer.address,
    ALTO_UTILITY_PRIVATE_KEY: altoUtility.privateKey,
    ALTO_EXECUTOR_PRIVATE_KEYS: altoExecutors.slice(0, altoExecCount).map((w) => w.privateKey).join(","),
    // Dashboard should observe the same bundler identities used by Alto.
    DASHBOARD_ALTO_UTILITY_KEY: altoUtility.privateKey,
    DASHBOARD_ALTO_EXECUTOR_KEYS: altoExecutors.slice(0, dashboardExecCount).map((w) => w.privateKey).join(","),
  };

  const commentUpdates = {
    "# Paymaster signer address": `# Paymaster signer address (EOA that will sign paymaster operations)`,
    "# Treasury address for collecting fees": `# USDC fees accrue on the paymaster contract (deploy calls setTreasury(paymaster)). Optional legacy DASHBOARD_TREASURY_ADDRESS for Redis only.`,
    "# Private key for Hardhat deploy scripts": `# Private key for Hardhat deploy scripts - SECURE THIS IN PRODUCTION! address: ${deployer.address}`,
  };

  const updatedLines = updateEnvLines(lines, replacements, commentUpdates);
  const updatedText = `${updatedLines.join("\n")}\n`;

  const backupPath = `${envPath}.bak.${Date.now()}`;
  fs.writeFileSync(backupPath, original, "utf8");
  fs.writeFileSync(envPath, updatedText, "utf8");

  console.log(`Backup created: ${backupPath}`);
  console.log(`Updated: ${envPath}`);
  console.log("Rotation complete. New key owner addresses:");
  console.log(`- Deployer: ${deployer.address}`);
  console.log(`- Paymaster signer: ${signer.address}`);
  console.log(
    "- PAYMASTER_REFILL_OWNER_PRIVATE_KEY set to deployer key; paymaster on-chain owner() must match after deploy or transferOwnership."
  );
  console.log("Post-deploy: contract-deployer sets on-chain treasury to the paymaster contract address.");
}

main().catch((err) => {
  console.error(`Key rotation failed: ${err.message}`);
  process.exit(1);
});

