"use client";

import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { MetricValue } from "@/lib/metrics";
import type { DecodedLog } from "@/lib/userops";
import { getGasPriceHeroTitle } from "@/lib/gas-price-hero";
import { formatLogArg, formatTypicalDappCallUsdc, shortAddress } from "@/lib/dashboard-format";
import { ControlPlaneTabPanel } from "@/app/control-plane-tab-panel";

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
};

/** Overview/hero metrics polling — fewer RPC calls than aggressive intervals. */
const METRICS_REFRESH_MS = 300_000;
/** Live tables (UserOps + EntryPoint) while Live Metrics tab is active. */
const LIVE_TABLES_REFRESH_MS = 60_000;

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
  detail,
}: {
  title: string;
  value: MetricValue;
  index?: number;
  icon?: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  status?: "normal" | "warning" | "error" | "success";
  /** Secondary line (e.g. derived estimate under the primary metric). */
  detail?: React.ReactNode;
}) {
  const previousRawRef = useRef<string | null>(null);
  const [isValueUpdating, setIsValueUpdating] = useState(false);
  const [updateDirection, setUpdateDirection] = useState<"up" | "down" | "none">("none");

  useEffect(() => {
    if (previousRawRef.current === null) {
      previousRawRef.current = value.raw;
      return;
    }

    if (previousRawRef.current !== value.raw) {
      let direction: "up" | "down" | "none" = "none";
      try {
        const prevVal = BigInt(previousRawRef.current);
        const nextVal = BigInt(value.raw);
        if (nextVal > prevVal) direction = "up";
        else if (nextVal < prevVal) direction = "down";
      } catch {
        direction = "none";
      }

      setUpdateDirection(direction);
      setIsValueUpdating(true);
      const timeoutId = setTimeout(() => setIsValueUpdating(false), 1100);
      previousRawRef.current = value.raw;
      return () => clearTimeout(timeoutId);
    }

    previousRawRef.current = value.raw;
  }, [value.raw]);

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

  const pulseClasses =
    updateDirection === "up"
      ? "ring-2 ring-emerald-400/80 shadow-emerald-400/30"
      : updateDirection === "down"
        ? "ring-2 ring-red-400/80 shadow-red-400/30"
        : "ring-2 ring-cyan-400/80 shadow-cyan-400/30";

  const overlayClass =
    updateDirection === "up"
      ? "bg-emerald-400/20"
      : updateDirection === "down"
        ? "bg-red-400/20"
        : "bg-cyan-400/20";

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
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${statusColors[status]} border backdrop-blur-sm p-5 shadow-xl w-full transition-all duration-300 ${
        isValueUpdating ? pulseClasses : ""
      }`}
    >
      {/* Background glow effect */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent" />
      {isValueUpdating && (
        <motion.div
          initial={{ opacity: 0.35 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1 }}
          className={`pointer-events-none absolute inset-0 rounded-2xl ${overlayClass}`}
        />
      )}

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
                <motion.p
                  key={value.raw}
                  initial={{ opacity: 0.35, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.35 }}
                  className="text-2xl font-bold text-white"
                >
                  {value.formatted}
                </motion.p>
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
              {detail && (
                <p className="mt-2 text-xs leading-snug text-slate-300/90">{detail}</p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-slate-500 font-mono">
            Raw: {value.raw} {value.unit}
          </p>
        </div>

        {value.address && (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono">{shortAddress(value.address)}</span>
            <CopyButton value={value.address} label="Copy address" />
          </div>
        )}
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
      className={`relative overflow-hidden rounded-3xl border backdrop-blur-xl p-6 xl:p-7 shadow-2xl ${variants[variant]} ${className} w-full`}
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

function PremiumTopBar({
  health,
  paymasterAddress,
  isValidating,
  onLogout,
}: {
  health: { paymasterApi?: string; bundler?: string } | undefined;
  paymasterAddress?: string;
  isValidating: boolean;
  onLogout?: () => void;
}) {
  const apiOk = health?.paymasterApi === "ok";
  const bundlerOk = health?.bundler === "ok";
  const allOnline = apiOk && bundlerOk;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700/50 bg-slate-900/60 px-4 py-3 backdrop-blur-xl"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center rounded-full border border-violet-400/40 bg-violet-500/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-200">
          Control Center
        </span>
        <span className="text-xs text-slate-400">
          Paymaster: <span className="font-mono text-slate-200">{paymasterAddress ? shortAddress(paymasterAddress) : "n/a"}</span>
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center min-w-0">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <div className={`h-2 w-2 rounded-full ${isValidating ? "bg-indigo-400 animate-pulse" : "bg-slate-500"}`} />
          <span>Overview auto-refresh every 5 minutes</span>
          {isValidating && <span className="text-indigo-400 font-medium">Updating...</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            allOnline
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/30"
              : "bg-amber-500/20 text-amber-300 border border-amber-400/30"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${allOnline ? "bg-emerald-300" : "bg-amber-300"}`} />
          {allOnline ? "All Systems Operational" : "Degraded Service"}
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-600/60 bg-slate-800/60 px-3 py-1 text-xs text-slate-300">
          <span className={`h-2 w-2 rounded-full ${isValidating ? "bg-indigo-300 animate-pulse" : "bg-slate-500"}`} />
          {isValidating ? "Refreshing overview" : "Overview up to date"}
        </span>
        {onLogout && (
          <button
            onClick={onLogout}
            className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800/70"
          >
            Logout
          </button>
        )}
      </div>
    </motion.div>
  );
}

type HeroMetricRow = {
  title: string;
  value: MetricValue;
  icon: ReactNode;
  status: "normal" | "success" | "warning" | "error";
  detail?: ReactNode;
};

type HeroMetricGroup = {
  id: string;
  /** Full description (e.g. aria-label). */
  label: string;
  /** Short label for the tab control. */
  tabLabel: string;
  items: HeroMetricRow[];
};

// Hero section with key metrics and overview
function HeroSection({
  data,
  health,
  isValidating,
  onRefreshMetrics,
}: {
  data: any;
  health: any;
  isValidating: boolean;
  onRefreshMetrics?: () => void;
}) {
  const metricGroups = useMemo((): HeroMetricGroup[] => {
    if (!data) return [];

    const treasury: HeroMetricRow[] = [];
    const chainGas: HeroMetricRow[] = [];
    const sponsorPricing: HeroMetricRow[] = [];
    const bundlerWallets: HeroMetricRow[] = [];

    // EntryPoint deposit
    if (data.entryPointDeposit?.status === "ok" && data.entryPointDeposit.value) {
      treasury.push({
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

    // Paymaster contract native (EntryPoint deposit is separate)
    if (
      data.paymasterContractNativeReserve?.status === "ok" &&
      data.paymasterContractNativeReserve.value
    ) {
      treasury.push({
        title: "Paymaster Native (contract)",
        value: data.paymasterContractNativeReserve.value,
        icon: (
          <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    if (data.gasPriceWei?.status === "ok" && data.gasPriceWei.value) {
      chainGas.push({
        title: getGasPriceHeroTitle(data.gasPriceWei.source),
        value: data.gasPriceWei.value,
        icon: (
          <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    if (
      data.paymasterContractUsdcReserve?.status === "ok" &&
      data.paymasterContractUsdcReserve.value
    ) {
      treasury.push({
        title: "Paymaster USDC (contract)",
        value: data.paymasterContractUsdcReserve.value,
        icon: (
          <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.refillOwnerNativeBalance?.status === "ok" && data.refillOwnerNativeBalance.value) {
      treasury.push({
        title: "Refill Owner Native",
        value: data.refillOwnerNativeBalance.value,
        icon: (
          <svg className="h-5 w-5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c0 2.761-2.239 5-5 5S2 13.761 2 11s2.239-5 5-5 5 2.239 5 5zm0 0V9a2 2 0 012-2h8m-8 0V5m0 2v2" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    if (data.refillOwnerUsdcBalance?.status === "ok" && data.refillOwnerUsdcBalance.value) {
      treasury.push({
        title: "Refill Owner USDC",
        value: data.refillOwnerUsdcBalance.value,
        icon: (
          <svg className="h-5 w-5 text-cyan-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.paymasterGasUnitsProcessed?.status === "ok" && data.paymasterGasUnitsProcessed.value) {
      sponsorPricing.push({
        title: "Gas units processed",
        value: data.paymasterGasUnitsProcessed.value,
        icon: (
          <svg className="h-5 w-5 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.paymasterGasBoughtWei?.status === "ok" && data.paymasterGasBoughtWei.value) {
      sponsorPricing.push({
        title: "Gas bought (native)",
        value: data.paymasterGasBoughtWei.value,
        icon: (
          <svg className="h-5 w-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.paymasterUsdcSpentForGasE6?.status === "ok" && data.paymasterUsdcSpentForGasE6.value) {
      sponsorPricing.push({
        title: "USDC spent (gas counters)",
        value: data.paymasterUsdcSpentForGasE6.value,
        icon: (
          <svg className="h-5 w-5 text-fuchsia-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.paymasterUsdcPerGas?.status === "ok" && data.paymasterUsdcPerGas.value) {
      const usdcPerGas = data.paymasterUsdcPerGas.value;
      const typicalCallLine = formatTypicalDappCallUsdc(usdcPerGas.raw);
      sponsorPricing.push({
        title: "USDC/gas",
        value: usdcPerGas,
        ...(typicalCallLine ? { detail: typicalCallLine } : {}),
        icon: (
          <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
          </svg>
        ),
        status: "success" as const,
      });
    }

    if (data.paymasterAmplifierBps?.status === "ok" && data.paymasterAmplifierBps.value) {
      sponsorPricing.push({
        title: "Pricing amplifier",
        value: data.paymasterAmplifierBps.value,
        icon: (
          <svg className="h-5 w-5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.paymasterServiceFeeBps?.status === "ok" && data.paymasterServiceFeeBps.value) {
      sponsorPricing.push({
        title: "Service fee",
        value: data.paymasterServiceFeeBps.value,
        icon: (
          <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
          </svg>
        ),
        status: "normal" as const,
      });
    }

    if (data.bundlerUtilityBalance?.status === "ok" && data.bundlerUtilityBalance.value) {
      bundlerWallets.push({
        title: "Bundler Utility",
        value: data.bundlerUtilityBalance.value,
        icon: (
          <svg className="h-5 w-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        ),
        status: "warning" as const,
      });
    }

    if (data.bundlerExecutorBalances?.status === "ok" && data.bundlerExecutorBalances.items?.length > 0) {
      data.bundlerExecutorBalances.items.forEach((item: { address: string; value: MetricValue }, i: number) => {
        bundlerWallets.push({
          title: `Executor ${i + 1}`,
          value: item.value,
          icon: (
            <svg className="h-5 w-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          ),
          status: "success" as const,
        });
      });
    }

    return [
      { id: "treasury", label: "Treasury & reserves", tabLabel: "Treasury", items: treasury },
      { id: "chain-gas", label: "Chain gas", tabLabel: "Chain gas", items: chainGas },
      { id: "sponsor-pricing", label: "Sponsor pricing", tabLabel: "Pricing", items: sponsorPricing },
      { id: "bundler-wallets", label: "Bundler wallets", tabLabel: "Bundler", items: bundlerWallets },
    ].filter((g) => g.items.length > 0);
  }, [data]);

  const [heroGroupId, setHeroGroupId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (metricGroups.length === 0) return;
    setHeroGroupId((prev) => {
      if (prev && metricGroups.some((g) => g.id === prev)) return prev;
      return metricGroups[0].id;
    });
  }, [metricGroups]);

  const activeHeroGroup =
    metricGroups.find((g) => g.id === heroGroupId) ?? metricGroups[0] ?? null;

  return (
    <div className="relative mb-8">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/20 via-purple-900/20 to-pink-900/20 rounded-3xl blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative rounded-3xl bg-gradient-to-br from-slate-900/80 to-slate-800/80 backdrop-blur-xl border border-slate-700/50 p-6 xl:p-7 shadow-2xl"
      >
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="flex-1">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
            >
              <h1 className="text-4xl lg:text-5xl font-bold text-white mb-4">
                NoKYC-GasStation
                <span className="block text-2xl lg:text-3xl font-normal text-slate-400 mt-2">
                  Premium Operations Dashboard
                </span>
              </h1>
              <p className="text-lg text-slate-300 mb-6 max-w-2xl xl:max-w-3xl 2xl:max-w-4xl leading-relaxed">
                Real-time command center for ERC-4337 paymaster health, treasury reserves, and execution-quality analytics.
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
            </motion.div>
          </div>

          {/* Key metrics grid */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.6 }}
            className="flex flex-1 flex-col gap-3 min-w-0"
          >
            {onRefreshMetrics && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {isValidating && (
                  <span className="text-xs font-medium text-indigo-400">Updating…</span>
                )}
                <button
                  type="button"
                  onClick={onRefreshMetrics}
                  disabled={isValidating}
                  aria-label="Refresh metrics"
                  className="rounded-lg border border-slate-600/60 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700/60 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Refresh metrics
                </button>
              </div>
            )}
            <div className="flex flex-col gap-3 min-w-0">
              {metricGroups.length > 1 && (
                <div
                  className="flex flex-wrap gap-1 p-1 rounded-xl bg-slate-800/50 border border-slate-700/50 backdrop-blur-sm w-full sm:w-fit shadow-lg"
                  role="tablist"
                  aria-label="Hero metric categories"
                >
                  {metricGroups.map((group) => {
                    const selected = group.id === activeHeroGroup?.id;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-label={group.label}
                        id={`hero-metric-tab-${group.id}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setHeroGroupId(group.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                          selected
                            ? "bg-indigo-500/30 text-indigo-100 border border-indigo-400/40 shadow-sm"
                            : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/30 border border-transparent"
                        }`}
                      >
                        {group.tabLabel}
                        <span className="ml-1.5 text-xs font-normal text-slate-500 tabular-nums">
                          ({group.items.length})
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {activeHeroGroup && (
                <div
                  role="tabpanel"
                  aria-labelledby={
                    metricGroups.length > 1 ? `hero-metric-tab-${activeHeroGroup.id}` : undefined
                  }
                  className="min-w-0"
                >
                  {metricGroups.length === 1 && (
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-1 mb-2">
                      {activeHeroGroup.label}
                    </h3>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {activeHeroGroup.items.map((metric, mi) => (
                      <MetricCard
                        key={`${activeHeroGroup.id}-${metric.title}-${mi}`}
                        title={metric.title}
                        value={metric.value}
                        icon={metric.icon}
                        status={metric.status}
                        index={mi}
                        detail={metric.detail}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"live-metrics" | "control-plane">("live-metrics");
  const [userOpsPage, setUserOpsPage] = useState(1);
  const USEROPS_PAGE_SIZE = 3;
  const [entrypointOpsPage, setEntrypointOpsPage] = useState(1);
  const ENTRYPOINT_OPS_PAGE_SIZE = 3;
  const [expandedTxHash, setExpandedTxHash] = useState<string | null>(null);
  const [logsCache, setLogsCache] = useState<Map<string, { logs: DecodedLog[]; error?: string }>>(new Map());
  const [logsLoading, setLogsLoading] = useState<string | null>(null);

  const userOpsSwrKey = useMemo(
    () => (activeTab === "live-metrics" ? "/api/userops?limit=100" : null),
    [activeTab]
  );
  const entrypointOpsSwrKey = useMemo(
    () => (activeTab === "live-metrics" ? "/api/entrypoint-ops?limit=100" : null),
    [activeTab]
  );

  const { data, error, isLoading, isValidating, mutate: mutateMetrics } = useSWR("/api/metrics", fetcher, {
    refreshInterval: METRICS_REFRESH_MS,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const {
    data: userOpsData,
    isValidating: userOpsValidating,
    mutate: mutateUserOps,
  } = useSWR(userOpsSwrKey, fetcher, {
    refreshInterval: activeTab === "live-metrics" ? LIVE_TABLES_REFRESH_MS : 0,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const {
    data: entrypointOpsData,
    isValidating: entrypointValidating,
    mutate: mutateEntrypointOps,
  } = useSWR(entrypointOpsSwrKey, fetcher, {
    refreshInterval: activeTab === "live-metrics" ? LIVE_TABLES_REFRESH_MS : 0,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const tablesValidating = userOpsValidating || entrypointValidating;

  const onRefreshMetricsTop = useCallback(() => {
    void mutateMetrics();
  }, [mutateMetrics]);

  const onRefreshLiveTables = useCallback(() => {
    if (activeTab !== "live-metrics") return;
    void Promise.all([mutateUserOps(), mutateEntrypointOps()]);
  }, [activeTab, mutateUserOps, mutateEntrypointOps]);

  useEffect(() => {
    if (!error) return;
    const status = (error as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      router.replace("/login");
    }
  }, [error, router]);

  const onLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }, [router]);

  const onLogsClick = useCallback(
    async (txHash: string) => {
      if (expandedTxHash === txHash) {
        setExpandedTxHash(null);
        return;
      }
      const cached = logsCache.get(txHash);
      if (cached) {
        setExpandedTxHash(txHash);
        return;
      }
      setLogsLoading(txHash);
      try {
        const res = await fetch(`/api/userops/logs?txHash=${encodeURIComponent(txHash)}`, {
          credentials: "include",
        });
        const json = (await res.json()) as { status: string; logs?: DecodedLog[]; error?: string };
        if (json.status === "ok" && json.logs) {
          setLogsCache((m) => new Map(m).set(txHash, { logs: json.logs! }));
          setExpandedTxHash(txHash);
        } else {
          setLogsCache((m) => new Map(m).set(txHash, { logs: [], error: json.error || "Failed to load logs" }));
          setExpandedTxHash(txHash);
        }
      } catch (e) {
        setLogsCache((m) => new Map(m).set(txHash, { logs: [], error: (e as Error).message }));
        setExpandedTxHash(txHash);
      } finally {
        setLogsLoading(null);
      }
    },
    [expandedTxHash, logsCache]
  );

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
  const health = data.health;

  const userOpsItems = userOpsData?.items ?? [];
  const totalUserOps = userOpsItems.length;
  const totalUserOpsPages = Math.max(1, Math.ceil(totalUserOps / USEROPS_PAGE_SIZE));
  const clampedPage = Math.min(userOpsPage, totalUserOpsPages);
  const paginatedUserOps = userOpsItems.slice(
    (clampedPage - 1) * USEROPS_PAGE_SIZE,
    clampedPage * USEROPS_PAGE_SIZE
  );

  const entrypointOpsItems = entrypointOpsData?.items ?? [];
  const totalEntryPointOps = entrypointOpsItems.length;
  const totalEntryPointOpsPages = Math.max(1, Math.ceil(totalEntryPointOps / ENTRYPOINT_OPS_PAGE_SIZE));
  const clampedEntryPointPage = Math.min(entrypointOpsPage, totalEntryPointOpsPages);
  const paginatedEntryPointOps = entrypointOpsItems.slice(
    (clampedEntryPointPage - 1) * ENTRYPOINT_OPS_PAGE_SIZE,
    clampedEntryPointPage * ENTRYPOINT_OPS_PAGE_SIZE
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 lg:p-6 xl:p-8 2xl:p-10">
      <div className="w-full max-w-none mx-auto px-0 xl:px-2 2xl:px-4">
        <PremiumTopBar
          health={health}
          paymasterAddress={pm?.status === "ok" ? pm.value : undefined}
          isValidating={isValidating}
          onLogout={onLogout}
        />
        <HeroSection
          data={data}
          health={health}
          isValidating={isValidating}
          onRefreshMetrics={onRefreshMetricsTop}
        />

        {/* Tab bar */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-1 p-1 rounded-xl bg-slate-800/50 border border-slate-700/50 backdrop-blur-sm mb-6 w-fit shadow-xl"
        >
          <button
            onClick={() => setActiveTab("live-metrics")}
            className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === "live-metrics"
                ? "bg-indigo-500/30 text-indigo-100 border border-indigo-400/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/30"
            }`}
          >
            Live Metrics
          </button>
          <button
            onClick={() => setActiveTab("control-plane")}
            className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === "control-plane"
                ? "bg-indigo-500/30 text-indigo-100 border border-indigo-400/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/30"
            }`}
          >
            Control plane
          </button>
        </motion.div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className={activeTab === "live-metrics" ? "flex flex-col gap-4" : "flex flex-col gap-6"}
          >
            {activeTab === "live-metrics" ? (
              <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-3">
            <p className="text-sm text-slate-400">
              Tables auto-refresh every 60s while this tab is open.
            </p>
            <div className="flex items-center gap-2">
              {tablesValidating && (
                <span className="text-xs font-medium text-indigo-400">Updating…</span>
              )}
              <button
                type="button"
                onClick={onRefreshLiveTables}
                disabled={tablesValidating}
                aria-label="Refresh User Operations and EntryPoint tables"
                className="rounded-lg border border-slate-600/60 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700/60 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Refresh tables
              </button>
            </div>
          </div>
          <div className="grid gap-4 grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 auto-rows-fr">
          {/* Recent User Operations - First section */}
          <Section
            title="Recent User Operations"
            subtitle="Latest processed transactions with gas charges (newest first)"
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
                <>
                <div className="overflow-x-auto">
                  <table className="table-modern">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th>Block</th>
                        <th>Sender</th>
                        <th>USDC Charged</th>
                        <th>Gas (units)</th>
                        <th>MATIC Spent</th>
                        <th>Initial Charge</th>
                        <th>Gas Price</th>
                        <th>Limits</th>
                        <th>Transaction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {paginatedUserOps.map((op: { blockNumber: number; sender: string; chargedUsdcE6: string; chargedWei: string; gasUsed: string; transactionHash: string; initialChargeAmount: string; maxCostUsdcE6: string; unitCostUsdcPerWei: string; minPostopFeeUsdcE6: string; treasury: string; wasMinFeeApplied: boolean; wasMaxFeeApplied: boolean; referralAddress?: string; referralChargeUsdcE6?: string; baseChargeUsdcE6?: string; estimatedCostWei?: string }, i: number) => (
                        <Fragment key={`${op.transactionHash}-${op.sender}-${i}`}>
                        <motion.tr
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                          className="odd:bg-slate-900/20 hover:bg-slate-800/40 transition-colors"
                        >
                          <td className="text-sm font-mono text-slate-300">{op.blockNumber}</td>
                          <td className="text-sm font-mono text-slate-300 truncate max-w-[120px]" title={op.sender}>
                            <span className="inline-flex items-center gap-2 flex-wrap">
                              <span className="truncate">{shortAddress(op.sender)}</span>
                              <CopyButton value={op.sender} />
                              {op.referralAddress && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-cyan-900/60 text-cyan-300 border border-cyan-600/40" title={`Referral: ${op.referralAddress}`}>
                                  Referral
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="text-sm font-mono text-purple-300">
                            {(Number(op.chargedUsdcE6) / 1e6).toFixed(6)} USDC
                            {op.referralChargeUsdcE6 != null && Number(op.referralChargeUsdcE6) > 0 && (
                              <span className="block text-xs text-cyan-400 mt-0.5">
                                (base {(Number(op.baseChargeUsdcE6 ?? 0) / 1e6).toFixed(6)} + ref {(Number(op.referralChargeUsdcE6) / 1e6).toFixed(6)})
                              </span>
                            )}
                          </td>
                          <td className="text-sm font-mono text-green-300">
                            {op.gasUsed !== "-" ? op.gasUsed : "-"}
                          </td>
                          <td className="text-sm font-mono text-purple-300">
                            {Number(op.chargedWei) > 0
                              ? `${(Number(op.chargedWei) / 1e18).toFixed(6)} MATIC`
                              : (op as { estimatedCostWei?: string }).estimatedCostWei && Number((op as { estimatedCostWei?: string }).estimatedCostWei) > 0
                                ? `${(Number((op as { estimatedCostWei?: string }).estimatedCostWei) / 1e18).toFixed(6)} MATIC (est.)`
                                : "-"}
                          </td>
                          <td className="text-sm font-mono text-blue-300">
                            {Number(op.initialChargeAmount) > 0 ? `${(Number(op.initialChargeAmount) / 1e6).toFixed(6)} USDC` : "-"}
                          </td>
                          <td className="text-sm font-mono text-orange-300">
                            {Number(op.unitCostUsdcPerWei) > 0 ? `${(Number(op.unitCostUsdcPerWei) / 1e18).toFixed(2)} USDC/wei` : "-"}
                          </td>
                          <td className="text-sm font-mono text-slate-300">
                            {(op as { referralAddress?: string }).referralAddress ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-300 text-xs">
                                Referral
                              </span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1">
                                  <span className={op.wasMinFeeApplied ? "text-red-400" : "text-green-400"}>
                                    {op.wasMinFeeApplied ? "⚠️" : "✓"} Min
                                  </span>
                                  <span className="text-xs text-slate-400">
                                    {(Number(op.minPostopFeeUsdcE6) / 1e6).toFixed(6)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className={op.wasMaxFeeApplied ? "text-yellow-400" : "text-green-400"}>
                                    {op.wasMaxFeeApplied ? "⚠️" : "✓"} Max
                                  </span>
                                  <span className="text-xs text-slate-400">
                                    {(Number(op.maxCostUsdcE6) / 1e6).toFixed(6)}
                                  </span>
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="text-sm font-mono text-slate-300">
                            <span className="inline-flex items-center gap-2 flex-wrap">
                              <span className="truncate max-w-[100px]" title={op.transactionHash}>
                                {op.transactionHash ? `${op.transactionHash.slice(0, 8)}…` : "-"}
                              </span>
                              {op.transactionHash && (
                                <>
                                  <CopyButton value={op.transactionHash} label="Copy transaction hash" />
                                  <button
                                    type="button"
                                    onClick={() => onLogsClick(op.transactionHash)}
                                    disabled={logsLoading === op.transactionHash}
                                    className="rounded px-2 py-1 text-xs font-medium bg-slate-700/60 text-slate-200 border border-slate-600/50 hover:bg-slate-600/60 disabled:opacity-50"
                                  >
                                    {logsLoading === op.transactionHash ? "Loading…" : "Logs"}
                                  </button>
                                </>
                              )}
                            </span>
                          </td>
                        </motion.tr>
                        <AnimatePresence>
                          {expandedTxHash === op.transactionHash && (
                            <motion.tr
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="bg-slate-800/40"
                            >
                              <td colSpan={9} className="p-4">
                                <div className="rounded-lg border border-slate-600/50 bg-slate-900/60 p-4">
                                  {logsLoading === op.transactionHash ? (
                                    <div className="flex items-center gap-2 text-slate-400">
                                      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                        </svg>
                                      </motion.div>
                                      Loading logs…
                                    </div>
                                  ) : logsCache.get(op.transactionHash)?.error ? (
                                    <p className="text-red-400 text-sm">{logsCache.get(op.transactionHash)?.error}</p>
                                  ) : !logsCache.get(op.transactionHash)?.logs?.length ? (
                                    <p className="text-slate-400 text-sm">No logs</p>
                                  ) : (
                                    <div className="space-y-2">
                                      {logsCache.get(op.transactionHash)!.logs!.map((l) => (
                                        <div key={l.logIndex} className="text-sm font-mono">
                                          <span className="text-cyan-400">{l.name}</span>
                                          <span className="text-slate-500">(</span>
                                          {Object.entries(l.args)
                                            .map(([k, v]) => {
                                              const val = formatLogArg(l.name, k, v);
                                              return (
                                                <span key={k}>
                                                  <span className="text-slate-400">{k}=</span>
                                                  <span className="text-slate-200">{val}</span>
                                                </span>
                                              );
                                            })
                                            .reduce<React.ReactNode[]>((prev, curr) => (prev.length ? [...prev, ", ", curr] : [curr]), [])}
                                          <span className="text-slate-500">)</span>
                                          <span className="text-slate-500 text-xs ml-2">@{shortAddress(l.address)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </motion.tr>
                          )}
                        </AnimatePresence>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                {totalUserOpsPages > 1 && (
                  <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-slate-700/50 bg-slate-800/30">
                    <p className="text-sm text-slate-400">
                      Showing {(clampedPage - 1) * USEROPS_PAGE_SIZE + 1}–{Math.min(clampedPage * USEROPS_PAGE_SIZE, totalUserOps)} of {totalUserOps}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setUserOpsPage((p) => Math.max(1, p - 1))}
                        disabled={clampedPage <= 1}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-700/50 text-slate-200 border border-slate-600/50 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-600/50 transition-colors"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-slate-300 px-2">
                        Page {clampedPage} of {totalUserOpsPages}
                      </span>
                      <button
                        onClick={() => setUserOpsPage((p) => Math.min(totalUserOpsPages, p + 1))}
                        disabled={clampedPage >= totalUserOpsPages}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-700/50 text-slate-200 border border-slate-600/50 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-600/50 transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
                </>
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

          {/* Recent EntryPoint Operations */}
          <Section
            title="Recent EntryPoint Operations"
            subtitle="MATIC spent (actualGasCost) per UserOp — compare with USDC charged above"
            gridCols="grid-cols-1"
            className="xl:col-span-2 2xl:col-span-3"
          >
            <div className="overflow-hidden rounded-2xl border border-slate-700/50 bg-gradient-to-br from-slate-800/50 to-slate-700/50 backdrop-blur-sm">
              {entrypointOpsData?.status === "error" ? (
                <div className="p-8 text-center">
                  <svg className="w-12 h-12 mx-auto mb-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <p className="text-red-400 font-medium mb-2">Failed to load EntryPoint Operations</p>
                  <p className="text-slate-400 text-sm">{entrypointOpsData?.error ?? "Could not fetch EntryPoint ops"}</p>
                </div>
              ) : entrypointOpsData?.items?.length ? (
                <>
                <div className="overflow-x-auto">
                  <table className="table-modern">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th>Block</th>
                        <th>UserOp Hash</th>
                        <th>Sender</th>
                        <th>MATIC Spent</th>
                        <th>Success</th>
                        <th>Gas (units)</th>
                        <th>Transaction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {paginatedEntryPointOps.map((op: { blockNumber: number; userOpHash: string; sender: string; actualGasCostWei: string; success: boolean; actualGasUsed: string; transactionHash: string }, i: number) => (
                        <motion.tr
                          key={`${op.transactionHash}-${op.userOpHash}-${i}`}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                          className="odd:bg-slate-900/20 hover:bg-slate-800/40 transition-colors"
                        >
                          <td className="text-sm font-mono text-slate-300">{op.blockNumber}</td>
                          <td className="text-sm font-mono text-slate-300 truncate max-w-[140px]" title={op.userOpHash}>
                            <span className="inline-flex items-center gap-2">
                              <span className="truncate">{op.userOpHash.slice(0, 10)}…</span>
                              <CopyButton value={op.userOpHash} />
                            </span>
                          </td>
                          <td className="text-sm font-mono text-slate-300 truncate max-w-[120px]" title={op.sender}>
                            <span className="inline-flex items-center gap-2">
                              <span className="truncate">{shortAddress(op.sender)}</span>
                              <CopyButton value={op.sender} />
                            </span>
                          </td>
                          <td className="text-sm font-mono text-purple-300">
                            {(Number(op.actualGasCostWei) / 1e18).toFixed(6)} MATIC
                          </td>
                          <td className="text-sm font-mono">
                            <span className={op.success ? "text-green-400" : "text-red-400"}>
                              {op.success ? "Yes" : "No"}
                            </span>
                          </td>
                          <td className="text-sm font-mono text-green-300">
                            {op.actualGasUsed}
                          </td>
                          <td className="text-sm font-mono text-slate-300">
                            <span className="inline-flex items-center gap-2">
                              <span className="truncate max-w-[100px]" title={op.transactionHash}>
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
                {totalEntryPointOpsPages > 1 && (
                  <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-slate-700/50 bg-slate-800/30">
                    <p className="text-sm text-slate-400">
                      Showing {(clampedEntryPointPage - 1) * ENTRYPOINT_OPS_PAGE_SIZE + 1}–{Math.min(clampedEntryPointPage * ENTRYPOINT_OPS_PAGE_SIZE, totalEntryPointOps)} of {totalEntryPointOps}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setEntrypointOpsPage((p) => Math.max(1, p - 1))}
                        disabled={clampedEntryPointPage <= 1}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-700/50 text-slate-200 border border-slate-600/50 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-600/50 transition-colors"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-slate-300 px-2">
                        Page {clampedEntryPointPage} of {totalEntryPointOpsPages}
                      </span>
                      <button
                        onClick={() => setEntrypointOpsPage((p) => Math.min(totalEntryPointOpsPages, p + 1))}
                        disabled={clampedEntryPointPage >= totalEntryPointOpsPages}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-700/50 text-slate-200 border border-slate-600/50 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-600/50 transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
                </>
              ) : (
                <div className="p-12 text-center">
                  <svg className="w-16 h-16 mx-auto mb-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-slate-400 text-lg font-medium mb-2">No EntryPoint Operations Yet</p>
                  <p className="text-slate-500">UserOps using this paymaster will appear here</p>
                </div>
              )}
            </div>
          </Section>
          </div>
              </>
            ) : (
              <ControlPlaneTabPanel />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  );
}
