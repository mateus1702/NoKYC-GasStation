/** Re-export USDC whale funding from @project4/simulation (single source of truth). */
export {
  USDC_ADDRESS,
  FUNDING_WHALE,
  DEFAULT_WHALE_CANDIDATES,
  DEFAULT_TRANSFER_TARGET,
  FUNDING_WHALE_CANDIDATES,
  FUNDING_AMOUNT,
  fundAccountWithUSDC,
  MIN_USDC_BALANCE,
  type UsdcReadContract,
} from "@project4/simulation/lib/usdc-whale-funding.js";
