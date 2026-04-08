import { describe, expect, it, vi } from "vitest";
import {
  COMMON_DAPP_CALL_GAS_UNITS,
  formatLastUpdated,
  formatLogArg,
  formatTypicalDappCallUsdc,
  shortAddress,
} from "@/lib/dashboard-format";

describe("shortAddress", () => {
  it("keeps short values unchanged", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });

  it("shortens long addresses", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
  });
});

describe("formatLogArg", () => {
  it("formats USDC e6 amounts", () => {
    expect(formatLogArg("GasCharged", "chargedUsdcE6", "1234567")).toBe("1.234567 USDC");
  });

  it("keeps fee-per-gas wei values raw", () => {
    expect(formatLogArg("GasCharged", "actualUserOpFeePerGas", "3000000000")).toBe("3000000000");
  });

  it("formats basis points as percentage", () => {
    expect(formatLogArg("GasChargedWithReferral", "referralBps", "250")).toBe("2.50%");
  });

  it("shortens addresses and long hashes", () => {
    expect(formatLogArg("Any", "sender", "0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234...5678"
    );
    expect(
      formatLogArg(
        "Any",
        "userOpHash",
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      )
    ).toBe("0x12345678…90abcdef");
  });
});

describe("formatTypicalDappCallUsdc", () => {
  it("multiplies per-gas e6 by default common call gas", () => {
    // 2 e6 per gas * 213_782 gas = 427_564 e6 -> 0.427564 USDC
    const line = formatTypicalDappCallUsdc("2");
    expect(line).toContain("213,782");
    expect(line).toContain("~0.427564");
    expect(line).toContain("USDC");
  });

  it("respects custom gas units", () => {
    // 1000 e6 per gas * 1000 gas = 1e6 e6 = 1 USDC
    expect(formatTypicalDappCallUsdc("1000", 1000)).toBe("Typical dapp call (~1,000 gas): ~1 USDC");
  });

  it("returns null for invalid input", () => {
    expect(formatTypicalDappCallUsdc("not-a-number")).toBeNull();
    expect(formatTypicalDappCallUsdc("1", -1)).toBeNull();
    expect(formatTypicalDappCallUsdc("1", NaN)).toBeNull();
  });

  it("exports baseline gas constant", () => {
    expect(COMMON_DAPP_CALL_GAS_UNITS).toBe(213_782);
  });
});

describe("formatLastUpdated", () => {
  it("returns Unknown when timestamp is missing or invalid", () => {
    expect(formatLastUpdated()).toBe("Unknown");
    expect(formatLastUpdated("not-a-date")).toBe("Unknown");
  });

  it("formats relative time windows", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-19T12:00:00.000Z").getTime());
    try {
      expect(formatLastUpdated("2026-03-19T11:59:58.000Z")).toBe("Just now");
      expect(formatLastUpdated("2026-03-19T11:59:40.000Z")).toBe("20s ago");
      expect(formatLastUpdated("2026-03-19T11:58:00.000Z")).toBe("2m ago");
      expect(formatLastUpdated("2026-03-19T10:00:00.000Z")).toBe("2h ago");
    } finally {
      nowSpy.mockRestore();
    }
  });
});
