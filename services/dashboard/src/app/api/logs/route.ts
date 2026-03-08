import { fetchLogs } from "@/lib/logs";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const service = searchParams.get("service");
    const tail = searchParams.get("tail");
    const payload = await fetchLogs(service, tail);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        service: "all",
        tail: 100,
        timestamp: new Date().toISOString(),
        lines: [],
        error: (e as Error).message,
      },
      { status: 200 }
    );
  }
}
