/**
 * Pricing reconciler state: base unit cost derived from balance deltas + UserOp cursor.
 * GasCharged-driven pricing paths may update this state for Paymaster API consumers.
 */
import { getBigInt, getRedis, key, setBigInt } from "./redis.js";
import { readTotalsState } from "./inventory.js";

const RECON_UNIT_COST = "pricing:recon:unit_cost_usdc_per_wei";
const RECON_TOTAL_CHARGED = "pricing:recon:total_charged_usdc_e6";
const RECON_TOTAL_GAS = "pricing:recon:total_gas_consumed_wei";
const RECON_CURSOR_BLOCK = "pricing:recon:cursor_block";
const RECON_CURSOR_TX = "pricing:recon:cursor_tx";
const RECON_CURSOR_LOG_INDEX = "pricing:recon:cursor_log_index";
const RECON_GAS_PRICE_WEI = "pricing:recon:gas_price_wei";
const GAS_PRICE_CURSOR_BLOCK = "pricing:gas_price:cursor_block";
const GAS_PRICE_CURSOR_TX = "pricing:gas_price:cursor_tx";
const GAS_PRICE_CURSOR_LOG_INDEX = "pricing:gas_price:cursor_log_index";
const SCALE_18 = 10n ** 18n;

export interface GasPriceCursor {
  block: bigint;
  tx: string;
  logIndex: number;
}

/** Read gas price tracker cursor. Returns empty cursor if not set. */
export async function readGasPriceCursor(): Promise<GasPriceCursor> {
  const [blockStr, tx, logStr] = await Promise.all([
    getRedis().get(key(GAS_PRICE_CURSOR_BLOCK)),
    getRedis().get(key(GAS_PRICE_CURSOR_TX)),
    getRedis().get(key(GAS_PRICE_CURSOR_LOG_INDEX)),
  ]);
  return {
    block: blockStr ? BigInt(blockStr) : 0n,
    tx: tx ?? "",
    logIndex: logStr ? Number(logStr) : 0,
  };
}

/** Persist gas price tracker cursor. */
export async function setGasPriceCursor(block: bigint, tx: string, logIndex: number): Promise<void> {
  await getRedis().set(key(GAS_PRICE_CURSOR_BLOCK), block.toString());
  await getRedis().set(key(GAS_PRICE_CURSOR_TX), tx);
  await getRedis().set(key(GAS_PRICE_CURSOR_LOG_INDEX), String(logIndex));
}

export interface ReconcilerState {
  unitCostUsdcPerWei: bigint;
  totalChargedUsdcE6: bigint;
  totalGasConsumedWei: bigint;
  cursorBlock: bigint;
  cursorTx: string;
  cursorLogIndex: number;
}

/** Read reconciler gas price (wei). Returns 0n if missing or invalid. */
export async function readReconcilerGasPriceWei(): Promise<bigint> {
  return getBigInt(RECON_GAS_PRICE_WEI);
}

/** Set reconciler gas price (wei). Ignored when gasPriceWei <= 0n. */
export async function setReconcilerGasPriceWei(gasPriceWei: bigint): Promise<void> {
  if (gasPriceWei <= 0n) return;
  await setBigInt(RECON_GAS_PRICE_WEI, gasPriceWei);
}

/** Read reconciler base unit cost. Returns 0n if not yet set. */
export async function readReconcilerUnitCost(): Promise<bigint> {
  return getBigInt(RECON_UNIT_COST);
}

/** Read full reconciler state. */
export async function readReconcilerState(): Promise<ReconcilerState> {
  const [unitCost, totalCharged, totalGas, cursorBlockStr, cursorTx, cursorLogStr] = await Promise.all([
    getBigInt(RECON_UNIT_COST),
    getBigInt(RECON_TOTAL_CHARGED),
    getBigInt(RECON_TOTAL_GAS),
    getRedis().get(key(RECON_CURSOR_BLOCK)),
    getRedis().get(key(RECON_CURSOR_TX)),
    getRedis().get(key(RECON_CURSOR_LOG_INDEX)),
  ]);
  return {
    unitCostUsdcPerWei: unitCost,
    totalChargedUsdcE6: totalCharged,
    totalGasConsumedWei: totalGas,
    cursorBlock: cursorBlockStr ? BigInt(cursorBlockStr) : 0n,
    cursorTx: cursorTx ?? "",
    cursorLogIndex: cursorLogStr ? Number(cursorLogStr) : 0,
  };
}

/** Set reconciler base unit cost. */
export async function setReconcilerUnitCost(unitCostUsdcPerWei: bigint): Promise<void> {
  await setBigInt(RECON_UNIT_COST, unitCostUsdcPerWei);
}

/** Add a charged UserOp to rolling totals and recompute unit cost. */
export async function addChargedUserOp(chargedUsdcE6: bigint, gasCostWei: bigint): Promise<void> {
  if (chargedUsdcE6 <= 0n || gasCostWei <= 0n) return;
  const totalCharged = await getBigInt(RECON_TOTAL_CHARGED);
  const totalGas = await getBigInt(RECON_TOTAL_GAS);
  const newCharged = totalCharged + chargedUsdcE6;
  const newGas = totalGas + gasCostWei;
  await setBigInt(RECON_TOTAL_CHARGED, newCharged);
  await setBigInt(RECON_TOTAL_GAS, newGas);
  const unitCost = (newCharged * SCALE_18) / newGas;
  await setReconcilerUnitCost(unitCost);
}

/** Advance reconciler cursor after processing events. */
export async function setReconcilerCursor(block: bigint, txHash: string, logIndex: number): Promise<void> {
  await getRedis().set(key(RECON_CURSOR_BLOCK), block.toString());
  await getRedis().set(key(RECON_CURSOR_TX), txHash);
  await getRedis().set(key(RECON_CURSOR_LOG_INDEX), String(logIndex));
}

/**
 * Initialize reconciler from swap totals when no UserOp data yet.
 * Call at service startup to seed base cost from cumulative swap history.
 */
export async function initReconcilerFromTotals(): Promise<boolean> {
  const existing = await readReconcilerUnitCost();
  if (existing > 0n) return false;
  const totals = await readTotalsState();
  if (totals.unitCostUsdcPerWei === 0n) return false;
  await setReconcilerUnitCost(totals.unitCostUsdcPerWei);
  return true;
}
