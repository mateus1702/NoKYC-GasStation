/**
 * Unit tests for pure profitability and fee math.
 * No Redis/HTTP/env; deterministic table-driven cases.
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import {
  BPS_DENOMINATOR,
  computeChargeFromGas,
  computeCogsFromGasSold,
  computeEffectiveUnitCost,
  computeProfitability,
  computeReferralSplit,
  deriveFreshSwapWmaticWei,
  deriveNetPricingGasWei,
  deriveUnitCostFromTotals,
  SCALE_18,
} from "../profitability.js";

describe("deriveUnitCostFromTotals", () => {
  it("computes unit cost from cumulative totals", () => {
    const totalUsdc = 10_000_000n;
    const totalGas = 5n * SCALE_18;
    expect(deriveUnitCostFromTotals(totalUsdc, totalGas)).to.equal(2_000_000n);
  });

  it("returns zero when gas is zero", () => {
    expect(deriveUnitCostFromTotals(10_000_000n, 0n)).to.equal(0n);
  });
});

describe("computeEffectiveUnitCost", () => {
  const base = 2_000_000n;

  it("applies service fee only", () => {
    const effective = computeEffectiveUnitCost({
      baseUnitCostUsdcPerWei: base,
      serviceFeeBps: 500n,
    });
    expect(effective).to.equal((base * 10_500n) / 10_000n);
  });

  it("returns base when service fee is zero", () => {
    expect(
      computeEffectiveUnitCost({
        baseUnitCostUsdcPerWei: base,
        serviceFeeBps: 0n,
      })
    ).to.equal(base);
  });

  it("returns zero when base is zero", () => {
    expect(
      computeEffectiveUnitCost({
        baseUnitCostUsdcPerWei: 0n,
        serviceFeeBps: 500n,
      })
    ).to.equal(0n);
  });

  it("rounds down on fractional markup", () => {
    const small = 1n;
    const effective = computeEffectiveUnitCost({
      baseUnitCostUsdcPerWei: small,
      serviceFeeBps: 1n,
    });
    const upper = (small * 10_001n) / 10_000n;
    expect(effective <= upper).to.be.true;
  });
});

describe("computeChargeFromGas", () => {
  const unitCost = 2_000_000n;
  const minFee = 10_000n;
  const maxCost = 50_000_000n;

  it("computes charge from gas when within bounds", () => {
    const gasWei = 10n * SCALE_18;
    const res = computeChargeFromGas({
      actualGasCostWei: gasWei,
      unitCostUsdcPerWei: unitCost,
      minPostopFeeUsdcE6: minFee,
      maxCostUsdcE6: maxCost,
    });
    const expected = (gasWei * unitCost) / SCALE_18;
    expect(res.chargeAmountUsdcE6).to.equal(expected);
    expect(res.initialChargeAmountUsdcE6).to.equal(expected);
    expect(res.wasMinFeeApplied).to.be.false;
    expect(res.wasMaxFeeApplied).to.be.false;
  });

  it("enforces minimum fee when charge truncates to zero", () => {
    const tinyGas = 1n;
    const res = computeChargeFromGas({
      actualGasCostWei: tinyGas,
      unitCostUsdcPerWei: unitCost,
      minPostopFeeUsdcE6: minFee,
      maxCostUsdcE6: maxCost,
    });
    expect(res.chargeAmountUsdcE6).to.equal(minFee);
    expect(res.wasMinFeeApplied).to.be.true;
    expect(res.wasMaxFeeApplied).to.be.false;
  });

  it("enforces max fee when charge exceeds cap", () => {
    const hugeGas = 30n * SCALE_18;
    const res = computeChargeFromGas({
      actualGasCostWei: hugeGas,
      unitCostUsdcPerWei: unitCost,
      minPostopFeeUsdcE6: minFee,
      maxCostUsdcE6: maxCost,
    });
    expect(res.chargeAmountUsdcE6).to.equal(maxCost);
    expect(res.wasMaxFeeApplied).to.be.true;
  });

  it("invariant: charge >= min fee when charging active", () => {
    const gasCasesWei: bigint[] = [0n, 1n, 100n, 1_000n * 1_000_000_000n, 100_000n * 1_000_000_000n];
    for (const gasWei of gasCasesWei) {
      const res = computeChargeFromGas({
        actualGasCostWei: gasWei,
        unitCostUsdcPerWei: unitCost,
        minPostopFeeUsdcE6: minFee,
        maxCostUsdcE6: maxCost,
      });
      if (res.chargeAmountUsdcE6 > 0n) {
        expect(res.chargeAmountUsdcE6 >= minFee).to.be.true;
      }
    }
  });

  it("invariant: charge <= max cost", () => {
    const gasCasesWei: bigint[] = [0n, 1n, 100n, 1_000n * 1_000_000_000n, 10n * SCALE_18];
    for (const gasWei of gasCasesWei) {
      const res = computeChargeFromGas({
        actualGasCostWei: gasWei,
        unitCostUsdcPerWei: unitCost,
        minPostopFeeUsdcE6: minFee,
        maxCostUsdcE6: maxCost,
      });
      expect(res.chargeAmountUsdcE6 <= maxCost).to.be.true;
    }
  });

  it("returns zero when unit cost is zero", () => {
    const res = computeChargeFromGas({
      actualGasCostWei: 1n * SCALE_18,
      unitCostUsdcPerWei: 0n,
      minPostopFeeUsdcE6: minFee,
      maxCostUsdcE6: maxCost,
    });
    expect(res.chargeAmountUsdcE6).to.equal(0n);
  });
});

describe("swap accounting regression (stale WMATIC overcount)", () => {
  it("shows stale WMATIC in gas totals collapses unit cost and forces min fee", () => {
    // Single swap spends 14 USDC and actually returns only 0.5 native token for user ops.
    // If stale WMATIC (100 tokens) is mistakenly counted as fresh swap output, denominator explodes.
    const usdcSpentE6 = 14_000_000n;
    const freshSwapGasWei = 500_000_000_000_000_000n; // 0.5
    const staleWmaticWei = 100_000_000_000_000_000_000n; // 100
    const inflatedGasWei = freshSwapGasWei + staleWmaticWei; // wrong denominator

    const correctUnitCost = deriveUnitCostFromTotals(usdcSpentE6, freshSwapGasWei);
    const inflatedUnitCost = deriveUnitCostFromTotals(usdcSpentE6, inflatedGasWei);
    expect(correctUnitCost).to.equal(28_000_000n);
    expect(inflatedUnitCost).to.equal(139_303n);
    expect(inflatedUnitCost < correctUnitCost / 100n).to.be.true;

    // Heavy user op that should be above min fee under correct unit cost.
    const actualGasCostWei = 2_000_000_000_000_000n;
    const minPostopFeeUsdcE6 = 10_000n;
    const maxCostUsdcE6 = 1_000_000_000n;

    const chargeWithCorrectTotals = computeChargeFromGas({
      actualGasCostWei,
      unitCostUsdcPerWei: correctUnitCost,
      minPostopFeeUsdcE6,
      maxCostUsdcE6,
    });
    expect(chargeWithCorrectTotals.initialChargeAmountUsdcE6).to.equal(56_000n);
    expect(chargeWithCorrectTotals.wasMinFeeApplied).to.be.false;

    const chargeWithInflatedTotals = computeChargeFromGas({
      actualGasCostWei,
      unitCostUsdcPerWei: inflatedUnitCost,
      minPostopFeeUsdcE6,
      maxCostUsdcE6,
    });
    expect(chargeWithInflatedTotals.initialChargeAmountUsdcE6).to.equal(278n);
    expect(chargeWithInflatedTotals.chargeAmountUsdcE6).to.equal(minPostopFeeUsdcE6);
    expect(chargeWithInflatedTotals.wasMinFeeApplied).to.be.true;
  });
});

describe("swap output accounting helpers", () => {
  it("counts only fresh WMATIC received in current swap", () => {
    const staleWmaticWei = 100n * SCALE_18;
    const freshWmaticWei = 5n * SCALE_18;
    const wmaticBefore = staleWmaticWei;
    const wmaticAfter = staleWmaticWei + freshWmaticWei;
    expect(
      deriveFreshSwapWmaticWei({
        wmaticBeforeSwapWei: wmaticBefore,
        wmaticAfterSwapWei: wmaticAfter,
      })
    ).to.equal(freshWmaticWei);
  });

  it("returns zero when post-swap WMATIC is not above pre-swap", () => {
    expect(
      deriveFreshSwapWmaticWei({
        wmaticBeforeSwapWei: 10n,
        wmaticAfterSwapWei: 9n,
      })
    ).to.equal(0n);
  });

  it("derives non-negative net pricing gas", () => {
    expect(
      deriveNetPricingGasWei({
        freshSwapGasWei: 5n * SCALE_18,
        distributionTxGasWei: 1n * SCALE_18,
      })
    ).to.equal(4n * SCALE_18);
    expect(
      deriveNetPricingGasWei({
        freshSwapGasWei: 1n,
        distributionTxGasWei: 2n,
      })
    ).to.equal(0n);
  });
});

describe("computeReferralSplit (P4 shared math)", () => {
  it("computes base and referral with total = base + referral", () => {
    const baseCharge = 1_000_000n;
    const referralBps = 200n;
    const { referralAmountUsdcE6, totalChargeUsdcE6 } = computeReferralSplit({ baseChargeUsdcE6: baseCharge, referralBps });
    expect(referralAmountUsdcE6).to.equal((baseCharge * referralBps) / 10_000n);
    expect(totalChargeUsdcE6).to.equal(baseCharge + referralAmountUsdcE6);
  });

  it("returns zero referral when referralBps is 0", () => {
    const baseCharge = 1_000_000n;
    const { referralAmountUsdcE6, totalChargeUsdcE6 } = computeReferralSplit({ baseChargeUsdcE6: baseCharge, referralBps: 0n });
    expect(referralAmountUsdcE6).to.equal(0n);
    expect(totalChargeUsdcE6).to.equal(baseCharge);
  });

  it("rounds down referral (floor)", () => {
    const baseCharge = 999n;
    const referralBps = 100n; // 1%
    const { referralAmountUsdcE6 } = computeReferralSplit({ baseChargeUsdcE6: baseCharge, referralBps });
    expect(referralAmountUsdcE6).to.equal(9n); // floor(999*100/10000) = 9
    expect(referralAmountUsdcE6).to.equal((baseCharge * referralBps) / 10_000n);
  });
});

describe("computeCogsFromGasSold", () => {
  it("computes COGS from gas sold and unit cost", () => {
    const gas = 1n * SCALE_18;
    const unitCost = 2_000_000n;
    expect(
      computeCogsFromGasSold({ gasSoldWei: gas, unitCostUsdcPerWei: unitCost })
    ).to.equal(2_000_000n);
  });

  it("returns zero when unit cost is zero", () => {
    expect(
      computeCogsFromGasSold({
        gasSoldWei: 1n * SCALE_18,
        unitCostUsdcPerWei: 0n,
      })
    ).to.equal(0n);
  });

  it("rounds down on fractional wei", () => {
    const gas = 1n;
    const unitCost = 2_000_000n;
    const cogs = computeCogsFromGasSold({ gasSoldWei: gas, unitCostUsdcPerWei: unitCost });
    expect(cogs).to.equal(0n);
  });
});

describe("computeProfitability", () => {
  it("profitability baseline: revenue > COGS yields profit", () => {
    const revenue = 75_000n;
    const gasSold = 1n * SCALE_18;
    const unitCost = 50_000n;
    const res = computeProfitability({
      revenueUsdcE6: revenue,
      gasSoldWei: gasSold,
      unitCostUsdcPerWei: unitCost,
    });
    expect(res.cogsUsdcE6).to.equal(50_000n);
    expect(res.profitUsdcE6).to.equal(25_000n);
    expect(res.marginBps).to.equal(5_000n);
    expect(res.isProfitable).to.be.true;
  });

  it("zero gas sold: no COGS, full revenue is profit", () => {
    const res = computeProfitability({
      revenueUsdcE6: 100_000n,
      gasSoldWei: 0n,
      unitCostUsdcPerWei: 2_000_000n,
    });
    expect(res.cogsUsdcE6).to.equal(0n);
    expect(res.profitUsdcE6).to.equal(100_000n);
    expect(res.marginBps).to.equal(0n);
    expect(res.isProfitable).to.be.true;
  });

  it("zero revenue: no profit", () => {
    const res = computeProfitability({
      revenueUsdcE6: 0n,
      gasSoldWei: 1n * SCALE_18,
      unitCostUsdcPerWei: 2_000_000n,
    });
    expect(res.profitUsdcE6).to.equal(0n);
    expect(res.marginBps).to.equal(0n);
    expect(res.isProfitable).to.be.false;
  });

  it("revenue < COGS: not profitable", () => {
    const res = computeProfitability({
      revenueUsdcE6: 10_000n,
      gasSoldWei: 1n * SCALE_18,
      unitCostUsdcPerWei: 100_000n,
    });
    expect(res.cogsUsdcE6).to.equal(100_000n);
    expect(res.profitUsdcE6).to.equal(0n);
    expect(res.isProfitable).to.be.false;
  });

  it("margin BPS is stable across large bigint values", () => {
    const revenue = 1_000n * 1_000_000n;
    const gasSold = 100n * SCALE_18;
    const unitCost = 8_000_000n;
    const res = computeProfitability({
      revenueUsdcE6: revenue,
      gasSoldWei: gasSold,
      unitCostUsdcPerWei: unitCost,
    });
    const expectedCogs = (gasSold * unitCost) / SCALE_18;
    expect(res.cogsUsdcE6).to.equal(expectedCogs);
    expect(res.profitUsdcE6).to.equal(revenue - expectedCogs);
    expect(res.marginBps).to.equal(((revenue - expectedCogs) * BPS_DENOMINATOR) / expectedCogs);
  });

  it("min fee binding: low gas rounds down but min fee yields margin", () => {
    const unitCost = 2_000_000n;
    const gasSold = 1n * SCALE_18;
    const cogs = computeCogsFromGasSold({ gasSoldWei: gasSold, unitCostUsdcPerWei: unitCost });
    expect(cogs).to.equal(2_000_000n);
    const revenue = 2_500_000n;
    const res = computeProfitability({
      revenueUsdcE6: revenue,
      gasSoldWei: gasSold,
      unitCostUsdcPerWei: unitCost,
    });
    expect(res.cogsUsdcE6).to.equal(2_000_000n);
    expect(res.profitUsdcE6).to.equal(500_000n);
    expect(res.isProfitable).to.be.true;
  });
});
