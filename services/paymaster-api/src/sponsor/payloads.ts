import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address } from "viem";
import { computeUsdcPerWeiE6FromCounters } from "@project4/shared";
import { paymasterDebugLog } from "../debugLog.js";
import type { PaymasterRuntime } from "../runtimeConfig.js";
import { readPaymasterOnchainLimits, resolvePaymasterAddressFromFile } from "./address.js";
import { CAP_PROFILE_DEPLOY, CAP_PROFILE_NORMAL } from "./paymasterAbi.js";
import { extractExecuteTarget, isDeployProfileUserOp } from "./callData.js";
import { fromHexBigInt, toBigIntHex } from "./encoding.js";
import { parseReferralContext } from "./referral.js";
import { getPricingGasPriceWei } from "./gasPrice.js";

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

const DEFAULT_V3_FEE_CANDIDATES = [100, 500, 3000, 10000] as const;
const LIVE_QUOTE_USDC_IN_E6 = 1_000_000n; // 1 USDC

function parseV3FeeCandidates(raw: string | undefined): readonly number[] {
  if (!raw?.trim()) return [...DEFAULT_V3_FEE_CANDIDATES];
  const parts = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1_000_000);
  return parts.length > 0 ? parts : [...DEFAULT_V3_FEE_CANDIDATES];
}

function applyAmplifierAndFee(unit: bigint, amplifierBps: bigint, serviceFeeBps: bigint): bigint {
  let v = (unit * (10000n + amplifierBps)) / 10000n;
  v = (v * (10000n + serviceFeeBps)) / 10000n;
  return v;
}

/** v0.7 packed gasFees: low 128 bits = maxFeePerGas (matches viem toPackedUserOperation). */
function unpackMaxFeePerGasFromUserOp(userOp: Record<string, unknown>): bigint | null {
  const direct = userOp.maxFeePerGas;
  if (typeof direct === "bigint") return direct;
  if (typeof direct === "string" && direct.startsWith("0x")) {
    try {
      return BigInt(direct);
    } catch {
      /* ignore */
    }
  }
  const gasFees = userOp.gasFees;
  if (typeof gasFees === "string" && gasFees.startsWith("0x") && gasFees.length >= 66) {
    const word = BigInt(gasFees as `0x${string}`);
    return word & ((1n << 128n) - 1n);
  }
  return null;
}

function estimatedMaxWeiForGasCap(
  userOp: Record<string, unknown>,
  gasCapUnits: bigint,
  pricingGasPriceWei: bigint
): bigint {
  const maxFee = unpackMaxFeePerGasFromUserOp(userOp);
  const feePerGas = maxFee !== null && maxFee > 0n ? maxFee : pricingGasPriceWei;
  return gasCapUnits * feePerGas;
}

/** v0.7 packed accountGasLimits: high 128 = verificationGasLimit, low 128 = callGasLimit. */
function unpackAccountGasLimitsFromUserOp(userOp: Record<string, unknown>): { verificationGasLimit: bigint; callGasLimit: bigint } {
  const U128_MASK = (1n << 128n) - 1n;
  const packed = userOp.accountGasLimits;
  if (typeof packed === "string" && packed.startsWith("0x") && packed.length >= 66) {
    try {
      const word = BigInt(packed as `0x${string}`);
      return {
        verificationGasLimit: (word >> 128n) & U128_MASK,
        callGasLimit: word & U128_MASK,
      };
    } catch {
      // ignore malformed packed value
    }
  }
  return { verificationGasLimit: 0n, callGasLimit: 0n };
}

/** Approximate gas units for user-facing charge display using user-op limits. */
function estimatedLikelyGasUnitsForDisplay(userOp: Record<string, unknown>, quoteGasUnits: bigint): bigint {
  const preVerificationGas = fromHexBigInt(userOp.preVerificationGas, 0n);
  let verificationGasLimit = fromHexBigInt(userOp.verificationGasLimit, 0n);
  let callGasLimit = fromHexBigInt(userOp.callGasLimit, 0n);

  if (verificationGasLimit <= 0n || callGasLimit <= 0n) {
    const unpacked = unpackAccountGasLimitsFromUserOp(userOp);
    if (verificationGasLimit <= 0n) verificationGasLimit = unpacked.verificationGasLimit;
    if (callGasLimit <= 0n) callGasLimit = unpacked.callGasLimit;
  }

  const summed = preVerificationGas + verificationGasLimit + callGasLimit;
  if (summed <= 0n) return quoteGasUnits;
  return summed > quoteGasUnits ? quoteGasUnits : summed;
}

async function resolveFallbackUsdcPerWeiE6Raw(runtime: PaymasterRuntime): Promise<bigint> {
  const gasPriceWei = await getPricingGasPriceWei(runtime.publicClient);
  if (gasPriceWei <= 0n) return 1n;
  const raw = (runtime.fallbackUsdcPerGasUnitE6 * 10n ** 18n) / gasPriceWei;
  return raw > 0n ? raw : 1n;
}

async function quoteWrappedNativeOutForUsdcIn(
  runtime: PaymasterRuntime,
  params: { quoterV2Address: Address; tokenIn: Address; tokenOut: Address; poolFee: number; amountInE6: bigint }
): Promise<bigint | null> {
  try {
    const out = (await runtime.publicClient.readContract({
      address: params.quoterV2Address,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInE6,
          fee: params.poolFee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint];
    return out[0] > 0n ? out[0] : null;
  } catch {
    return null;
  }
}

async function computeLiveQuotedUsdcPerWeiE6(runtime: PaymasterRuntime): Promise<bigint> {
  const quoterV2Address = process.env.PAYMASTER_API_REFILL_QUOTER_V2_ADDRESS?.trim() as Address | undefined;
  const tokenIn = process.env.PAYMASTER_API_REFILL_USDC_ADDRESS?.trim() as Address | undefined;
  const tokenOut = process.env.PAYMASTER_API_REFILL_WRAPPED_NATIVE?.trim() as Address | undefined;
  if (!quoterV2Address || !tokenIn || !tokenOut) {
    throw new Error("Counters empty and live quote unavailable: missing refill quoter/token env");
  }

  const v3Fees = parseV3FeeCandidates(process.env.PAYMASTER_API_REFILL_V3_FEE_CANDIDATES);
  let bestOut: bigint | null = null;
  let bestFee = 0;
  for (const fee of v3Fees) {
    const outWei = await quoteWrappedNativeOutForUsdcIn(runtime, {
      quoterV2Address,
      tokenIn,
      tokenOut,
      poolFee: fee,
      amountInE6: LIVE_QUOTE_USDC_IN_E6,
    });
    if (!outWei) continue;
    if (bestOut === null || outWei > bestOut) {
      bestOut = outWei;
      bestFee = fee;
    }
  }
  if (!bestOut || bestOut <= 0n) {
    throw new Error("Counters empty and live quote unavailable: quoter returned no viable USDC->native quote");
  }

  let unit = (LIVE_QUOTE_USDC_IN_E6 * 10n ** 18n) / bestOut;
  if (unit <= 0n) unit = 1n;
  const adjusted = applyAmplifierAndFee(unit, runtime.amplifierBps, runtime.serviceFeeBps);
  paymasterDebugLog("sponsor", {
    step: "sponsor:live_quote_pricing_wei",
    quotedUsdcInE6: LIVE_QUOTE_USDC_IN_E6.toString(),
    quotedNativeOutWei: bestOut.toString(),
    selectedPoolFee: String(bestFee),
    usdcPerWeiE6BeforeBps: unit.toString(),
    usdcPerWeiE6AfterBps: adjusted.toString(),
  });
  return adjusted;
}

async function resolveUsdcPerWeiE6(
  runtime: PaymasterRuntime,
  counters: { usdcSpentForGasE6: bigint; gasBoughtWei: bigint }
): Promise<bigint> {
  const u = counters.usdcSpentForGasE6;
  const b = counters.gasBoughtWei;
  if (u > 0n && b > 0n) {
    const raw = (u * 10n ** 18n) / b;
    if (raw > 0n) {
      return computeUsdcPerWeiE6FromCounters({
        totalUsdcSpentForGasE6: u,
        totalGasBoughtWei: b,
        amplifierBps: runtime.amplifierBps,
        serviceFeeBps: runtime.serviceFeeBps,
        fallbackUsdcPerWeiE6: 1n,
      });
    }
  }
  paymasterDebugLog("sponsor", { step: "sponsor:pricing_counters_empty_or_too_small_using_live_quote" });
  try {
    return await computeLiveQuotedUsdcPerWeiE6(runtime);
  } catch {
    const fb = await resolveFallbackUsdcPerWeiE6Raw(runtime);
    return applyAmplifierAndFee(fb, runtime.amplifierBps, runtime.serviceFeeBps);
  }
}

async function buildSignedPaymasterData(
  runtime: PaymasterRuntime,
  params: {
    userOp: Record<string, unknown>;
    paymasterAddress: string;
    entryPointAddress: string;
    target: string;
    validUntil: bigint;
    validAfter: bigint;
    usdcPerWeiE6: bigint;
    minPostopFeeUsdcE6: bigint;
    estimatedNormalGasUnits: bigint;
    estimatedDeployGasUnits: bigint;
    referralAddress: string;
    referralBps: number;
    capProfile: number;
  }
): Promise<string> {
  const { publicClient, signer } = runtime;
  const chainId = await publicClient.getChainId();
  paymasterDebugLog("sponsor", { step: "sponsor:sign_chainId", chainId });
  const nonce = fromHexBigInt(params.userOp.nonce);
  const callDataHash = keccak256((params.userOp.callData as `0x${string}`) ?? "0x");
  const referralAddr = (params.referralAddress || "0x0000000000000000000000000000000000000000").toLowerCase() as `0x${string}`;
  const innerHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "uint256,address,address,address,uint256,bytes32,address,uint256,uint256,uint256,uint256,uint48,uint48,address,uint256,uint8"
      ),
      [
        BigInt(chainId),
        params.paymasterAddress as `0x${string}`,
        params.entryPointAddress as `0x${string}`,
        (params.userOp.sender as `0x${string}`) ?? "0x",
        nonce,
        callDataHash,
        params.target as `0x${string}`,
        params.usdcPerWeiE6,
        params.minPostopFeeUsdcE6,
        params.estimatedNormalGasUnits,
        params.estimatedDeployGasUnits,
        Number(params.validUntil),
        Number(params.validAfter),
        referralAddr,
        BigInt(params.referralBps),
        params.capProfile,
      ]
    )
  );
  paymasterDebugLog("sponsor", { step: "sponsor:sign_inner_hash", capProfile: params.capProfile });
  const signature = await signer.signMessage({ message: { raw: innerHash } });
  paymasterDebugLog("sponsor", { step: "sponsor:sign_message_done", capProfile: params.capProfile });
  const encoded = encodeAbiParameters(
    parseAbiParameters("uint48,uint48,uint256,uint256,uint256,uint256,address,uint256,uint8,bytes"),
    [
      Number(params.validUntil),
      Number(params.validAfter),
      params.usdcPerWeiE6,
      params.minPostopFeeUsdcE6,
      params.estimatedNormalGasUnits,
      params.estimatedDeployGasUnits,
      referralAddr,
      BigInt(params.referralBps),
      params.capProfile,
      signature as `0x${string}`,
    ]
  );
  paymasterDebugLog("sponsor", { step: "sponsor:sign_encode_paymasterData_done", capProfile: params.capProfile });
  return encoded;
}

export async function buildSponsorPayload(
  runtime: PaymasterRuntime,
  userOp: Record<string, unknown>,
  entryPointAddress: string,
  params2?: unknown
): Promise<{
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
  estimatedBaseCostUsdcE6: string;
  estimatedReferralUsdcE6: string;
  estimatedTotalCostUsdcE6: string;
  estimatedNormalGasUnits: string;
  estimatedDeployGasUnits: string;
  minUsdcReserveNormalE6: string;
  minUsdcReserveDeployE6: string;
  estimatedGas: string;
  approximateBaseCostUsdcE6: string;
  approximateReferralUsdcE6: string;
  approximateTotalCostUsdcE6: string;
  approximateGasUnits: string;
  validUntil: string;
}> {
  const refCtx = parseReferralContext(params2);
  paymasterDebugLog("buildSponsorPayload start", {
    sender: typeof userOp.sender === "string" ? userOp.sender : null,
    referralBps: refCtx.referralBps.toString(),
  });
  if ((entryPointAddress ?? "").toLowerCase() !== runtime.entryPointAddress) {
    throw new Error(`Unsupported entryPoint. expected=${runtime.entryPointAddress}`);
  }

  const target = extractExecuteTarget(String(userOp.callData ?? "")) || "0x0000000000000000000000000000000000000000";
  const paymasterAddress = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
  paymasterDebugLog("sponsor", { step: "sponsor:payload_resolved_paymaster", paymasterAddress, target });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + BigInt(runtime.validitySeconds);
  const validAfter = 0n;

  const onchain = await readPaymasterOnchainLimits(runtime.publicClient, paymasterAddress);
  paymasterDebugLog("sponsor", {
    step: "sponsor:payload_after_counters",
    gasUnitsProcessed: onchain.gasUnitsProcessed.toString(),
    usdcSpentForGasE6: onchain.usdcSpentForGasE6.toString(),
    gasBoughtWei: onchain.gasBoughtWei.toString(),
  });
  const usdcPerWeiE6 = await resolveUsdcPerWeiE6(runtime, onchain);
  const pricingGasPriceWei = await getPricingGasPriceWei(runtime.publicClient);

  const capProfile = isDeployProfileUserOp(userOp) ? CAP_PROFILE_DEPLOY : CAP_PROFILE_NORMAL;
  const quoteGasUnits = capProfile === CAP_PROFILE_DEPLOY ? runtime.deployMaxGasUnits : runtime.normalMaxGasUnits;

  const maxWeiNormal = estimatedMaxWeiForGasCap(userOp, runtime.normalMaxGasUnits, pricingGasPriceWei);
  const maxWeiDeploy = estimatedMaxWeiForGasCap(userOp, runtime.deployMaxGasUnits, pricingGasPriceWei);
  const minUsdcReserveNormalE6 = (maxWeiNormal * usdcPerWeiE6) / 10n ** 18n;
  const minUsdcReserveDeployE6 = (maxWeiDeploy * usdcPerWeiE6) / 10n ** 18n;

  const quoteMaxWei = estimatedMaxWeiForGasCap(userOp, quoteGasUnits, pricingGasPriceWei);
  const estimatedBaseCostUsdcE6 = (quoteMaxWei * usdcPerWeiE6) / 10n ** 18n;
  const estimatedReferralUsdcE6 = (estimatedBaseCostUsdcE6 * refCtx.referralBps) / 10000n;
  const estimatedTotalCostUsdcE6 = estimatedBaseCostUsdcE6 + estimatedReferralUsdcE6;
  const approximateGasUnits = estimatedLikelyGasUnitsForDisplay(userOp, quoteGasUnits);
  const approximateWei = approximateGasUnits * pricingGasPriceWei;
  let approximateBaseCostUsdcE6 = (approximateWei * usdcPerWeiE6) / 10n ** 18n;
  if (approximateBaseCostUsdcE6 < runtime.minPostopFeeUsdcE6) {
    approximateBaseCostUsdcE6 = runtime.minPostopFeeUsdcE6;
  }
  const approximateReferralUsdcE6 = (approximateBaseCostUsdcE6 * refCtx.referralBps) / 10000n;
  const approximateTotalCostUsdcE6 = approximateBaseCostUsdcE6 + approximateReferralUsdcE6;

  paymasterDebugLog("sponsor", {
    step: "sponsor:payload_before_sign",
    usdcPerWeiE6: usdcPerWeiE6.toString(),
    capProfile,
    quoteGasUnits: quoteGasUnits.toString(),
    quoteMaxWei: quoteMaxWei.toString(),
    approximateGasUnits: approximateGasUnits.toString(),
    approximateWei: approximateWei.toString(),
    approximateBaseCostUsdcE6: approximateBaseCostUsdcE6.toString(),
    approximateReferralUsdcE6: approximateReferralUsdcE6.toString(),
    approximateTotalCostUsdcE6: approximateTotalCostUsdcE6.toString(),
  });

  const paymasterData = await buildSignedPaymasterData(runtime, {
    userOp,
    paymasterAddress,
    entryPointAddress: runtime.entryPointAddress,
    target,
    validUntil,
    validAfter,
    usdcPerWeiE6,
    minPostopFeeUsdcE6: runtime.minPostopFeeUsdcE6,
    estimatedNormalGasUnits: runtime.normalMaxGasUnits,
    estimatedDeployGasUnits: runtime.deployMaxGasUnits,
    referralAddress: refCtx.referralAddress,
    referralBps: Number(refCtx.referralBps),
    capProfile,
  });

  paymasterDebugLog("sponsor_complete", {
    capProfile,
    usdcPerWeiE6: usdcPerWeiE6.toString(),
    quoteGasUnits: quoteGasUnits.toString(),
    minUsdcReserveNormalE6: minUsdcReserveNormalE6.toString(),
    minUsdcReserveDeployE6: minUsdcReserveDeployE6.toString(),
  });

  return {
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: toBigIntHex(runtime.pmVerificationGas),
    paymasterPostOpGasLimit: toBigIntHex(runtime.pmPostOpGas),
    paymasterData,
    validUntil: validUntil.toString(),
    estimatedBaseCostUsdcE6: estimatedBaseCostUsdcE6.toString(),
    estimatedReferralUsdcE6: estimatedReferralUsdcE6.toString(),
    estimatedTotalCostUsdcE6: estimatedTotalCostUsdcE6.toString(),
    estimatedNormalGasUnits: runtime.normalMaxGasUnits.toString(),
    estimatedDeployGasUnits: runtime.deployMaxGasUnits.toString(),
    minUsdcReserveNormalE6: minUsdcReserveNormalE6.toString(),
    minUsdcReserveDeployE6: minUsdcReserveDeployE6.toString(),
    estimatedGas: quoteGasUnits.toString(),
    approximateBaseCostUsdcE6: approximateBaseCostUsdcE6.toString(),
    approximateReferralUsdcE6: approximateReferralUsdcE6.toString(),
    approximateTotalCostUsdcE6: approximateTotalCostUsdcE6.toString(),
    approximateGasUnits: approximateGasUnits.toString(),
  };
}

export async function buildStubPayload(
  runtime: PaymasterRuntime,
  userOp: Record<string, unknown>,
  entryPointAddress: string
): Promise<{
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
}> {
  if ((entryPointAddress ?? "").toLowerCase() !== runtime.entryPointAddress) {
    throw new Error(`Unsupported entryPoint. expected=${runtime.entryPointAddress}`);
  }

  paymasterDebugLog("buildStubPayload start", {
    sender: typeof userOp.sender === "string" ? userOp.sender : null,
  });

  const target = extractExecuteTarget(String(userOp.callData ?? "")) || "0x0000000000000000000000000000000000000000";
  const paymasterAddress = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
  paymasterDebugLog("sponsor", { step: "sponsor:stub_resolved_paymaster", paymasterAddress, target });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + BigInt(runtime.validitySeconds);
  const validAfter = 0n;

  const onchain = await readPaymasterOnchainLimits(runtime.publicClient, paymasterAddress);
  paymasterDebugLog("sponsor", {
    step: "sponsor:stub_after_counters",
    gasUnitsProcessed: onchain.gasUnitsProcessed.toString(),
    usdcSpentForGasE6: onchain.usdcSpentForGasE6.toString(),
    gasBoughtWei: onchain.gasBoughtWei.toString(),
  });
  const usdcPerWeiE6 = await resolveUsdcPerWeiE6(runtime, onchain);

  const stubCapProfile = isDeployProfileUserOp(userOp) ? CAP_PROFILE_DEPLOY : CAP_PROFILE_NORMAL;
  paymasterDebugLog("sponsor", {
    step: "sponsor:stub_before_sign",
    usdcPerWeiE6: usdcPerWeiE6.toString(),
    capProfile: stubCapProfile,
  });
  const paymasterData = await buildSignedPaymasterData(runtime, {
    userOp,
    paymasterAddress,
    entryPointAddress: runtime.entryPointAddress,
    target,
    validUntil,
    validAfter,
    usdcPerWeiE6,
    minPostopFeeUsdcE6: runtime.minPostopFeeUsdcE6,
    estimatedNormalGasUnits: runtime.normalMaxGasUnits,
    estimatedDeployGasUnits: runtime.deployMaxGasUnits,
    referralAddress: "0x0000000000000000000000000000000000000000",
    referralBps: 0,
    capProfile: stubCapProfile,
  });

  paymasterDebugLog("stub_complete", { paymaster: paymasterAddress, capProfile: stubCapProfile });

  return {
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: toBigIntHex(runtime.pmVerificationGas),
    paymasterPostOpGasLimit: toBigIntHex(runtime.pmPostOpGas),
    paymasterData,
  };
}
