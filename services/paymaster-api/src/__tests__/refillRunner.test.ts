import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import type { Address } from "viem";
import {
  allocateNativeAcrossDeficits,
  DEFAULT_MIN_NATIVE_WEI,
  mergeRefillRunnerConfig,
  parseRefillConfigFromEnv,
} from "../refillRunner.js";

const ENV_KEYS = [
  "PAYMASTER_REFILL_OWNER_PRIVATE_KEY",
  "ALTO_UTILITY_PRIVATE_KEY",
  "ALTO_EXECUTOR_PRIVATE_KEYS",
  "PAYMASTER_API_REFILL_QUOTER_V2_ADDRESS",
  "PAYMASTER_API_REFILL_USDC_ADDRESS",
  "PAYMASTER_API_REFILL_ROUTER_ADDRESS",
  "PAYMASTER_API_REFILL_WRAPPED_NATIVE",
  "PAYMASTER_API_REFILL_SCHEDULE_DEBOUNCE_MS",
  "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_ENTRYPOINT_BPS",
  "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_PAYMASTER_NATIVE_BPS",
  "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_UTILITY_BPS",
  "PAYMASTER_API_REFILL_TARGET_MULTIPLIER_EXECUTOR_BPS",
] as const;

describe("refillRunner config", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parseRefillConfigFromEnv returns null without owner key", () => {
    process.env.ALTO_UTILITY_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.ALTO_EXECUTOR_PRIVATE_KEYS =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(parseRefillConfigFromEnv("http://rpc")).to.equal(null);
  });

  it("mergeRefillRunnerConfig merges paymaster, entrypoint, and min wei", () => {
    const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.PAYMASTER_REFILL_OWNER_PRIVATE_KEY = pk;
    process.env.ALTO_UTILITY_PRIVATE_KEY = pk;
    process.env.ALTO_EXECUTOR_PRIVATE_KEYS =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.PAYMASTER_API_REFILL_QUOTER_V2_ADDRESS = "0x00000000000000000000000000000000000000aa";
    process.env.PAYMASTER_API_REFILL_USDC_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.PAYMASTER_API_REFILL_ROUTER_ADDRESS = "0x0000000000000000000000000000000000000002";
    process.env.PAYMASTER_API_REFILL_WRAPPED_NATIVE = "0x0000000000000000000000000000000000000003";
    const partial = parseRefillConfigFromEnv("http://localhost:8545");
    expect(partial).to.not.equal(undefined);
    expect(partial).to.not.equal(null);
    const pm = "0x1111111111111111111111111111111111111111" as Address;
    const ep = "0x2222222222222222222222222222222222222222" as Address;
    const full = mergeRefillRunnerConfig(partial!, {
      paymasterAddress: pm,
      entryPointAddress: ep,
      minNativeWei: DEFAULT_MIN_NATIVE_WEI,
    });
    expect(full.paymasterAddress).to.equal(pm);
    expect(full.entryPointAddress).to.equal(ep);
    expect(full.minNativeWei).to.equal(DEFAULT_MIN_NATIVE_WEI);
    expect(full.quoterV2Address.toLowerCase()).to.equal("0x00000000000000000000000000000000000000aa");
    expect(full.poolFeeAuto).to.equal(true);
    expect(full.poolFeeFixed).to.equal(500);
    expect(full.v3FeeCandidates.length).to.be.at.least(1);
    expect(full.scheduleDebounceMs).to.equal(15000);
    expect(full.targetMultipliersBps.entrypoint).to.equal(20000n);
    expect(full.targetMultipliersBps.paymasterNative).to.equal(10500n);
    expect(full.targetMultipliersBps.utility).to.equal(15000n);
    expect(full.targetMultipliersBps.executor).to.equal(15000n);
  });

  it("allocateNativeAcrossDeficits splits evenly when deficits match", () => {
    const out = allocateNativeAcrossDeficits([10n, 10n], 10n);
    expect(out).to.deep.equal([5n, 5n]);
  });

  it("allocateNativeAcrossDeficits does not starve small parties when one deficit dominates", () => {
    const out = allocateNativeAcrossDeficits([100n, 1n], 10n);
    expect(out[0]).to.equal(9n);
    expect(out[1]).to.equal(1n);
  });

  it("allocateNativeAcrossDeficits caps at deficits when av exceeds total need", () => {
    const out = allocateNativeAcrossDeficits([3n, 2n], 100n);
    expect(out).to.deep.equal([3n, 2n]);
  });
});
