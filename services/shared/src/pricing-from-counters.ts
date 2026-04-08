/**
 * Derive USDC (6 decimals) per 1 wei of native gas cost from procurement counters:
 * usdcPerWeiE6 = (totalUsdcSpentForGasE6 * 1e18) / totalGasBoughtWei, then amplifier + service fee BPS.
 * Used with postOp: baseChargeUsdcE6 = (actualGasCost * usdcPerWeiE6) / 1e18.
 */
export function computeUsdcPerWeiE6FromCounters(params: {
  totalUsdcSpentForGasE6: bigint;
  totalGasBoughtWei: bigint;
  amplifierBps: bigint;
  serviceFeeBps: bigint;
  fallbackUsdcPerWeiE6: bigint;
}): bigint {
  const { totalUsdcSpentForGasE6: U, totalGasBoughtWei: B } = params;
  if (B <= 0n || U <= 0n) {
    return applyAmplifierAndFee(params.fallbackUsdcPerWeiE6, params.amplifierBps, params.serviceFeeBps);
  }
  let raw = (U * 10n ** 18n) / B;
  if (raw <= 0n) raw = params.fallbackUsdcPerWeiE6;
  return applyAmplifierAndFee(raw, params.amplifierBps, params.serviceFeeBps);
}

/**
 * @deprecated Legacy gas-unit pricing; prefer {@link computeUsdcPerWeiE6FromCounters} for paymaster charges.
 * Derive USDC (6 decimals) charged per EntryPoint gas unit (old model).
 */
export function computeUsdcPerGasUnitE6FromCounters(params: {
  totalGasUnitsProcessed: bigint;
  totalUsdcSpentForGasE6: bigint;
  totalGasBoughtWei: bigint;
  amplifierBps: bigint;
  serviceFeeBps: bigint;
  fallbackUsdcPerGasUnitE6: bigint;
}): bigint {
  const { totalGasUnitsProcessed: G, totalUsdcSpentForGasE6: U, totalGasBoughtWei: B } = params;
  if (G <= 0n || B <= 0n || U <= 0n) {
    return applyAmplifierAndFee(params.fallbackUsdcPerGasUnitE6, params.amplifierBps, params.serviceFeeBps);
  }
  const gasWeiPerGasUnit = B / G;
  const usdcE6PerWei = (U * 10n ** 18n) / B;
  let unit = (gasWeiPerGasUnit * usdcE6PerWei) / 10n ** 18n;
  if (unit <= 0n) unit = params.fallbackUsdcPerGasUnitE6;
  return applyAmplifierAndFee(unit, params.amplifierBps, params.serviceFeeBps);
}

function applyAmplifierAndFee(unit: bigint, amplifierBps: bigint, serviceFeeBps: bigint): bigint {
  let v = (unit * (10000n + amplifierBps)) / 10000n;
  v = (v * (10000n + serviceFeeBps)) / 10000n;
  return v;
}
