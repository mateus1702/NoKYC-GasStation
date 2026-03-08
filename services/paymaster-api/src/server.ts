/**
 * Project4 Paymaster API - Pimlico-compatible JSON-RPC
 * Redis-backed weighted-average inventory pricing, 5% service fee, no oracles
 * Gas pricing uses bundler eth_estimateUserOperationGas (authoritative, not client-supplied).
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  encodeAbiParameters,
  http as viemHttp,
  keccak256,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readTotalsState } from "@project4/shared";

/** Dummy signature for bundler gas estimation (passes simulation). */
const STUB_SIGNATURE =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c" as `0x${string}`;

const PORT = Number(process.env.PAYMASTER_API_PORT!);
const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE!;
const SIGNER_PRIVATE_KEY = process.env.PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY!;
const QUOTE_BUFFER_BPS = BigInt(process.env.PAYMASTER_API_QUOTE_BUFFER_BPS!);
const VALIDITY_SECONDS = Number(process.env.PAYMASTER_API_VALIDITY_SECONDS!);
const PM_VERIFICATION_GAS = BigInt(process.env.PAYMASTER_CONTRACT_VERIFICATION_GAS_LIMIT!);
const PM_POSTOP_GAS = BigInt(process.env.PAYMASTER_CONTRACT_POSTOP_GAS_LIMIT!);
const STUB_MAX_COST_USDC_E6 = BigInt(process.env.PAYMASTER_API_STUB_MAX_COST_USDC_E6!);

if (!SIGNER_PRIVATE_KEY) throw new Error("PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY required (set in .env)");
if (!PAYMASTER_ADDRESS_FILE) throw new Error("CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE required (set in .env)");
if (!process.env.PAYMASTER_API_BUNDLER_URL) throw new Error("PAYMASTER_API_BUNDLER_URL required (set in .env)");

const BUNDLER_URL = process.env.PAYMASTER_API_BUNDLER_URL.trim().replace(/\/$/, "");

const PAYMASTER_API_ENTRYPOINT_ADDRESS = process.env.PAYMASTER_API_ENTRYPOINT_ADDRESS!;
const PAYMASTER_API_SERVICE_FEE_BPS = BigInt(process.env.PAYMASTER_API_SERVICE_FEE_BPS!);
const PAYMASTER_API_RPC_URL = process.env.PAYMASTER_API_RPC_URL!;

const ENTRYPOINT_ADDRESS = PAYMASTER_API_ENTRYPOINT_ADDRESS.toLowerCase();
const SERVICE_FEE_BPS = PAYMASTER_API_SERVICE_FEE_BPS;
const publicClient = createPublicClient({ transport: viemHttp(PAYMASTER_API_RPC_URL) });

// Get current unit cost from inventory (USDC e6 per wei, scaled by 1e18), with fallback.
async function getUnitCostUsdcPerWei(): Promise<bigint> {
  try {
    const state = await readTotalsState();
    if (state.unitCostUsdcPerWei > 0n) {
      return state.unitCostUsdcPerWei;
    }
  } catch (error) {
    console.warn("Failed to load unit cost from inventory:", error);
  }
  // Fallback: 1 USDC per 1000 gas => 1e6 / 1000 = 1000 e6 per gas.
  // To convert from gas to wei basis, divide by 1e18:
  // unitCostUsdcPerWei (scaled 1e18) = 1000 * 1e18 / 1e18 = 1000.
  return 1000n;
}

// Minimum postOp fee: 0.01 USDC (10,000 units with 6 decimals)
const MIN_POSTOP_FEE_USDC_E6 = 10_000n;
const signer = privateKeyToAccount(
  (SIGNER_PRIVATE_KEY.startsWith("0x") ? SIGNER_PRIVATE_KEY : `0x${SIGNER_PRIVATE_KEY}`) as `0x${string}`
);

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function toBigIntHex(v: bigint | number | string): string {
  return `0x${BigInt(v).toString(16)}`;
}

function fromHexBigInt(v: unknown, fallback = 0n): bigint {
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

function extractExecuteTarget(callData: string): string | null {
  if (typeof callData !== "string" || !callData.startsWith("0x") || callData.length < 2 + 4 * 2) return null;
  // Allow any selector, not just SimpleAccount.execute (0xb61d27f6)
  // For non-standard call patterns, return zero address (allowed by allowAllTargets=true in contract)
  if (callData.length < 2 + 36 * 2) return `0x${"0".repeat(40)}`;
  // Try to extract target from standard execute call pattern
  const selector = callData.slice(0, 10).toLowerCase();
  if (selector === "0xb61d27f6") {
    // SimpleAccount.execute(address,uint256,bytes) pattern
    return `0x${callData.slice(10 + 24, 10 + 64)}`.toLowerCase();
  }
  // For other patterns, return zero address (will be allowed by contract)
  return `0x${"0".repeat(40)}`;
}

async function resolvePaymasterAddress(): Promise<string> {
  const raw = (await readFile(PAYMASTER_ADDRESS_FILE, "utf8")).trim().toLowerCase();
  if (!raw) throw new Error("CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE is empty");
  return raw;
}

interface BundlerGasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

async function buildSignedPaymasterData(params: {
  userOp: Record<string, unknown>;
  paymasterAddress: string;
  entryPointAddress: string;
  target: string;
  validUntil: bigint;
  validAfter: bigint;
  maxCostUsdcE6: bigint;
  unitCostUsdcPerWei: bigint;
  minPostopFeeUsdcE6: bigint;
}): Promise<string> {
  const chainId = await publicClient.getChainId();
  const nonce = fromHexBigInt(params.userOp.nonce);
  const callDataHash = keccak256((params.userOp.callData as `0x${string}`) ?? "0x");
  const innerHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("uint256,address,address,address,uint256,bytes32,address,uint256,uint256,uint256,uint48,uint48"),
      [
        BigInt(chainId),
        params.paymasterAddress as `0x${string}`,
        params.entryPointAddress as `0x${string}`,
        (params.userOp.sender as `0x${string}`) ?? "0x",
        nonce,
        callDataHash,
        params.target as `0x${string}`,
        params.maxCostUsdcE6,
        params.unitCostUsdcPerWei,
        params.minPostopFeeUsdcE6,
        Number(params.validUntil),
        Number(params.validAfter),
      ]
    )
  );
  const signature = await signer.signMessage({ message: { raw: innerHash } });
  return encodeAbiParameters(
    parseAbiParameters("uint48,uint48,uint256,uint256,uint256,bytes"),
    [Number(params.validUntil), Number(params.validAfter), params.maxCostUsdcE6, params.unitCostUsdcPerWei, params.minPostopFeeUsdcE6, signature as `0x${string}`]
  );
}

/**
 * Fetch gas limits from bundler eth_estimateUserOperationGas (authoritative).
 * Uses stub paymasterData so the bundler can simulate. No fallback to client values.
 */
async function estimateGasFromBundler(
  userOp: Record<string, unknown>,
  entryPointAddress: string,
  paymasterAddress: string,
  stubPaymasterData: string
): Promise<BundlerGasEstimate> {
  const stubUserOp = {
    sender: userOp.sender,
    nonce: userOp.nonce,
    factory: userOp.factory ?? null,
    factoryData: userOp.factoryData ?? null,
    callData: userOp.callData ?? "0x",
    callGasLimit: "0x0",
    verificationGasLimit: "0x0",
    preVerificationGas: "0x0",
    maxFeePerGas: userOp.maxFeePerGas ?? "0x3b9aca00",
    maxPriorityFeePerGas: userOp.maxPriorityFeePerGas ?? userOp.maxFeePerGas ?? "0x3b9aca00",
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: toBigIntHex(PM_VERIFICATION_GAS),
    paymasterPostOpGasLimit: toBigIntHex(PM_POSTOP_GAS),
    paymasterData: stubPaymasterData,
    signature: userOp.signature ?? STUB_SIGNATURE,
  };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_estimateUserOperationGas",
    params: [stubUserOp, entryPointAddress],
  });

  const res = await fetch(BUNDLER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const responseBody = await res.text();
    const compactBody = responseBody.length > 2000 ? `${responseBody.slice(0, 2000)}...<truncated>` : responseBody;
    throw new Error(
      [
        `Bundler request failed: ${res.status} ${res.statusText}`,
        `bundlerUrl=${BUNDLER_URL}`,
        `entryPoint=${entryPointAddress}`,
        `paymaster=${paymasterAddress}`,
        `bundlerResponse=${compactBody || "<empty>"}`,
      ].join(" | ")
    );
  }

  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) {
    throw new Error(`Bundler estimate failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  const result = json.result as {
    callGasLimit?: string;
    verificationGasLimit?: string;
    preVerificationGas?: string;
    paymasterVerificationGasLimit?: string;
    paymasterPostOpGasLimit?: string;
  };

  if (
    !result?.callGasLimit ||
    !result?.verificationGasLimit ||
    !result?.preVerificationGas ||
    !result?.paymasterVerificationGasLimit ||
    !result?.paymasterPostOpGasLimit
  ) {
    throw new Error("Bundler returned incomplete gas estimate");
  }

  return {
    callGasLimit: BigInt(result.callGasLimit),
    verificationGasLimit: BigInt(result.verificationGasLimit),
    preVerificationGas: BigInt(result.preVerificationGas),
    paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit),
  };
}

async function buildSponsorPayload(userOp: Record<string, unknown>, entryPointAddress: string): Promise<{
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
}> {
  if ((entryPointAddress ?? "").toLowerCase() !== ENTRYPOINT_ADDRESS) {
    throw new Error(`Unsupported entryPoint. expected=${ENTRYPOINT_ADDRESS}`);
  }

  // Allow any target - the contract validates via allowAllTargets flag
  const target = extractExecuteTarget(String(userOp.callData ?? "")) || "0x0000000000000000000000000000000000000000";

  const paymasterAddress = await resolvePaymasterAddress();

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + BigInt(VALIDITY_SECONDS);
  const validAfter = 0n;

  const baseUnitCostUsdcPerWei = await getUnitCostUsdcPerWei();

   // Calculate effective unit cost that includes service fee and buffer markup
  // This ensures postOp charges match the quoted pricing
  const sponsorEffectiveUnitCostUsdcPerWei = (baseUnitCostUsdcPerWei * (10_000n + SERVICE_FEE_BPS) * (10_000n + QUOTE_BUFFER_BPS)) / (10_000n * 10_000n);


  const stubPaymasterData = await buildSignedPaymasterData({
    userOp,
    paymasterAddress,
    entryPointAddress: ENTRYPOINT_ADDRESS,
    target,
    validUntil,
    validAfter,
    maxCostUsdcE6: STUB_MAX_COST_USDC_E6,
    unitCostUsdcPerWei: sponsorEffectiveUnitCostUsdcPerWei,
    minPostopFeeUsdcE6: MIN_POSTOP_FEE_USDC_E6,
  });

  const gasEstimate = await estimateGasFromBundler(
    userOp,
    ENTRYPOINT_ADDRESS,
    paymasterAddress,
    stubPaymasterData
  );

  // Calculate total gas from estimate
  const totalGas =
    gasEstimate.callGasLimit +
    gasEstimate.verificationGasLimit +
    gasEstimate.preVerificationGas +
    gasEstimate.paymasterVerificationGasLimit +
    gasEstimate.paymasterPostOpGasLimit;

  // Convert estimated gas units to wei using paymaster-controlled gas price.
  const pricingMaxFeePerGas = await publicClient.getGasPrice();
  if (pricingMaxFeePerGas <= 0n) throw new Error("Could not fetch gas price");
  const estimatedCostWei = totalGas * pricingMaxFeePerGas;

  // Convert wei cost to USDC e6 using effective pricing.
  const estimatedCostUsdcE6 = (estimatedCostWei * sponsorEffectiveUnitCostUsdcPerWei) / 10n ** 18n;

  // Add 50% safety buffer and enforce minimum to keep postOp charging path active.
  let maxCostUsdcE6 = (estimatedCostUsdcE6 * 3n) / 2n;
  if (maxCostUsdcE6 < MIN_POSTOP_FEE_USDC_E6) {
    maxCostUsdcE6 = MIN_POSTOP_FEE_USDC_E6;
  }

 
  const paymasterData = await buildSignedPaymasterData({
    userOp,
    paymasterAddress,
    entryPointAddress: ENTRYPOINT_ADDRESS,
    target,
    validUntil,
    validAfter,
    maxCostUsdcE6,
    unitCostUsdcPerWei: sponsorEffectiveUnitCostUsdcPerWei,
    minPostopFeeUsdcE6: MIN_POSTOP_FEE_USDC_E6,
  });

  return {
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: toBigIntHex(PM_VERIFICATION_GAS),
    paymasterPostOpGasLimit: toBigIntHex(PM_POSTOP_GAS),
    paymasterData,
  };
}

async function buildStubPayload(userOp: Record<string, unknown>, entryPointAddress: string): Promise<{
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
}> {
  if ((entryPointAddress ?? "").toLowerCase() !== ENTRYPOINT_ADDRESS) {
    throw new Error(`Unsupported entryPoint. expected=${ENTRYPOINT_ADDRESS}`);
  }

  const target = extractExecuteTarget(String(userOp.callData ?? "")) || "0x0000000000000000000000000000000000000000";
  const paymasterAddress = await resolvePaymasterAddress();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + BigInt(VALIDITY_SECONDS);
  const validAfter = 0n;

  const baseUnitCostUsdcPerWei = await getUnitCostUsdcPerWei();

   // Calculate effective unit cost that includes service fee and buffer markup
  // This ensures postOp charges match the quoted pricing
  const sponsorEffectiveUnitCostUsdcPerWei = (baseUnitCostUsdcPerWei * (10_000n + SERVICE_FEE_BPS) * (10_000n + QUOTE_BUFFER_BPS)) / (10_000n * 10_000n);

  const paymasterData = await buildSignedPaymasterData({
    userOp,
    paymasterAddress,
    entryPointAddress: ENTRYPOINT_ADDRESS,
    target,
    validUntil,
    validAfter,
    maxCostUsdcE6: STUB_MAX_COST_USDC_E6,
    unitCostUsdcPerWei: sponsorEffectiveUnitCostUsdcPerWei,
    minPostopFeeUsdcE6: MIN_POSTOP_FEE_USDC_E6,
  });

  return {
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: toBigIntHex(PM_VERIFICATION_GAS),
    paymasterPostOpGasLimit: toBigIntHex(PM_POSTOP_GAS),
    paymasterData,
  };
}

async function getGasPricePayload(): Promise<unknown> {
  const gasPrice = await publicClient.getGasPrice();
  const priority = gasPrice > 1_000_000_000n ? 1_000_000_000n : gasPrice;
  const standard = {
    maxFeePerGas: toBigIntHex(gasPrice),
    maxPriorityFeePerGas: toBigIntHex(priority),
  };
  return { slow: standard, standard, fast: standard };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/paymaster-address") {
    try {
      const address = await resolvePaymasterAddress();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ paymasterAddress: address }));
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e as Error).message) }));
    }
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body || "{}");
    const id = rpc.id ?? null;
    const method = rpc.method;
    const params = Array.isArray(rpc.params) ? rpc.params : [];

    if (method === "getUserOperationGasPrice" || method === "pimlico_getUserOperationGasPrice") {
      const gasPayload = await getGasPricePayload();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpcResult(id, gasPayload));
      return;
    }
    if (method === "pm_getPaymasterStubData") {
      const userOp = params[0] ?? {};
      const entryPointAddress = params[1];
      const payload = await buildStubPayload(userOp, entryPointAddress);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpcResult(id, payload));
      return;
    }
    if (method === "pm_sponsorUserOperation" || method === "pm_getPaymasterData") {
      const userOp = params[0] ?? {};
      const entryPointAddress = params[1];
      const payload = await buildSponsorPayload(userOp, entryPointAddress);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpcResult(id, payload));
      return;
    }
    if (method === "eth_supportedEntryPoints") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpcResult(id, [ENTRYPOINT_ADDRESS]));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(jsonRpcError(id, -32601, `Method not found: ${method}`));
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jsonRpcError(null, -32000, message));
  }
});

async function main() {
  server.listen(PORT, () => {
    console.log(`[paymaster-api] listening on :${PORT}`);
  });
}

main();
