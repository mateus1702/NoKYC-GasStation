import "../../src/load-env.js";
/**
 * Smoke test: paymaster API /gas-price (RPC) and pm_getPaymasterData with on-chain counter pricing.
 * Prereqs: docker compose up (anvil, contract-deployer, bundler-alto, paymaster-api, valkey)
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

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const DASHBOARD_URL = (process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
  console.log("Gas price + sponsor smoke test:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("");

  const gasPriceRes = await fetch(`${PAYMASTER_URL}/gas-price`, { signal: AbortSignal.timeout(5000) });
  if (!gasPriceRes.ok) {
    console.error("GET /gas-price failed:", gasPriceRes.status, await gasPriceRes.text());
    process.exit(1);
  }
  const gasPriceJson = (await gasPriceRes.json()) as { gasPriceWei?: string; source?: string; error?: string };
  const gasPriceWei = gasPriceJson.gasPriceWei != null ? BigInt(gasPriceJson.gasPriceWei) : 0n;

  if (gasPriceWei <= 0n) {
    console.error("FAIL: /gas-price returned gasPriceWei <= 0");
    process.exit(1);
  }
  if (gasPriceJson.source !== "rpc") {
    console.error("FAIL: /gas-price expected source rpc, got:", gasPriceJson.source);
    process.exit(1);
  }
  console.log("GET /gas-price: source=rpc, gasPriceWei=", gasPriceWei.toString());

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

  const userOp = {
    sender: account.address,
    nonce: `0x${nonce.toString(16)}`,
    factory: null,
    factoryData: null,
    callData,
    callGasLimit: "0x186a0",
    verificationGasLimit: "0x186a0",
    preVerificationGas: "0xc350",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit: "0x30d40",
    paymasterPostOpGasLimit: "0x1d4c0",
    paymasterData: "0x",
    signature:
      "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c",
  };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_getPaymasterData",
    params: [userOp, entryPoint07Address],
  });

  const sponsorRes = await fetch(PAYMASTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!sponsorRes.ok) {
    console.error("pm_getPaymasterData failed:", sponsorRes.status, await sponsorRes.text());
    process.exit(1);
  }

  const sponsorJson = (await sponsorRes.json()) as {
    result?: { paymasterData?: string };
    error?: { message?: string };
  };
  if (sponsorJson.error) {
    console.error("Paymaster error:", sponsorJson.error.message);
    process.exit(1);
  }

  const paymasterData = sponsorJson.result?.paymasterData;
  if (!paymasterData || typeof paymasterData !== "string") {
    console.error("No paymasterData in response");
    process.exit(1);
  }

  const decoded = decodeAbiParameters(
    parseAbiParameters(
      "uint48 validUntil, uint48 validAfter, uint256 maxTotalChargeUsdcE6, uint256 usdcPerGasUnitE6, uint256 minPostopFeeUsdcE6, uint256 minUserUsdcBalanceE6, address referralAddress, uint256 referralBps, uint8 capProfile, bytes signature"
    ),
    paymasterData as `0x${string}`
  );
  const maxTotal = decoded[2] as bigint;
  const perGas = decoded[3] as bigint;
  if (maxTotal <= 0n) {
    console.error("FAIL: maxTotalChargeUsdcE6 <= 0");
    process.exit(1);
  }
  if (perGas <= 0n) {
    console.error("FAIL: usdcPerGasUnitE6 <= 0");
    process.exit(1);
  }
  console.log("pm_getPaymasterData: maxTotalChargeUsdcE6=", maxTotal.toString(), "usdcPerGasUnitE6=", perGas.toString());

  if (DASHBOARD_URL) {
    try {
      const metricsRes = await fetch(`${DASHBOARD_URL}/api/metrics`, {
        credentials: "include",
        signal: AbortSignal.timeout(5000),
      });
      if (metricsRes.ok) {
        const metrics = (await metricsRes.json()) as { gasPriceWei?: { status?: string } };
        if (metrics.gasPriceWei?.status !== "ok") {
          console.error("FAIL: dashboard gasPriceWei.status != ok:", metrics.gasPriceWei?.status);
          process.exit(1);
        }
        console.log("Dashboard metrics: gasPriceWei.status=ok");
      }
    } catch (e) {
      console.warn("Could not reach dashboard (skipping metrics check):", (e as Error).message);
    }
  }

  console.log("PASS: Gas price + sponsor smoke test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
