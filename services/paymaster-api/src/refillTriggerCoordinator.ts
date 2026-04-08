export type RefillTriggerSkipReason = "preflight_in_flight" | "debounced";

export type RefillTriggerCoordinatorOptions<T> = {
  debounceMs: number;
  run: (ctx: T) => Promise<void>;
  nowMs?: () => number;
  onSkip?: (reason: RefillTriggerSkipReason) => void;
  onError?: (error: unknown) => void;
};

/**
 * Coalesces many trigger calls into one preflight execution.
 * Used to reduce redundant Redis/RPC checks under sponsor traffic bursts.
 */
export class RefillTriggerCoordinator<T> {
  private readonly debounceMs: number;
  private readonly runFn: (ctx: T) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly onSkip?: (reason: RefillTriggerSkipReason) => void;
  private readonly onError?: (error: unknown) => void;

  private preflightInFlight = false;
  private nextAllowedAtMs = 0;

  constructor(options: RefillTriggerCoordinatorOptions<T>) {
    this.debounceMs = options.debounceMs;
    this.runFn = options.run;
    this.nowMs = options.nowMs ?? Date.now;
    this.onSkip = options.onSkip;
    this.onError = options.onError;
  }

  trigger(ctx: T): void {
    if (this.preflightInFlight) {
      this.onSkip?.("preflight_in_flight");
      return;
    }

    const now = this.nowMs();
    if (now < this.nextAllowedAtMs) {
      this.onSkip?.("debounced");
      return;
    }

    this.preflightInFlight = true;
    this.nextAllowedAtMs = now + this.debounceMs;
    void this.runFn(ctx)
      .catch((error) => {
        this.onError?.(error);
      })
      .finally(() => {
        this.preflightInFlight = false;
      });
  }
}
