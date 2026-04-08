import http from "node:http";
import { readFile } from "node:fs/promises";
import { paymasterDebugLog } from "../debugLog.js";
import {
  ensureAnvilDevActive,
  fundPaymasterNative,
  fundPaymasterUsdc20,
  getAnvilDevStatus,
} from "../anvilDevTools.js";
import { BUNDLER_PROXY_ALLOWED_METHODS, forwardBundlerRpc } from "../bundlerProxy.js";
import { jsonRpcError, jsonRpcResult } from "../jsonRpc.js";
import type { PaymasterRuntime } from "../runtimeConfig.js";
import {
  estimateOperationalRefill,
  scheduleOperationalRefillIfNeeded,
  runOperationalRefillExclusive,
} from "../refillRunner.js";
import { resolvePaymasterAddressFromFile } from "../sponsor/address.js";
import { buildSponsorPayload, buildStubPayload } from "../sponsor/payloads.js";
import { getGasPricePayload, getPricingGasPriceWei } from "../sponsor/gasPrice.js";

export function createPaymasterHttpServer(runtime: PaymasterRuntime): http.Server {
  return http.createServer(async (req, res) => {
    paymasterDebugLog("http_request", { method: req.method, url: req.url });

    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "*",
      "access-control-allow-headers": "*",
    };

    if (req.method === "OPTIONS") {
      paymasterDebugLog("http_route", { route: "OPTIONS", status: 204 });
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      paymasterDebugLog("http_route", { route: "GET /health", status: 200 });
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/paymaster-address") {
      try {
        const address = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
        paymasterDebugLog("http_route", { route: "GET /paymaster-address", status: 200, address });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ paymasterAddress: address }));
      } catch (e) {
        paymasterDebugLog("http_route", { route: "GET /paymaster-address", status: 503, error: String((e as Error).message) });
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: String((e as Error).message) }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/gas-burner-address") {
      try {
        if (!runtime.gasBurnerAddressFile) {
          res.writeHead(404, corsHeaders);
          res.end();
          return;
        }
        const address = (await readFile(runtime.gasBurnerAddressFile, "utf8")).trim().toLowerCase();
        if (!address) {
          res.writeHead(404, corsHeaders);
          res.end();
          return;
        }
        paymasterDebugLog("http_route", { route: "GET /gas-burner-address", status: 200 });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ gasBurnerAddress: address }));
      } catch {
        paymasterDebugLog("http_route", { route: "GET /gas-burner-address", status: 404 });
        res.writeHead(404, corsHeaders);
        res.end();
      }
      return;
    }
    if (req.method === "GET" && req.url === "/gas-price") {
      try {
        const gasPriceWei = await getPricingGasPriceWei(runtime.publicClient);
        paymasterDebugLog("http_route", { route: "GET /gas-price", status: 200, gasPriceWei: gasPriceWei.toString() });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ gasPriceWei: gasPriceWei.toString(), source: "rpc" as const }));
      } catch (e) {
        paymasterDebugLog("http_route", { route: "GET /gas-price", status: 503, error: String((e as Error).message) });
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: String((e as Error).message) }));
      }
      return;
    }
    const pathname = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && pathname === "/anvil-dev/status") {
      try {
        const status = await getAnvilDevStatus(runtime.paymasterApiRpcUrl);
        paymasterDebugLog("http_route", { route: "GET /anvil-dev/status", status: 200, ...status });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify(status));
      } catch (e) {
        paymasterDebugLog("http_route", { route: "GET /anvil-dev/status", status: 500, error: String((e as Error).message) });
        res.writeHead(500, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ enabled: false, error: String((e as Error).message) }));
      }
      return;
    }
    if (req.method !== "POST") {
      paymasterDebugLog("http_route", { route: "non-POST after GET handling", status: 404, method: req.method, pathname });
      res.writeHead(404, corsHeaders);
      res.end();
      return;
    }

    if (pathname === "/bundler/rpc") {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body || "{}") as { method?: string; id?: unknown };

        if (Array.isArray(rpc)) {
          paymasterDebugLog("bundler_rpc reject", { reason: "batch_not_supported" });
          res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
          res.end(jsonRpcError(null, -32600, "Batch requests not supported"));
          return;
        }

        const method = typeof rpc?.method === "string" ? rpc.method : "";
        if (!BUNDLER_PROXY_ALLOWED_METHODS.has(method)) {
          paymasterDebugLog("bundler_rpc reject", { reason: "method_not_allowed", method: method || "missing" });
          res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
          res.end(jsonRpcError(rpc?.id ?? null, -32601, `Method not found: ${method || "missing"}`));
          return;
        }

        const upstream = await forwardBundlerRpc(runtime.bundlerUrl, body, { rpcMethod: method });
        res.writeHead(upstream.status, {
          "content-type": upstream.contentType,
          ...corsHeaders,
        });
        res.end(upstream.bodyText);
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        paymasterDebugLog("bundler_rpc_error", { error: message });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(jsonRpcError(null, -32000, message));
      }
      return;
    }

    if (pathname === "/operational-refill") {
      paymasterDebugLog("http_route", { route: "POST /operational-refill" });
      const triggerSecret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
      if (!triggerSecret) {
        paymasterDebugLog("operational_refill disabled", { reason: "no PAYMASTER_API_REFILL_TRIGGER_SECRET" });
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders });
        res.end(
          JSON.stringify({
            ok: false,
            error: "PAYMASTER_API_REFILL_TRIGGER_SECRET not set; operational refill HTTP endpoint is disabled",
          })
        );
        return;
      }
      const auth = req.headers.authorization?.trim() ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const headerSecret = (req.headers["x-refill-trigger-secret"] as string | undefined)?.trim() ?? "";
      const provided = bearer || headerSecret;
      if (provided !== triggerSecret) {
        paymasterDebugLog("operational_refill", { status: 401, reason: "unauthorized" });
        res.writeHead(401, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      try {
        for await (const chunk of req) {
          void chunk;
        }
        const paymasterAddress = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
        const cfg = runtime.buildRefillRunnerConfig(paymasterAddress);
        if (!cfg) {
          paymasterDebugLog("operational_refill", { status: 400, reason: "refill_env_incomplete_or_disabled" });
          res.writeHead(400, { "content-type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: "refill_env_incomplete_or_disabled" }));
          return;
        }
        paymasterDebugLog("operational_refill running", { paymasterAddress });
        const result = await runOperationalRefillExclusive(runtime.publicClient, cfg, { force: true });
        const httpStatus =
          result.status === "failed"
            ? 500
            : result.reason === "refill_already_in_flight"
              ? 409
              : 200;
        paymasterDebugLog("operational_refill done", { httpStatus, resultStatus: result.status, reason: result.reason });
        res.writeHead(httpStatus, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: result.status === "completed", result }));
      } catch (e) {
        paymasterDebugLog("operational_refill error", { error: String((e as Error).message) });
        res.writeHead(500, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }));
      }
      return;
    }

    if (pathname === "/operational-refill-estimate") {
      paymasterDebugLog("http_route", { route: "POST /operational-refill-estimate" });
      const triggerSecret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
      if (!triggerSecret) {
        paymasterDebugLog("operational_refill_estimate disabled", { reason: "no PAYMASTER_API_REFILL_TRIGGER_SECRET" });
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders });
        res.end(
          JSON.stringify({
            ok: false,
            error: "PAYMASTER_API_REFILL_TRIGGER_SECRET not set; operational refill estimate endpoint is disabled",
          })
        );
        return;
      }
      const auth = req.headers.authorization?.trim() ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const headerSecret = (req.headers["x-refill-trigger-secret"] as string | undefined)?.trim() ?? "";
      const provided = bearer || headerSecret;
      if (provided !== triggerSecret) {
        paymasterDebugLog("operational_refill_estimate", { status: 401, reason: "unauthorized" });
        res.writeHead(401, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      try {
        for await (const chunk of req) {
          void chunk;
        }
        const paymasterAddress = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
        const cfg = runtime.buildRefillRunnerConfig(paymasterAddress);
        if (!cfg) {
          paymasterDebugLog("operational_refill_estimate", { status: 400, reason: "refill_env_incomplete_or_disabled" });
          res.writeHead(400, { "content-type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: "refill_env_incomplete_or_disabled" }));
          return;
        }
        const result = await estimateOperationalRefill(runtime.publicClient, cfg);
        const httpStatus = result.status === "failed" ? 500 : 200;
        paymasterDebugLog("operational_refill_estimate done", {
          httpStatus,
          resultStatus: result.status,
          reason: result.reason,
        });
        res.writeHead(httpStatus, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: result.status !== "failed", result }));
      } catch (e) {
        paymasterDebugLog("operational_refill_estimate error", { error: String((e as Error).message) });
        res.writeHead(500, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }));
      }
      return;
    }

    if (pathname === "/anvil-dev/fund-usdc" || pathname === "/anvil-dev/fund-native") {
      paymasterDebugLog("http_route", { route: `POST ${pathname}` });
      const triggerSecret = process.env.PAYMASTER_API_REFILL_TRIGGER_SECRET?.trim();
      if (!triggerSecret) {
        paymasterDebugLog("anvil_fund disabled", { reason: "no PAYMASTER_API_REFILL_TRIGGER_SECRET" });
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders });
        res.end(
          JSON.stringify({
            ok: false,
            error: "PAYMASTER_API_REFILL_TRIGGER_SECRET not set; anvil dev funding is disabled",
          })
        );
        return;
      }
      const auth = req.headers.authorization?.trim() ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const headerSecret = (req.headers["x-refill-trigger-secret"] as string | undefined)?.trim() ?? "";
      const provided = bearer || headerSecret;
      if (provided !== triggerSecret) {
        paymasterDebugLog("anvil_fund", { status: 401, reason: "unauthorized" });
        res.writeHead(401, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      try {
        for await (const chunk of req) {
          void chunk;
        }
        const gate = await ensureAnvilDevActive(runtime.paymasterApiRpcUrl);
        if (!gate.ok) {
          paymasterDebugLog("anvil_fund gate failed", { httpStatus: gate.httpStatus, error: gate.error });
          res.writeHead(gate.httpStatus, { "content-type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: gate.error }));
          return;
        }
        const paymasterAddress = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
        if (pathname === "/anvil-dev/fund-usdc") {
          const out = await fundPaymasterUsdc20(
            runtime.paymasterApiRpcUrl,
            runtime.publicClient,
            paymasterAddress
          );
          if (!out.ok) {
            paymasterDebugLog("anvil_fund usdc failed", { error: out.error });
            res.writeHead(400, { "content-type": "application/json", ...corsHeaders });
            res.end(JSON.stringify({ ok: false, error: out.error }));
            return;
          }
          paymasterDebugLog("anvil_fund usdc ok", { txHash: out.txHash });
          res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ ok: true, txHash: out.txHash }));
          return;
        }
        const outN = await fundPaymasterNative(
          runtime.paymasterApiRpcUrl,
          runtime.publicClient,
          paymasterAddress
        );
        if (!outN.ok) {
          paymasterDebugLog("anvil_fund native failed", { error: outN.error });
          res.writeHead(400, { "content-type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: outN.error }));
          return;
        }
        paymasterDebugLog("anvil_fund native ok", { newBalanceWei: outN.newBalanceWei });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: true, newBalanceWei: outN.newBalanceWei }));
      } catch (e) {
        paymasterDebugLog("anvil_fund error", { error: String((e as Error).message) });
        res.writeHead(500, { "content-type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }));
      }
      return;
    }

    if (pathname !== "/" && pathname !== "") {
      paymasterDebugLog("http_route", { route: "POST unknown path", pathname, status: 404 });
      res.writeHead(404, corsHeaders);
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

      paymasterDebugLog("jsonrpc_request", { id, method, paramsCount: params.length });

      if (method === "getUserOperationGasPrice" || method === "pimlico_getUserOperationGasPrice") {
        const gasPayload = await getGasPricePayload(runtime.publicClient);
        paymasterDebugLog("jsonrpc_response", { method, ok: true });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(jsonRpcResult(id, gasPayload));
        return;
      }
      if (method === "pm_getPaymasterStubData") {
        const userOp = params[0] ?? {};
        const ep = params[1];
        const payload = await buildStubPayload(runtime, userOp, ep);
        paymasterDebugLog("jsonrpc_response", { method, ok: true });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(jsonRpcResult(id, payload));
        return;
      }
      if (method === "pm_sponsorUserOperation" || method === "pm_getPaymasterData") {
        const userOp = params[0] ?? {};
        const ep = params[1];
        const referralContext = params[2];
        const pmAddr = await resolvePaymasterAddressFromFile(runtime.paymasterAddressFile);
        const refillCfg = runtime.buildRefillRunnerConfig(pmAddr);
        if (refillCfg) {
          scheduleOperationalRefillIfNeeded(runtime.publicClient, refillCfg);
        }
        const payload = await buildSponsorPayload(runtime, userOp, ep, referralContext);
        paymasterDebugLog("jsonrpc_response", { method, ok: true });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(jsonRpcResult(id, payload));
        return;
      }
      if (method === "eth_supportedEntryPoints") {
        paymasterDebugLog("jsonrpc_response", { method, ok: true });
        res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
        res.end(jsonRpcResult(id, [runtime.entryPointAddress]));
        return;
      }

      paymasterDebugLog("jsonrpc_response", { method, error: "method_not_found" });
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
      res.end(jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      paymasterDebugLog("jsonrpc_error", { error: message });
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders });
      res.end(jsonRpcError(null, -32000, message));
    }
  });
}
