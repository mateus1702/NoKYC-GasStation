import { describe, it } from "mocha";
import { expect } from "chai";
import { computeUsdcPerGasUnitE6FromCounters, computeUsdcPerWeiE6FromCounters } from "../pricing-from-counters.js";

describe("computeUsdcPerWeiE6FromCounters", () => {
  it("uses fallback when gas bought is zero", () => {
    const v = computeUsdcPerWeiE6FromCounters({
      totalUsdcSpentForGasE6: 0n,
      totalGasBoughtWei: 0n,
      amplifierBps: 0n,
      serviceFeeBps: 500n,
      fallbackUsdcPerWeiE6: 100n,
    });
    expect(v).to.equal((100n * 10500n) / 10000n);
  });

  it("computes USDC e6 per wei from U/B with amplifier and fee", () => {
    const B = 2n * 10n ** 18n;
    const U = 1_000_000n;
    const v = computeUsdcPerWeiE6FromCounters({
      totalUsdcSpentForGasE6: U,
      totalGasBoughtWei: B,
      amplifierBps: 10000n,
      serviceFeeBps: 0n,
      fallbackUsdcPerWeiE6: 1n,
    });
    const raw = (U * 10n ** 18n) / B;
    const doubled = (raw * 20000n) / 10000n;
    expect(v).to.equal(doubled);
  });
});

describe("computeUsdcPerGasUnitE6FromCounters", () => {
  it("uses fallback when counters are empty", () => {
    const v = computeUsdcPerGasUnitE6FromCounters({
      totalGasUnitsProcessed: 0n,
      totalUsdcSpentForGasE6: 0n,
      totalGasBoughtWei: 0n,
      amplifierBps: 0n,
      serviceFeeBps: 500n,
      fallbackUsdcPerGasUnitE6: 100n,
    });
    expect(v).to.equal((100n * 10500n) / 10000n);
  });

  it("computes from counters with amplifier and fee", () => {
    const G = 100_000n;
    const B = 2n * 10n ** 18n;
    const U = 1_000_000n;
    const v = computeUsdcPerGasUnitE6FromCounters({
      totalGasUnitsProcessed: G,
      totalUsdcSpentForGasE6: U,
      totalGasBoughtWei: B,
      amplifierBps: 10000n,
      serviceFeeBps: 0n,
      fallbackUsdcPerGasUnitE6: 1n,
    });
    const gasWeiPerUnit = B / G;
    const usdcPerWei = (U * 10n ** 18n) / B;
    const raw = (gasWeiPerUnit * usdcPerWei) / 10n ** 18n;
    const doubled = (raw * 20000n) / 10000n;
    expect(v).to.equal(doubled);
  });
});
