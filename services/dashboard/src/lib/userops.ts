/**
 * Fetch latest processed UserOps from GasCharged events on NoKYC-GasStation Paymaster.
 * No docker dependency; uses RPC + paymaster address.
 */
import { readFile } from "node:fs/promises";
import { loadDashboardRedisConfig } from "@project4/shared";
import { createPublicClient, http as viemHttp, decodeEventLog, parseAbiItem } from "viem";
import { polygon } from "viem/chains";

export interface DecodedLog {
  name: string;
  args: Record<string, unknown>;
  address: string;
  logIndex: number;
  /** For unknown events */
  topics?: string[];
  data?: string;
}

/** Combined ABIs for EntryPoint and Paymaster events */
const LOG_DECODE_ABI = [
  parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGas)"),
  parseAbiItem("event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)"),
  parseAbiItem("event GasCharged(address indexed sender, uint256 chargedUsdcE6, uint256 baseChargeUsdcE6, address treasury, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"),
  parseAbiItem("event GasChargedWithReferral(address indexed sender, uint256 baseChargeUsdcE6, uint256 referralChargeUsdcE6, uint256 totalChargeUsdcE6, address indexed referralAddress, uint256 referralBps, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"),
  parseAbiItem("event GasUsageTracked(address indexed sender, uint256 periodGasUsed, uint256 totalGasUsed)"),
  parseAbiItem("event CircuitBreakerTriggered(address indexed sender, uint256 gasUsed, uint256 limit)"),
  parseAbiItem("event GasEstimationAlert(address indexed sender, uint256 estimatedGas, uint256 actualGas, uint256 variance)"),
  parseAbiItem("event MaxGasLimitExceeded(address indexed sender, uint256 requestedGas, uint256 maxAllowed)"),
  parseAbiItem("event PausedUpdated(bool paused)"),
] as const;

const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE || "";
const PAYMASTER_ADDRESS_ENV = (process.env.PAYMASTER_ADDRESS || "").trim().toLowerCase();
const DEFAULT_LIMIT = 30;

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
  /** Present when event was GasChargedWithReferral */
  referralAddress?: string;
  referralChargeUsdcE6?: string;
  baseChargeUsdcE6?: string;
  /** Estimated gas units from quote (when available) */
  estimatedGasUnits?: string;
  /** Estimated cost in wei from quote (when available) */
  estimatedCostWei?: string;
  /** Gas price (wei per gas) used by API when building quote */
  gasPriceApiWei?: string;
  /** Gas price (wei per gas) from UserOp at execution */
  gasPriceContractWei?: string;
}

type RawProcessedUserOp = Omit<ProcessedUserOp, "gasUsed">;

export interface UserOpsPayload {
  status: "ok" | "error";
  items: ProcessedUserOp[];
  timestamp: string;
  error?: string;
}

async function resolvePaymasterAddress(
  RPC_URL: string,
  PAYMASTER_API_URL: string,
  redisPaymaster?: string | undefined
): Promise<string> {
  if (!RPC_URL) throw new Error("RPC_URL required (set in .env)");
  const fromRedis = redisPaymaster?.trim().toLowerCase();
  if (fromRedis) return fromRedis as `0x${string}`;
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
    const cfg = await loadDashboardRedisConfig();
    const RPC_URL = cfg.DASHBOARD_RPC_URL;
    const PAYMASTER_API_URL = cfg.PAYMASTER_API_URL.replace(/\/$/, "");
    const USEROPS_BLOCK_RANGE = BigInt(cfg.DASHBOARD_USEROPS_BLOCK_RANGE);

    const paymasterAddress = await resolvePaymasterAddress(RPC_URL, PAYMASTER_API_URL, cfg.PAYMASTER_ADDRESS);
    const client = createPublicClient({
      chain: polygon,
      transport: viemHttp(RPC_URL),
    });

    const block = await client.getBlockNumber();
    const fromBlock = block > USEROPS_BLOCK_RANGE ? block - USEROPS_BLOCK_RANGE : 0n;
    const range = { fromBlock, toBlock: block, address: paymasterAddress as `0x${string}` };

    const [gasChargedLogs, referralLogs] = await Promise.all([
      client.getContractEvents({
        ...range,
        abi: [
          parseAbiItem(
            "event GasCharged(address indexed sender, uint256 chargedUsdcE6, uint256 baseChargeUsdcE6, address treasury, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"
          ),
        ],
      }),
      client.getContractEvents({
        ...range,
        abi: [
          parseAbiItem(
            "event GasChargedWithReferral(address indexed sender, uint256 baseChargeUsdcE6, uint256 referralChargeUsdcE6, uint256 totalChargeUsdcE6, address indexed referralAddress, uint256 referralBps, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"
          ),
        ],
      }),
    ]);

    const rawMapped = gasChargedLogs.map((log) => {
      // viem log type can be a union where decoded args are absent.
      if (!("args" in log) || !log.args) return null;
      const args = log.args as {
        sender?: unknown;
        chargedUsdcE6?: unknown;
        baseChargeUsdcE6?: unknown;
        treasury?: unknown;
        gasUnits?: unknown;
        actualGasCost?: unknown;
        actualUserOpFeePerGas?: unknown;
      };
      if (args.sender == null || args.chargedUsdcE6 == null || args.baseChargeUsdcE6 == null || args.treasury == null)
        return null;

      const chargedUsdcE6 = BigInt(args.chargedUsdcE6 as bigint | string | number);
      const baseChargeUsdcE6 = BigInt(args.baseChargeUsdcE6 as bigint | string | number);
      const estimatedGasUnits = args.gasUnits != null ? BigInt(args.gasUnits as bigint | string | number).toString() : undefined;
      const estimatedCostWei = args.actualGasCost != null ? BigInt(args.actualGasCost as bigint | string | number).toString() : undefined;
      const gasPriceContractWei =
        args.actualUserOpFeePerGas != null
          ? BigInt(args.actualUserOpFeePerGas as bigint | string | number).toString()
          : undefined;
      return {
        blockNumber: Number(log.blockNumber ?? 0n),
        transactionHash: (log.transactionHash ?? "") as string,
        sender: String(args.sender).toLowerCase(),
        chargedUsdcE6: chargedUsdcE6.toString(),
        chargedWei: "0",
        usdcPer1MGas: "0",
        initialChargeAmount: chargedUsdcE6.toString(),
        maxCostUsdcE6: baseChargeUsdcE6.toString(),
        unitCostUsdcPerWei: "0",
        minPostopFeeUsdcE6: "0",
        treasury: String(args.treasury).toLowerCase(),
        wasMinFeeApplied: false,
        wasMaxFeeApplied: false,
        estimatedGasUnits,
        estimatedCostWei,
        gasPriceApiWei: undefined,
        gasPriceContractWei,
      };
    });

    const referralMapped = referralLogs.map((log) => {
      if (!("args" in log) || !log.args) return null;
      const args = log.args as {
        sender?: unknown;
        baseChargeUsdcE6?: unknown;
        referralChargeUsdcE6?: unknown;
        totalChargeUsdcE6?: unknown;
        referralAddress?: unknown;
        referralBps?: unknown;
        gasUnits?: unknown;
        actualGasCost?: unknown;
        actualUserOpFeePerGas?: unknown;
      };
      if (args.sender == null || args.baseChargeUsdcE6 == null || args.referralChargeUsdcE6 == null ||
          args.totalChargeUsdcE6 == null || args.referralAddress == null || args.referralBps == null) return null;

      const totalCharge = BigInt(args.totalChargeUsdcE6 as bigint | string | number);
      const baseCharge = BigInt(args.baseChargeUsdcE6 as bigint | string | number);
      const referralCharge = BigInt(args.referralChargeUsdcE6 as bigint | string | number);
      const estimatedGasUnits = args.gasUnits != null ? BigInt(args.gasUnits as bigint | string | number).toString() : undefined;
      const estimatedCostWei = args.actualGasCost != null ? BigInt(args.actualGasCost as bigint | string | number).toString() : undefined;
      const gasPriceContractWei =
        args.actualUserOpFeePerGas != null
          ? BigInt(args.actualUserOpFeePerGas as bigint | string | number).toString()
          : undefined;
      return {
        blockNumber: Number(log.blockNumber ?? 0n),
        transactionHash: (log.transactionHash ?? "") as string,
        sender: String(args.sender).toLowerCase(),
        chargedUsdcE6: totalCharge.toString(),
        chargedWei: "0",
        usdcPer1MGas: "0",
        initialChargeAmount: baseCharge.toString(),
        maxCostUsdcE6: "0",
        unitCostUsdcPerWei: "0",
        minPostopFeeUsdcE6: "0",
        treasury: paymasterAddress,
        wasMinFeeApplied: false,
        wasMaxFeeApplied: false,
        referralAddress: String(args.referralAddress).toLowerCase(),
        referralChargeUsdcE6: referralCharge.toString(),
        baseChargeUsdcE6: baseCharge.toString(),
        estimatedGasUnits,
        estimatedCostWei,
        gasPriceApiWei: undefined,
        gasPriceContractWei,
      };
    });

    const rawItemsBase = rawMapped.filter((x): x is NonNullable<typeof rawMapped[number]> => x != null);
    const rawItemsReferral = referralMapped.filter((x): x is NonNullable<typeof referralMapped[number]> => x != null);
    const rawItems: RawProcessedUserOp[] = [...rawItemsBase, ...rawItemsReferral].sort(
      (a, b) => b.blockNumber - a.blockNumber || (a.transactionHash < b.transactionHash ? 1 : -1)
    );
    const uniqueTxHashes = [...new Set(rawItems.map((x) => x.transactionHash).filter(Boolean))];

    const receiptMap = new Map<string, { effectiveGasPrice: bigint; gasUsed: bigint }>();
    await Promise.all(
      uniqueTxHashes.map(async (hash) => {
        try {
          const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
          if (!receipt) return;
          const effectiveGasPrice = receipt.effectiveGasPrice ?? (receipt as { gasPrice?: bigint }).gasPrice ?? 0n;
          const gasUsed = receipt.gasUsed ?? 0n;
          receiptMap.set(hash, { effectiveGasPrice, gasUsed });
        } catch {
          /* ignore; gasUsed will show "-" */
        }
      })
    );

    const mapped: ProcessedUserOp[] = rawItems.map((raw) => {
      const receiptData = receiptMap.get(raw.transactionHash);
      const chargedWei = BigInt(raw.chargedWei);
      let gasUsed: string;
      if (chargedWei > 0n && receiptData && receiptData.effectiveGasPrice > 0n) {
        gasUsed = (chargedWei / receiptData.effectiveGasPrice).toString();
      } else if (receiptData && receiptData.gasUsed > 0n) {
        gasUsed = receiptData.gasUsed.toString();
      } else {
        gasUsed = "-";
      }
      return { ...raw, gasUsed };
    });

    const items: ProcessedUserOp[] = mapped.slice(0, limit);

    payload.status = "ok";
    payload.items = items;
    payload.error = undefined;
  } catch (e) {
    payload.error = (e as Error).message;
  }

  return payload;
}

export async function decodeTransactionLogs(txHash: string): Promise<DecodedLog[]> {
  const cfg = await loadDashboardRedisConfig();
  const RPC_URL = cfg.DASHBOARD_RPC_URL;
  if (!RPC_URL) throw new Error("DASHBOARD_RPC_URL required (Redis config)");
  const client = createPublicClient({
    chain: polygon,
    transport: viemHttp(RPC_URL),
  });
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  if (!receipt || !receipt.logs) return [];
  const decoded: DecodedLog[] = [];
  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    try {
      const { eventName, args } = decodeEventLog({
        abi: LOG_DECODE_ABI,
        data: log.data,
        topics: log.topics,
      });
      decoded.push({
        name: eventName,
        args: args as Record<string, unknown>,
        address: String(log.address).toLowerCase(),
        logIndex: i,
      });
    } catch {
      decoded.push({
        name: "Unknown",
        args: {},
        address: String(log.address).toLowerCase(),
        logIndex: i,
        topics: log.topics as string[],
        data: log.data,
      });
    }
  }
  return decoded;
}
