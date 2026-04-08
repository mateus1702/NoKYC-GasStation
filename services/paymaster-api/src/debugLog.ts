/** Verbose request/flow logging when `PAYMASTER_API_DEBUG_LOGS=true`. */

export function paymasterDebugLogsEnabled(): boolean {
  return process.env.PAYMASTER_API_DEBUG_LOGS?.trim() === "true";
}

export function paymasterDebugLog(message: string, detail?: Record<string, unknown>): void {
  if (!paymasterDebugLogsEnabled()) return;
  if (detail !== undefined && Object.keys(detail).length > 0) {
    console.log(`[paymaster-api:debug] ${message}`, detail);
  } else {
    console.log(`[paymaster-api:debug] ${message}`);
  }
}
