export function shortAddress(value: string): string {
  if (!value || value.length < 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** Representative UserOp gas for a common dapp interaction (simulation / ops baseline). */
export const COMMON_DAPP_CALL_GAS_UNITS = 213_782;

function formatUsdcAmountFromNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (Math.abs(n) < 1e-8) return n.toExponential(4);
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return s || "0";
}

/**
 * Total USDC (human) for `gasUnits` at runtime USDC-per-gas in e6 micro-units
 * (same `value.raw` as dashboard metric `paymasterUsdcPerGas`, unit `usdc_e6_per_gas`).
 */
export function formatTypicalDappCallUsdc(
  runtimeUsdcPerGasUnitE6Raw: string,
  gasUnits: number = COMMON_DAPP_CALL_GAS_UNITS
): string | null {
  if (!Number.isFinite(gasUnits) || gasUnits <= 0) return null;
  try {
    const perGasE6 = BigInt(runtimeUsdcPerGasUnitE6Raw);
    const totalE6 = perGasE6 * BigInt(Math.floor(gasUnits));
    const n = Number(totalE6) / 1_000_000;
    if (!Number.isFinite(n)) return null;
    const usdc = formatUsdcAmountFromNumber(n);
    const gasLabel = Math.floor(gasUnits).toLocaleString("en-US");
    return `Typical dapp call (~${gasLabel} gas): ~${usdc} USDC`;
  } catch {
    return null;
  }
}

export function formatLogArg(_eventName: string, key: string, value: unknown): string {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "");
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(raw);

  const safeBigInt = (s: string): bigint | null => {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  };

  const usdcKeys = [
    "chargedUsdcE6",
    "quotedUsdcE6",
    "baseChargeUsdcE6",
    "referralChargeUsdcE6",
    "totalChargeUsdcE6",
    "minPostopFeeUsdcE6",
  ];
  if (usdcKeys.includes(key)) {
    const n = safeBigInt(raw);
    if (n != null) return `${(Number(n) / 1e6).toFixed(6)} USDC`;
  }

  const weiOnlyKeys = ["gasPriceApiWei", "gasPriceContractWei", "actualUserOpFeePerGas"];
  if (weiOnlyKeys.includes(key)) return raw;

  const weiKeys = ["actualGasCost", "actualGasUsed", "estimatedCostWei"];
  if (weiKeys.includes(key) || key === "gasCost") {
    const n = safeBigInt(raw);
    if (n != null) return `${(Number(n) / 1e18).toFixed(6)} MATIC`;
  }

  if (key === "referralBps") {
    const n = Number(raw);
    if (!Number.isNaN(n)) return `${(n / 100).toFixed(2)}%`;
  }

  if (
    isAddress ||
    key.toLowerCase().includes("address") ||
    key === "sender" ||
    key === "paymaster" ||
    key === "treasury" ||
    key === "referralAddress"
  ) {
    return shortAddress(raw);
  }

  if (raw.startsWith("0x") && raw.length === 66) {
    return `${raw.slice(0, 10)}…${raw.slice(-8)}`;
  }

  return raw.length > 42 ? `${raw.slice(0, 10)}…${raw.slice(-8)}` : raw;
}

export function formatLastUpdated(timestamp?: string): string {
  if (!timestamp) return "Unknown";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 5) return "Just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleString();
}
