import "./load-env.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { toSimpleSmartAccount } from "permissionless/accounts";
import {
  createPublicClient,
  createTestClient,
  getContract,
  http,
  parseAbi,
  parseUnits,
  defineChain,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { analyzeGasCaps, type AnalyzerOptions, type TelemetrySample } from "./gas-cap-analyzer.js";
import { buildScenarioSequence, DEFAULT_SCENARIOS, type ScenarioDefinition } from "./gas-cap-scenarios.js";
import {
  collectTelemetryFromTx,
  resolveTransactionHashFromMaybeUserOpHash,
  type OpTelemetry,
} from "./gas-cap-telemetry.js";
import { fundAccountWithUSDC, USDC_ADDRESS } from "./funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BUNDLER_URL = process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const OUTPUT_ROOT = process.env.TOOLS_GASCAP_OUTPUT_DIR ?? "integrated-tests/artifacts/gas-cap-discovery";
const FUNDING_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6);
const TEST_OWNER_PRIVATE_KEY =
  process.env.TOOLS_TEST_OWNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const FALLBACK_TARGET = (process.env.TOOLS_GASCAP_FALLBACK_TARGET ??
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045") as Address;
const REFERRAL_TARGET = (process.env.TOOLS_GASCAP_REFERRAL_TARGET ??
  "0x47c031236e19d024b42f8de678d3110562d925b5") as Address;

const localChain = defineChain({
  id: 137,
  name: "Polygon Fork",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

interface SponsorPayload {
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
  estimatedGas?: string;
  estimatedNormalGasUnits?: string;
  estimatedDeployGasUnits?: string;
}

interface RunnerOptions {
  mode: "run" | "analyze";
  normalOps: number;
  deployOps: number;
  targetOverCapRate: number;
  bufferBps: number;
  minSamples: number;
  candidatePercentiles: number[];
  input?: string;
}

function asHexKey(k: string): `0x${string}` {
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseArgs(): RunnerOptions {
  const mode = (parseArg("--mode") ?? "run") as "run" | "analyze";
  const normalOps = Number(parseArg("--normal-ops") ?? "80");
  const deployOps = Number(parseArg("--deploy-ops") ?? "25");
  const targetOverCapRate = Number(parseArg("--target-overcap-rate") ?? "0.005");
  const bufferBps = Number(parseArg("--buffer-bps") ?? "1500");
  const minSamples = Number(parseArg("--min-samples") ?? "10");
  const candidatePercentiles = (parseArg("--candidate-percentiles") ?? "95,97,99,99.5,99.9")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
  const input = parseArg("--input");

  if (mode === "analyze" && !input) {
    throw new Error("Analyze mode requires --input <path-to-telemetry-json>");
  }
  return { mode, normalOps, deployOps, targetOverCapRate, bufferBps, minSamples, candidatePercentiles, input };
}

function nowTag(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function derivePrivateKey(seed: string, index: number): `0x${string}` {
  const normalizedSeed = seed.replace(/^0x/, "").padEnd(64, "0").slice(0, 56);
  const suffix = index.toString(16).padStart(8, "0");
  return (`0x${normalizedSeed}${suffix}`) as `0x${string}`;
}

async function requestSponsorPayload(userOp: Record<string, unknown>, entryPointAddress: string): Promise<SponsorPayload> {
  const body = JSON.stringify(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "pm_sponsorUserOperation",
      params: [userOp, entryPointAddress],
    },
    (_key, value) => (typeof value === "bigint" ? `0x${value.toString(16)}` : value)
  );
  const res = await fetch(PAYMASTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Paymaster request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { result?: SponsorPayload; error?: { message?: string } };
  if (json.error) throw new Error(`Paymaster error: ${json.error.message ?? "unknown error"}`);
  if (!json.result?.paymasterData) throw new Error("No paymasterData in response");
  return json.result;
}

async function resolvePaymasterAddress(): Promise<Address> {
  const fromEnv = process.env.TOOLS_PAYMASTER_ADDRESS as Address | undefined;
  if (fromEnv) return fromEnv;
  const res = await fetch(`${PAYMASTER_URL}/paymaster-address`);
  if (!res.ok) throw new Error("Could not resolve paymaster address");
  const json = (await res.json()) as { paymasterAddress?: string };
  if (!json.paymasterAddress) throw new Error("API did not return paymaster address");
  return json.paymasterAddress as Address;
}

function toCsv(rows: OpTelemetry[]): string {
  const header = [
    "scenarioId",
    "scenarioDescription",
    "profile",
    "success",
    "txHash",
    "userOpHash",
    "actualGasUsed",
    "actualGasCostWei",
    "gasUnitsCharged",
    "contractGasPriceWei",
    "sponsorEstimatedGas",
    "sponsorEstimatedNormalGasUnits",
    "sponsorEstimatedDeployGasUnits",
    "error",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = rows.map((r) =>
    [
      r.scenarioId,
      r.scenarioDescription,
      r.profile,
      r.success,
      r.txHash,
      r.userOpHash,
      r.actualGasUsed?.toString(),
      r.actualGasCostWei?.toString(),
      r.gasUnitsCharged?.toString(),
      r.contractGasPriceWei?.toString(),
      r.sponsorEstimatedGas?.toString(),
      r.sponsorEstimatedNormalGasUnits?.toString(),
      r.sponsorEstimatedDeployGasUnits?.toString(),
      r.error ?? "",
    ]
      .map(esc)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

async function runDiscovery(options: RunnerOptions): Promise<{ telemetryPath: string }> {
  const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
  const testClient = createTestClient({ chain: localChain, transport: http(RPC_URL), mode: "anvil" });
  const paymasterAddress = await resolvePaymasterAddress();
  const entryPointAddress = entryPoint07Address as Address;
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    client: publicClient,
  });
  const feeClient = createPimlicoClient({
    entryPoint: { address: entryPoint07Address, version: "0.7" },
    transport: http(PAYMASTER_URL),
  });
  const scenarios = buildScenarioSequence(DEFAULT_SCENARIOS, options.normalOps, options.deployOps);
  const telemetry: OpTelemetry[] = [];
  const outDir = resolve(join(OUTPUT_ROOT, nowTag()));
  await mkdir(outDir, { recursive: true });

  const baseOwner = privateKeyToAccount(asHexKey(TEST_OWNER_PRIVATE_KEY));
  const baseAccount = await toSimpleSmartAccount({
    client: publicClient,
    owner: baseOwner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });
  await fundAccountWithUSDC(baseAccount.address, FUNDING_AMOUNT, usdc, publicClient, testClient);

  // Warm up once so all "normal" operations run on an already deployed account.
  {
    let ignoreSponsorPayload: SponsorPayload | undefined;
    const warmupPaymaster = {
      getPaymasterData: async (parameters: Record<string, unknown>) => {
        const { entryPointAddress: ep, context: _ctx, ...partialUserOp } = parameters;
        void _ctx;
        ignoreSponsorPayload = await requestSponsorPayload(partialUserOp, String(ep));
        return {
          paymaster: ignoreSponsorPayload.paymaster as Address,
          paymasterData: ignoreSponsorPayload.paymasterData as `0x${string}`,
          paymasterVerificationGasLimit: BigInt(ignoreSponsorPayload.paymasterVerificationGasLimit),
          paymasterPostOpGasLimit: BigInt(ignoreSponsorPayload.paymasterPostOpGasLimit),
        };
      },
    };
    const warmupClient = createSmartAccountClient({
      account: baseAccount,
      chain: localChain,
      bundlerTransport: http(BUNDLER_URL),
      paymaster: warmupPaymaster,
      userOperation: { estimateFeesPerGas: async () => (await feeClient.getUserOperationGasPrice()).fast },
    });
    const warmupApproveData = DEFAULT_SCENARIOS[0].buildCalls({
      paymasterAddress,
      fallbackTarget: FALLBACK_TARGET,
      referralTarget: REFERRAL_TARGET,
    });
    await warmupClient.sendTransaction({ calls: warmupApproveData });
  }

  const executeScenario = async (
    scenario: ScenarioDefinition,
    index: number
  ): Promise<void> => {
    const ownerPk =
      scenario.profile === "deploy"
        ? derivePrivateKey(TEST_OWNER_PRIVATE_KEY, index + 1)
        : asHexKey(TEST_OWNER_PRIVATE_KEY);
    const owner = privateKeyToAccount(ownerPk);
    const account = await toSimpleSmartAccount({
      client: publicClient,
      owner,
      entryPoint: { address: entryPoint07Address, version: "0.7" },
    });
    await fundAccountWithUSDC(account.address, FUNDING_AMOUNT, usdc, publicClient, testClient);

    let sponsorPayload: SponsorPayload | undefined;
    const paymaster = {
      getPaymasterData: async (parameters: Record<string, unknown>) => {
        const { entryPointAddress: ep, context: _ctx, ...partialUserOp } = parameters;
        void _ctx;
        sponsorPayload = await requestSponsorPayload(partialUserOp, String(ep));
        return {
          paymaster: sponsorPayload.paymaster as Address,
          paymasterData: sponsorPayload.paymasterData as `0x${string}`,
          paymasterVerificationGasLimit: BigInt(sponsorPayload.paymasterVerificationGasLimit),
          paymasterPostOpGasLimit: BigInt(sponsorPayload.paymasterPostOpGasLimit),
        };
      },
    };

    const smartAccountClient = createSmartAccountClient({
      account,
      chain: localChain,
      bundlerTransport: http(BUNDLER_URL),
      paymaster,
      userOperation: { estimateFeesPerGas: async () => (await feeClient.getUserOperationGasPrice()).fast },
    });

    const base: OpTelemetry = {
      scenarioId: scenario.id,
      scenarioDescription: scenario.description,
      profile: scenario.profile,
      success: false,
    };

    try {
      const hash = await smartAccountClient.sendTransaction({
        calls: scenario.buildCalls({
          paymasterAddress,
          fallbackTarget: FALLBACK_TARGET,
          referralTarget: REFERRAL_TARGET,
        }),
      });
      const resolved = await resolveTransactionHashFromMaybeUserOpHash(
        BUNDLER_URL,
        hash as `0x${string}`,
        publicClient
      );
      if (!resolved.txHash) {
        telemetry.push({
          ...base,
          userOpHash: resolved.userOpHash,
          sponsorEstimatedGas: sponsorPayload?.estimatedGas ? BigInt(sponsorPayload.estimatedGas) : undefined,
          sponsorEstimatedNormalGasUnits: sponsorPayload?.estimatedNormalGasUnits
            ? BigInt(sponsorPayload.estimatedNormalGasUnits)
            : undefined,
          sponsorEstimatedDeployGasUnits: sponsorPayload?.estimatedDeployGasUnits
            ? BigInt(sponsorPayload.estimatedDeployGasUnits)
            : undefined,
          error: "Could not resolve transaction hash from userOp hash",
        });
        return;
      }

      const chainTelemetry = await collectTelemetryFromTx(
        publicClient,
        resolved.txHash,
        entryPointAddress,
        paymasterAddress
      );
      telemetry.push({
        ...base,
        success: chainTelemetry.success,
        txHash: resolved.txHash,
        userOpHash: chainTelemetry.userOpHash ?? resolved.userOpHash,
        actualGasUsed: chainTelemetry.actualGasUsed,
        actualGasCostWei: chainTelemetry.actualGasCostWei,
        gasUnitsCharged: chainTelemetry.gasUnitsCharged,
        contractGasPriceWei: chainTelemetry.contractGasPriceWei,
        sponsorEstimatedGas: sponsorPayload?.estimatedGas ? BigInt(sponsorPayload.estimatedGas) : undefined,
        sponsorEstimatedNormalGasUnits: sponsorPayload?.estimatedNormalGasUnits
          ? BigInt(sponsorPayload.estimatedNormalGasUnits)
          : undefined,
        sponsorEstimatedDeployGasUnits: sponsorPayload?.estimatedDeployGasUnits
          ? BigInt(sponsorPayload.estimatedDeployGasUnits)
          : undefined,
      });
    } catch (e) {
      telemetry.push({
        ...base,
        error: (e as Error).message,
        sponsorEstimatedGas: sponsorPayload?.estimatedGas ? BigInt(sponsorPayload.estimatedGas) : undefined,
        sponsorEstimatedNormalGasUnits: sponsorPayload?.estimatedNormalGasUnits
          ? BigInt(sponsorPayload.estimatedNormalGasUnits)
          : undefined,
        sponsorEstimatedDeployGasUnits: sponsorPayload?.estimatedDeployGasUnits
          ? BigInt(sponsorPayload.estimatedDeployGasUnits)
          : undefined,
      });
    }
  };

  let i = 0;
  for (const scenario of scenarios) {
    i += 1;
    console.log(`[${i}/${scenarios.length}] ${scenario.id} (${scenario.profile})`);
    await executeScenario(scenario, i);
  }

  const telemetryPath = join(outDir, "telemetry.json");
  const csvPath = join(outDir, "telemetry.csv");
  await writeFile(telemetryPath, stringifyWithBigInt(telemetry), "utf8");
  await writeFile(csvPath, toCsv(telemetry), "utf8");
  console.log(`Telemetry written: ${telemetryPath}`);
  console.log(`CSV written: ${csvPath}`);
  return { telemetryPath };
}

async function analyzeFromTelemetry(telemetryPath: string, options: RunnerOptions): Promise<void> {
  const raw = await readFile(telemetryPath, "utf8");
  const telemetry = JSON.parse(raw) as OpTelemetry[];
  const samples: TelemetrySample[] = telemetry.map((t) => ({
    profile: t.profile,
    success: t.success,
    actualGasUsed: t.actualGasUsed != null ? BigInt(t.actualGasUsed) : undefined,
    gasUnitsCharged: t.gasUnitsCharged != null ? BigInt(t.gasUnitsCharged) : undefined,
  }));

  const analyzerOptions: AnalyzerOptions = {
    targetOverCapRate: options.targetOverCapRate,
    bufferBps: options.bufferBps,
    minSamples: options.minSamples,
    candidatePercentiles: options.candidatePercentiles,
  };
  const report = analyzeGasCaps(samples, analyzerOptions);

  const dir = resolve(join(OUTPUT_ROOT, `analysis-${nowTag()}`));
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  await writeFile(reportPath, stringifyWithBigInt(report), "utf8");

  console.log("");
  console.log("Recommended values:");
  console.log(`PAYMASTER_API_NORMAL_MAX_GAS_UNITS=${report.recommendations.normal.recommendedCap.toString()}`);
  console.log(`PAYMASTER_API_DEPLOY_MAX_GAS_UNITS=${report.recommendations.deploy.recommendedCap.toString()}`);
  console.log("");
  console.log(
    `normal metric=${report.recommendations.normal.chosenMetric}, overCapRate=${(
      report.recommendations.normal.achievedOverCapRate * 100
    ).toFixed(3)}%`
  );
  console.log(
    `deploy metric=${report.recommendations.deploy.chosenMetric}, overCapRate=${(
      report.recommendations.deploy.achievedOverCapRate * 100
    ).toFixed(3)}%`
  );
  console.log(`Analysis input: ${basename(telemetryPath)}`);
  console.log(`Analysis report: ${reportPath}`);
}

async function main() {
  const options = parseArgs();
  if (options.mode === "analyze") {
    await analyzeFromTelemetry(resolve(options.input!), options);
    return;
  }
  const out = await runDiscovery(options);
  await analyzeFromTelemetry(out.telemetryPath, options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
