"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";

type PublicMetric = {
  status: "ok" | "error";
  value?: {
    formatted: string;
    formattedUnit?: string;
    raw: string;
  };
  error?: string;
};

type PublicMetricsResponse = {
  paymasterAddress?: { value?: string };
  entryPointDeposit?: PublicMetric;
  paymasterContractNativeReserve?: PublicMetric;
  paymasterContractUsdcReserve?: PublicMetric;
  gasPriceWei?: PublicMetric;
  paymasterServiceFeeBps?: PublicMetric;
  paymasterUsdcPerGas?: PublicMetric;
  health?: { paymasterApi?: string; bundler?: string };
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

export default function PublicLandingPage() {
  const [metrics, setMetrics] = useState<PublicMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetcher("/api/public-metrics")
      .then(setMetrics)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const formatValue = (metric?: PublicMetric) => {
    if (!metric || metric.status !== "ok" || !metric.value) return "—";
    return `${metric.value.formatted} ${metric.value.formattedUnit || ""}`;
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="hidden md:flex items-center justify-between gap-8">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-sm font-bold">NG</div>
              <span className="text-2xl font-semibold tracking-tight whitespace-nowrap">NoKYC Gas Station</span>
            </div>
            <div className="flex items-center gap-8 text-sm">
              <a href="#infrastructure" className="hover:text-indigo-400 transition-colors">Infrastructure</a>
              <a href="#integrate" className="hover:text-indigo-400 transition-colors">How to Integrate</a>
              <a href="#compare" className="hover:text-indigo-400 transition-colors">vs Pimlico</a>
            </div>
          </div>
          <div className="md:hidden flex items-center justify-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-sm font-bold">NG</div>
            <span className="text-lg sm:text-2xl font-semibold tracking-tight whitespace-nowrap">NoKYC Gas Station</span>
          </div>
        </div>
        <div className="md:hidden mt-2 flex items-center justify-center gap-2 overflow-x-auto pb-2">
          <a href="#infrastructure" className="shrink-0 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-slate-200">
            Infrastructure
          </a>
          <a href="#integrate" className="shrink-0 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-slate-200">
            Integrate
          </a>
          <a href="#compare" className="shrink-0 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-slate-200">
            vs Pimlico
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 md:pt-32 pb-20 px-6 relative">
        <div className="max-w-5xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/10 bg-white/5 text-sm mb-6"
          >
            ERC-4337 • Polygon • USDC Paymaster
          </motion.div>

          <h1 className="text-6xl sm:text-7xl font-bold tracking-tighter mb-6 bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-200 to-white">
            NoKYC Gas Station
          </h1>
          <p className="text-2xl text-slate-400 max-w-2xl mx-auto mb-10">
            The dApp user pays for gas + our AA infrastructure fee in USDC (compare with Pimlico).<br />
            Zero KYC. Production-grade ERC-4337 paymaster on Polygon.
          </p>

          <div className="flex items-center justify-center gap-4">
            <a 
              href="#integrate"
              className="px-10 py-4 bg-white text-slate-950 rounded-3xl font-semibold text-lg hover:bg-white/90 transition-all active:scale-[0.985]"
            >
              Integrate Now
            </a>
          </div>

          <div className="mt-16 text-xs text-slate-500 flex items-center justify-center gap-8">
            <div>Live on Polygon</div>
            <div>99.9% Uptime</div>
            <div>USDC-first</div>
          </div>
        </div>
      </section>

      {/* Infrastructure */}
      <section id="infrastructure" className="py-20 border-t border-white/10 bg-slate-950">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="text-indigo-400 text-sm font-mono tracking-[3px] mb-3">AA INFRASTRUCTURE</div>
            <h2 className="text-5xl font-semibold tracking-tight">No Registration Required</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              Developers do not need to sign up or create an account. Just point your dapp to
              <span className="font-mono text-slate-200"> https://nokycgas.com </span>
              and start calling <span className="font-mono text-slate-200">pm_sponsorUserOperation</span>.
            </p>
          </div>
        </div>
      </section>

      {/* Integrate */}
      <section id="integrate" className="py-20 bg-slate-900 border-t border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">How to Integrate</h2>
            <p className="text-slate-400 max-w-md mx-auto">
              One RPC call. The dApp user pays for gas + AA infrastructure fee in USDC. No KYC. Works with any ERC-4337 wallet or SDK.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-5 sm:gap-8">
            <div className="bg-slate-950 border border-white/10 rounded-3xl p-6 sm:p-10">
              <div className="font-mono text-xs text-emerald-400 mb-4">POST /</div>
              <div className="text-xl font-medium mb-6">pm_sponsorUserOperation</div>
              <pre className="bg-black/50 p-4 sm:p-6 rounded-2xl text-xs sm:text-sm text-slate-300 overflow-x-auto font-mono leading-relaxed">
{`{
  "jsonrpc": "2.0",
  "method": "pm_sponsorUserOperation",
  "params": [userOp, entryPoint],
  "id": 1
}`}
              </pre>
              <div className="mt-8 text-xs text-slate-400 space-y-3">
                <div className="flex gap-3">
                  <div className="text-emerald-400 font-medium">✓</div>
                  <div>Returns <span className="font-mono text-white">paymasterData</span>, gas limits, and accurate USDC estimates</div>
                </div>
                <div className="flex gap-3">
                  <div className="text-emerald-400 font-medium">✓</div>
                  <div>Supports referral addresses and basis points</div>
                </div>
                <div className="flex gap-3">
                  <div className="text-emerald-400 font-medium">✓</div>
                  <div>Approximate cost fields for dApp UX: <span className="font-mono">approximateTotalCostUsdcE6</span></div>
                </div>
              </div>
            </div>

            <div className="space-y-5 sm:space-y-6">
              <div className="bg-slate-950 border border-white/10 rounded-3xl p-6 sm:p-8">
                <div className="text-cyan-400 text-sm font-medium mb-3">BUNDLER PROXY (CORS)</div>
                <div className="font-mono text-xs sm:text-sm text-slate-400 break-all">Use <span className="text-white">https://nokycgas.com/bundler/rpc</span> instead of raw bundler port</div>
              </div>

              <div className="bg-slate-950 border border-white/10 rounded-3xl p-6 sm:p-8">
                <div className="text-amber-400 text-sm font-medium mb-4">PRICING</div>
                <div className="text-sm text-slate-400 leading-relaxed">
                  The dApp user pays for gas + our AA infrastructure fee in USDC (default service fee 10%, compare with Pimlico).<br />
                  Real-time USDC/gas rate and approximate total cost are returned in every sponsor response.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Referral Revenue */}
      <section id="referral" className="py-20 border-t border-white/10 bg-slate-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <div className="text-fuchsia-400 text-sm font-mono tracking-[3px] mb-3">REFERRAL REVENUE</div>
            <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight">Monetize Every Sponsored UserOp</h2>
            <p className="text-slate-400 mt-4 max-w-3xl mx-auto">
              Integrated dapps can charge for their own service at the same moment users pay gas.
              Add your referral context to sponsorship requests and your fee is included in the USDC charge flow.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-5 sm:gap-6">
            <div className="rounded-3xl border border-fuchsia-400/30 bg-fuchsia-500/10 p-6 sm:p-8">
              <h3 className="text-xl sm:text-2xl font-semibold text-fuchsia-200 mb-5">What your users see</h3>
              <ul className="space-y-3 text-sm text-slate-300">
                <li>- One clear total fee in USDC before submission.</li>
                <li>- Gas + infra + dapp service fee combined in one transparent flow.</li>
                <li>- Better trust and fewer checkout surprises.</li>
              </ul>
            </div>
            <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 sm:p-8">
              <h3 className="text-xl sm:text-2xl font-semibold text-slate-100 mb-5">How you integrate it</h3>
              <p className="text-sm text-slate-400 mb-4">
                Pass referral context in <span className="font-mono text-slate-200">params[2]</span> of
                <span className="font-mono text-slate-200"> pm_sponsorUserOperation</span>:
              </p>
              <pre className="bg-black/50 p-4 rounded-2xl text-xs text-slate-300 overflow-x-auto font-mono leading-relaxed">
{`{
  "referralAddress": "0xYourRevenueAddress",
  "referralBps": 200
}`}
              </pre>
              <p className="text-xs text-slate-500 mt-3">
                Example above: <span className="font-mono">200 bps = 2.00%</span> referral fee.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Compare */}
      <section id="compare" className="py-20 border-t border-white/10 bg-slate-950">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-cyan-400 text-sm font-mono tracking-[3px] mb-3">COMPARISON</div>
            <h2 className="text-5xl font-semibold tracking-tight">NoKYC vs Pimlico</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              Built for teams that want a simple integration plus transparent user-facing economics.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-3xl border border-indigo-400/30 bg-indigo-500/10 p-8">
              <h3 className="text-2xl font-semibold text-indigo-200 mb-6">NoKYC Gas Station</h3>
              <ul className="space-y-3 text-sm text-slate-300">
                <li>- Dapp user pays gas + AA infra fee in USDC.</li>
                <li>- Pricing fields are returned in sponsor response for dapp UX.</li>
                <li>- One integration flow: paymaster RPC + bundler proxy endpoint.</li>
                <li>- Fee model and reserve strategy are visible and explicit.</li>
                <li>- Optimized for clear conversion messaging to end users.</li>
              </ul>
            </div>

            <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-8">
              <h3 className="text-2xl font-semibold text-slate-100 mb-6">Typical Pimlico Setup</h3>
              <ul className="space-y-3 text-sm text-slate-300">
                <li>- Requires developer registration and direct payment to Pimlico services.</li>
                <li>- Sponsorship economics are usually abstracted behind provider defaults.</li>
                <li>- Dapp teams commonly add their own explanation layer for users.</li>
                <li>- Provider-centric controls and dashboards depend on external product choices.</li>
                <li>- Great managed option; less opinionated on your public conversion narrative.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Live Stats */}
      <section className="py-20 border-t border-white/10">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-emerald-400 text-sm font-mono mb-3">LIVE</div>
            <h2 className="text-4xl font-semibold">Current Network Status</h2>
          </div>

          {loading ? (
            <div className="text-center py-12 text-slate-400">Loading live metrics...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 text-center">
                <div className="text-xs text-slate-500 mb-2">GAS PRICE</div>
                <div className="text-4xl font-mono text-amber-300">{formatValue(metrics?.gasPriceWei)}</div>
              </div>
              <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 text-center">
                <div className="text-xs text-slate-500 mb-2">SERVICE FEE</div>
                <div className="text-4xl font-mono text-rose-300">{formatValue(metrics?.paymasterServiceFeeBps)}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* CTA Footer */}
      <footer className="border-t border-white/10 py-20 bg-black">
        <div className="max-w-4xl mx-auto text-center px-6">
          <div className="text-3xl font-semibold mb-6">Ready to sponsor UserOps with USDC?</div>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a 
              href="#integrate"
              className="px-10 py-4 bg-white text-black rounded-3xl font-semibold text-lg hover:bg-white/90 transition-all"
            >
              Start Integration
            </a>
          </div>
          <div className="mt-6 text-xs text-slate-500">
            <Link href="/login" className="hover:text-slate-300 transition-colors">
              Admin access
            </Link>
          </div>
          <p className="text-xs text-slate-500 mt-12">
            NoKYC Gas Station — Production ERC-4337 Paymaster on Polygon
          </p>
        </div>
      </footer>
    </main>
  );
}
