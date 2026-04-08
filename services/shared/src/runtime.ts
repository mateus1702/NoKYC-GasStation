/**
 * Runtime coordination types (legacy naming; reserved for future orchestration).
 */

export type RuntimeId = "bootstrap" | "health" | "monitor" | "gasPrice" | "distribution";

export type RuntimeLifecycleStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface RuntimeHandle {
  readonly id: RuntimeId;
  start(): Promise<void>;
  stop(): Promise<void>;
}
