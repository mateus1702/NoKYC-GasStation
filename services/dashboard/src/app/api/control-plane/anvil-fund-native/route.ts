import { getSessionFromRequest } from "@/lib/auth";
import { loadDashboardRedisConfig } from "@project4/shared";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const secret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: "PAYMASTER_API_REFILL_TRIGGER_SECRET not set on dashboard",
      },
      { status: 503 }
    );
  }

  try {
    const cfg = await loadDashboardRedisConfig();
    const base = cfg.PAYMASTER_API_URL.replace(/\/$/, "");
    const url = `${base}/anvil-dev/fund-native`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return NextResponse.json(
        { ok: false, error: "paymaster_api_non_json", status: res.status, body: text.slice(0, 500) },
        { status: 502 }
      );
    }
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
