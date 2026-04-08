import { describe, it } from "mocha";
import { expect } from "chai";
import { pickFirst } from "../config.js";

describe("pickFirst", () => {
  it("returns first non-empty string", () => {
    expect(pickFirst({ a: "", b: "x" }, "a", "b")).to.equal("x");
  });

  it("returns undefined when all empty", () => {
    expect(pickFirst({ a: "" }, "a", "b")).to.equal(undefined);
  });
});
