export const REFERRAL_BPS_MAX = 500n;

export interface ReferralContext {
  referralAddress: string;
  referralBps: bigint;
}

export function parseReferralContext(params2: unknown): ReferralContext {
  const def: ReferralContext = { referralAddress: "0x0000000000000000000000000000000000000000", referralBps: 0n };
  if (params2 == null || typeof params2 !== "object") return def;
  const ctx = params2 as Record<string, unknown>;
  const rawBps = ctx.referralBps;
  const rawAddr = ctx.referralAddress;
  if (rawBps == null && rawAddr == null) return def;

  let bps = 0n;
  if (rawBps != null) {
    const n = typeof rawBps === "number" ? BigInt(Math.floor(rawBps)) : BigInt(String(rawBps));
    if (n < 0n || n > REFERRAL_BPS_MAX) {
      throw new Error(`referralBps must be 0-${REFERRAL_BPS_MAX}, got ${n}`);
    }
    bps = n;
  }

  let addr = "0x0000000000000000000000000000000000000000";
  if (rawAddr != null) {
    const s = String(rawAddr).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(s)) {
      throw new Error("referralAddress must be a valid 20-byte hex address");
    }
    addr = s;
  }

  if (bps > 0n && addr === "0x0000000000000000000000000000000000000000") {
    throw new Error("referralAddress required when referralBps > 0");
  }

  return { referralAddress: addr, referralBps: bps };
}
