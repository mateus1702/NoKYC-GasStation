/**
 * Project4 Paymaster API — Pimlico-compatible JSON-RPC.
 * Pricing from on-chain paymaster counters + amplifier; no bundler gas estimate on sponsor path.
 */
import { paymasterDebugLog, paymasterDebugLogsEnabled } from "./debugLog.js";
import { createPaymasterHttpServer } from "./http/paymasterHttpServer.js";
import { loadPaymasterRuntime } from "./runtimeConfig.js";
import { assertRefillOwnerMatchesOnChain } from "./sponsor/refillOwner.js";
import { assertSignerMatchesOnChainVerifier } from "./sponsor/verifier.js";

async function main() {
  const runtime = await loadPaymasterRuntime();
  await assertSignerMatchesOnChainVerifier(
    runtime.publicClient,
    runtime.signer,
    runtime.paymasterAddressFile
  );
  paymasterDebugLog("signer matches on-chain verifier");
  const refillPartial = runtime.getRefillConfigBase();
  if (refillPartial) {
    await assertRefillOwnerMatchesOnChain(
      runtime.publicClient,
      runtime.paymasterAddressFile,
      refillPartial.refillOwnerPrivateKey
    );
    paymasterDebugLog("refill owner matches on-chain paymaster owner()");
  }
  const server = createPaymasterHttpServer(runtime);
  server.listen(runtime.port, () => {
    console.log(`[paymaster-api] listening on :${runtime.port}`);
    paymasterDebugLog("server ready", {
      port: runtime.port,
      PAYMASTER_API_DEBUG_LOGS: paymasterDebugLogsEnabled(),
    });
  });
}

main();
