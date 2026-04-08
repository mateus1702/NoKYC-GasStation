import { createPublicClient, http as viemHttp, type Address, type PublicClient } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { loadStrictRedisConfig } from "@project4/shared";
import { paymasterDebugLog } from "./debugLog.js";
import {
  DEFAULT_MIN_NATIVE_WEI,
  mergeRefillRunnerConfig,
  parseRefillConfigFromEnv,
  type RefillConfigEnvPartial,
  type RefillRunnerConfig,
} from "./refillRunner.js";

export type { RefillConfigEnvPartial, RefillRunnerConfig };

export interface PaymasterRuntime {
  port: number;
  paymasterAddressFile: string;
  gasBurnerAddressFile: string | undefined;
  signer: LocalAccount;
  publicClient: PublicClient;
  validitySeconds: number;
  pmVerificationGas: bigint;
  pmPostOpGas: bigint;
  normalMaxGasUnits: bigint;
  deployMaxGasUnits: bigint;
  minPostopFeeUsdcE6: bigint;
  bundlerUrl: string;
  entryPointAddress: string;
  paymasterApiRpcUrl: string;
  amplifierBps: bigint;
  fallbackUsdcPerGasUnitE6: bigint;
  serviceFeeBps: bigint;
  refillMinNativeWei: bigint;
  /** @deprecated use buildRefillRunnerConfig */
  getRefillConfigBase: () => RefillConfigEnvPartial | undefined;
  buildRefillRunnerConfig: (paymasterAddress: Address) => RefillRunnerConfig | null;
}

export async function loadPaymasterRuntime(): Promise<PaymasterRuntime> {
  paymasterDebugLog("runtime", { step: "runtime:redis_connect_start", key: "paymaster-api" });
  const rc = await loadStrictRedisConfig("paymaster-api");
  paymasterDebugLog("runtime", { step: "runtime:redis_connect_ok" });
  const SIGNER_PRIVATE_KEY = process.env.PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY!;
  const paymasterAddressFile = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE!;
  const gasBurnerAddressFile = process.env.CONTRACT_DEPLOYER_GAS_BURNER_ADDRESS_FILE;
  if (!SIGNER_PRIVATE_KEY) throw new Error("PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY required (set in .env)");
  if (!paymasterAddressFile) throw new Error("CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE required (set in .env)");
  if (!rc.PAYMASTER_API_BUNDLER_URL?.trim()) throw new Error("PAYMASTER_API_BUNDLER_URL required (Redis config)");

  const validitySeconds = Number(rc.PAYMASTER_API_VALIDITY_SECONDS);
  const pmVerificationGas = BigInt(rc.PAYMASTER_CONTRACT_VERIFICATION_GAS_LIMIT);
  const pmPostOpGas = BigInt(rc.PAYMASTER_CONTRACT_POSTOP_GAS_LIMIT);
  const normalMaxGasUnits = BigInt(rc.PAYMASTER_API_NORMAL_MAX_GAS_UNITS ?? "800000");
  const deployMaxGasUnits = BigInt(rc.PAYMASTER_API_DEPLOY_MAX_GAS_UNITS ?? "3000000");
  const minPostopFeeUsdcE6 = BigInt(rc.PAYMASTER_API_MIN_POSTOP_FEE_USDC_E6 ?? "2000");
  const bundlerUrl = rc.PAYMASTER_API_BUNDLER_URL.trim().replace(/\/$/, "");
  const paymasterApiEntryPointAddress = rc.PAYMASTER_API_ENTRYPOINT_ADDRESS;
  const paymasterApiServiceFeeBps = BigInt(rc.PAYMASTER_API_SERVICE_FEE_BPS);
  const paymasterApiRpcUrl = rc.PAYMASTER_API_RPC_URL;
  const entryPointAddress = paymasterApiEntryPointAddress.toLowerCase();
  const serviceFeeBps = paymasterApiServiceFeeBps;
  const amplifierBps = BigInt(rc.PAYMASTER_API_PRICING_AMPLIFIER_BPS ?? "10000");
  const fallbackUsdcPerGasUnitE6 = BigInt(rc.PAYMASTER_API_FALLBACK_USDC_PER_GAS_UNIT_E6 ?? "50");

  const minWeiRaw = rc.PAYMASTER_API_REFILL_MIN_NATIVE_WEI?.trim();
  let refillMinNativeWei = DEFAULT_MIN_NATIVE_WEI;
  if (minWeiRaw) {
    try {
      const parsed = BigInt(minWeiRaw);
      if (parsed > 0n) {
        refillMinNativeWei = parsed;
      }
    } catch {
      paymasterDebugLog("runtime", { step: "runtime:refill_min_wei_invalid", value: minWeiRaw });
    }
  }

  const publicClient = createPublicClient({ transport: viemHttp(paymasterApiRpcUrl) });

  const signer = privateKeyToAccount(
    (SIGNER_PRIVATE_KEY.startsWith("0x") ? SIGNER_PRIVATE_KEY : `0x${SIGNER_PRIVATE_KEY}`) as `0x${string}`
  );

  let refillEnvPartialCache: RefillConfigEnvPartial | undefined;

  paymasterDebugLog("runtime config loaded", {
    port: Number(process.env.PAYMASTER_API_PORT!),
    paymasterApiRpcUrl,
    bundlerUrl,
    entryPointAddress,
    validitySeconds,
    normalMaxGasUnits: normalMaxGasUnits.toString(),
    deployMaxGasUnits: deployMaxGasUnits.toString(),
    signerAddress: signer.address,
    paymasterAddressFile,
    hasGasBurnerAddressFile: Boolean(gasBurnerAddressFile),
    refillMinNativeWei: refillMinNativeWei.toString(),
  });

  return {
    port: Number(process.env.PAYMASTER_API_PORT!),
    paymasterAddressFile,
    gasBurnerAddressFile,
    signer,
    publicClient,
    validitySeconds,
    pmVerificationGas,
    pmPostOpGas,
    normalMaxGasUnits,
    deployMaxGasUnits,
    minPostopFeeUsdcE6,
    bundlerUrl,
    entryPointAddress,
    paymasterApiRpcUrl,
    amplifierBps,
    fallbackUsdcPerGasUnitE6,
    serviceFeeBps,
    refillMinNativeWei,
    getRefillConfigBase() {
      if (refillEnvPartialCache === undefined) {
        refillEnvPartialCache = parseRefillConfigFromEnv(paymasterApiRpcUrl) ?? undefined;
      }
      return refillEnvPartialCache;
    },
    buildRefillRunnerConfig(paymasterAddress: Address) {
      if (refillEnvPartialCache === undefined) {
        refillEnvPartialCache = parseRefillConfigFromEnv(paymasterApiRpcUrl) ?? undefined;
      }
      const partial = refillEnvPartialCache;
      if (!partial) return null;
      return mergeRefillRunnerConfig(partial, {
        paymasterAddress,
        entryPointAddress: entryPointAddress as Address,
        minNativeWei: refillMinNativeWei,
      });
    },
  };
}
