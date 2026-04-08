import { readFile } from "node:fs/promises";
import type { Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * Ensures PAYMASTER_REFILL_OWNER_PRIVATE_KEY matches on-chain owner() when refill is configured.
 */
export async function assertRefillOwnerMatchesOnChain(
  publicClient: PublicClient,
  paymasterAddressFile: string,
  ownerPrivateKey: `0x${string}`
): Promise<void> {
  const raw = (await readFile(paymasterAddressFile, "utf8")).trim().toLowerCase();
  if (!raw.startsWith("0x") || raw.length !== 42) {
    throw new Error(`[paymaster-api] invalid paymaster address file: ${paymasterAddressFile}`);
  }
  const paymaster = raw as Address;
  const onchainOwner = (await publicClient.readContract({
    address: paymaster,
    abi: OWNER_ABI,
    functionName: "owner",
  })) as Address;
  const fromKey = privateKeyToAccount(ownerPrivateKey).address;
  if (onchainOwner.toLowerCase() !== fromKey.toLowerCase()) {
    throw new Error(
      `[paymaster-api] PAYMASTER_REFILL_OWNER_PRIVATE_KEY (${fromKey}) does not match paymaster owner() (${onchainOwner})`
    );
  }
}
