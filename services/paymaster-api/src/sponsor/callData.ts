export function extractExecuteTarget(callData: string): string | null {
  if (typeof callData !== "string" || !callData.startsWith("0x") || callData.length < 2 + 4 * 2) return null;
  if (callData.length < 2 + 36 * 2) return `0x${"0".repeat(40)}`;
  const selector = callData.slice(0, 10).toLowerCase();
  if (selector === "0xb61d27f6") {
    return `0x${callData.slice(10 + 24, 10 + 64)}`.toLowerCase();
  }
  return `0x${"0".repeat(40)}`;
}

export function isDeployProfileUserOp(userOp: Record<string, unknown>): boolean {
  const factory = userOp.factory;
  const fd = userOp.factoryData ?? userOp.initCode;
  const fStr = typeof factory === "string" ? factory : "";
  const fdStr = typeof fd === "string" ? fd : "";
  const hasFactory = fStr.length > 2 && fStr !== "0x";
  const hasData = fdStr.length > 2 && fdStr !== "0x";
  return hasFactory || hasData;
}
