/**
 * Tests for metrics gas-price payload mapping from paymaster API.
 */
import { describe, it, expect } from "vitest";
import {
  bpsToMetricValue,
  deriveRuntimeUsdcPerGasE6,
  gasUnitsToMetricValue,
  mapGasPriceApiResponse,
  usdcPerGasE6ToMetricValue,
} from "../metrics";

describe("mapGasPriceApiResponse", () => {
  it("maps successful response: wei to gwei with formattedUnit gwei", () => {
    const result = mapGasPriceApiResponse(true, {
      gasPriceWei: "3000000000",
      source: "rpc",
    });
    expect(result.status).toBe("ok");
    expect(result.value).toBeDefined();
    expect(result.value!.raw).toBe("3000000000");
    expect(result.value!.formatted).toBe("3.00");
    expect(result.value!.unit).toBe("wei");
    expect(result.value!.formattedUnit).toBe("gwei");
  });

  it("normalizes source to rpc", () => {
    const result = mapGasPriceApiResponse(true, {
      gasPriceWei: "2000000000",
      source: "legacy-worker",
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("rpc");
  });

  it("preserves source rpc", () => {
    const result = mapGasPriceApiResponse(true, {
      gasPriceWei: "2500000000",
      source: "rpc",
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("rpc");
  });

  it("defaults source to rpc when missing", () => {
    const result = mapGasPriceApiResponse(true, {
      gasPriceWei: "1000000000",
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("rpc");
  });

  it("sets status error when ok is false", () => {
    const result = mapGasPriceApiResponse(false, null);
    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
  });

  it("sets status error when json is null and ok is true", () => {
    const result = mapGasPriceApiResponse(true, null);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Empty response");
  });
});

describe("gasUnitsToMetricValue", () => {
  it("formats gas count with grouping", () => {
    const v = gasUnitsToMetricValue(12_345_678n);
    expect(v.raw).toBe("12345678");
    expect(v.formatted).toBe("12,345,678");
    expect(v.unit).toBe("gas");
  });
});

describe("bpsToMetricValue", () => {
  it("maps basis points to percent display", () => {
    const v = bpsToMetricValue(500n);
    expect(v.raw).toBe("500");
    expect(v.formatted).toBe("5.00");
    expect(v.unit).toBe("bps");
    expect(v.formattedUnit).toBe("%");
  });
});

describe("deriveRuntimeUsdcPerGasE6", () => {
  it("multiplies usdc-per-wei (e6) by gas price wei with /1e18", () => {
    expect(deriveRuntimeUsdcPerGasE6(1000n, 10n ** 18n)).toBe(1000n);
    expect(deriveRuntimeUsdcPerGasE6(2n, 10n ** 18n)).toBe(2n);
  });

  it("returns 0 when gas price is non-positive", () => {
    expect(deriveRuntimeUsdcPerGasE6(1000n, 0n)).toBe(0n);
  });
});

describe("usdcPerGasE6ToMetricValue", () => {
  it("formats micro-USDC per gas as decimal with fixed precision", () => {
    const v = usdcPerGasE6ToMetricValue(12345n);
    expect(v.raw).toBe("12345");
    expect(v.formatted).toBe("0.0123450000");
    expect(v.formattedUnit).toBe("USDC/gas");
    expect(v.unit).toBe("usdc_e6_per_gas");
  });

  it("formats single micro-unit per gas", () => {
    const v = usdcPerGasE6ToMetricValue(1n);
    expect(v.raw).toBe("1");
    expect(v.formatted).toBe("0.0000010000");
  });
});
