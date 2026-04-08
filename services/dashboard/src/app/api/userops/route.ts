import { fetchRecentProcessedUserOps } from "@/lib/userops";
import { getSessionFromRequest } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ status: "error", items: [], timestamp: new Date().toISOString(), error: "unauthorized" }, { status: 401 });
    }
    if (session.role !== "admin") {
      return NextResponse.json({ status: "error", items: [], timestamp: new Date().toISOString(), error: "forbidden" }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 100) : 30;
    const payload = await fetchRecentProcessedUserOps(limit);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        items: [],
        timestamp: new Date().toISOString(),
        error: (e as Error).message,
      },
      { status: 200 }
    );
  }
}
