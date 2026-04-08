/**
 * Anvil-only dev helpers: probe RPC, fund paymaster USDC via whale impersonation, fund native via setBalance.
 */
import { paymasterDebugLog } from "./debugLog.js";
import {
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Address,
  type PublicClient,
} from "viem";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const USDC_AMOUNT_20_E6 = 20_000_000n;

/** Top up impersonated whale with ETH so the ERC-20 transfer can pay gas (matches integrated-tests funding). */
const WHALE_GAS_TOPUP_WEI = parseEther("1");

const DEFAULT_NATIVE_TOPUP_WEI = 10_000_000_000_000_000_000n; // 10 ether

function rpcUrlHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host || rpcUrl;
  } catch {
    return "(unparsed)";
  }
}

export async function isAnvilRpc(rpcUrl: string): Promise<boolean> {
  const rpcHost = rpcUrlHost(rpcUrl);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
    });
    if (!res.ok) {
      paymasterDebugLog("anvil", {
        step: "anvil:rpc_probe",
        ok: false,
        rpcHost,
        httpStatus: res.status,
      });
      return false;
    }
    const json = (await res.json()) as { result?: string };
    const ver = typeof json.result === "string" ? json.result : "";
    const isAnvil = ver.toLowerCase().includes("anvil");
    if (!isAnvil) {
      paymasterDebugLog("anvil", {
        step: "anvil:rpc_probe",
        ok: false,
        rpcHost,
        reason: "client_version_not_anvil",
        clientVersionPreview: ver.slice(0, 120),
      });
    }
    return isAnvil;
  } catch (e) {
    paymasterDebugLog("anvil", {
      step: "anvil:rpc_probe",
      ok: false,
      rpcHost,
      error: String((e as Error).message),
    });
    return false;
  }
}

export function anvilDevToolsFlagOn(): boolean {
  return process.env.PAYMASTER_API_ANVIL_DEV_TOOLS?.trim() === "true";
}

export async function getAnvilDevStatus(rpcUrl: string): Promise<{ enabled: boolean }> {
  if (!anvilDevToolsFlagOn()) {
    paymasterDebugLog("anvil_dev_status", { enabled: false, reason: "PAYMASTER_API_ANVIL_DEV_TOOLS not true" });
    return { enabled: false };
  }
  const anvil = await isAnvilRpc(rpcUrl);
  paymasterDebugLog("anvil_dev_status", { enabled: anvil, rpcUrl });
  return { enabled: anvil };
}

export async function ensureAnvilDevActive(
  rpcUrl: string
): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  if (!anvilDevToolsFlagOn()) {
    paymasterDebugLog("anvil_dev_gate", { ok: false, error: "anvil_dev_tools_flag_off" });
    return { ok: false, error: "PAYMASTER_API_ANVIL_DEV_TOOLS is not enabled", httpStatus: 503 };
  }
  if (!(await isAnvilRpc(rpcUrl))) {
    paymasterDebugLog("anvil_dev_gate", { ok: false, error: "not_anvil_rpc" });
    return { ok: false, error: "RPC is not Anvil (web3_clientVersion probe failed)", httpStatus: 503 };
  }
  paymasterDebugLog("anvil_dev_gate", { ok: true });
  return { ok: true };
}

/** Fund target: optional env override, else deployed paymaster address. */
export function resolveAnvilFundTarget(paymasterAddress: string): Address | null {
  const override = process.env.PAYMASTER_API_ANVIL_DEV_FUND_ADDRESS?.trim();
  const raw = (override || paymasterAddress).trim().toLowerCase();
  return raw ? (raw as Address) : null;
}

export async function fundPaymasterUsdc20(
  rpcUrl: string,
  publicClient: PublicClient,
  paymasterAddress: string
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const fundTo = resolveAnvilFundTarget(paymasterAddress);
  const whale = process.env.PAYMASTER_API_ANVIL_USDC_WHALE_ADDRESS?.trim();
  const usdc = process.env.PAYMASTER_API_REFILL_USDC_ADDRESS?.trim();
  if (!fundTo) return { ok: false, error: "Paymaster address required for Anvil USDC funding" };
  if (!whale) return { ok: false, error: "PAYMASTER_API_ANVIL_USDC_WHALE_ADDRESS required" };
  if (!usdc) return { ok: false, error: "PAYMASTER_API_REFILL_USDC_ADDRESS required" };

  const whaleAddr = whale.toLowerCase() as Address;
  const usdcAddr = usdc.toLowerCase() as Address;

  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "anvil-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const anvilClient = createTestClient({
    transport: http(rpcUrl),
    mode: "anvil",
  });

  const walletClient = createWalletClient({
    chain,
    transport: http(rpcUrl),
  });

  paymasterDebugLog("fund_paymaster_usdc20 start", { fundTo, whale: whaleAddr, usdc: usdcAddr });
  await anvilClient.impersonateAccount({ address: whaleAddr });
  await anvilClient.setBalance({ address: whaleAddr, value: WHALE_GAS_TOPUP_WEI });
  try {
    const hash = await walletClient.writeContract({
      address: usdcAddr,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [fundTo, USDC_AMOUNT_20_E6],
      account: whaleAddr,
    });
    paymasterDebugLog("fund_paymaster_usdc20 done", { txHash: hash });
    return { ok: true, txHash: hash };
  } finally {
    await anvilClient.stopImpersonatingAccount({ address: whaleAddr });
  }
}

export async function fundPaymasterNative(
  rpcUrl: string,
  publicClient: PublicClient,
  paymasterAddress: string
): Promise<{ ok: true; newBalanceWei: string } | { ok: false; error: string }> {
  const fundTo = resolveAnvilFundTarget(paymasterAddress);
  if (!fundTo) return { ok: false, error: "Paymaster address required for Anvil native funding" };

  let addWei = DEFAULT_NATIVE_TOPUP_WEI;
  const raw = process.env.PAYMASTER_API_ANVIL_DEV_NATIVE_WEI?.trim();
  if (raw) {
    try {
      addWei = BigInt(raw);
    } catch {
      return { ok: false, error: "PAYMASTER_API_ANVIL_DEV_NATIVE_WEI is not a valid integer" };
    }
  }

  const current = await publicClient.getBalance({ address: fundTo });
  const target = current + addWei;

  paymasterDebugLog("fund_paymaster_native start", {
    fundTo,
    addWei: addWei.toString(),
    targetWei: target.toString(),
  });

  const anvilClient = createTestClient({
    transport: http(rpcUrl),
    mode: "anvil",
  });

  await anvilClient.setBalance({
    address: fundTo,
    value: target,
  });

  paymasterDebugLog("fund_paymaster_native done", { newBalanceWei: target.toString() });
  return { ok: true, newBalanceWei: target.toString() };
}
