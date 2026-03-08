/**
 * Unit tests for totals-only pricing math
 * unit_cost = total_usdc_spent_e6 / total_gas_returned_wei
 */
import { describe, it } from "mocha";
import { expect } from "chai";

describe("Totals-only pricing math", () => {
  it("should compute unit cost from single swap totals", () => {
    const usdcInE6 = 10_000_000n;
    const gasOutWei = 5n * 10n ** 18n;
    const unitCost = (usdcInE6 * 10n ** 18n) / gasOutWei;
    expect(unitCost).to.equal(2_000_000n);
  });

  it("should accumulate totals across multiple swaps", () => {
    const swap1Usdc = 10_000_000n;
    const swap1Gas = 5n * 10n ** 18n;
    const swap2Usdc = 4_000_000n;
    const swap2Gas = 2n * 10n ** 18n;

    const totalUsdc = swap1Usdc + swap2Usdc;
    const totalGas = swap1Gas + swap2Gas;
    const unitCost = (totalUsdc * 10n ** 18n) / totalGas;

    expect(totalUsdc).to.equal(14_000_000n);
    expect(totalGas).to.equal(7n * 10n ** 18n);
    expect(unitCost).to.equal(2_000_000n);
  });

  it("should quote USDC from gas using unit cost", () => {
    const unitCost = 2_000_000n;
    const gasWei = 1n * 10n ** 18n;
    const quotedUsdcE6 = (gasWei * unitCost) / 10n ** 18n;
    expect(quotedUsdcE6).to.equal(2_000_000n);
  });

  it("should preserve unit cost after archive (synthetic baseline)", () => {
    const totalUsdc = 50_000_000n;
    const totalGas = 25n * 10n ** 18n;
    const unitCostBefore = (totalUsdc * 10n ** 18n) / totalGas;

    const syntheticGas = 10n ** 18n;
    const syntheticSpent = (unitCostBefore * syntheticGas) / 10n ** 18n;
    const unitCostAfter = (syntheticSpent * 10n ** 18n) / syntheticGas;

    expect(unitCostAfter).to.equal(unitCostBefore);
    expect(unitCostBefore).to.equal(2_000_000n);
  });

  it("should compute refill deficit from min/cap (EntryPoint)", () => {
    const minEp = 200n * 10n ** 15n; // 0.2 ETH
    const capEp = 1000n * 10n ** 15n; // 1 ETH

    const balanceLow = 100n * 10n ** 15n;
    const needEp = balanceLow < minEp ? capEp - balanceLow : 0n;
    expect(needEp).to.equal(900n * 10n ** 15n);

    const balanceOk = 500n * 10n ** 15n;
    const needEpOk = balanceOk < minEp ? capEp - balanceOk : 0n;
    expect(needEpOk).to.equal(0n);
  });

  it("should compute refill deficit from min/cap (worker native)", () => {
    const minWorker = 100n * 10n ** 15n;
    const capWorker = 500n * 10n ** 15n;

    const balanceLow = 50n * 10n ** 15n;
    const needWorker = balanceLow < minWorker ? capWorker - balanceLow : 0n;
    expect(needWorker).to.equal(450n * 10n ** 15n);

    const balanceAtCap = 500n * 10n ** 15n;
    const needWorkerAtCap = balanceAtCap < minWorker ? capWorker - balanceAtCap : 0n;
    expect(needWorkerAtCap).to.equal(0n);
  });
});
