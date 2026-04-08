import { getSessionFromRequest } from "@/lib/auth";
import { configHashKey, getRedis, key } from "@project4/shared";
import { formatEther, parseEther } from "viem";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FIELD_MIN_WEI = "PAYMASTER_API_REFILL_MIN_NATIVE_WEI";
const FIELD_ENTRYPOINT_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_ENTRYPOINT_BPS";
const FIELD_PAYMASTER_NATIVE_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS";
const FIELD_UTILITY_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_UTILITY_BPS";
const FIELD_EXECUTOR_BPS = "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_EXECUTOR_BPS";
const DEFAULT_MIN_WEI = 10n * 10n ** 18n;
const DEFAULT_ENTRYPOINT_BPS = 20_000n;
const DEFAULT_PAYMASTER_NATIVE_BPS = 10_500n;
const DEFAULT_UTILITY_BPS = 15_000n;
const DEFAULT_EXECUTOR_BPS = 15_000n;

function parsePositiveBpsOrDefault(raw: string | null | undefined, fallback: bigint): bigint {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = BigInt(trimmed);
    return parsed >= 10_000n && parsed <= 1_000_000n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseMultiplierXToBps(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = BigInt(wholeRaw);
  const fracPadded = (fracRaw + "0000").slice(0, 4);
  const frac = BigInt(fracPadded);
  const bps = whole * 10000n + frac;
  if (bps < 10000n || bps > 1_000_000n) return null;
  return bps;
}

function bpsToXString(bps: bigint): string {
  const whole = bps / 10000n;
  const frac = (bps % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const out = await getRedis().hmget(
      key(configHashKey("paymaster-api")),
      FIELD_MIN_WEI,
      FIELD_ENTRYPOINT_BPS,
      FIELD_PAYMASTER_NATIVE_BPS,
      FIELD_UTILITY_BPS,
      FIELD_EXECUTOR_BPS
    );
    const minRaw = out[0]?.trim();
    let wei: bigint;
    if (minRaw) {
      wei = BigInt(minRaw);
      if (wei <= 0n) {
        return NextResponse.json({ ok: false, error: "invalid_stored_min_wei" }, { status: 500 });
      }
    } else {
      wei = DEFAULT_MIN_WEI;
    }
    const entrypointBps = parsePositiveBpsOrDefault(out[1], DEFAULT_ENTRYPOINT_BPS);
    const paymasterNativeBps = parsePositiveBpsOrDefault(out[2], DEFAULT_PAYMASTER_NATIVE_BPS);
    const utilityBps = parsePositiveBpsOrDefault(out[3], DEFAULT_UTILITY_BPS);
    const executorBps = parsePositiveBpsOrDefault(out[4], DEFAULT_EXECUTOR_BPS);

    return NextResponse.json({
      ok: true,
      minNativeWei: wei.toString(),
      minNativeEth: formatEther(wei),
      entrypointMultiplierBps: entrypointBps.toString(),
      paymasterNativeMultiplierBps: paymasterNativeBps.toString(),
      utilityMultiplierBps: utilityBps.toString(),
      executorMultiplierBps: executorBps.toString(),
      entrypointMultiplierX: bpsToXString(entrypointBps),
      paymasterNativeMultiplierX: bpsToXString(paymasterNativeBps),
      utilityMultiplierX: bpsToXString(utilityBps),
      executorMultiplierX: bpsToXString(executorBps),
      source: minRaw ? "redis" : "default",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const minEthRaw = (body as { minNativeEth?: unknown }).minNativeEth;
  const minWeiRaw = (body as { minNativeWei?: unknown }).minNativeWei;

  let wei: bigint;
  if (typeof minEthRaw === "string" && minEthRaw.trim()) {
    try {
      wei = parseEther(minEthRaw.trim());
    } catch {
      return NextResponse.json({ ok: false, error: "minNativeEth_invalid_decimal" }, { status: 400 });
    }
  } else if (typeof minWeiRaw === "string" && minWeiRaw.trim()) {
    try {
      wei = BigInt(minWeiRaw.trim());
    } catch {
      return NextResponse.json({ ok: false, error: "minNativeWei_not_integer" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ ok: false, error: "minNativeEth_or_minNativeWei_required" }, { status: 400 });
  }
  if (wei <= 0n) {
    return NextResponse.json({ ok: false, error: "minNativeWei_must_be_positive" }, { status: 400 });
  }

  const entrypointXRaw = (body as { entrypointMultiplierX?: unknown }).entrypointMultiplierX;
  const paymasterNativeXRaw = (body as { paymasterNativeMultiplierX?: unknown }).paymasterNativeMultiplierX;
  const utilityXRaw = (body as { utilityMultiplierX?: unknown }).utilityMultiplierX;
  const executorXRaw = (body as { executorMultiplierX?: unknown }).executorMultiplierX;

  const entrypointBps =
    typeof entrypointXRaw === "string" && entrypointXRaw.trim()
      ? parseMultiplierXToBps(entrypointXRaw)
      : DEFAULT_ENTRYPOINT_BPS;
  if (entrypointBps == null) {
    return NextResponse.json({ ok: false, error: "entrypointMultiplierX_invalid" }, { status: 400 });
  }
  const paymasterNativeBps =
    typeof paymasterNativeXRaw === "string" && paymasterNativeXRaw.trim()
      ? parseMultiplierXToBps(paymasterNativeXRaw)
      : DEFAULT_PAYMASTER_NATIVE_BPS;
  if (paymasterNativeBps == null) {
    return NextResponse.json({ ok: false, error: "paymasterNativeMultiplierX_invalid" }, { status: 400 });
  }
  const utilityBps =
    typeof utilityXRaw === "string" && utilityXRaw.trim()
      ? parseMultiplierXToBps(utilityXRaw)
      : DEFAULT_UTILITY_BPS;
  if (utilityBps == null) {
    return NextResponse.json({ ok: false, error: "utilityMultiplierX_invalid" }, { status: 400 });
  }
  const executorBps =
    typeof executorXRaw === "string" && executorXRaw.trim()
      ? parseMultiplierXToBps(executorXRaw)
      : DEFAULT_EXECUTOR_BPS;
  if (executorBps == null) {
    return NextResponse.json({ ok: false, error: "executorMultiplierX_invalid" }, { status: 400 });
  }

  try {
    await getRedis().hset(key(configHashKey("paymaster-api")), {
      [FIELD_MIN_WEI]: wei.toString(),
      [FIELD_ENTRYPOINT_BPS]: entrypointBps.toString(),
      [FIELD_PAYMASTER_NATIVE_BPS]: paymasterNativeBps.toString(),
      [FIELD_UTILITY_BPS]: utilityBps.toString(),
      [FIELD_EXECUTOR_BPS]: executorBps.toString(),
    });
    return NextResponse.json({
      ok: true,
      minNativeWei: wei.toString(),
      minNativeEth: formatEther(wei),
      entrypointMultiplierBps: entrypointBps.toString(),
      paymasterNativeMultiplierBps: paymasterNativeBps.toString(),
      utilityMultiplierBps: utilityBps.toString(),
      executorMultiplierBps: executorBps.toString(),
      entrypointMultiplierX: bpsToXString(entrypointBps),
      paymasterNativeMultiplierX: bpsToXString(paymasterNativeBps),
      utilityMultiplierX: bpsToXString(utilityBps),
      executorMultiplierX: bpsToXString(executorBps),
      source: "redis",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
