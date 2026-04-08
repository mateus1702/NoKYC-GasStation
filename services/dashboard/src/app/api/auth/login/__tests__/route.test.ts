import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyCredentialsMock = vi.fn();
const createSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE_NAME: "dashboard_session",
  verifyCredentials: verifyCredentialsMock,
  createSession: createSessionMock,
}));

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    verifyCredentialsMock.mockReset();
    createSessionMock.mockReset();
  });

  it("returns 400 when username/password are missing", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "", password: "" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it("returns 401 on invalid credentials", async () => {
    verifyCredentialsMock.mockResolvedValue(null);
    const { POST } = await import("@/app/api/auth/login/route");
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "bad" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(res.status).toBe(401);
    expect(json.error).toBe("invalid credentials");
  });

  it("returns 200 and sets session cookie on success", async () => {
    verifyCredentialsMock.mockResolvedValue({ username: "admin", role: "admin" });
    createSessionMock.mockResolvedValue("token-123");
    const { POST } = await import("@/app/api/auth/login/route");
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "user" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    const json = (await res.json()) as { ok: boolean; user: { username: string; role: string } };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.user).toEqual({ username: "admin", role: "admin" });
    expect(res.headers.get("set-cookie")).toContain("dashboard_session=token-123");
  });
});
