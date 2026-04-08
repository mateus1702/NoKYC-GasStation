import type { PublicClient } from "viem";
import { paymasterDebugLog } from "../debugLog.js";
import { toBigIntHex } from "./encoding.js";

export async function getPricingGasPriceWei(publicClient: PublicClient): Promise<bigint> {
  paymasterDebugLog("sponsor", { step: "sponsor:gas_price_fetch" });
  const gasPrice = await publicClient.getGasPrice();
  paymasterDebugLog("sponsor", { step: "sponsor:gas_price", gasPriceWei: gasPrice.toString() });
  if (gasPrice <= 0n) throw new Error("Could not fetch gas price");
  return gasPrice;
}

export async function getGasPricePayload(publicClient: PublicClient): Promise<unknown> {
  const gasPrice = await getPricingGasPriceWei(publicClient);
  const priority = gasPrice > 1_000_000_000n ? 1_000_000_000n : gasPrice;
  const standard = {
    maxFeePerGas: toBigIntHex(gasPrice),
    maxPriorityFeePerGas: toBigIntHex(priority),
  };
  return { slow: standard, standard, fast: standard };
}
