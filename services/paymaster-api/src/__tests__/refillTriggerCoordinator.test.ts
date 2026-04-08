import { describe, it } from "mocha";
import { expect } from "chai";
import { RefillTriggerCoordinator } from "../refillTriggerCoordinator.js";

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("RefillTriggerCoordinator", () => {
  it("coalesces burst triggers while preflight is in flight", async () => {
    let now = 1_000;
    const started: number[] = [];
    const skipped: string[] = [];
    const gate = defer();

    const coordinator = new RefillTriggerCoordinator<{ id: number }>({
      debounceMs: 15_000,
      nowMs: () => now,
      onSkip: (reason) => skipped.push(reason),
      run: async (ctx) => {
        started.push(ctx.id);
        await gate.promise;
      },
    });

    for (let i = 0; i < 100; i++) {
      coordinator.trigger({ id: i });
    }
    await flushMicrotasks();

    expect(started).to.deep.equal([0]);
    expect(skipped.filter((r) => r === "preflight_in_flight")).to.have.length(99);

    gate.resolve();
    await flushMicrotasks();

    now += 1_000;
    coordinator.trigger({ id: 100 });
    await flushMicrotasks();
    expect(skipped.filter((r) => r === "debounced")).to.have.length(1);
  });

  it("allows a new preflight after debounce window", async () => {
    let now = 1_000;
    const started: number[] = [];

    const coordinator = new RefillTriggerCoordinator<{ id: number }>({
      debounceMs: 5_000,
      nowMs: () => now,
      run: async (ctx) => {
        started.push(ctx.id);
      },
    });

    coordinator.trigger({ id: 1 });
    await flushMicrotasks();
    expect(started).to.deep.equal([1]);

    now += 1_000;
    coordinator.trigger({ id: 2 });
    await flushMicrotasks();
    expect(started).to.deep.equal([1]);

    now += 5_000;
    coordinator.trigger({ id: 3 });
    await flushMicrotasks();
    expect(started).to.deep.equal([1, 3]);
  });

  it("surfaces run errors and recovers for future triggers", async () => {
    let now = 50;
    const errors: string[] = [];
    let calls = 0;

    const coordinator = new RefillTriggerCoordinator({
      debounceMs: 10,
      nowMs: () => now,
      onError: (e) => errors.push((e as Error).message ?? String(e)),
      run: async () => {
        calls++;
        if (calls === 1) {
          throw new Error("boom");
        }
      },
    });

    coordinator.trigger(undefined);
    await flushMicrotasks();
    expect(errors).to.deep.equal(["boom"]);

    now += 11;
    coordinator.trigger(undefined);
    await flushMicrotasks();
    expect(calls).to.equal(2);
  });
});
