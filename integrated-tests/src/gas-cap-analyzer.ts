export type GasProfile = "normal" | "deploy";

export interface TelemetrySample {
  profile: GasProfile;
  actualGasUsed?: bigint;
  gasUnitsCharged?: bigint;
  success: boolean;
}

export interface AnalyzerOptions {
  targetOverCapRate: number;
  bufferBps: number;
  minSamples: number;
  candidatePercentiles: number[];
}

export interface ProfileRecommendation {
  profile: GasProfile;
  sampleSize: number;
  successSampleSize: number;
  chosenMetric: "actualGasUsed" | "gasUnitsCharged";
  chosenCapBeforeBuffer: bigint;
  recommendedCap: bigint;
  achievedOverCapRate: number;
  percentiles: Record<string, string>;
  candidates: Array<{
    percentile: number;
    capBeforeBuffer: string;
    overCapRate: number;
  }>;
}

export interface AnalyzerReport {
  generatedAt: string;
  options: AnalyzerOptions;
  recommendations: {
    normal: ProfileRecommendation;
    deploy: ProfileRecommendation;
  };
}

function sortBigints(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function percentile(sortedValues: bigint[], p: number): bigint {
  if (sortedValues.length === 0) return 0n;
  if (p <= 0) return sortedValues[0];
  if (p >= 100) return sortedValues[sortedValues.length - 1];
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const idx = Math.max(0, Math.min(sortedValues.length - 1, rank));
  return sortedValues[idx];
}

function overCapRate(values: bigint[], cap: bigint): number {
  if (values.length === 0) return 1;
  const over = values.filter((v) => v > cap).length;
  return over / values.length;
}

function applyBuffer(cap: bigint, bufferBps: number): bigint {
  if (bufferBps <= 0) return cap;
  return (cap * BigInt(10000 + bufferBps) + 9999n) / 10000n;
}

function profileValues(samples: TelemetrySample[], profile: GasProfile): {
  metric: "actualGasUsed" | "gasUnitsCharged";
  values: bigint[];
  successSampleSize: number;
} {
  const profileSamples = samples.filter((s) => s.profile === profile && s.success);
  const charged = profileSamples
    .map((s) => s.gasUnitsCharged)
    .filter((v): v is bigint => typeof v === "bigint" && v > 0n);
  if (charged.length > 0) {
    return { metric: "gasUnitsCharged", values: charged, successSampleSize: profileSamples.length };
  }
  const actual = profileSamples
    .map((s) => s.actualGasUsed)
    .filter((v): v is bigint => typeof v === "bigint" && v > 0n);
  return { metric: "actualGasUsed", values: actual, successSampleSize: profileSamples.length };
}

function recommendForProfile(
  samples: TelemetrySample[],
  profile: GasProfile,
  options: AnalyzerOptions
): ProfileRecommendation {
  const allProfileCount = samples.filter((s) => s.profile === profile).length;
  const { metric, values, successSampleSize } = profileValues(samples, profile);
  const sorted = sortBigints(values);
  if (sorted.length < options.minSamples) {
    throw new Error(
      `Insufficient ${profile} samples: have ${sorted.length}, need at least ${options.minSamples}.`
    );
  }

  const pMap: Record<string, string> = {};
  for (const p of [50, 90, 95, 99, 99.5, 99.9]) {
    pMap[`p${String(p).replace(".", "_")}`] = percentile(sorted, p).toString();
  }

  const candidates = options.candidatePercentiles.map((p) => {
    const cap = percentile(sorted, p);
    return {
      percentile: p,
      capBeforeBuffer: cap.toString(),
      overCapRate: overCapRate(sorted, cap),
    };
  });

  const chosen =
    candidates.find((c) => c.overCapRate <= options.targetOverCapRate) ??
    candidates[candidates.length - 1];
  const chosenCapBeforeBuffer = BigInt(chosen.capBeforeBuffer);
  const recommendedCap = applyBuffer(chosenCapBeforeBuffer, options.bufferBps);
  const achievedOverCapRate = overCapRate(sorted, chosenCapBeforeBuffer);

  return {
    profile,
    sampleSize: allProfileCount,
    successSampleSize,
    chosenMetric: metric,
    chosenCapBeforeBuffer,
    recommendedCap,
    achievedOverCapRate,
    percentiles: pMap,
    candidates,
  };
}

export function analyzeGasCaps(samples: TelemetrySample[], options: AnalyzerOptions): AnalyzerReport {
  const normal = recommendForProfile(samples, "normal", options);
  const deploy = recommendForProfile(samples, "deploy", options);
  return {
    generatedAt: new Date().toISOString(),
    options,
    recommendations: { normal, deploy },
  };
}
