/**
 * Config bootstrap: pure field mapping + optional Redis integration.
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { buildConfigSeedFromEnv, runConfigBootstrap } from "../bootstrap.js";

describe("buildConfigSeedFromEnv", () => {
  it("only includes non-shared config services (no separate worker package)", () => {
    const seed = buildConfigSeedFromEnv({});
    expect(Object.keys(seed).sort()).to.deep.equal(
      ["bundler", "contract-deployer", "dashboard", "paymaster-api", "shared"].sort()
    );
  });
});

describe("runConfigBootstrap integration", function () {
  this.timeout(5000);

  it("runs when VALKEY_URL and VALKEY_KEY_PREFIX are set", async function () {
    if (!process.env.VALKEY_URL?.trim() || !process.env.VALKEY_KEY_PREFIX?.trim()) {
      this.skip();
    }
    await runConfigBootstrap();
    await runConfigBootstrap();
  });
});
