/**
 * Regression test: Paymaster API must use bundler gas estimate, not client-supplied values.
 * Sends pm_getPaymasterData with fake low gas limits (0,0,0) and asserts the returned
 * signedMaxCostUsdcE6 reflects bundler-authoritative pricing (not undercharged).
 *
 * Prereqs: docker compose up (anvil, contract-deployer, bundler-alto, paymaster-api, valkey, worker)
 * Run: npm run test:project4:underpricing (from tools/aa-test)
 */
import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { defineChain } from "viem";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const MIN_EXPECTED_USDC_E6 = 10_000n; // 0.01 USDC - real quote for a small op is far higher

const localChain = defineChain({
  id: 137,
  name: "Polygon Fork",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const publicClient = createPublicClient({
  chain: localChain,
  transport: http(RPC_URL),
});

const owner = privateKeyToAccount(
  (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`
);

async function main() {
  console.log("AA Infrastructure:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("");

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });

  const paymasterRes = await fetch(`${PAYMASTER_URL}/paymaster-address`);
  if (!paymasterRes.ok) {
    console.error("Could not get paymaster address");
    process.exit(1);
  }
  const { paymasterAddress } = (await paymasterRes.json()) as { paymasterAddress?: string };
  if (!paymasterAddress) {
    console.error("API did not return paymaster address");
    process.exit(1);
  }

  const executeTarget = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const callData = encodeFunctionData({
    abi: parseAbi(["function execute(address target, uint256 value, bytes data)"]),
    functionName: "execute",
    args: [executeTarget as `0x${string}`, 0n, "0x"],
  });

  const nonce = await publicClient.readContract({
    address: entryPoint07Address,
    abi: parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]),
    functionName: "getNonce",
    args: [account.address, 0n],
  });

  const adversarialUserOp = {
    sender: account.address,
    nonce: `0x${nonce.toString(16)}`,
    factory: null,
    factoryData: null,
    callData,
    callGasLimit: "0x0",
    verificationGasLimit: "0x0",
    preVerificationGas: "0x0",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: "0x30d40",
    paymasterPostOpGasLimit: "0x1d4c0",
    paymasterData: "0x",
    signature: "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c",
  };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_getPaymasterData",
    params: [adversarialUserOp, entryPoint07Address],
  });

  const res = await fetch(PAYMASTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    console.error("Paymaster request failed:", res.status, await res.text());
    process.exit(1);
  }

  const json = (await res.json()) as { result?: { paymasterData?: string }; error?: { message?: string } };
  if (json.error) {
    console.error("Paymaster error:", json.error.message);
    process.exit(1);
  }

  const paymasterData = json.result?.paymasterData;
  if (!paymasterData || typeof paymasterData !== "string") {
    console.error("No paymasterData in response");
    process.exit(1);
  }

  const decoded = decodeAbiParameters(
    parseAbiParameters("uint48 validUntil, uint48 validAfter, uint256 maxCostUsdcE6, bytes signature"),
    paymasterData as `0x${string}`
  );
  const signedMaxCostUsdcE6 = decoded[2] as bigint;

  console.log("Adversarial request (callGasLimit=0, verificationGasLimit=0, preVerificationGas=0)");
  console.log("Returned signedMaxCostUsdcE6:", signedMaxCostUsdcE6.toString());

  if (signedMaxCostUsdcE6 < MIN_EXPECTED_USDC_E6) {
    console.error("FAIL: signedMaxCostUsdcE6", signedMaxCostUsdcE6.toString(), "<", MIN_EXPECTED_USDC_E6.toString());
    console.error("Paymaster accepted fake low gas and undercharged. Bundler-authoritative pricing may be broken.");
    process.exit(1);
  }

  console.log("PASS: Paymaster correctly used bundler estimate; fake low gas did not underprice.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
