import { createSession, SESSION_COOKIE_NAME, verifyCredentials } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { username?: string; password?: string };
    const username = (body?.username || "").trim();
    const password = (body?.password || "").trim();
    if (!username || !password) {
      return NextResponse.json({ ok: false, error: "username and password are required" }, { status: 400 });
    }

    const user = await verifyCredentials(username, password);
    if (!user) {
      return NextResponse.json({ ok: false, error: "invalid credentials" }, { status: 401 });
    }

    const token = await createSession({ username: user.username, role: user.role });
    const res = NextResponse.json({ ok: true, user: { username: user.username, role: user.role } });
    res.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

