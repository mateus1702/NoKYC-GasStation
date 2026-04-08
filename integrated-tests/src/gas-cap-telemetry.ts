import { decodeEventLog, parseAbiItem, type Address } from "viem";
import type { GasProfile } from "./gas-cap-analyzer.js";

const USER_OPERATION_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGas)"
);
const GAS_CHARGED_EVENT = parseAbiItem(
  "event GasCharged(address indexed sender, uint256 chargedUsdcE6, uint256 baseChargeUsdcE6, address treasury, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"
);
const GAS_CHARGED_WITH_REF_EVENT = parseAbiItem(
  "event GasChargedWithReferral(address indexed sender, uint256 baseChargeUsdcE6, uint256 referralChargeUsdcE6, uint256 totalChargeUsdcE6, address indexed referralAddress, uint256 referralBps, uint256 gasUnits, uint256 actualGasCost, uint256 actualUserOpFeePerGas)"
);

export interface OpTelemetry {
  scenarioId: string;
  scenarioDescription: string;
  profile: GasProfile;
  userOpHash?: string;
  txHash?: string;
  success: boolean;
  actualGasUsed?: bigint;
  actualGasCostWei?: bigint;
  gasUnitsCharged?: bigint;
  contractGasPriceWei?: bigint;
  sponsorEstimatedGas?: bigint;
  sponsorEstimatedNormalGasUnits?: bigint;
  sponsorEstimatedDeployGasUnits?: bigint;
  error?: string;
}

interface JsonRpcResult<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

export async function resolveTransactionHashFromMaybeUserOpHash(
  bundlerUrl: string,
  hash: `0x${string}`,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem public client type
  publicClient: { getTransactionReceipt: (args: any) => Promise<any> }
): Promise<{ txHash?: `0x${string}`; userOpHash?: `0x${string}` }> {
  try {
    await publicClient.getTransactionReceipt({ hash });
    return { txHash: hash };
  } catch {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getUserOperationReceipt",
      params: [hash],
    };
    const res = await fetch(bundlerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { userOpHash: hash };
    const json = (await res.json()) as JsonRpcResult<{ receipt?: { transactionHash?: string } }>;
    const txHash = json.result?.receipt?.transactionHash as `0x${string}` | undefined;
    return txHash ? { txHash, userOpHash: hash } : { userOpHash: hash };
  }
}

export async function collectTelemetryFromTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem public client type
  publicClient: { getTransactionReceipt: (args: any) => Promise<any> },
  txHash: `0x${string}`,
  entryPointAddress: Address,
  paymasterAddress: Address
): Promise<{
  userOpHash?: string;
  success: boolean;
  actualGasUsed?: bigint;
  actualGasCostWei?: bigint;
  gasUnitsCharged?: bigint;
  contractGasPriceWei?: bigint;
}> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  let userOpHash: string | undefined;
  let success = receipt.status === "success";
  let actualGasUsed: bigint | undefined;
  let actualGasCostWei: bigint | undefined;
  let gasUnitsCharged: bigint | undefined;
  let contractGasPriceWei: bigint | undefined;

  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() === entryPointAddress.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: [USER_OPERATION_EVENT],
          data: log.data,
          topics: log.topics,
        });
        const args = decoded.args as {
          userOpHash?: unknown;
          success?: unknown;
          actualGas?: unknown;
          actualGasCost?: unknown;
        };
        if (args.userOpHash != null) userOpHash = String(args.userOpHash);
        if (args.success != null) success = Boolean(args.success);
        if (args.actualGas != null) actualGasUsed = BigInt(args.actualGas as bigint | string | number);
        if (args.actualGasCost != null) actualGasCostWei = BigInt(args.actualGasCost as bigint | string | number);
      } catch {
        // ignore non-matching events
      }
    }

    if (String(log.address).toLowerCase() === paymasterAddress.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: [GAS_CHARGED_EVENT, GAS_CHARGED_WITH_REF_EVENT],
          data: log.data,
          topics: log.topics,
        });
        const args = decoded.args as {
          gasUnits?: unknown;
          actualUserOpFeePerGas?: unknown;
        };
        if (args.gasUnits != null) gasUnitsCharged = BigInt(args.gasUnits as bigint | string | number);
        if (args.actualUserOpFeePerGas != null) {
          contractGasPriceWei = BigInt(args.actualUserOpFeePerGas as bigint | string | number);
        }
      } catch {
        // ignore non-matching events
      }
    }
  }

  return { userOpHash, success, actualGasUsed, actualGasCostWei, gasUnitsCharged, contractGasPriceWei };
}
