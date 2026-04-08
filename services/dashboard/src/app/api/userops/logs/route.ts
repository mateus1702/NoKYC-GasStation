import { decodeTransactionLogs } from "@/lib/userops";
import { getSessionFromRequest } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

/** Recursively convert BigInt to string for JSON serialization */
function serializeForJson<T>(obj: T): T {
  if (typeof obj === "bigint") return String(obj) as T;
  if (Array.isArray(obj)) return obj.map(serializeForJson) as T;
  if (obj != null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serializeForJson(v);
    return out as T;
  }
  return obj;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ status: "error", logs: [], error: "unauthorized" }, { status: 401 });
    }
    if (session.role !== "admin") {
      return NextResponse.json({ status: "error", logs: [], error: "forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const txHash = searchParams.get("txHash")?.trim();
    if (!txHash || !TX_HASH_REGEX.test(txHash)) {
      return NextResponse.json({ status: "error", logs: [], error: "txHash required (0x + 64 hex chars)" }, { status: 400 });
    }

    const logs = await decodeTransactionLogs(txHash);
    return NextResponse.json({ status: "ok", logs: serializeForJson(logs) });
  } catch (e) {
    const message = (e as Error).message;
    return NextResponse.json(
      { status: "error", logs: [], error: message },
      { status: 200 }
    );
  }
}
