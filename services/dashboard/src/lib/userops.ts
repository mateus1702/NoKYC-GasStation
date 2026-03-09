/**
 * Fetch latest processed UserOps from GasCharged events on NoKYC-GasStation Paymaster.
 * No docker dependency; uses RPC + paymaster address.
 */
import { readFile } from "node:fs/promises";
import { createPublicClient, http as viemHttp, parseAbiItem } from "viem";
import { polygon } from "viem/chains";

const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE!;
const PAYMASTER_ADDRESS_ENV = (process.env.PAYMASTER_ADDRESS || "").trim().toLowerCase();
const PAYMASTER_API_URL = process.env.PAYMASTER_API_URL!.trim().replace(/\/$/, "");
const RPC_URL = process.env.DASHBOARD_RPC_URL!;
const DEFAULT_LIMIT = 30;
/** Env override: max block range for eth_getLogs. If set, use only this (no retry). */
const USEROPS_BLOCK_RANGE = process.env.DASHBOARD_USEROPS_BLOCK_RANGE ? BigInt(process.env.DASHBOARD_USEROPS_BLOCK_RANGE) : null;
/** Block ranges to try when env not set. Probed: Anvil+Ankr fork limit is 1024 blocks. */
const BLOCK_RANGES_TO_TRY = USEROPS_BLOCK_RANGE != null ? [USEROPS_BLOCK_RANGE] : [1024n, 512n, 256n, 128n];

export interface ProcessedUserOp {
  blockNumber: number;
  transactionHash: string;
  sender: string;
  chargedUsdcE6: string;
  chargedWei: string;
  gasUsed: string;
  usdcPer1MGas: string;
  initialChargeAmount: string;
  maxCostUsdcE6: string;
  unitCostUsdcPerWei: string;
  minPostopFeeUsdcE6: string;
  treasury: string;
  wasMinFeeApplied: boolean;
  wasMaxFeeApplied: boolean;
}

export interface UserOpsPayload {
  status: "ok" | "error";
  items: ProcessedUserOp[];
  timestamp: string;
  error?: string;
}

async function resolvePaymasterAddress(): Promise<string> {
  if (!RPC_URL) throw new Error("RPC_URL required (set in .env)");
  if (PAYMASTER_ADDRESS_ENV) return PAYMASTER_ADDRESS_ENV as `0x${string}`;
  if (PAYMASTER_ADDRESS_FILE) {
    try {
      const raw = (await readFile(PAYMASTER_ADDRESS_FILE, "utf8")).trim().toLowerCase();
      if (raw) return raw as `0x${string}`;
      throw new Error("Paymaster address file is empty");
    } catch (e) {
      if (PAYMASTER_API_URL) {
        try {
          const res = await fetch(`${PAYMASTER_API_URL}/paymaster-address`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const json = (await res.json()) as { paymasterAddress?: string };
            const addr = (json.paymasterAddress || "").trim().toLowerCase();
            if (addr) return addr as `0x${string}`;
          }
        } catch {
          /* fall through to throw */
        }
      }
      throw new Error(`Could not read paymaster address: ${(e as Error).message}`);
    }
  }
  if (PAYMASTER_API_URL) {
    const res = await fetch(`${PAYMASTER_API_URL}/paymaster-address`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = (await res.json()) as { paymasterAddress?: string };
      const addr = (json.paymasterAddress || "").trim().toLowerCase();
      if (addr) return addr as `0x${string}`;
    }
  }
  throw new Error("PAYMASTER_ADDRESS, CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE, or PAYMASTER_API_URL required (set in .env)");
}

export async function fetchRecentProcessedUserOps(limit = DEFAULT_LIMIT): Promise<UserOpsPayload> {
  const payload: UserOpsPayload = {
    status: "error",
    items: [],
    timestamp: new Date().toISOString(),
    error: "Could not fetch UserOps",
  };

  try {
    const paymasterAddress = await resolvePaymasterAddress();
    const client = createPublicClient({
      chain: polygon,
      transport: viemHttp(RPC_URL),
    });

    const block = await client.getBlockNumber();
    let logs: Awaited<ReturnType<typeof client.getContractEvents>> = [];
    let lastError: Error | null = null;

    for (const range of BLOCK_RANGES_TO_TRY) {
      const fromBlock = block > range ? block - range : 0n;
      try {
        logs = await client.getContractEvents({
          address: paymasterAddress as `0x${string}`,
          abi: [parseAbiItem("event GasCharged(address indexed sender, uint256 chargedUsdcE6, uint256 chargedWei, uint256 initialChargeAmount, uint256 maxCostUsdcE6, uint256 unitCostUsdcPerWei, uint256 minPostopFeeUsdcE6, address treasury, bool wasMinFeeApplied, bool wasMaxFeeApplied)")],
          fromBlock,
          toBlock: block,
        });
        lastError = null;
        break;
      } catch (e) {
        lastError = e as Error;
        const msg = String((e as Error).message || "").toLowerCase();
        if (msg.includes("block range") || msg.includes("too large") || msg.includes("too wide")) {
          continue;
        }
        throw e;
      }
    }
    if (lastError) throw lastError;

    const rawMapped = logs.map((log) => {
      // viem log type can be a union where decoded args are absent.
      if (!("args" in log) || !log.args) return null;
      const args = log.args as {
        sender?: unknown;
        chargedUsdcE6?: unknown;
        chargedWei?: unknown;
        initialChargeAmount?: unknown;
        maxCostUsdcE6?: unknown;
        unitCostUsdcPerWei?: unknown;
        minPostopFeeUsdcE6?: unknown;
        treasury?: unknown;
        wasMinFeeApplied?: unknown;
        wasMaxFeeApplied?: unknown;
      };
      if (args.sender == null || args.chargedUsdcE6 == null || args.chargedWei == null ||
          args.initialChargeAmount == null || args.maxCostUsdcE6 == null ||
          args.unitCostUsdcPerWei == null || args.minPostopFeeUsdcE6 == null ||
          args.treasury == null || args.wasMinFeeApplied == null || args.wasMaxFeeApplied == null) return null;

      const chargedUsdcE6 = BigInt(args.chargedUsdcE6 as bigint | string | number);
      const chargedWei = BigInt(args.chargedWei as bigint | string | number);
      const usdcPer1MGas = chargedWei > 0n ? (chargedUsdcE6 * 1_000_000n) / chargedWei : 0n;
      return {
        blockNumber: Number(log.blockNumber ?? 0n),
        transactionHash: (log.transactionHash ?? "") as string,
        sender: String(args.sender).toLowerCase(),
        chargedUsdcE6: chargedUsdcE6.toString(),
        chargedWei: chargedWei.toString(),
        usdcPer1MGas: usdcPer1MGas.toString(),
        initialChargeAmount: BigInt(args.initialChargeAmount as bigint | string | number).toString(),
        maxCostUsdcE6: BigInt(args.maxCostUsdcE6 as bigint | string | number).toString(),
        unitCostUsdcPerWei: BigInt(args.unitCostUsdcPerWei as bigint | string | number).toString(),
        minPostopFeeUsdcE6: BigInt(args.minPostopFeeUsdcE6 as bigint | string | number).toString(),
        treasury: String(args.treasury).toLowerCase(),
        wasMinFeeApplied: Boolean(args.wasMinFeeApplied),
        wasMaxFeeApplied: Boolean(args.wasMaxFeeApplied),
      };
    });

    const rawItems = rawMapped.filter((x): x is NonNullable<typeof rawMapped[number]> => x != null);
    const uniqueTxHashes = [...new Set(rawItems.map((x) => x.transactionHash).filter(Boolean))];

    const receiptMap = new Map<string, { effectiveGasPrice: bigint }>();
    await Promise.all(
      uniqueTxHashes.map(async (hash) => {
        try {
          const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
          if (!receipt) return;
          const effectiveGasPrice = receipt.effectiveGasPrice ?? (receipt as { gasPrice?: bigint }).gasPrice ?? 0n;
          if (effectiveGasPrice > 0n) {
            receiptMap.set(hash, { effectiveGasPrice });
          }
        } catch {
          /* ignore; gasUsed will show "-" */
        }
      })
    );

    const mapped: ProcessedUserOp[] = rawItems.map((raw) => {
      const receiptData = receiptMap.get(raw.transactionHash);
      const chargedWei = BigInt(raw.chargedWei);
      const gasUsed =
        receiptData && chargedWei > 0n && receiptData.effectiveGasPrice > 0n
          ? (chargedWei / receiptData.effectiveGasPrice).toString()
          : "-";
      return { ...raw, gasUsed };
    });

    const items: ProcessedUserOp[] = mapped.reverse().slice(0, limit);

    payload.status = "ok";
    payload.items = items;
    payload.error = undefined;
  } catch (e) {
    payload.error = (e as Error).message;
  }

  return payload;
}
