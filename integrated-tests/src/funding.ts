/**
 * Shared USDC funding utilities for AA integrated tests.
 * Whale selection, impersonation, transfer, waitForTransactionReceipt.
 */
import { encodeFunctionData, parseAbi, parseUnits, type Address } from "viem";

export const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;

export const FUNDING_WHALE = process.env.TOOLS_USDC_WHALE as Address | undefined;

export const DEFAULT_WHALE_CANDIDATES = [
  "0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055",
  "0xb75f972af41d6ff0bcc6b2613b832632de1e418b",
  "0x815937a75074e0df3419973c629221c82121a082",
  "0xffa8db7b38579e6a2d14f9b347a9ace4d044cd54",
  "0x47c031236e19d024b42f8de678d3110562d925b5",
] as Address[];

/** Default address for UserOp transfer/approve targets (e.g. vuln tests). */
export const DEFAULT_TRANSFER_TARGET = DEFAULT_WHALE_CANDIDATES[4];

export const FUNDING_WHALE_CANDIDATES = (
  (process.env.TOOLS_USDC_WHALE_CANDIDATES ?? "").split(",").map((x) => x.trim()).filter(Boolean)
) as Address[];

export const FUNDING_AMOUNT = parseUnits(
  process.env.TOOLS_USDC_FUND_AMOUNT ?? "1000",
  6
);

export type UsdcReadContract = {
  read: { balanceOf: (args: [Address]) => Promise<bigint> };
};

export async function fundAccountWithUSDC(
  accountAddress: Address,
  amount: bigint,
  usdc: UsdcReadContract,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts viem PublicClient
  publicClient: { request: (args: any) => Promise<any>; waitForTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts viem TestClient
  testClient: { impersonateAccount: (args: any) => Promise<any>; setBalance: (args: any) => Promise<any>; stopImpersonatingAccount: (args: any) => Promise<any> }
): Promise<void> {
  const candidateWhales: Address[] = [
    ...(FUNDING_WHALE ? [FUNDING_WHALE] : []),
    ...FUNDING_WHALE_CANDIDATES,
    ...DEFAULT_WHALE_CANDIDATES,
  ].filter(
    (addr, idx, arr) =>
      arr.findIndex((x) => x.toLowerCase() === addr.toLowerCase()) === idx
  );

  let whale: Address | undefined;
  for (const candidate of candidateWhales) {
    const bal = await usdc.read.balanceOf([candidate]);
    if (bal >= amount) {
      whale = candidate;
      break;
    }
  }
  if (!whale) {
    throw new Error(
      "No whale has enough USDC; set TOOLS_USDC_WHALE or TOOLS_USDC_WHALE_CANDIDATES"
    );
  }

  await testClient.impersonateAccount({ address: whale });
  await testClient.setBalance({ address: whale, value: BigInt(1e18) });

  const transferData = encodeFunctionData({
    abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
    functionName: "transfer",
    args: [accountAddress, amount],
  });

  const transferHash = (await publicClient.request({
    method: "eth_sendTransaction" as never,
    params: [{ from: whale, to: USDC_ADDRESS, data: transferData, gas: "0x186A0" }],
  })) as `0x${string}`;

  await publicClient.waitForTransactionReceipt({ hash: transferHash });
  await testClient.stopImpersonatingAccount({ address: whale });
}

export const MIN_USDC_BALANCE = parseUnits("1", 6);
