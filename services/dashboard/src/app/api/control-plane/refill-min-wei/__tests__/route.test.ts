import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionFromRequestMock = vi.fn();
const hmgetMock = vi.fn();
const hsetMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  getSessionFromRequest: getSessionFromRequestMock,
}));

vi.mock("@project4/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@project4/shared")>();
  return {
    ...actual,
    getRedis: () => ({
      hmget: hmgetMock,
      hset: hsetMock,
    }),
  };
});

describe("GET /api/control-plane/refill-min-wei", () => {
  beforeEach(() => {
    getSessionFromRequestMock.mockReset();
    hmgetMock.mockReset();
  });

  it("returns 401 when no session", async () => {
    getSessionFromRequestMock.mockResolvedValue(null);
    const { GET } = await import("../route");
    const req = new Request("http://localhost/api/control-plane/refill-min-wei", { method: "GET" });
    const res = await GET(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  it("returns default min when redis field missing", async () => {
    getSessionFromRequestMock.mockResolvedValue({ username: "admin", role: "admin" });
    hmgetMock.mockResolvedValue([null, null, null, null, null]);
    const { GET } = await import("../route");
    const req = new Request("http://localhost/api/control-plane/refill-min-wei", { method: "GET" });
    const res = await GET(req as unknown as import("next/server").NextRequest);
    const json = (await res.json()) as { ok: boolean; source?: string; minNativeWei?: string; entrypointMultiplierX?: string };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.source).toBe("default");
    expect(json.minNativeWei).toBe((10n * 10n ** 18n).toString());
    expect(json.entrypointMultiplierX).toBe("2");
  });
});

describe("POST /api/control-plane/refill-min-wei", () => {
  beforeEach(() => {
    getSessionFromRequestMock.mockReset();
    hsetMock.mockReset();
  });

  it("returns 403 for non-admin", async () => {
    getSessionFromRequestMock.mockResolvedValue({ username: "u", role: "user" });
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/control-plane/refill-min-wei", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minNativeWei: "1000000000000000000" }),
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(403);
  });

  it("HSETs validated wei for admin", async () => {
    getSessionFromRequestMock.mockResolvedValue({ username: "admin", role: "admin" });
    hsetMock.mockResolvedValue(1);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/control-plane/refill-min-wei", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        minNativeEth: "5",
        entrypointMultiplierX: "2.0",
        paymasterNativeMultiplierX: "1.05",
        utilityMultiplierX: "1.5",
        executorMultiplierX: "1.5",
      }),
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const json = (await res.json()) as { ok: boolean; minNativeWei?: string; entrypointMultiplierX?: string };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.minNativeWei).toBe("5000000000000000000");
    expect(json.entrypointMultiplierX).toBe("2");
    expect(hsetMock).toHaveBeenCalled();
  });
});
