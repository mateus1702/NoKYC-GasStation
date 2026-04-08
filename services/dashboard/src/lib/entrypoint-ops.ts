/**
 * Fetch EntryPoint UserOperationEvent logs for our paymaster.
 * Shows MATIC spent (actualGasCost) per UserOp so you can compare with USDC charged.
 */
import { readFile } from "node:fs/promises";
import { loadDashboardRedisConfig } from "@project4/shared";
import { createPublicClient, http as viemHttp, parseAbiItem } from "viem";
import { polygon } from "viem/chains";

const PAYMASTER_ADDRESS_FILE = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE || "";
const PAYMASTER_ADDRESS_ENV = (process.env.PAYMASTER_ADDRESS || "").trim().toLowerCase();
const DEFAULT_LIMIT = 30;

export interface EntryPointOp {
  blockNumber: number;
  transactionHash: string;
  userOpHash: string;
  sender: string;
  paymaster: string;
  nonce: string;
  success: boolean;
  actualGasCostWei: string;
  actualGasUsed: string;
}

export interface EntryPointOpsPayload {
  status: "ok" | "error";
  items: EntryPointOp[];
  timestamp: string;
  error?: string;
}

async function resolvePaymasterAddress(
  RPC_URL: string,
  PAYMASTER_API_URL: string
): Promise<string> {
  if (!RPC_URL) throw new Error("DASHBOARD_RPC_URL required (Redis config)");
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

const USER_OP_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGas)"
);

export async function fetchRecentEntryPointOps(limit = DEFAULT_LIMIT): Promise<EntryPointOpsPayload> {
  const payload: EntryPointOpsPayload = {
    status: "error",
    items: [],
    timestamp: new Date().toISOString(),
    error: "Could not fetch EntryPoint ops",
  };

  try {
    const cfg = await loadDashboardRedisConfig();
    const RPC_URL = cfg.DASHBOARD_RPC_URL;
    const PAYMASTER_API_URL = cfg.PAYMASTER_API_URL.replace(/\/$/, "");
    const ENTRYPOINT_ADDRESS = (
      cfg.DASHBOARD_ENTRYPOINT_ADDRESS ||
      process.env.PAYMASTER_API_ENTRYPOINT_ADDRESS ||
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
    ).trim().toLowerCase();
    const USEROPS_BLOCK_RANGE = BigInt(cfg.DASHBOARD_USEROPS_BLOCK_RANGE);

    const paymasterAddress = await resolvePaymasterAddress(RPC_URL, PAYMASTER_API_URL);
    if (!ENTRYPOINT_ADDRESS) throw new Error("DASHBOARD_ENTRYPOINT_ADDRESS required");

    const client = createPublicClient({
      chain: polygon,
      transport: viemHttp(RPC_URL),
    });

    const block = await client.getBlockNumber();
    const fromBlock = block > USEROPS_BLOCK_RANGE ? block - USEROPS_BLOCK_RANGE : 0n;

    const logs = await client.getContractEvents({
      address: ENTRYPOINT_ADDRESS as `0x${string}`,
      abi: [USER_OP_EVENT],
      args: { paymaster: paymasterAddress as `0x${string}` },
      fromBlock,
      toBlock: block,
    });

    const items: EntryPointOp[] = logs
      .map((log) => {
        if (!("args" in log) || !log.args) return null;
        const args = log.args as {
          userOpHash?: unknown;
          sender?: unknown;
          paymaster?: unknown;
          nonce?: unknown;
          success?: unknown;
          actualGasCost?: unknown;
          actualGas?: unknown;
        };
        if (
          args.userOpHash == null ||
          args.sender == null ||
          args.paymaster == null ||
          args.nonce == null ||
          args.success == null ||
          args.actualGasCost == null ||
          args.actualGas == null
        )
          return null;

        return {
          blockNumber: Number(log.blockNumber ?? 0n),
          transactionHash: (log.transactionHash ?? "") as string,
          userOpHash: String(args.userOpHash),
          sender: String(args.sender).toLowerCase(),
          paymaster: String(args.paymaster).toLowerCase(),
          nonce: BigInt(args.nonce as bigint | string | number).toString(),
          success: Boolean(args.success),
          actualGasCostWei: BigInt(args.actualGasCost as bigint | string | number).toString(),
          actualGasUsed: BigInt(args.actualGas as bigint | string | number).toString(),
        };
      })
      .filter((x): x is EntryPointOp => x != null)
      .sort((a, b) => b.blockNumber - a.blockNumber || (a.transactionHash < b.transactionHash ? 1 : -1))
      .slice(0, limit);

    payload.status = "ok";
    payload.items = items;
    payload.error = undefined;
  } catch (e) {
    payload.error = (e as Error).message;
  }

  return payload;
}
