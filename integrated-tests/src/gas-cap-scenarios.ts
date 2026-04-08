import { encodeFunctionData, parseAbi, parseUnits, type Address } from "viem";
import { USDC_ADDRESS } from "./funding.js";

export type ScenarioProfile = "normal" | "deploy";

export interface ScenarioContext {
  paymasterAddress: Address;
  fallbackTarget: Address;
  referralTarget: Address;
}

export interface ScenarioDefinition {
  id: string;
  description: string;
  profile: ScenarioProfile;
  weight: number;
  buildCalls: (ctx: ScenarioContext) => Array<{ to: Address; value: bigint; data?: `0x${string}` }>;
}

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const approveUnlimited = (spender: Address) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, parseUnits("1000000", 6)],
  });

const transferTiny = (to: Address, amountUsdc = "0.05") =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(amountUsdc, 6)],
  });

export const DEFAULT_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "normal_approve_only",
    description: "USDC approve paymaster only",
    profile: "normal",
    weight: 4,
    buildCalls: (ctx) => [{ to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) }],
  },
  {
    id: "normal_transfer_only",
    description: "USDC approve + transfer tiny amount",
    profile: "normal",
    weight: 3,
    buildCalls: (ctx) => [
      { to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) },
      { to: USDC_ADDRESS, value: 0n, data: transferTiny(ctx.referralTarget) },
    ],
  },
  {
    id: "normal_approve_plus_call",
    description: "USDC approve then empty target call",
    profile: "normal",
    weight: 5,
    buildCalls: (ctx) => [
      { to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) },
      { to: ctx.fallbackTarget, value: 0n },
    ],
  },
  {
    id: "normal_double_call",
    description: "USDC approve + two empty external calls",
    profile: "normal",
    weight: 2,
    buildCalls: (ctx) => [
      { to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) },
      { to: ctx.fallbackTarget, value: 0n },
      { to: ctx.referralTarget, value: 0n },
    ],
  },
  {
    id: "deploy_first_approve",
    description: "Smart account deploy with first-op approve",
    profile: "deploy",
    weight: 4,
    buildCalls: (ctx) => [{ to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) }],
  },
  {
    id: "deploy_approve_plus_call",
    description: "Smart account deploy with approve + empty call",
    profile: "deploy",
    weight: 5,
    buildCalls: (ctx) => [
      { to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) },
      { to: ctx.fallbackTarget, value: 0n },
    ],
  },
  {
    id: "deploy_transfer_plus_call",
    description: "Smart account deploy with approve + transfer + empty call",
    profile: "deploy",
    weight: 3,
    buildCalls: (ctx) => [
      { to: USDC_ADDRESS, value: 0n, data: approveUnlimited(ctx.paymasterAddress) },
      { to: USDC_ADDRESS, value: 0n, data: transferTiny(ctx.referralTarget, "0.1") },
      { to: ctx.fallbackTarget, value: 0n },
    ],
  },
];

export function buildScenarioSequence(
  scenarios: ScenarioDefinition[],
  normalCount: number,
  deployCount: number
): ScenarioDefinition[] {
  const out: ScenarioDefinition[] = [];
  const normal = scenarios.filter((s) => s.profile === "normal");
  const deploy = scenarios.filter((s) => s.profile === "deploy");
  const pushWeighted = (bucket: ScenarioDefinition[], count: number) => {
    const expanded = bucket.flatMap((s) => Array.from({ length: Math.max(1, s.weight) }, () => s));
    for (let i = 0; i < count; i++) {
      out.push(expanded[i % expanded.length]);
    }
  };
  pushWeighted(normal, normalCount);
  pushWeighted(deploy, deployCount);
  return out;
}
