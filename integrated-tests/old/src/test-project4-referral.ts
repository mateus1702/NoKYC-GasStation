import "../../src/load-env.js";
/**
 * Test: Referral sponsorship returns quote fields, then executes real UserOp and validates
 * USDC balance deltas across user, NoKYC treasury, and dApp treasury.
 *
 * Prereqs: docker compose up (anvil, contract-deployer, bundler-alto, paymaster-api, valkey, dashboard)
 * Run: npm run test:project4:referral (from integrated-tests)
 */
import {
  createPublicClient,
  createTestClient,
  decodeAbiParameters,
  encodeFunctionData,
  getContract,
  http,
  isAddress,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  type Address,
  type Hex,
  defineChain,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { fundAccountWithUSDC, MIN_USDC_BALANCE, USDC_ADDRESS } from "../../src/funding.js";

const RPC_URL = process.env.TOOLS_RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_URL = (process.env.TOOLS_PAYMASTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BUNDLER_URL = process.env.TOOLS_BUNDLER_URL ?? "http://127.0.0.1:4337";
const PRIVATE_KEY = process.env.TOOLS_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const REFERRAL_ADDRESS = process.env.TOOLS_DAPP_TREASURY_ADDRESS ?? process.env.TOOLS_REFERRAL_ADDRESS ?? "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const REFERRAL_BPS = Number(process.env.TOOLS_REFERRAL_BPS ?? "200");
const FUNDING_AMOUNT = parseUnits(process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000", 6);
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

const testClient = createTestClient({
  chain: localChain,
  transport: http(RPC_URL),
  mode: "anvil",
});

const paymasterClient = createPimlicoClient({
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
  transport: http(PAYMASTER_URL),
});

const owner = privateKeyToAccount(
  (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`
);

interface SponsorPayload {
  paymaster: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  paymasterData: string;
  estimatedBaseCostUsdcE6?: string;
  estimatedReferralUsdcE6?: string;
  estimatedTotalCostUsdcE6?: string;
  maxBaseCostUsdcE6?: string;
  maxReferralUsdcE6?: string;
  maxTotalCostUsdcE6?: string;
  estimatedGas?: string;
}

type ReferralContext = { referralAddress: string; referralBps: number };

function stringifyRpcBody(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
}

async function requestSponsorPayload(
  userOp: Record<string, unknown>,
  entryPointAddress: string,
  referralContext?: ReferralContext
): Promise<SponsorPayload> {
  const body = stringifyRpcBody({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_sponsorUserOperation",
    params: referralContext ? [userOp, entryPointAddress, referralContext] : [userOp, entryPointAddress],
  });

  const res = await fetch(PAYMASTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Paymaster request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { result?: SponsorPayload; error?: { message?: string } };
  if (json.error) throw new Error(`Paymaster error: ${json.error.message ?? "unknown error"}`);
  if (!json.result?.paymasterData) throw new Error("No paymasterData in response");
  return json.result;
}

async function main() {
  console.log("Referral sponsorship test:");
  console.log("  RPC_URL:", RPC_URL);
  console.log("  Paymaster API:", PAYMASTER_URL);
  console.log("  Bundler:", BUNDLER_URL);
  console.log("  dApp treasury (referral):", REFERRAL_ADDRESS);
  console.log("  Referral BPS:", REFERRAL_BPS);
  console.log("");

  if (!isAddress(REFERRAL_ADDRESS)) {
    console.error("Invalid referral/dApp treasury address:", REFERRAL_ADDRESS);
    process.exit(1);
  }
  if (REFERRAL_BPS <= 0 || REFERRAL_BPS > 500) {
    console.error("Invalid TOOLS_REFERRAL_BPS; expected 1..500.");
    process.exit(1);
  }

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

  const nokycFeeSink = (
    process.env.PAYMASTER_CONTRACT_TREASURY_ADDRESS ||
    process.env.DASHBOARD_TREASURY_ADDRESS ||
    paymasterAddress
  )
    .trim()
    .toLowerCase();
  if (!isAddress(nokycFeeSink)) {
    console.error("Invalid NoKYC USDC fee sink address (paymaster contract expected).");
    process.exit(1);
  }
  console.log("  NoKYC USDC fee sink:", nokycFeeSink);
  console.log("");

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });

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

  const referralContext: ReferralContext = { referralAddress: REFERRAL_ADDRESS, referralBps: REFERRAL_BPS };
  const result = await requestSponsorPayload(userOp as Record<string, unknown>, entryPoint07Address, referralContext);

  const quoteFields = [
    "estimatedBaseCostUsdcE6",
    "estimatedReferralUsdcE6",
    "estimatedTotalCostUsdcE6",
    "maxBaseCostUsdcE6",
    "maxReferralUsdcE6",
    "maxTotalCostUsdcE6",
    "estimatedGas",
  ] as const;

  for (const field of quoteFields) {
    if (!(field in result) || result[field] == null) {
      console.error("Missing quote field:", field);
      process.exit(1);
    }
  }

  const estimatedBase = BigInt(result.estimatedBaseCostUsdcE6!);
  const estimatedReferral = BigInt(result.estimatedReferralUsdcE6!);
  const estimatedTotal = BigInt(result.estimatedTotalCostUsdcE6!);

  if (estimatedTotal !== estimatedBase + estimatedReferral) {
    console.error(
      "FAIL: estimatedTotal != estimatedBase + estimatedReferral:",
      estimatedTotal.toString(),
      "!=",
      (estimatedBase + estimatedReferral).toString()
    );
    process.exit(1);
  }

  const decoded = decodeAbiParameters(
    parseAbiParameters(
      "uint48 validUntil, uint48 validAfter, uint256 maxTotalChargeUsdcE6, uint256 usdcPerGasUnitE6, uint256 minPostopFeeUsdcE6, uint256 minUserUsdcBalanceE6, address referralAddress, uint256 referralBps, uint8 capProfile, bytes signature"
    ),
    result.paymasterData as `0x${string}`
  );

  const decodedReferralAddress = (decoded[6] as string).toLowerCase();
  const decodedReferralBps = decoded[7] as bigint;

  if (decodedReferralAddress !== REFERRAL_ADDRESS.toLowerCase()) {
    console.error("FAIL: paymasterData referralAddress mismatch:", decodedReferralAddress, "!= expected", REFERRAL_ADDRESS);
    process.exit(1);
  }
  if (decodedReferralBps !== BigInt(REFERRAL_BPS)) {
    console.error("FAIL: paymasterData referralBps mismatch:", decodedReferralBps.toString(), "!=", REFERRAL_BPS.toString());
    process.exit(1);
  }

  console.log("Step 1/3 PASS: referral quote + paymasterData fields validated:", {
    estimatedBaseCostUsdcE6: result.estimatedBaseCostUsdcE6,
    estimatedReferralUsdcE6: result.estimatedReferralUsdcE6,
    estimatedTotalCostUsdcE6: result.estimatedTotalCostUsdcE6,
    maxBaseCostUsdcE6: result.maxBaseCostUsdcE6,
    maxReferralUsdcE6: result.maxReferralUsdcE6,
    maxTotalCostUsdcE6: result.maxTotalCostUsdcE6,
    estimatedGas: result.estimatedGas,
  });
  const usdc = getContract({
    address: USDC_ADDRESS,
    abi: parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ]),
    client: publicClient,
  });

  const userBalanceBeforeFund = await usdc.read.balanceOf([account.address]);
  if (userBalanceBeforeFund < MIN_USDC_BALANCE) {
    console.log("Funding smart account with USDC...");
    await fundAccountWithUSDC(account.address, FUNDING_AMOUNT, usdc, publicClient, testClient);
  }

  const referralAwarePaymaster = {
    getPaymasterData: async (parameters: Record<string, unknown>) => {
      const { entryPointAddress, context, ...partialUserOp } = parameters;
      const payload = await requestSponsorPayload(
        partialUserOp,
        String(entryPointAddress),
        (context ?? undefined) as ReferralContext | undefined
      );
      return {
        paymaster: payload.paymaster as Address,
        paymasterData: payload.paymasterData as Hex,
        paymasterVerificationGasLimit: BigInt(payload.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: BigInt(payload.paymasterPostOpGasLimit),
      };
    },
  };

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: localChain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: referralAwarePaymaster,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  // Bootstrap: approve paymaster spending. This path is intentionally not charged.
  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [paymasterAddress as Address, parseUnits("1000000", 6)],
  });
  await smartAccountClient.sendTransaction({
    calls: [{ to: USDC_ADDRESS, value: 0n, data: approveData }],
  });

  const userBefore = await usdc.read.balanceOf([account.address]);
  const noKycBefore = await usdc.read.balanceOf([nokycFeeSink as Address]);
  const dappBefore = await usdc.read.balanceOf([REFERRAL_ADDRESS as Address]);

  const executionHash = await smartAccountClient.sendTransaction({
    calls: [{ to: executeTarget as Address, value: 0n }],
    paymasterContext: referralContext,
  });

  const userAfter = await usdc.read.balanceOf([account.address]);
  const noKycAfter = await usdc.read.balanceOf([nokycFeeSink as Address]);
  const dappAfter = await usdc.read.balanceOf([REFERRAL_ADDRESS as Address]);

  const userCharged = userBefore - userAfter;
  const noKycReceived = noKycAfter - noKycBefore;
  const dappReceived = dappAfter - dappBefore;

  console.log("Execution tx hash:", executionHash);
  console.log("Balance deltas (USDC e6):", {
    userCharged: userCharged.toString(),
    noKycReceived: noKycReceived.toString(),
    dappReceived: dappReceived.toString(),
  });

  if (userCharged <= 0n) {
    console.error("FAIL: expected user to be charged USDC after sponsored UserOp.");
    process.exit(1);
  }
  if (noKycReceived <= 0n) {
    console.error("FAIL: expected NoKYC paymaster (fee sink) to receive USDC.");
    process.exit(1);
  }
  if (dappReceived <= 0n) {
    console.error("FAIL: expected dApp treasury (referral) to receive USDC.");
    process.exit(1);
  }
  if (userCharged !== noKycReceived + dappReceived) {
    console.error(
      "FAIL: user charge mismatch. userCharged != noKycReceived + dappReceived",
      userCharged.toString(),
      "!=",
      (noKycReceived + dappReceived).toString()
    );
    process.exit(1);
  }

  console.log("PASS: Referral sponsorship executed end-to-end with expected treasury/user balance movements (P4-IT-002).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
