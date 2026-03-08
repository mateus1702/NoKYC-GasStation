/**
 * Multi-DEX quote aggregation for Polygon
 * Queries Uniswap V3, selects best route (no MySQL)
 */
import { createPublicClient, http as viemHttp } from "viem";
import { polygon } from "viem/chains";

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const UNISWAP_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;
const UNISWAP_V3_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;

export interface DexQuote {
  dex: string;
  amountIn: bigint;
  amountOut: bigint;
  router: string;
  fee: number;
}

export async function getBestQuote(
  amountInUsdcE6: bigint,
  usdcAddress: string,
  wmaticAddress: string,
  rpcUrl: string
): Promise<DexQuote> {
  const client = createPublicClient({
    chain: polygon,
    transport: viemHttp(rpcUrl),
  });

  const feeTiers = [500, 3000, 10000];
  const quotes: DexQuote[] = [];

  for (const fee of feeTiers) {
    try {
      const result = await client.readContract({
        address: UNISWAP_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: usdcAddress as `0x${string}`,
            tokenOut: wmaticAddress as `0x${string}`,
            amountIn: amountInUsdcE6,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }) as readonly [bigint, bigint, number, bigint];
      const amountOut = result[0];
      quotes.push({
        dex: "uniswap_v3",
        amountIn: amountInUsdcE6,
        amountOut,
        router: UNISWAP_V3_ROUTER,
        fee,
      });
    } catch {
      // skip failed quotes
    }
  }

  const best =
    quotes.length > 0 ? quotes.reduce((a, b) => (b.amountOut > a.amountOut ? b : a), quotes[0]) : null;

  if (!best || best.amountOut <= 0n) {
    throw new Error("No valid DEX quote available");
  }
  return best;
}
