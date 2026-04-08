export function toBigIntHex(v: bigint | number | string): string {
  return `0x${BigInt(v).toString(16)}`;
}

export function fromHexBigInt(v: unknown, fallback = 0n): bigint {
  if (v == null) return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    if (v.startsWith("0x") || v.startsWith("0X")) return BigInt(v);
    if (v === "") return fallback;
    return BigInt(v);
  }
  return fallback;
}
