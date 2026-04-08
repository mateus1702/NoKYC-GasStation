import "../load-env.js";
/**
 * Simulation: repeated "common dapp" sponsored UserOps (USDC approve paymaster + empty external call).
 *
 * For a predictable local stack, run `bash scripts/docker-reset.sh` from the repo root first
 * (full Docker teardown including volumes), then execute this from the host.
 *
 * Usage:
 *   npm run simulate:common-dapp (repo root; forwards CLI flags correctly)
 *   npm run simulate:common-dapp -- --count 10
 *   npm run simulate:common-dapp -- --count 5 --create-account
 *   npm run simulate:common-dapp -w @project4/simulation -- --count 3
 *
 * If your shell/npm forwards only a bare number (e.g. `tsx ... 5`), it is accepted as the count.
 *
 * Flags:
 *   --count N     Number of UserOps to send (default 1).
 *   --create-account
 *                 Use a newly generated owner key for this process. The first UserOp deploys SimpleAccount;
 *                 subsequent ops in the same run reuse that smart account (not N separate deployments).
 *                 Default: reuse TOOLS_TEST_OWNER_PRIVATE_KEY (account may already exist on-chain).
 *
 * Env: same as integrated-tests smoke (TOOLS_RPC_URL, TOOLS_PAYMASTER_URL, TOOLS_BUNDLER_URL, …).
 */
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prepareCommonDappFeeContext } from "../lib/fee-userop-context.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BUNDLER_URL = process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const TEST_OWNER_PRIVATE_KEY =
  process.env.TOOLS_TEST_OWNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function asHexKey(k: string): `0x${string}` {
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, "..", "..", "reports", "common-dapp-call");

function asIsoFileSafe(value: Date): string {
  return value.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      count: { type: "string", short: "n", default: "1" },
      "create-account": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  let count = Math.max(1, parseInt(String(values.count ?? "1"), 10) || 1);
  if (positionals.length > 0) {
    const fromPos = parseInt(positionals[0], 10);
    if (!Number.isNaN(fromPos) && fromPos >= 1) {
      count = fromPos;
    }
  }
  const createAccount = values["create-account"] === true;
  const startedAt = new Date();
  const runId = asIsoFileSafe(startedAt);

  const owner = createAccount
    ? privateKeyToAccount(generatePrivateKey())
    : privateKeyToAccount(asHexKey(TEST_OWNER_PRIVATE_KEY));

  console.log("Simulation: common dapp call");
  console.log("  RPC:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("  Count:", count);
  console.log("  Create account (new owner this run):", createAccount);
  console.log("  Owner EOA:", owner.address);
  console.log("");

  const ctx = await prepareCommonDappFeeContext({
    owner,
    rpcUrl: RPC_URL,
    paymasterUrl: PAYMASTER_URL,
    bundlerUrl: BUNDLER_URL,
  });

  console.log("SimpleAccount:", ctx.smartAccountAddress);
  console.log("Paymaster:", ctx.paymasterAddress);
  console.log("");

  let totalFee = 0n;
  const opReports: Array<{
    index: number;
    hash: string;
    feeE6: string;
    sponsor: {
      estimatedBaseCostUsdcE6?: string;
      estimatedTotalCostUsdcE6?: string;
      estimatedGas?: string;
      selectedUsdcPerWeiE6?: string;
      sourceGuess: "counters" | "live_quote_or_min";
    };
    pricingBefore: {
      gasUnitsProcessed: string;
      usdcSpentForGasE6: string;
      gasBoughtWei: string;
      derivedUsdcPerWeiE6Raw: string | null;
    };
    pricingAfter: {
      gasUnitsProcessed: string;
      usdcSpentForGasE6: string;
      gasBoughtWei: string;
      derivedUsdcPerWeiE6Raw: string | null;
    };
  }> = [];

  for (let i = 0; i < count; i++) {
    const { hash, fee, sponsor, pricingBefore, pricingAfter } = await ctx.sendCommonDappUserOp();
    totalFee += fee;
    console.log(`  #${i + 1}/${count} hash=${hash} fee=${fee}`);
    opReports.push({
      index: i + 1,
      hash,
      feeE6: fee.toString(),
      sponsor,
      pricingBefore: {
        gasUnitsProcessed: pricingBefore.gasUnitsProcessed.toString(),
        usdcSpentForGasE6: pricingBefore.usdcSpentForGasE6.toString(),
        gasBoughtWei: pricingBefore.gasBoughtWei.toString(),
        derivedUsdcPerWeiE6Raw:
          pricingBefore.derivedUsdcPerWeiE6Raw === null ? null : pricingBefore.derivedUsdcPerWeiE6Raw.toString(),
      },
      pricingAfter: {
        gasUnitsProcessed: pricingAfter.gasUnitsProcessed.toString(),
        usdcSpentForGasE6: pricingAfter.usdcSpentForGasE6.toString(),
        gasBoughtWei: pricingAfter.gasBoughtWei.toString(),
        derivedUsdcPerWeiE6Raw:
          pricingAfter.derivedUsdcPerWeiE6Raw === null ? null : pricingAfter.derivedUsdcPerWeiE6Raw.toString(),
      },
    });
    if (fee <= 0n) {
      console.error("Expected USDC fee > 0 for each UserOp");
      process.exit(1);
    }
  }

  const finishedAt = new Date();
  const report = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    args: { count, createAccount },
    endpoints: { rpcUrl: RPC_URL, paymasterUrl: PAYMASTER_URL, bundlerUrl: BUNDLER_URL },
    account: { ownerAddress: owner.address, smartAccountAddress: ctx.smartAccountAddress, paymasterAddress: ctx.paymasterAddress },
    envSnapshot: {
      PAYMASTER_API_SERVICE_FEE_BPS: process.env.PAYMASTER_API_SERVICE_FEE_BPS ?? null,
      PAYMASTER_API_PRICING_AMPLIFIER_BPS: process.env.PAYMASTER_API_PRICING_AMPLIFIER_BPS ?? null,
      PAYMASTER_API_FALLBACK_USDC_PER_GAS_UNIT_E6: process.env.PAYMASTER_API_FALLBACK_USDC_PER_GAS_UNIT_E6 ?? null,
      PAYMASTER_API_REFILL_MIN_NATIVE_WEI: process.env.PAYMASTER_API_REFILL_MIN_NATIVE_WEI ?? null,
      PAYMASTER_CONTRACT_VERIFICATION_GAS_LIMIT: process.env.PAYMASTER_CONTRACT_VERIFICATION_GAS_LIMIT ?? null,
      PAYMASTER_CONTRACT_POSTOP_GAS_LIMIT: process.env.PAYMASTER_CONTRACT_POSTOP_GAS_LIMIT ?? null,
    },
    totals: { userOps: count, totalFeeE6: totalFee.toString() },
    operations: opReports,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const jsonPath = resolve(REPORTS_DIR, `${runId}.json`);
  const mdPath = resolve(REPORTS_DIR, `${runId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const md = [
    `# Common Dapp Call Report`,
    ``,
    `- Run ID: \`${runId}\``,
    `- Started: \`${report.startedAt}\``,
    `- Duration: \`${report.durationMs} ms\``,
    `- Count: \`${count}\``,
    `- Create Account: \`${createAccount}\``,
    `- Owner: \`${owner.address}\``,
    `- SmartAccount: \`${ctx.smartAccountAddress}\``,
    `- Paymaster: \`${ctx.paymasterAddress}\``,
    `- Total fee (e6): \`${totalFee.toString()}\``,
    ``,
    `## Operations`,
    ...opReports.map(
      (op) =>
        `- #${op.index}: feeE6=${op.feeE6}, hash=${op.hash}, sourceGuess=${op.sponsor.sourceGuess}, selectedUsdcPerWeiE6=${op.sponsor.selectedUsdcPerWeiE6 ?? "n/a"}, derivedWeiRawBefore=${op.pricingBefore.derivedUsdcPerWeiE6Raw ?? "n/a"}`
    ),
    ``,
    `JSON report: \`${jsonPath}\``,
  ].join("\n");
  await writeFile(mdPath, `${md}\n`, "utf8");

  console.log("");
  console.log(`Done. UserOps: ${count}, total USDC fee (6 decimals): ${totalFee.toString()}`);
  console.log(`Report (json): ${jsonPath}`);
  console.log(`Report (md): ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
