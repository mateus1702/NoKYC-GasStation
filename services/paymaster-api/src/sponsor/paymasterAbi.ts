export const PAYMASTER_READ_ABI = [
  {
    type: "function",
    name: "getPricingCounters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "gasUnitsProcessed", type: "uint256" },
      { name: "usdcSpentForGasE6", type: "uint256" },
      { name: "gasBoughtWei", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const CAP_PROFILE_NORMAL = 0;
export const CAP_PROFILE_DEPLOY = 1;
