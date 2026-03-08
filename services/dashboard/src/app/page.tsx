"use client";

import useSWR from "swr";
import { motion } from "framer-motion";
import { useCallback, useState } from "react";
import type { MetricValue } from "@/lib/metrics";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function CopyRawButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 800);
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-1 text-zinc-500 hover:bg-dark-border hover:text-zinc-300 transition-colors"
      title={label ?? "Copy raw value"}
    >
      {copied ? (
        <span className="text-xs text-dark-success">✓</span>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16V4a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}

function MetricCard({
  title,
  value,
  index,
}: {
  title: string;
  value: MetricValue;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: (index ?? 0) * 0.05 }}
      className="rounded-xl border border-dark-border bg-dark-card p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-zinc-500">{title}</p>
          <p className="mt-1 text-lg font-medium text-zinc-100">
            {value.formatted} {value.formattedUnit ?? value.unit}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 font-mono">
            {value.raw} {value.unit}
          </p>
        </div>
        <CopyRawButton value={value.raw} />
      </div>
    </motion.div>
  );
}

function StatusBadge({ name, status }: { name: string; status: string }) {
  const ok = status === "ok";
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        ok ? "bg-dark-success/20 text-dark-success" : "bg-dark-error/20 text-dark-error"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-dark-success" : "bg-dark-error"}`} />
      {name}: {status}
    </motion.span>
  );
}

function Section({
  title,
  subtitle,
  children,
  gridCols = "grid-cols-[repeat(auto-fit,minmax(280px,1fr))]",
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  gridCols?: string;
  className?: string;
}) {
  return (
    <section className={`h-fit rounded-xl border border-dark-border/60 bg-dark-card/30 p-5 ${className}`}>
      <div className="mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      </div>
      <div className={`grid gap-4 ${gridCols}`}>{children}</div>
    </section>
  );
}

export default function DashboardPage() {
  const { data, error, isLoading, isValidating } = useSWR("/api/metrics", fetcher, {
    refreshInterval: 5000,
  });

  const { data: userOpsData } = useSWR("/api/userops?limit=30", fetcher, {
    refreshInterval: 5000,
  });

  if (error) {
    return (
      <main className="min-h-screen w-full p-8">
        <h1 className="text-2xl font-bold text-zinc-100">Project4 AA Dashboard</h1>
        <p className="mt-4 text-dark-error">Failed to load metrics: {String(error)}</p>
      </main>
    );
  }

  if (isLoading || !data) {
    return (
      <main className="min-h-screen w-full p-8">
        <h1 className="text-2xl font-bold text-zinc-100">Project4 AA Dashboard</h1>
        <p className="mt-4 text-zinc-500">Loading...</p>
      </main>
    );
  }

  const pm = data.paymasterAddress;
  const ep = data.entryPointDeposit;
  const workerReserve = data.workerNativeReserve;
  const workerUsdcReserve = data.workerUsdcReserve;
  const bundlerUtility = data.bundlerUtilityBalance;
  const bundlerExecutors = data.bundlerExecutorBalances;
  const pricing = data.pricing;
  const cfg = data.workerConfig;
  const health = data.health;

  return (
    <main className="min-h-screen w-full p-6 md:p-8">
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-4 mb-8"
      >
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-zinc-100">Project4 AA Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Auto-refresh every 5s
            {isValidating && (
              <span className="ml-2 inline-block h-2 w-2 rounded-full bg-dark-accent animate-pulse" />
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge name="Paymaster API" status={health?.paymasterApi ?? "unknown"} />
          <StatusBadge name="Bundler" status={health?.bundler ?? "unknown"} />
          <StatusBadge name="Redis" status={health?.redis ?? "unknown"} />
        </div>
      </motion.header>

      <div className="grid gap-6 grid-cols-[repeat(auto-fit,minmax(360px,1fr))] items-start">
        <Section
          title="Paymaster & EntryPoint"
          subtitle="Paymaster contract address and EntryPoint deposit balance"
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="rounded-xl border border-dark-border bg-dark-card p-4"
          >
            <p className="text-xs uppercase tracking-wider text-zinc-500">Paymaster Address</p>
            <p className="mt-1 break-all font-mono text-sm text-zinc-100">
              {pm.status === "ok" ? pm.value : `Error: ${pm.error}`}
            </p>
          </motion.div>
          {ep.status === "ok" && ep.value && (
            <MetricCard title="EntryPoint Deposit" value={ep.value} index={1} />
          )}
          {ep.status === "error" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-dark-border bg-dark-card p-4"
            >
              <p className="text-xs uppercase tracking-wider text-zinc-500">EntryPoint Deposit</p>
              <p className="mt-1 text-dark-error">Error: {ep.error}</p>
            </motion.div>
          )}
        </Section>

        <Section
          title="Bundler Gas Balances (ETH)"
          subtitle="Utility and executor addresses used for submitting UserOps"
        >
          {bundlerUtility?.status === "ok" && bundlerUtility.value && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="rounded-xl border border-dark-border bg-dark-card p-4 shadow-lg"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-zinc-500">Utility Balance</p>
                  <p className="mt-1 text-lg font-medium text-zinc-100">
                    {bundlerUtility.value.formatted} {bundlerUtility.value.formattedUnit ?? bundlerUtility.value.unit}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 font-mono truncate" title={bundlerUtility.address}>
                    {bundlerUtility.address ? `${bundlerUtility.address.slice(0, 10)}…${bundlerUtility.address.slice(-8)}` : "-"}
                  </p>
                </div>
                <CopyRawButton value={bundlerUtility.value.raw} label="Copy value" />
              </div>
            </motion.div>
          )}
          {bundlerUtility?.status === "error" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-dark-border bg-dark-card p-4"
            >
              <p className="text-xs uppercase tracking-wider text-zinc-500">Bundler Utility</p>
              <p className="mt-1 text-dark-error text-sm">{bundlerUtility.error ?? "Not configured"}</p>
            </motion.div>
          )}
          {bundlerExecutors?.status === "ok" && bundlerExecutors.items?.length > 0 && (
            <>
              {bundlerExecutors.items.map((item: { address: string; value: MetricValue }, i: number) => (
                <motion.div
                  key={item.address}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: (i + 1) * 0.05 }}
                  className="rounded-xl border border-dark-border bg-dark-card p-4 shadow-lg"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wider text-zinc-500">Executor {i + 1} Balance</p>
                      <p className="mt-1 text-lg font-medium text-zinc-100">
                        {item.value.formatted} {item.value.formattedUnit ?? item.value.unit}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500 font-mono truncate" title={item.address}>
                        {`${item.address.slice(0, 10)}…${item.address.slice(-8)}`}
                      </p>
                    </div>
                    <CopyRawButton value={item.value.raw} label="Copy value" />
                  </div>
                </motion.div>
              ))}
            </>
          )}
          {bundlerExecutors?.status === "error" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-dark-border bg-dark-card p-4"
            >
              <p className="text-xs uppercase tracking-wider text-zinc-500">Bundler Executors</p>
              <p className="mt-1 text-dark-error text-sm">{bundlerExecutors.error ?? "Not configured"}</p>
            </motion.div>
          )}
        </Section>

        <Section
          title="Worker Reserves"
          subtitle="Treasury native and USDC balances"
        >
          {workerReserve?.status === "ok" && workerReserve.value && (
            <MetricCard title="Native Reserve (Treasury)" value={workerReserve.value} index={0} />
          )}
          {workerUsdcReserve?.status === "ok" && workerUsdcReserve.value && (
            <MetricCard title="USDC Balance (Treasury)" value={workerUsdcReserve.value} index={1} />
          )}
        </Section>

        <Section
          title="Pricing (Redis)"
          subtitle="Aggregate USDC spent, gas returned, and unit costs"
        >
          {pricing.status === "ok" && pricing.totalUsdcSpentE6 && (
            <>
              <MetricCard title="Total USDC Spent" value={pricing.totalUsdcSpentE6} index={0} />
              <MetricCard title="Total Gas Returned" value={pricing.totalGasReturnedWei!} index={1} />
              <MetricCard title="Unit Cost" value={pricing.unitCostUsdcPerWei!} index={2} />
              <MetricCard title="USDC per 1M Gas" value={pricing.usdcPer1MGas!} index={3} />
            </>
          )}
          {pricing.status === "error" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-dark-border bg-dark-card p-4"
            >
              <p className="text-xs uppercase tracking-wider text-zinc-500">Pricing</p>
              <p className="mt-1 text-dark-error">Error: {pricing.error}</p>
            </motion.div>
          )}
        </Section>

        <Section
          title="Worker Config"
          subtitle="Deposit thresholds and swap parameters"
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="rounded-xl border border-dark-border bg-dark-card p-4 md:col-span-2 lg:col-span-1"
          >
            <p className="text-xs uppercase tracking-wider text-zinc-500">Worker Config</p>
            <div className="mt-2 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Poll interval</span>
                <span className="text-zinc-100">{cfg?.pollIntervalMs ?? "-"} ms</span>
              </div>
              {cfg?.swapUsdcE6 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">Swap USDC</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-100">{cfg.swapUsdcE6.formatted} USDC</span>
                    <CopyRawButton value={cfg.swapUsdcE6.raw} />
                  </div>
                </div>
              )}
              {cfg?.minEntryPointWei && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">Min EntryPoint</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-100">{cfg.minEntryPointWei.formatted} MATIC</span>
                    <CopyRawButton value={cfg.minEntryPointWei.raw} />
                  </div>
                </div>
              )}
              {cfg?.capEntryPointWei && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">Cap EntryPoint</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-100">{cfg.capEntryPointWei.formatted} MATIC</span>
                    <CopyRawButton value={cfg.capEntryPointWei.raw} />
                  </div>
                </div>
              )}
              {cfg?.minWorkerWei && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">Min Worker</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-100">{cfg.minWorkerWei.formatted} MATIC</span>
                    <CopyRawButton value={cfg.minWorkerWei.raw} />
                  </div>
                </div>
              )}
              {cfg?.capWorkerWei && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">Cap Worker</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-100">{cfg.capWorkerWei.formatted} MATIC</span>
                    <CopyRawButton value={cfg.capWorkerWei.raw} />
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </Section>

        <Section
          title="Latest Processed UserOps"
          subtitle="GasCharged events from Project4Paymaster (last 30)"
          gridCols="grid-cols-1"
          className="col-span-full"
        >
        <div className="col-span-full overflow-x-auto">
          {userOpsData?.status === "error" ? (
            <p className="text-dark-error text-sm">{userOpsData?.error ?? "Could not fetch UserOps"}</p>
          ) : userOpsData?.items?.length ? (
            <div className="overflow-y-auto max-h-80">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-zinc-500 border-b border-dark-border">
                    <th className="pb-2 pr-4">Block</th>
                    <th className="pb-2 pr-4">Sender</th>
                    <th className="pb-2 pr-4">USDC Charged</th>
                    <th className="pb-2 pr-4">Gas (wei)</th>
                    <th className="pb-2 pr-4">Tx Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {userOpsData.items.map((op: { blockNumber: number; sender: string; chargedUsdcE6: string; chargedWei: string; transactionHash: string }, i: number) => (
                    <tr key={`${op.transactionHash}-${i}`} className="border-b border-dark-border/50 text-zinc-400">
                      <td className="py-2 pr-4 font-mono">{op.blockNumber}</td>
                      <td className="py-2 pr-4 font-mono truncate max-w-[140px]" title={op.sender}>
                        {op.sender.slice(0, 6)}…{op.sender.slice(-4)}
                      </td>
                      <td className="py-2 pr-4 font-mono">{(Number(op.chargedUsdcE6) / 1e6).toFixed(6)}</td>
                      <td className="py-2 pr-4 font-mono">{op.chargedWei}</td>
                      <td className="py-2 pr-4 font-mono">
                        <span className="inline-flex items-center gap-1">
                          <span className="truncate max-w-[90px]" title={op.transactionHash}>
                            {op.transactionHash ? `${op.transactionHash.slice(0, 10)}…` : "-"}
                          </span>
                          {op.transactionHash && (
                            <CopyRawButton value={op.transactionHash} label="Copy tx hash" />
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-zinc-500 text-sm">No processed UserOps yet.</p>
          )}
        </div>
        </Section>
      </div>
    </main>
  );
}
