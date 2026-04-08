import { readFile } from "node:fs/promises";
import type { PublicClient } from "viem";
import { paymasterDebugLog } from "../debugLog.js";
import { PAYMASTER_READ_ABI } from "./paymasterAbi.js";

export async function resolvePaymasterAddressFromFile(paymasterAddressFile: string): Promise<`0x${string}`> {
  paymasterDebugLog("sponsor", { step: "sponsor:resolve_paymaster_file_start" });
  const raw = (await readFile(paymasterAddressFile, "utf8")).trim().toLowerCase();
  if (!raw) throw new Error("CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE is empty");
  const addr = raw as `0x${string}`;
  paymasterDebugLog("sponsor", { step: "sponsor:resolve_paymaster_file_done", paymasterAddress: addr });
  return addr;
}

export async function readPaymasterOnchainLimits(
  publicClient: PublicClient,
  paymasterAddress: `0x${string}`
) {
  paymasterDebugLog("sponsor", { step: "sponsor:read_pricing_counters", paymasterAddress });
  const counters = await publicClient.readContract({
    address: paymasterAddress,
    abi: PAYMASTER_READ_ABI,
    functionName: "getPricingCounters",
  });
  const [gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei] = counters as [bigint, bigint, bigint];
  paymasterDebugLog("sponsor", {
    step: "sponsor:read_pricing_counters_done",
    paymasterAddress,
    gasUnitsProcessed: gasUnitsProcessed.toString(),
    usdcSpentForGasE6: usdcSpentForGasE6.toString(),
    gasBoughtWei: gasBoughtWei.toString(),
  });
  return { gasUnitsProcessed, usdcSpentForGasE6, gasBoughtWei };
}
