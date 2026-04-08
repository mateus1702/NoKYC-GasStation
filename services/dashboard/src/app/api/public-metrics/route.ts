import { NextResponse } from 'next/server';
import { collectMetrics } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Public endpoint - no auth required, returns safe read-only subset for landing page
export async function GET() {
  try {
    const payload = await collectMetrics();

    // Return only safe public fields for marketing/developer landing page
    const publicPayload = {
      paymasterAddress: payload.paymasterAddress,
      entryPointDeposit: payload.entryPointDeposit,
      paymasterContractNativeReserve: payload.paymasterContractNativeReserve,
      paymasterContractUsdcReserve: payload.paymasterContractUsdcReserve,
      refillOwnerNativeBalance: payload.refillOwnerNativeBalance,
      refillOwnerUsdcBalance: payload.refillOwnerUsdcBalance,
      gasPriceWei: payload.gasPriceWei,
      paymasterServiceFeeBps: payload.paymasterServiceFeeBps,
      paymasterUsdcPerGas: payload.paymasterUsdcPerGas,
      health: payload.health,
    };

    return NextResponse.json(publicPayload);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
