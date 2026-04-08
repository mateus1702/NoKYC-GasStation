/**
 * Tests for Hero metric card gas price display labels.
 */
import { describe, it, expect } from "vitest";
import { getGasPriceHeroTitle } from "@/lib/gas-price-hero";

describe("Hero gas price display", () => {
  it("shows Effective Gas Price (RPC)", () => {
    expect(getGasPriceHeroTitle("rpc")).toBe("Effective Gas Price (RPC)");
  });

  it("shows same title when source is undefined", () => {
    expect(getGasPriceHeroTitle()).toBe("Effective Gas Price (RPC)");
  });
});
