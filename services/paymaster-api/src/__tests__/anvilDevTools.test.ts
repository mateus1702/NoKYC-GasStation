import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { isAnvilRpc } from "../anvilDevTools.js";

describe("isAnvilRpc", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("returns true when clientVersion contains anvil", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "anvil/v1.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    expect(await isAnvilRpc("http://localhost:8545")).to.equal(true);
  });

  it("returns false when clientVersion does not contain anvil", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "Geth/v1.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    expect(await isAnvilRpc("http://localhost:8545")).to.equal(false);
  });
});
