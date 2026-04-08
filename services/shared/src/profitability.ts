/**
 * Pure profitability and fee math for USDC-denominated gas sales.
 * No Redis/HTTP/env dependencies. Bigint-safe, O(1) operations only.
 */

/** BPS = basis points (10000 = 100%). */
export const BPS_DENOMINATOR = 10_000n;

/** USDC uses 6 decimals; wei scaling for unit cost. */
export const SCALE_18 = 10n ** 18n;

/** Input params for effective unit cost calculation (service fee only; no quote buffer). */
export interface EffectiveUnitCostParams {
  readonly baseUnitCostUsdcPerWei: bigint;
  readonly serviceFeeBps: bigint;
}

/**
 * Compute effective unit cost (USDC e6 per wei, scaled by 1e18) including service fee.
 * Formula: base * (1 + serviceFeeBps/10000)
 */
export function computeEffectiveUnitCost(params: EffectiveUnitCostParams): bigint {
  const { baseUnitCostUsdcPerWei, serviceFeeBps } = params;
  if (baseUnitCostUsdcPerWei === 0n) return 0n;
  return (baseUnitCostUsdcPerWei * (BPS_DENOMINATOR + serviceFeeBps)) / BPS_DENOMINATOR;
}

/** Input params for charge-from-gas calculation (matches Project4Paymaster.postOp logic). */
export interface ChargeFromGasParams {
  readonly actualGasCostWei: bigint;
  readonly unitCostUsdcPerWei: bigint;
  readonly minPostopFeeUsdcE6: bigint;
  readonly maxCostUsdcE6: bigint;
}

/** Result of charge calculation including which cap was applied. */
export interface ChargeResult {
  readonly chargeAmountUsdcE6: bigint;
  readonly initialChargeAmountUsdcE6: bigint;
  readonly wasMinFeeApplied: boolean;
  readonly wasMaxFeeApplied: boolean;
}

/**
 * Compute USDC charge for actual gas cost, enforcing min and max fees.
 * Matches Project4Paymaster.postOp behavior exactly. When unit cost is zero, returns 0 (no charge).
 */
export function computeChargeFromGas(params: ChargeFromGasParams): ChargeResult {
  const { actualGasCostWei, unitCostUsdcPerWei, minPostopFeeUsdcE6, maxCostUsdcE6 } = params;
  if (unitCostUsdcPerWei === 0n) {
    return {
      chargeAmountUsdcE6: 0n,
      initialChargeAmountUsdcE6: 0n,
      wasMinFeeApplied: false,
      wasMaxFeeApplied: false,
    };
  }
  let chargeAmount = (actualGasCostWei * unitCostUsdcPerWei) / SCALE_18;
  const initialChargeAmount = chargeAmount;
  let wasMinFeeApplied = false;
  let wasMaxFeeApplied = false;
  if (chargeAmount < minPostopFeeUsdcE6) {
    chargeAmount = minPostopFeeUsdcE6;
    wasMinFeeApplied = true;
  }
  if (chargeAmount > maxCostUsdcE6) {
    chargeAmount = maxCostUsdcE6;
    wasMaxFeeApplied = true;
  }
  return {
    chargeAmountUsdcE6: chargeAmount,
    initialChargeAmountUsdcE6: initialChargeAmount,
    wasMinFeeApplied,
    wasMaxFeeApplied,
  };
}

/** Input params for COGS from gas sold. */
export interface CogsParams {
  readonly gasSoldWei: bigint;
  readonly unitCostUsdcPerWei: bigint;
}

/**
 * Compute cost-of-goods-sold (USDC e6) for gas sold, using base acquisition unit cost.
 * COGS = gasSoldWei * unitCostUsdcPerWei / 1e18
 */
export function computeCogsFromGasSold(params: CogsParams): bigint {
  const { gasSoldWei, unitCostUsdcPerWei } = params;
  if (unitCostUsdcPerWei === 0n) return 0n;
  return (gasSoldWei * unitCostUsdcPerWei) / SCALE_18;
}

/** Input params for profitability summary. */
export interface ProfitabilityParams {
  readonly revenueUsdcE6: bigint;
  readonly gasSoldWei: bigint;
  readonly unitCostUsdcPerWei: bigint;
}

/** Result of profitability computation. */
export interface ProfitabilityResult {
  readonly revenueUsdcE6: bigint;
  readonly cogsUsdcE6: bigint;
  readonly profitUsdcE6: bigint;
  readonly marginBps: bigint;
  readonly isProfitable: boolean;
}

/**
 * Compute profitability: revenue, COGS, profit, and margin in basis points.
 * marginBps = (profit / cogs) * 10000 when cogs > 0; else 0.
 */
export function computeProfitability(params: ProfitabilityParams): ProfitabilityResult {
  const { revenueUsdcE6, gasSoldWei, unitCostUsdcPerWei } = params;
  const cogsUsdcE6 = computeCogsFromGasSold({ gasSoldWei, unitCostUsdcPerWei });
  const profitUsdcE6 = revenueUsdcE6 > cogsUsdcE6 ? revenueUsdcE6 - cogsUsdcE6 : 0n;
  const marginBps = cogsUsdcE6 > 0n ? (profitUsdcE6 * BPS_DENOMINATOR) / cogsUsdcE6 : 0n;
  return {
    revenueUsdcE6,
    cogsUsdcE6,
    profitUsdcE6,
    marginBps,
    isProfitable: profitUsdcE6 > 0n,
  };
}

/**
 * Derive base unit cost (USDC e6 per wei, scaled 1e18) from cumulative pricing totals.
 * unitCost = (totalUsdcSpentE6 * 1e18) / totalGasReturnedWei
 */
export function deriveUnitCostFromTotals(totalUsdcSpentE6: bigint, totalGasReturnedWei: bigint): bigint {
  if (totalGasReturnedWei === 0n) return 0n;
  return (totalUsdcSpentE6 * SCALE_18) / totalGasReturnedWei;
}

/** Params for deriving fresh WMATIC output from one swap cycle. */
export interface SwapOutputDeltaParams {
  readonly wmaticBeforeSwapWei: bigint;
  readonly wmaticAfterSwapWei: bigint;
}

/**
 * Derive WMATIC received by the current swap only.
 * Guards against stale pre-existing WMATIC by taking the post-pre delta.
 */
export function deriveFreshSwapWmaticWei(params: SwapOutputDeltaParams): bigint {
  const { wmaticBeforeSwapWei, wmaticAfterSwapWei } = params;
  if (wmaticAfterSwapWei <= wmaticBeforeSwapWei) return 0n;
  return wmaticAfterSwapWei - wmaticBeforeSwapWei;
}

/** Params for net gas credited to pricing totals in a swap cycle. */
export interface NetPricingGasParams {
  readonly freshSwapGasWei: bigint;
  readonly distributionTxGasWei: bigint;
}

/**
 * Compute gas credited to pricing totals for a swap cycle.
 * Never returns negative values.
 */
export function deriveNetPricingGasWei(params: NetPricingGasParams): bigint {
  const { freshSwapGasWei, distributionTxGasWei } = params;
  if (freshSwapGasWei <= distributionTxGasWei) return 0n;
  return freshSwapGasWei - distributionTxGasWei;
}

/** Params for referral split calculation (matches Project4Paymaster.postOp). */
export interface ReferralSplitParams {
  readonly baseChargeUsdcE6: bigint;
  readonly referralBps: bigint;
}

/** Result of referral split: referralAmount = floor(baseCharge * referralBps / 10000), total = base + referral. */
export interface ReferralSplitResult {
  readonly referralAmountUsdcE6: bigint;
  readonly totalChargeUsdcE6: bigint;
}

/**
 * Compute referral amount and total charge.
 * referralAmount = floor(baseCharge * referralBps / 10000)
 * totalCharge = baseCharge + referralAmount
 */
export function computeReferralSplit(params: ReferralSplitParams): ReferralSplitResult {
  const { baseChargeUsdcE6, referralBps } = params;
  if (referralBps === 0n) {
    return { referralAmountUsdcE6: 0n, totalChargeUsdcE6: baseChargeUsdcE6 };
  }
  const referralAmountUsdcE6 = (baseChargeUsdcE6 * referralBps) / BPS_DENOMINATOR;
  return {
    referralAmountUsdcE6,
    totalChargeUsdcE6: baseChargeUsdcE6 + referralAmountUsdcE6,
  };
}

