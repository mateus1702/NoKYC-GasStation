"use client";

import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useState, useMemo } from "react";
import type { MetricValue } from "@/lib/metrics";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Enhanced copy button with better feedback
function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <motion.button
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      onClick={copy}
      className="group relative flex items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500/10 to-purple-500/10 px-3 py-2 text-xs font-medium text-indigo-300 border border-indigo-500/20 hover:border-indigo-400/40 transition-all duration-200"
      title={label ?? "Copy to clipboard"}
    >
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.div
            key="checkmark"
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, rotate: 180 }}
            className="flex items-center gap-1"
          >
            <svg className="h-3 w-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-green-400">Copied!</span>
          </motion.div>
        ) : (
          <motion.div
            key="copy"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            className="flex items-center gap-1"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span>Copy</span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

// Enhanced metric card with gradient backgrounds and animations
function MetricCard({
  title,
  value,
  index,
  icon,
  trend,
  status = "normal",
}: {
  title: string;
  value: MetricValue;
  index?: number;
  icon?: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  status?: "normal" | "warning" | "error" | "success";
}) {
  const statusColors = {
    normal: "from-slate-500/20 to-slate-600/20 border-slate-500/30",
    warning: "from-yellow-500/20 to-orange-500/20 border-yellow-500/30",
    error: "from-red-500/20 to-red-600/20 border-red-500/30",
    success: "from-green-500/20 to-emerald-500/20 border-green-500/30",
  };

  const trendColors = {
    up: "text-green-400",
    down: "text-red-400",
    neutral: "text-slate-400",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.5,
        delay: (index ?? 0) * 0.1,
        type: "spring",
        stiffness: 100
      }}
      whileHover={{ y: -2, scale: 1.02 }}
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${statusColors[status]} border backdrop-blur-sm p-6 shadow-xl max-w-xl w-full`}
    >
      {/* Background glow effect */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent" />

      <div className="relative z-10">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                {icon}
              </div>
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{title}</p>
              <div className="flex items-baseline gap-2 mt-1">
                <p className="text-2xl font-bold text-white">
                  {value.formatted}
                </p>
                <p className="text-sm text-slate-400">
                  {value.formattedUnit ?? value.unit}
                </p>
                {trend && (
                  <div className={`flex items-center ${trendColors[trend]}`}>
                    {trend === "up" && <span>↗</span>}
                    {trend === "down" && <span>↘</span>}
                    {trend === "neutral" && <span>→</span>}
                  </div>
                )}
              </div>
            </div>
          </div>
          <CopyButton value={value.raw} />
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-slate-500 font-mono">
            Raw: {value.raw} {value.unit}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// Enhanced status indicator with better visual feedback
function StatusIndicator({ name, status, description }: {
  name: string;
  status: string;
  description?: string;
}) {
  const getStatusConfig = (status: string) => {
    switch (status) {
      case "ok":
      case "healthy":
        return {
          bg: "bg-green-500/20 border-green-400/40",
          text: "text-green-300",
          dot: "bg-green-400",
          label: "Operational"
        };
      case "warning":
        return {
          bg: "bg-yellow-500/20 border-yellow-400/40",
          text: "text-yellow-300",
          dot: "bg-yellow-400",
          label: "Degraded"
        };
      case "error":
      case "down":
        return {
          bg: "bg-red-500/20 border-red-400/40",
          text: "text-red-300",
          dot: "bg-red-400",
          label: "Down"
        };
      default:
        return {
          bg: "bg-slate-500/20 border-slate-400/40",
          text: "text-slate-300",
          dot: "bg-slate-400",
          label: "Unknown"
        };
    }
  };

  const config = getStatusConfig(status);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`flex items-center gap-3 rounded-xl ${config.bg} border px-4 py-3 backdrop-blur-sm`}
    >
      <div className={`h-3 w-3 rounded-full ${config.dot} animate-pulse`} />
      <div>
        <p className={`text-sm font-medium ${config.text}`}>{name}</p>
        <p className="text-xs text-slate-400">{description || config.label}</p>
      </div>
    </motion.div>
  );
}

// Modern section component with glassmorphism
function Section({
  title,
  subtitle,
  children,
  gridCols = "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
  className = "",
  variant = "default",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  gridCols?: string;
  className?: string;
  variant?: "default" | "hero" | "compact";
}) {
  const variants = {
    default: "bg-gradient-to-br from-slate-900/40 to-slate-800/40 border-slate-700/50",
    hero: "bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border-indigo-500/30",
    compact: "bg-gradient-to-br from-slate-800/30 to-slate-700/30 border-slate-600/50",
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className={`relative overflow-hidden rounded-3xl border backdrop-blur-xl p-8 shadow-2xl ${variants[variant]} ${className} w-full`}
    >
      {/* Subtle background pattern */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(120,119,198,0.1),transparent_50%)]" />

      <div className="relative z-10">
        {(title || subtitle) && (
          <div className="mb-8">
            {title && (
              <h2 className="text-xl font-bold text-white mb-2">{title}</h2>
            )}
            {subtitle && (
              <p className="text-sm text-slate-400 leading-relaxed">{subtitle}</p>
            )}
          </div>
        )}
        <div className={`grid gap-6 ${gridCols}`}>{children}</div>
      </div>
    </motion.section>
  );
}

// Hero section with key metrics and overview
function HeroSection({ data, health, isValidating }: {
  data: any;
  health: any;
  isValidating: boolean;
}) {
  const keyMetrics = useMemo(() => {
    if (!data) return [];

    const metrics = [];

    // EntryPoint deposit
    if (data.entryPointDeposit?.status === "ok" && data.entryPointDeposit.value) {
      metrics.push({
        title: "EntryPoint Balance",
        value: data.entryPointDeposit.value,
        icon: (
          <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    // Worker reserves
    if (data.workerNativeReserve?.status === "ok" && data.workerNativeReserve.value) {
      metrics.push({
        title: "Worker Gas Reserve",
        value: data.workerNativeReserve.value,
        icon: (
          <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    // Total USDC spent
    if (data.pricing?.status === "ok" && data.pricing.totalUsdcSpentE6) {
      metrics.push({
        title: "Total USDC Spent",
        value: data.pricing.totalUsdcSpentE6,
        icon: (
          <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    return metrics;
  }, [data]);

  return (
    <div className="relative mb-12">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/20 via-purple-900/20 to-pink-900/20 rounded-3xl blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative rounded-3xl bg-gradient-to-br from-slate-900/80 to-slate-800/80 backdrop-blur-xl border border-slate-700/50 p-8 shadow-2xl"
      >
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
          <div className="flex-1">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
            >
              <h1 className="text-4xl lg:text-5xl font-bold text-white mb-4">
                NoKYC-GasStation
                <span className="block text-2xl lg:text-3xl font-normal text-slate-400 mt-2">
                  Dashboard
                </span>
              </h1>
              <p className="text-lg text-slate-300 mb-6 max-w-2xl xl:max-w-3xl 2xl:max-w-4xl">
                Real-time monitoring of your ERC-4337 paymaster operations, gas reserves, and transaction metrics.
              </p>
            </motion.div>

            {/* Status indicators */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="flex flex-wrap gap-4"
            >
              <StatusIndicator
                name="Paymaster API"
                status={health?.paymasterApi ?? "unknown"}
                description="Transaction processing"
              />
              <StatusIndicator
                name="Bundler"
                status={health?.bundler ?? "unknown"}
                description="UserOp submission"
              />
              <StatusIndicator
                name="Redis"
                status={health?.redis ?? "unknown"}
                description="Data storage"
              />
            </motion.div>
          </div>

          {/* Key metrics grid */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.6 }}
            className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-4"
          >
            {keyMetrics.map((metric, index) => (
              <MetricCard
                key={metric.title}
                title={metric.title}
                value={metric.value}
                icon={metric.icon}
                status={metric.status}
                index={index}
              />
            ))}
          </motion.div>
        </div>

        {/* Auto-refresh indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="flex items-center justify-center mt-8 pt-6 border-t border-slate-700/50"
        >
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${isValidating ? 'bg-indigo-400 animate-pulse' : 'bg-slate-500'}`} />
              <span>Auto-refresh every 5 seconds</span>
            </div>
            {isValidating && (
              <span className="text-indigo-400 font-medium">Updating...</span>
            )}
          </div>
        </motion.div>
      </motion.div>
    </div>
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
      <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md mx-auto text-center"
        >
          <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Connection Error</h1>
          <p className="text-slate-400 mb-6">Failed to load dashboard metrics</p>
          <p className="text-sm text-red-400 bg-red-500/10 rounded-lg p-3 border border-red-500/20">
            {String(error)}
          </p>
        </motion.div>
      </main>
    );
  }

  if (isLoading || !data) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-indigo-500/20 flex items-center justify-center">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            >
              <svg className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </motion.div>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Loading Dashboard</h2>
          <p className="text-slate-400">Connecting to NoKYC-GasStation services...</p>
        </motion.div>
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
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6 lg:p-8 xl:p-12 2xl:p-16">
      <div className="w-full max-w-none mx-auto px-4 xl:px-8 2xl:px-12">
        <HeroSection data={data} health={health} isValidating={isValidating} />

        <div className="grid gap-6 grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 auto-rows-fr">
          {/* Paymaster & EntryPoint Section */}
          <Section
            title="Paymaster & EntryPoint"
            subtitle="Core contract addresses and EntryPoint deposit management"
            variant="hero"
            gridCols="grid-cols-1 xl:grid-cols-2"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="col-span-full lg:col-span-1"
            >
              <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 rounded-2xl border border-slate-600/50 p-6 backdrop-blur-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Paymaster Address</h3>
                    <p className="text-sm text-slate-400">Contract handling gas payments</p>
                  </div>
                </div>
                <p className="break-all font-mono text-sm text-slate-300 bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
                  {pm.status === "ok" ? pm.value : `Error: ${pm.error}`}
                </p>
                {pm.status === "ok" && (
                  <div className="mt-4">
                    <CopyButton value={pm.value} label="Copy paymaster address" />
                  </div>
                )}
              </div>
            </motion.div>

            {ep.status === "ok" && ep.value && (
              <MetricCard
                title="EntryPoint Deposit"
                value={ep.value}
                icon={
                  <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                }
                status="success"
                index={1}
              />
            )}
          </Section>

          {/* Gas Reserves Section */}
          <Section
            title="Gas Reserves"
            subtitle="Monitor all operational accounts that need gas funding"
            gridCols="grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3"
          >
            {/* Worker Reserves */}
            {(workerReserve?.status === "ok" || workerUsdcReserve?.status === "ok") && (
              <div className="col-span-full">
                <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Worker Account
                </h3>
                <div className="grid gap-4 md:grid-cols-2">
                  {workerReserve?.status === "ok" && workerReserve.value && (
                    <MetricCard
                      title="Native Gas Reserve"
                      value={workerReserve.value}
                      icon={
                        <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      }
                      status="success"
                    />
                  )}
                  {workerUsdcReserve?.status === "ok" && workerUsdcReserve.value && (
                    <MetricCard
                      title="USDC Balance"
                      value={workerUsdcReserve.value}
                      icon={
                        <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                        </svg>
                      }
                      status="normal"
                    />
                  )}
                </div>
              </div>
            )}

            {/* Bundler Accounts */}
            <div className="col-span-full">
              <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Bundler Accounts
              </h3>

              {bundlerUtility?.status === "ok" && bundlerUtility.value && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-4"
                >
                  <MetricCard
                    title="Utility Account Balance"
                    value={bundlerUtility.value}
                    icon={
                      <svg className="h-5 w-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    }
                    status="warning"
                  />
                </motion.div>
              )}

              {bundlerExecutors?.status === "ok" && bundlerExecutors.items?.length > 0 && (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {bundlerExecutors.items.map((item: { address: string; value: MetricValue }, i: number) => (
                    <MetricCard
                      key={item.address}
                      title={`Executor ${i + 1} Balance`}
                      value={item.value}
                      icon={
                        <svg className="h-5 w-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                        </svg>
                      }
                      status="success"
                      index={i}
                    />
                  ))}
                </div>
              )}
            </div>
          </Section>

          {/* Pricing Analytics */}
          <Section
            title="Pricing Analytics"
            subtitle="USDC spending efficiency and gas return metrics"
            variant="compact"
            gridCols="grid-cols-1 xl:grid-cols-2"
          >
            {pricing.status === "ok" && pricing.totalUsdcSpentE6 && (
              <>
                <MetricCard
                  title="Total USDC Spent"
                  value={pricing.totalUsdcSpentE6}
                  icon={
                    <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                    </svg>
                  }
                  status="normal"
                  index={0}
                />
                <MetricCard
                  title="Total Gas Returned"
                  value={pricing.totalGasReturnedWei!}
                  icon={
                    <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                    </svg>
                  }
                  status="success"
                  index={1}
                />
                <MetricCard
                  title="Unit Cost (USDC/Gas)"
                  value={pricing.unitCostUsdcPerWei!}
                  icon={
                    <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  }
                  status="warning"
                  index={2}
                />
                <MetricCard
                  title="Cost per 1M Gas"
                  value={pricing.usdcPer1MGas!}
                  icon={
                    <svg className="h-5 w-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                    </svg>
                  }
                  status="normal"
                  index={3}
                />
              </>
            )}
          </Section>

          {/* Configuration */}
          <Section
            title="System Configuration"
            subtitle="Worker parameters and operational thresholds"
            variant="compact"
            gridCols="grid-cols-1 xl:grid-cols-2"
          >
            {/* Operational Settings Card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 rounded-2xl border border-slate-600/50 p-6 backdrop-blur-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Operational Settings</h3>
                    <p className="text-sm text-slate-400">Timing and transaction parameters</p>
                  </div>
                </div>
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-400">Poll Interval</label>
                    <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                      <span className="text-white font-medium">{cfg?.pollIntervalMs ?? "-"} ms</span>
                    </div>
                  </div>

                  {cfg?.swapUsdcE6 && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">Swap USDC Amount</label>
                      <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <CopyButton value={cfg.swapUsdcE6.raw} />
                        <span className="text-white font-medium">{cfg.swapUsdcE6.formatted} USDC</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>

            {/* Gas Thresholds Card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 rounded-2xl border border-slate-600/50 p-6 backdrop-blur-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Gas Thresholds</h3>
                    <p className="text-sm text-slate-400">EntryPoint and worker gas limits</p>
                  </div>
                </div>
                <div className="grid gap-4">
                  {cfg?.minEntryPointWei && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">Min EntryPoint Gas</label>
                      <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <CopyButton value={cfg.minEntryPointWei.raw} />
                        <span className="text-white font-medium">{cfg.minEntryPointWei.formatted} MATIC</span>
                      </div>
                    </div>
                  )}

                  {cfg?.capEntryPointWei && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">Cap EntryPoint Gas</label>
                      <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <CopyButton value={cfg.capEntryPointWei.raw} />
                        <span className="text-white font-medium">{cfg.capEntryPointWei.formatted} MATIC</span>
                      </div>
                    </div>
                  )}

                  {cfg?.minWorkerWei && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">Min Worker Gas</label>
                      <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <CopyButton value={cfg.minWorkerWei.raw} />
                        <span className="text-white font-medium">{cfg.minWorkerWei.formatted} MATIC</span>
                      </div>
                    </div>
                  )}

                  {cfg?.capWorkerWei && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">Cap Worker Gas</label>
                      <div className="flex flex-col items-center gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <CopyButton value={cfg.capWorkerWei.raw} />
                        <span className="text-white font-medium">{cfg.capWorkerWei.formatted} MATIC</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </Section>

          {/* User Operations Table */}
          <Section
            title="Recent User Operations"
            subtitle="Latest processed transactions with gas charges"
            gridCols="grid-cols-1"
            className="xl:col-span-2 2xl:col-span-3"
          >
            <div className="overflow-hidden rounded-2xl border border-slate-700/50 bg-gradient-to-br from-slate-800/50 to-slate-700/50 backdrop-blur-sm">
              {userOpsData?.status === "error" ? (
                <div className="p-8 text-center">
                  <svg className="w-12 h-12 mx-auto mb-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <p className="text-red-400 font-medium mb-2">Failed to load User Operations</p>
                  <p className="text-slate-400 text-sm">{userOpsData?.error ?? "Could not fetch UserOps"}</p>
                </div>
              ) : userOpsData?.items?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Block</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Sender</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">USDC Charged</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Gas Used</th>
                        <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Transaction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {userOpsData.items.map((op: { blockNumber: number; sender: string; chargedUsdcE6: string; chargedWei: string; transactionHash: string }, i: number) => (
                        <motion.tr
                          key={`${op.transactionHash}-${i}`}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                          className="hover:bg-slate-800/30 transition-colors"
                        >
                          <td className="px-6 py-4 text-sm font-mono text-slate-300">{op.blockNumber}</td>
                          <td className="px-6 py-4 text-sm font-mono text-slate-300 truncate max-w-[140px]" title={op.sender}>
                            <span className="inline-flex items-center gap-2">
                              <span className="truncate">{op.sender.slice(0, 6)}…{op.sender.slice(-4)}</span>
                              <CopyButton value={op.sender} />
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm font-mono text-purple-300">
                            {(Number(op.chargedUsdcE6) / 1e6).toFixed(6)} USDC
                          </td>
                          <td className="px-6 py-4 text-sm font-mono text-green-300">
                            {op.chargedWei} wei
                          </td>
                          <td className="px-6 py-4 text-sm font-mono text-slate-300">
                            <span className="inline-flex items-center gap-2">
                              <span className="truncate max-w-[120px]" title={op.transactionHash}>
                                {op.transactionHash ? `${op.transactionHash.slice(0, 8)}…` : "-"}
                              </span>
                              {op.transactionHash && (
                                <CopyButton value={op.transactionHash} label="Copy transaction hash" />
                              )}
                            </span>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-12 text-center">
                  <svg className="w-16 h-16 mx-auto mb-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-slate-400 text-lg font-medium mb-2">No User Operations Yet</p>
                  <p className="text-slate-500">Processed transactions will appear here</p>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
