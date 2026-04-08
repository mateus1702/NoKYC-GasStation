import type { LocalAccount } from "viem/accounts";
import type { PublicClient } from "viem";
import { paymasterDebugLog } from "../debugLog.js";
import { PAYMASTER_READ_ABI } from "./paymasterAbi.js";
import { resolvePaymasterAddressFromFile } from "./address.js";

/** Fails fast on AA33 InvalidSignature: on-chain verifier must equal PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY. */
export async function assertSignerMatchesOnChainVerifier(
  publicClient: PublicClient,
  signer: LocalAccount,
  paymasterAddressFile: string
): Promise<void> {
  const paymasterAddress = await resolvePaymasterAddressFromFile(paymasterAddressFile);
  paymasterDebugLog("sponsor", { step: "sponsor:verifier_read", paymasterAddress });
  const onchainVerifier = await publicClient.readContract({
    address: paymasterAddress,
    abi: PAYMASTER_READ_ABI,
    functionName: "verifier",
  });
  const verifierAddr = String(onchainVerifier).toLowerCase();
  paymasterDebugLog("sponsor", {
    step: "sponsor:verifier_read_done",
    paymasterAddress,
    onchainVerifier: verifierAddr,
    signerAddress: signer.address.toLowerCase(),
  });
  const a = signer.address.toLowerCase();
  const b = verifierAddr;
  if (a !== b) {
    paymasterDebugLog("sponsor", { step: "sponsor:verifier_mismatch", signerAddress: a, onchainVerifier: b });
    throw new Error(
      `PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY is ${signer.address} but paymaster ${paymasterAddress} verifier() is ${onchainVerifier}. ` +
        `Signatures will revert (AA33 InvalidSignature). Use the verifier key, set PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY to match the deployed verifier, or paymaster.setVerifier(${signer.address}).`
    );
  }
  paymasterDebugLog("sponsor", { step: "sponsor:verifier_ok", paymasterAddress });
}
