import { paymasterDebugLog } from "./debugLog.js";

export const BUNDLER_PROXY_ALLOWED_METHODS = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "eth_supportedEntryPoints",
  "pimlico_getUserOperationGasPrice",
  "getUserOperationGasPrice",
]);

export async function forwardBundlerRpc(
  bundlerUrl: string,
  body: string,
  opts?: { rpcMethod?: string }
): Promise<{ status: number; bodyText: string; contentType: string }> {
  paymasterDebugLog("bundler_proxy request", { rpcMethod: opts?.rpcMethod ?? "(parse failed)", bundlerUrl });
  const res = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const bodyText = await res.text();
  const contentType = res.headers.get("content-type") ?? "application/json";
  paymasterDebugLog("bundler_proxy response", {
    rpcMethod: opts?.rpcMethod ?? "(unknown)",
    status: res.status,
    bodyBytes: bodyText.length,
  });
  return { status: res.status, bodyText, contentType };
}
