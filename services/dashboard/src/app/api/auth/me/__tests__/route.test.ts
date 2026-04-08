import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionFromRequestMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  getSessionFromRequest: getSessionFromRequestMock,
}));

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    getSessionFromRequestMock.mockReset();
  });

  it("returns 401 when no session exists", async () => {
    getSessionFromRequestMock.mockResolvedValue(null);
    const { GET } = await import("@/app/api/auth/me/route");
    const req = new Request("http://localhost/api/auth/me", { method: "GET" });

    const res = await GET(req as unknown as import("next/server").NextRequest);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(res.status).toBe(401);
    expect(json.error).toBe("unauthorized");
  });

  it("returns session user when authorized", async () => {
    getSessionFromRequestMock.mockResolvedValue({ username: "admin", role: "admin" });
    const { GET } = await import("@/app/api/auth/me/route");
    const req = new Request("http://localhost/api/auth/me", { method: "GET" });

    const res = await GET(req as unknown as import("next/server").NextRequest);
    const json = (await res.json()) as { ok: boolean; user: { username: string; role: string } };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.user).toEqual({ username: "admin", role: "admin" });
  });
});
