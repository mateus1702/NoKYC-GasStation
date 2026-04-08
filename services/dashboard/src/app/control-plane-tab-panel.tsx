"use client";

import { useCallback, useEffect, useState } from "react";

type RefillDistributionLeg = {
  kind?: string;
  to?: string;
  weiPlanned?: string;
  weiSent?: string;
  txHash?: string;
};

type RefillApiResponse = {
  ok?: boolean;
  error?: string;
  result?: {
    status: string;
    reason?: string;
    target?: string;
    totalDeficitWei?: string;
    withdrawUsdcE6?: string;
    recordedNativeWei?: string;
    swapTxHash?: string;
    withdrawTxHash?: string;
    approveTxHash?: string;
    recordTxHash?: string;
    unwrapTxHash?: string;
    sendTxHash?: string;
    distribution?: RefillDistributionLeg[];
  };
};

type RefillEstimateApiResponse = {
  ok?: boolean;
  error?: string;
  result?: {
    status: string;
    reason?: string;
    minNativeWei?: string;
    totalDeficitWei?: string;
    requiredUsdcE6?: string;
    requiredUsdc?: string;
    paymasterUsdcBalanceE6?: string;
    shortfallUsdcE6?: string;
    poolFee?: number;
    poolFeeSource?: string;
    parties?: Array<{ key?: string; deficitWei?: string }>;
  };
};

type RefillMinWeiResponse = {
  ok?: boolean;
  error?: string;
  minNativeWei?: string;
  minNativeEth?: string;
  entrypointMultiplierX?: string;
  paymasterNativeMultiplierX?: string;
  utilityMultiplierX?: string;
  executorMultiplierX?: string;
  source?: string;
};

type AnvilStatusResponse = {
  enabled?: boolean;
  error?: string;
};

type AnvilFundResponse = {
  ok?: boolean;
  error?: string;
  txHash?: string;
  newBalanceWei?: string;
};

export function ControlPlaneTabPanel() {
  const [loading, setLoading] = useState(false);
  const [lastResponse, setLastResponse] = useState<RefillApiResponse | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimateResponse, setEstimateResponse] = useState<RefillEstimateApiResponse | null>(null);

  const [anvilStatusLoading, setAnvilStatusLoading] = useState(true);
  const [anvilEnabled, setAnvilEnabled] = useState(false);

  const [devAction, setDevAction] = useState<"usdc" | "native" | null>(null);
  const [devLastResponse, setDevLastResponse] = useState<AnvilFundResponse | null>(null);
  const [devLastError, setDevLastError] = useState<string | null>(null);

  const [minWeiLoading, setMinWeiLoading] = useState(true);
  const [minWeiSaving, setMinWeiSaving] = useState(false);
  const [minWeiDisplay, setMinWeiDisplay] = useState<{
    wei: string;
    eth: string;
    source?: string;
    entrypointMultiplierX: string;
    paymasterNativeMultiplierX: string;
    utilityMultiplierX: string;
    executorMultiplierX: string;
  } | null>(null);
  const [minEthInput, setMinEthInput] = useState("");
  const [entrypointMultiplierInput, setEntrypointMultiplierInput] = useState("");
  const [paymasterNativeMultiplierInput, setPaymasterNativeMultiplierInput] = useState("");
  const [utilityMultiplierInput, setUtilityMultiplierInput] = useState("");
  const [executorMultiplierInput, setExecutorMultiplierInput] = useState("");
  const [minWeiError, setMinWeiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/control-plane/anvil-status", { credentials: "include" });
        const data = (await res.json()) as AnvilStatusResponse;
        if (!cancelled && res.ok && data.enabled === true) {
          setAnvilEnabled(true);
        }
      } catch {
        /* leave disabled */
      } finally {
        if (!cancelled) setAnvilStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshMinWei = useCallback(async () => {
    setMinWeiLoading(true);
    setMinWeiError(null);
    try {
      const res = await fetch("/api/control-plane/refill-min-wei", { credentials: "include" });
      const data = (await res.json()) as RefillMinWeiResponse;
      if (!res.ok || !data.ok || !data.minNativeWei) {
        setMinWeiError(data.error ?? `HTTP ${res.status}`);
        setMinWeiDisplay(null);
        return;
      }
      setMinWeiDisplay({
        wei: data.minNativeWei,
        eth: data.minNativeEth ?? "",
        entrypointMultiplierX: data.entrypointMultiplierX ?? "2",
        paymasterNativeMultiplierX: data.paymasterNativeMultiplierX ?? "1.05",
        utilityMultiplierX: data.utilityMultiplierX ?? "1.5",
        executorMultiplierX: data.executorMultiplierX ?? "1.5",
        source: data.source,
      });
      setMinEthInput(data.minNativeEth ?? "");
      setEntrypointMultiplierInput(data.entrypointMultiplierX ?? "2");
      setPaymasterNativeMultiplierInput(data.paymasterNativeMultiplierX ?? "1.05");
      setUtilityMultiplierInput(data.utilityMultiplierX ?? "1.5");
      setExecutorMultiplierInput(data.executorMultiplierX ?? "1.5");
    } catch (e) {
      setMinWeiError((e as Error).message);
      setMinWeiDisplay(null);
    } finally {
      setMinWeiLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMinWei();
  }, [refreshMinWei]);

  const saveMinWei = useCallback(async () => {
    setMinWeiSaving(true);
    setMinWeiError(null);
    try {
      const res = await fetch("/api/control-plane/refill-min-wei", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          minNativeEth: minEthInput.trim(),
          entrypointMultiplierX: entrypointMultiplierInput.trim(),
          paymasterNativeMultiplierX: paymasterNativeMultiplierInput.trim(),
          utilityMultiplierX: utilityMultiplierInput.trim(),
          executorMultiplierX: executorMultiplierInput.trim(),
        }),
      });
      const data = (await res.json()) as RefillMinWeiResponse;
      if (!res.ok || !data.ok) {
        setMinWeiError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setMinWeiDisplay({
        wei: data.minNativeWei ?? "",
        eth: data.minNativeEth ?? "",
        entrypointMultiplierX: data.entrypointMultiplierX ?? entrypointMultiplierInput.trim(),
        paymasterNativeMultiplierX: data.paymasterNativeMultiplierX ?? paymasterNativeMultiplierInput.trim(),
        utilityMultiplierX: data.utilityMultiplierX ?? utilityMultiplierInput.trim(),
        executorMultiplierX: data.executorMultiplierX ?? executorMultiplierInput.trim(),
        source: data.source,
      });
      if (data.minNativeEth) setMinEthInput(data.minNativeEth);
    } catch (e) {
      setMinWeiError((e as Error).message);
    } finally {
      setMinWeiSaving(false);
    }
  }, [
    entrypointMultiplierInput,
    executorMultiplierInput,
    minEthInput,
    paymasterNativeMultiplierInput,
    utilityMultiplierInput,
  ]);

  const refreshEstimate = useCallback(async () => {
    setEstimateLoading(true);
    setEstimateError(null);
    try {
      const res = await fetch("/api/control-plane/refill-estimate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as RefillEstimateApiResponse;
      setEstimateResponse(data);
      if (!res.ok) {
        setEstimateError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setEstimateError((e as Error).message);
    } finally {
      setEstimateLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshEstimate();
  }, [refreshEstimate]);

  const runRefill = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    setLastResponse(null);
    try {
      const res = await fetch("/api/control-plane/refill", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as RefillApiResponse;
      setLastResponse(data);
      if (!res.ok) {
        setLastError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setLastError((e as Error).message);
    } finally {
      setLoading(false);
      void refreshEstimate();
    }
  }, [refreshEstimate]);

  const runAnvilFund = useCallback(async (kind: "usdc" | "native") => {
    setDevAction(kind);
    setDevLastError(null);
    setDevLastResponse(null);
    try {
      const path = kind === "usdc" ? "anvil-fund-usdc" : "anvil-fund-native";
      const res = await fetch(`/api/control-plane/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as AnvilFundResponse;
      setDevLastResponse(data);
      if (!res.ok || data.ok === false) {
        setDevLastError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setDevLastError((e as Error).message);
    } finally {
      setDevAction(null);
    }
  }, []);

  const devBusy = devAction !== null;

  return (
    <div className="grid gap-6 max-w-3xl w-full min-h-[12rem]">
      <div>
        <h2 className="text-xl font-semibold text-slate-100 tracking-tight">Control plane</h2>
        <p className="mt-1 text-sm text-slate-400">
          Manual operational actions for paymaster-api (admin only).
        </p>
      </div>
      <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5">
        <h3 className="text-sm font-semibold text-amber-200 mb-2">Operational refill</h3>
        <p className="text-sm text-slate-300 leading-relaxed">
          The paymaster <strong>owner</strong> pulls USDC (<code className="text-xs text-slate-400">withdrawUsdc</code>
          ), swaps to wrapped native, calls <code className="text-xs text-slate-400">recordGasPurchase</code>, unwraps,
          then tops up in order: <strong>EntryPoint deposit</strong> for the paymaster contract, <strong>paymaster native</strong>,{" "}
          <strong>Alto utility</strong>, then <strong>executors</strong> (by address). Trigger runs when <em>any</em> of
          those balances is below the configured minimum (wei). Requires <code className="text-xs">PAYMASTER_REFILL_OWNER_PRIVATE_KEY</code>{" "}
          on paymaster-api to match on-chain <code className="text-xs">owner()</code>.
        </p>
      </div>

      <div className="rounded-2xl border border-sky-600/40 bg-sky-950/20 p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-sky-200">Required USDC funding (before manual refill)</h3>
          <button
            type="button"
            onClick={() => void refreshEstimate()}
            disabled={estimateLoading}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 disabled:opacity-50"
          >
            {estimateLoading ? "Refreshing…" : "Refresh estimate"}
          </button>
        </div>
        {estimateResponse?.result?.status === "ready" ? (
          <p className="mt-2 text-sm text-slate-200">
            Fund paymaster contract with at least{" "}
            <span className="font-mono text-sky-100">{estimateResponse.result.requiredUsdc ?? "0"} USDC</span>{" "}
            (<span className="font-mono text-slate-300">{estimateResponse.result.requiredUsdcE6 ?? "0"} e6</span>).
            Current contract USDC:{" "}
            <span className="font-mono text-slate-300">{estimateResponse.result.paymasterUsdcBalanceE6 ?? "0"} e6</span>.
            {estimateResponse.result.shortfallUsdcE6 && estimateResponse.result.shortfallUsdcE6 !== "0" ? (
              <>
                {" "}Shortfall:{" "}
                <span className="font-mono text-amber-200">{estimateResponse.result.shortfallUsdcE6} e6</span>.
              </>
            ) : (
              <> No shortfall.</>
            )}
          </p>
        ) : estimateResponse?.result?.status === "not_needed" ? (
          <p className="mt-2 text-sm text-emerald-300">
            Refill not needed right now ({estimateResponse.result.reason ?? "all targets satisfied"}).
          </p>
        ) : estimateResponse?.result?.status === "failed" ? (
          <p className="mt-2 text-sm text-red-400">
            Failed to estimate required funding: {estimateResponse.result.reason ?? "unknown_error"}.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-400">Estimate the required USDC, fund paymaster, then run manual refill.</p>
        )}
        {estimateError ? <p className="mt-2 text-sm text-red-400">{estimateError}</p> : null}
      </div>

      <div className="rounded-2xl border border-slate-600/50 bg-slate-950/40 p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">Refill policy (ETH + target multipliers)</h3>
        <p className="text-sm text-slate-400 mb-4">
          Stored in Valkey <code className="text-xs text-slate-500">config:paymaster-api</code> field{" "}
          <code className="text-xs text-slate-500">PAYMASTER_API_REFILL_MIN_NATIVE_WEI</code>. Paymaster-api reads this each
          run (default <strong>10 ETH</strong> if unset).
        </p>
        {minWeiLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : minWeiDisplay ? (
          <p className="text-sm text-slate-300 mb-3">
            Current: <span className="font-mono text-slate-200">{minWeiDisplay.wei}</span> wei (~
            {minWeiDisplay.eth} ETH){" "}
            <span className="text-slate-500">({minWeiDisplay.source === "redis" ? "from Redis" : "default"})</span>
          </p>
        ) : null}
        {minWeiDisplay ? (
          <p className="text-sm text-slate-300 mb-3">
            Targets: EntryPoint <span className="font-mono">{minWeiDisplay.entrypointMultiplierX}x</span>, paymaster native{" "}
            <span className="font-mono">{minWeiDisplay.paymasterNativeMultiplierX}x</span>, utility{" "}
            <span className="font-mono">{minWeiDisplay.utilityMultiplierX}x</span>, executors{" "}
            <span className="font-mono">{minWeiDisplay.executorMultiplierX}x</span>.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>New minimum (ETH)</span>
            <input
              type="text"
              value={minEthInput}
              onChange={(e) => setMinEthInput(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 font-mono w-72"
              placeholder="10"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>EntryPoint target (x)</span>
            <input
              type="text"
              value={entrypointMultiplierInput}
              onChange={(e) => setEntrypointMultiplierInput(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 font-mono w-28"
              placeholder="2.0"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>Paymaster native target (x)</span>
            <input
              type="text"
              value={paymasterNativeMultiplierInput}
              onChange={(e) => setPaymasterNativeMultiplierInput(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 font-mono w-28"
              placeholder="1.05"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>Utility target (x)</span>
            <input
              type="text"
              value={utilityMultiplierInput}
              onChange={(e) => setUtilityMultiplierInput(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 font-mono w-28"
              placeholder="1.5"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>Executor target (x)</span>
            <input
              type="text"
              value={executorMultiplierInput}
              onChange={(e) => setExecutorMultiplierInput(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 font-mono w-28"
              placeholder="1.5"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveMinWei()}
            disabled={minWeiSaving || minWeiLoading}
            className="rounded-xl bg-slate-600 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white"
          >
            {minWeiSaving ? "Saving…" : "Save to Redis"}
          </button>
          <button
            type="button"
            onClick={() => void refreshMinWei()}
            disabled={minWeiLoading}
            className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800/60 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
        {minWeiError ? <p className="mt-3 text-sm text-red-400">{minWeiError}</p> : null}
      </div>

      <div className="rounded-2xl border border-slate-700/60 bg-slate-950/35 p-6">
        <button
          type="button"
          onClick={() => void runRefill()}
          disabled={loading}
          className="rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-900/30"
        >
          {loading ? "Running…" : "Run operational refill"}
        </button>

        {lastError ? (
          <p className="mt-4 text-sm text-red-400">{lastError}</p>
        ) : null}

        {lastResponse ? (
          <div className="mt-4 rounded-lg border border-slate-700/50 bg-slate-900/50 p-4">
            <p className="text-xs font-medium text-slate-400 mb-2">Last response</p>
            <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(lastResponse, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>

      {!anvilStatusLoading && anvilEnabled ? (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/15 p-5">
          <h3 className="text-sm font-semibold text-emerald-200 mb-2">Local Anvil (dev)</h3>
          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            Paymaster-api detected Anvil with dev tools enabled. Funds the <strong>deployed paymaster contract</strong>{" "}
            (<strong>+20 USDC</strong> via impersonated whale transfer, <strong>native</strong> via{" "}
            <code className="text-xs text-slate-400">anvil_setBalance</code>), unless{" "}
            <code className="text-xs text-slate-400">PAYMASTER_API_ANVIL_DEV_FUND_ADDRESS</code> overrides the target. Only
            for local fork setups.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void runAnvilFund("usdc")}
              disabled={devBusy}
              className="rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-900/30"
            >
              {devAction === "usdc" ? "Funding…" : "Fund paymaster +20 USDC"}
            </button>
            <button
              type="button"
              onClick={() => void runAnvilFund("native")}
              disabled={devBusy}
              className="rounded-xl bg-slate-600 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-slate-900/30"
            >
              {devAction === "native" ? "Funding…" : "Fund paymaster native"}
            </button>
          </div>
          {devLastError ? <p className="mt-4 text-sm text-red-400">{devLastError}</p> : null}
          {devLastResponse ? (
            <div className="mt-4 rounded-lg border border-slate-700/50 bg-slate-900/50 p-4">
              <p className="text-xs font-medium text-slate-400 mb-2">Last dev action response</p>
              <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(devLastResponse, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
