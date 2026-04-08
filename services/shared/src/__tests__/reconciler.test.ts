/**
 * Unit tests for reconciler gas price and cursor helpers.
 * Requires Redis (VALKEY_URL, VALKEY_KEY_PREFIX) when running; skips when absent.
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { getRedis, key } from "../redis.js";
import {
  readGasPriceCursor,
  readReconcilerGasPriceWei,
  setGasPriceCursor,
  setReconcilerGasPriceWei,
} from "../reconciler.js";

const RECON_GAS_PRICE_WEI = "pricing:recon:gas_price_wei";
const GAS_PRICE_CURSOR_BLOCK = "pricing:gas_price:cursor_block";
const GAS_PRICE_CURSOR_TX = "pricing:gas_price:cursor_tx";
const GAS_PRICE_CURSOR_LOG_INDEX = "pricing:gas_price:cursor_log_index";

const hasRedis = !!process.env.VALKEY_URL && !!process.env.VALKEY_KEY_PREFIX;

describe("Reconciler gas price helpers", function () {
  this.timeout(5000);

  it("returns 0n when key is missing", async function () {
    if (!hasRedis) return this.skip();
    const r = getRedis();
    await r.del(key(RECON_GAS_PRICE_WEI));
    const v = await readReconcilerGasPriceWei();
    expect(v).to.equal(0n);
  });

  it("set then read returns the stored value", async function () {
    if (!hasRedis) return this.skip();
    const val = 2_500_000_000n;
    await setReconcilerGasPriceWei(val);
    const v = await readReconcilerGasPriceWei();
    expect(v).to.equal(val);
  });

  it("ignores set when gasPriceWei is 0n", async function () {
    if (!hasRedis) return this.skip();
    await setReconcilerGasPriceWei(3_000_000_000n);
    await setReconcilerGasPriceWei(0n);
    const v = await readReconcilerGasPriceWei();
    expect(v).to.equal(3_000_000_000n);
  });
});

describe("Gas price cursor helpers", function () {
  this.timeout(5000);

  async function clearGasPriceCursor() {
    const r = getRedis();
    await r.del(key(GAS_PRICE_CURSOR_BLOCK));
    await r.del(key(GAS_PRICE_CURSOR_TX));
    await r.del(key(GAS_PRICE_CURSOR_LOG_INDEX));
  }

  it("readGasPriceCursor returns default cursor when keys are missing", async function () {
    if (!hasRedis) return this.skip();
    await clearGasPriceCursor();
    const cursor = await readGasPriceCursor();
    expect(cursor.block).to.equal(0n);
    expect(cursor.tx).to.equal("");
    expect(cursor.logIndex).to.equal(0);
  });

  it("setGasPriceCursor persists block/tx/logIndex and read returns exact values", async function () {
    if (!hasRedis) return this.skip();
    await clearGasPriceCursor();
    await setGasPriceCursor(12345n, "0xabcd1234", 7);
    const cursor = await readGasPriceCursor();
    expect(cursor.block).to.equal(12345n);
    expect(cursor.tx).to.equal("0xabcd1234");
    expect(cursor.logIndex).to.equal(7);
  });

  it("overwrite cursor updates all fields", async function () {
    if (!hasRedis) return this.skip();
    await setGasPriceCursor(100n, "0xold", 1);
    await setGasPriceCursor(200n, "0xnew", 2);
    const cursor = await readGasPriceCursor();
    expect(cursor.block).to.equal(200n);
    expect(cursor.tx).to.equal("0xnew");
    expect(cursor.logIndex).to.equal(2);
  });
});
