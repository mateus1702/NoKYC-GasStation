/**
 * Cumulative pricing state for USDC-by-gas (Redis-backed).
 * unit_cost = total_usdc_spent_e6 / total_gas_returned_wei (all swaps).
 * No per-UserOp writes; price changes only when a swap completes.
 */
import { getBigInt, getRedis, key, setBigInt } from "./redis.js";

const PRICING_TOTAL_USDC_E6 = "pricing:total_usdc_spent_e6";
const PRICING_TOTAL_GAS_WEI = "pricing:total_gas_returned_wei";
const PRICING_SWAP_COUNT = "pricing:swap_count";

export interface TotalsState {
  totalUsdcSpentE6: bigint;
  totalGasReturnedWei: bigint;
  swapCount: number;
  unitCostUsdcPerWei: bigint;
}

/** Read cumulative totals from Redis. */
export async function readTotalsState(): Promise<TotalsState> {
  const spent = await getBigInt(PRICING_TOTAL_USDC_E6);
  const gas = await getBigInt(PRICING_TOTAL_GAS_WEI);
  const countStr = await getRedis().get(key(PRICING_SWAP_COUNT));
  const swapCount = countStr ? Number(countStr) : 0;

  if (spent > 0n && gas > 0n) {
    const unitCost = (spent * 10n ** 18n) / gas;
    return {
      totalUsdcSpentE6: spent,
      totalGasReturnedWei: gas,
      swapCount,
      unitCostUsdcPerWei: unitCost,
    };
  }

  return {
    totalUsdcSpentE6: 0n,
    totalGasReturnedWei: 0n,
    swapCount: 0,
    unitCostUsdcPerWei: 0n,
  };
}

/** Alias for compatibility with paymaster and dashboard. */
export async function readInventoryState(): Promise<{
  inventoryEthWei: bigint;
  inventoryCostUsdcE6: bigint;
  unitCostUsdcPerWei: bigint;
}> {
  const t = await readTotalsState();
  return {
    inventoryEthWei: t.totalGasReturnedWei,
    inventoryCostUsdcE6: t.totalUsdcSpentE6,
    unitCostUsdcPerWei: t.unitCostUsdcPerWei,
  };
}

/**
 * Quote USDC cost for gas. Uses unit cost from cumulative totals (all paid USDC / all received gas).
 * Caller must verify EntryPoint balance separately.
 */
export async function quoteFromInventory(gasWei: bigint): Promise<bigint> {
  const state = await readTotalsState();
  if (state.unitCostUsdcPerWei === 0n) {
    throw new Error("No pricing data; run a swap first");
  }
  return (gasWei * state.unitCostUsdcPerWei) / 10n ** 18n;
}

/**
 * Apply a swap: add usdcSpent and gasReturned to cumulative totals.
 * Does not deduct swap gas; treat all returned gas as user-facing per policy.
 */
export async function applyTotalsSwap(usdcSpentE6: bigint, gasReturnedWei: bigint): Promise<void> {
  if (usdcSpentE6 <= 0n || gasReturnedWei <= 0n) return;

  const spentBefore = await getBigInt(PRICING_TOTAL_USDC_E6);
  const gasBefore = await getBigInt(PRICING_TOTAL_GAS_WEI);
  const countStr = await getRedis().get(key(PRICING_SWAP_COUNT));
  const countBefore = countStr ? Number(countStr) : 0;

  const spentAfter = spentBefore + usdcSpentE6;
  const gasAfter = gasBefore + gasReturnedWei;
  const countAfter = countBefore + 1;

  await setBigInt(PRICING_TOTAL_USDC_E6, spentAfter);
  await setBigInt(PRICING_TOTAL_GAS_WEI, gasAfter);
  await getRedis().set(key(PRICING_SWAP_COUNT), String(countAfter));
}

/** No-op; cumulative model does not archive. */
export async function archiveTotals(): Promise<void> {
  /* no-op */
}

/** Deprecated: no-op. Totals model does not consume on UserOp. */
export async function consumeForUserOp(_chargedWei: bigint, _chargedUsdcE6: bigint): Promise<void> {
  /* no-op */
}

/** Deprecated: use applyTotalsSwap. Kept for migration during rollout. */
export async function applySwap(usdcInE6: bigint, ethOutWei: bigint, _swapGasWei: bigint): Promise<void> {
  await applyTotalsSwap(usdcInE6, ethOutWei);
}

/**
 * Seed pricing when empty.
 * Sets totals only if no prior swap is stored.
 */
export async function seedInventoryIfEmpty(ethWei: bigint, costUsdcE6: bigint): Promise<boolean> {
  const spent = await getBigInt(PRICING_TOTAL_USDC_E6);
  const gas = await getBigInt(PRICING_TOTAL_GAS_WEI);
  if (spent > 0n || gas > 0n) return false;

  await setBigInt(PRICING_TOTAL_USDC_E6, costUsdcE6);
  await setBigInt(PRICING_TOTAL_GAS_WEI, ethWei);
  await getRedis().set(key(PRICING_SWAP_COUNT), "1");
  return true;
}
