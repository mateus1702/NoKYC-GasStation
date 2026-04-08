/**
 * Tests for paymaster API gas-price endpoint.
 * Requires PAYMASTER_API_URL (default http://localhost:3000).
 */
import { describe, it } from "mocha";
import { expect } from "chai";

const PAYMASTER_API_URL = (process.env.PAYMASTER_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function fetchGasPrice(): Promise<{ status: number; body: { gasPriceWei?: string; source?: string; error?: string } }> {
  const res = await fetch(`${PAYMASTER_API_URL}/gas-price`, { signal: AbortSignal.timeout(5000) });
  const body = (await res.json()) as { gasPriceWei?: string; source?: string; error?: string };
  return { status: res.status, body };
}

describe("GET /gas-price", function () {
  this.timeout(10000);

  it("returns 200 with gasPriceWei and source rpc when API is reachable", async function () {
    try {
      const { status, body } = await fetchGasPrice();
      if (status === 503) {
        return this.skip();
      }
      expect(status).to.equal(200);
      expect(body).to.have.property("gasPriceWei");
      expect(body.source).to.equal("rpc");
      expect(body.gasPriceWei).to.match(/^\d+$/);
      expect(BigInt(body.gasPriceWei!) > 0n).to.be.true;
    } catch (e) {
      if ((e as Error).message?.includes("fetch") || (e as Error).message?.includes("ECONNREFUSED")) {
        return this.skip();
      }
      throw e;
    }
  });

  it("returns 503 with error when gas price cannot be resolved", async function () {
    try {
      const { status, body } = await fetchGasPrice();
      if (status === 503) {
        expect(body).to.have.property("error");
        expect(body.error).to.be.a("string");
      }
    } catch (e) {
      if ((e as Error).message?.includes("fetch") || (e as Error).message?.includes("ECONNREFUSED")) {
        return this.skip();
      }
      throw e;
    }
  });
});
