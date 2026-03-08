# Project4 Worker Service

The Worker service manages gas reserves for the entire Project4 ERC-4337 stack, ensuring all operational accounts maintain sufficient funds for sponsored UserOperations and infrastructure operations.

## Overview

The Worker implements a sophisticated gas management system that:

- **Validates bootstrap funding** on startup
- **Performs initial gas distribution** to all operational accounts
- **Monitors gas levels** continuously (30-second intervals)
- **Auto-refills gas** when accounts drop below thresholds
- **Manages USDC transfers** from revenue to operational accounts
- **Tracks profitability** by monitoring costs vs. revenue

## Architecture

### Account Types Managed

1. **Bootstrap Account** - Initial funding source (100 USDC + gas)
2. **Worker Account** - Operational account for swaps/transfers
3. **EntryPoint** - ERC-4337 EntryPoint contract gas reserves
4. **Bundler Accounts** - Dynamic number of executor/utility accounts for UserOp processing
5. **Revenue Account** - Collection point for sponsored UserOp fees

### Gas Thresholds

- **Minimum Gas Limit**: `0.005 ETH` per account (configurable via WORKER_MIN_GAS_LIMIT)
- **Refill Target**: `110%` of minimum requirement (provides 10% safety buffer)
- **Worker USDC Minimum**: `50 USDC` operational reserve (configurable via WORKER_MIN_WORKER_USDC)
- **Monitoring Interval**: Configurable via `WORKER_MONITORING_INTERVAL_SECONDS` (default: 30 seconds)

## Environment Variables

### Required Variables

```bash
# Bootstrap account (initial funding source)
WORKER_BOOTSTRAP_PRIVATE_KEY=     # Fund with 100 USDC + 0.01 ETH

# Revenue account (fee collection)
WORKER_REVENUE_PRIVATE_KEY=       # Signs USDC transfers to worker
WORKER_REVENUE_ADDRESS=           # Paymaster sends fees here (auto-derived)

# Infrastructure (DEX, RPC, contracts)
WORKER_RPC_URL=                   # RPC endpoint for worker operations
WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS= # USDC contract address
WORKER_TREASURY_PRIVATE_KEY=      # Operational account private key
WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS= # ERC-4337 EntryPoint address
WORKER_UNISWAP_V3_ROUTER=         # Uniswap V3 router for gas swaps
WORKER_WRAPPED_NATIVE_TOKEN=      # Wrapped native token (WMATIC)
WORKER_UNISWAP_POOL_FEE=          # Uniswap pool fee tier

# Bundler service (gas monitoring for all accounts)
# Bundler addresses auto-derived from:
ALTO_UTILITY_PRIVATE_KEY=         # Utility account private key
ALTO_EXECUTOR_PRIVATE_KEYS=       # Comma-separated executor private keys

# Monitoring configuration
WORKER_MONITORING_INTERVAL_SECONDS=30  # Check frequency

# Balance thresholds (in smallest units - required, no defaults)
WORKER_MIN_BOOTSTRAP_USDC=              # Min bootstrap USDC (100 USDC = 100000000)
WORKER_MIN_BOOTSTRAP_GAS=               # Min bootstrap gas (0.01 ETH = 10000000000000000)
WORKER_MIN_WORKER_USDC=                 # Min worker USDC (50 USDC = 50000000)
WORKER_MIN_GAS_LIMIT=                   # Min operational gas (0.005 ETH = 5000000000000000)

# Paymaster contract (must be configured to send fees to WORKER_REVENUE_ADDRESS)
PAYMASTER_CONTRACT_TREASURY_ADDRESS=   # Must match WORKER_REVENUE_ADDRESS
```

### Legacy Variables (Deprecated)

```bash
WORKER_ANVIL_WHALE_BOOTSTRAP         # Removed - no auto-funding
WORKER_BOOTSTRAP_USDC_E6            # Removed - use MIN_BOOTSTRAP_USDC constant
POLL_INTERVAL_MS                    # Removed - use WORKER_MONITORING_INTERVAL_SECONDS
```

## Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   STARTUP       │ -> │   BOOTSTRAP      │ -> │   INITIAL       │
│   VALIDATION    │    │   FUNDING        │    │   DISTRIBUTION  │
│                 │    │   CHECK          │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   MONITORING    │ -> │   DEFICIT        │ -> │   GAS REFILL    │
│   LOOP          │    │   DETECTION      │    │   & USDC TXFR   │
│  (30s cycle)    │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   USER OP       │ -> │   REVENUE        │ -> │   CONTINUOUS    │
│   PROCESSING    │    │   COLLECTION     │    │   MONITORING    │
│                 │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Detailed Flow

### Phase 1: Startup Validation

1. **Environment Validation**
   - Validates all required environment variables are set:
     - `WORKER_BOOTSTRAP_PRIVATE_KEY`
     - `WORKER_REVENUE_PRIVATE_KEY`
     - `WORKER_RPC_URL`
     - `WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS`
     - `WORKER_TREASURY_PRIVATE_KEY`
     - `WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS`
     - `WORKER_UNISWAP_V3_ROUTER`
     - `WORKER_WRAPPED_NATIVE_TOKEN`
     - `WORKER_UNISWAP_POOL_FEE`
     - `WORKER_MONITORING_INTERVAL_SECONDS`
     - `WORKER_MIN_BOOTSTRAP_USDC`
     - `WORKER_MIN_BOOTSTRAP_GAS`
     - `WORKER_MIN_WORKER_USDC`
     - `WORKER_MIN_GAS_LIMIT`
     - `ALTO_UTILITY_PRIVATE_KEY`
     - `ALTO_EXECUTOR_PRIVATE_KEYS`
   - Validates numeric environment variables are valid BigInt values
   - **No default values** - all configuration must be provided via environment variables

2. **Bootstrap Funding Verification**
   ```typescript
   // Verify bootstrap account has required balances (no auto-funding)
   const hasFunds = await verifyBootstrapFunding();
   if (!hasFunds) {
     console.error("❌ Bootstrap account insufficiently funded");
     console.error("   Required: 100 USDC + 0.01 ETH gas");
     console.error("   Please manually fund the bootstrap account");
     process.exit(1);
   }
   ```

3. **Required Balances**
   - **USDC**: Exactly 100 USDC (`MIN_BOOTSTRAP_USDC`)
   - **Gas**: At least 0.01 ETH (`MIN_BOOTSTRAP_GAS`)

### Phase 2: Initial Distribution

1. **Gas Requirement Calculation**
   ```typescript
   // Calculate gas needed for all operational accounts
   const gasNeededPerAccount = WORKER_MIN_GAS_LIMIT + BigInt(1e15); // + 0.001 ETH buffer
   const totalAccounts = 3 + bundlerAddresses.length; // EP + Worker + Revenue + all bundlers
   const totalGasNeeded = gasNeededPerAccount * BigInt(totalAccounts);
   ```

2. **Bootstrap Swap & Distribution**
   ```typescript
   // Approve all bootstrap USDC for DEX swap
   const swapAmount = WORKER_MIN_BOOTSTRAP_USDC;
   await approveUSDC(WORKER_UNISWAP_V3_ROUTER, swapAmount);

   // Swap requiring 110% of calculated gas (10% safety buffer)
   const requiredGasOutput = totalGasNeeded * 110n / 100n;
   const gasReceived = await swapUSDCForGas(swapAmount, requiredGasOutput);

   // Distribute gas to all accounts (EntryPoint + all bundler accounts + Worker + Revenue)
   await distributeGasToAllAccounts(gasReceived);

   // Transfer minimum USDC to worker account
   await transferUSDCToWorker(WORKER_MIN_WORKER_USDC);
   ```

### Phase 3: Monitoring Loop

**30-Second Cycle:**

1. **Worker USDC Check**
   ```typescript
   const workerUSDC = await getUSDCBalance(WORKER_ADDRESS);
   if (workerUSDC <= MIN_WORKER_USDC) {
     const needed = MIN_WORKER_USDC - workerUSDC + buffer;
     await transferUSDCFromRevenue(needed);
   }
   ```

2. **Gas Balance Check**
   ```typescript
   // Check all operational accounts (dynamic bundler count)
   const accounts = [
     { name: 'entryPoint', address: WORKER_PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS },
     { name: 'worker', address: workerAddress },
     { name: 'revenue', address: WORKER_REVENUE_ADDRESS }
   ];

   // Add all bundler accounts (utility + executors)
   WORKER_BUNDLER_ADDRESSES.forEach((address, index) => {
     accounts.push({ name: `bundler-${index}`, address });
   });

   for (const account of accounts) {
     const gasBalance = await getGasBalance(account.address);
     if (gasBalance <= WORKER_MIN_GAS_LIMIT) {
       deficits.push({
         name: account.name,
         address: account.address,
         neededGas: WORKER_MIN_GAS_LIMIT - gasBalance + BigInt(1e15) // + 0.001 ETH buffer
       });
     }
   }
   ```

3. **Refill Operations**
   ```typescript
   if (deficits.length > 0) {
     // Calculate total gas needed
     const totalNeeded = deficits.reduce((sum, d) => sum + d.neededGas, 0n);

     // Ensure worker has enough USDC
     await ensureWorkerHasUSDCForSwap(totalNeeded);

     // Perform swap and distribute
     const gasReceived = await worker.swapUSDCForGas(usdcNeeded);
     for (const deficit of deficits) {
       await worker.transferGas(deficit.address, deficit.neededGas);
     }
   }
   ```

## Key Functions

### Core Functions

- **`validateEnvironmentVariables()`** - Validates all required environment variables are set
- **`verifyBootstrapFunding()`** - Validates bootstrap account has required balances
- **`fundBootstrapFromWhale()`** - Auto-funds bootstrap account in local development
- **`performBootstrapDistribution()`** - Performs initial gas distribution to all accounts
- **`performInitialSetup()`** - Orchestrates complete startup process

### Monitoring Functions

- **`checkWorkerUSDC()`** - Monitors worker USDC balance, transfers from revenue if low
- **`checkGasBalances()`** - Checks gas balances of all operational accounts
- **`transferUSDCFromRevenue()`** - Moves USDC from revenue account to worker
- **`performGasRefill()`** - Swaps USDC for gas and distributes to deficit accounts
- **`startMonitoringLoop()`** - Runs continuous monitoring with recursive setTimeout

### Utility Functions

- **`gasCostFromReceipt()`** - Calculates gas cost from transaction receipt

## Setup Instructions

### Local Development

1. **Set all required WORKER_* environment variables** in .env file
2. **Start worker service** (bootstrap funding happens automatically)
3. **Worker will auto-fund bootstrap from Anvil whales**
4. **Worker will perform initial distribution and start monitoring**

### Production/Testnet

1. **Generate secure private keys** for bootstrap and revenue accounts
2. **Fund bootstrap address** with required USDC + gas (amounts from WORKER_MIN_* variables)
3. **Deploy/configure bundler service**
4. **Set all WORKER_* environment variables**
5. **Start worker service** (no auto-funding)

### Environment Variables Example

```bash
# Production setup (all WORKER_* variables required)
WORKER_BOOTSTRAP_PRIVATE_KEY=0x1234567890abcdef...
WORKER_REVENUE_PRIVATE_KEY=0xabcdef1234567890...
WORKER_RPC_URL=https://polygon-rpc.com/
WORKER_PAYMASTER_CONTRACT_USDC_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
WORKER_TREASURY_PRIVATE_KEY=0x1234567890abcdef...
WORKER_MONITORING_INTERVAL_SECONDS=30
# ... and all other WORKER_* variables
```

## Integration Points

### Paymaster Integration
- Paymaster sends fees to `WORKER_REVENUE_ADDRESS` (configured as `FEE_DESTINATION`)
- Worker monitors revenue account and transfers USDC to worker when needed

### Bundler Integration
- **Dynamic bundler monitoring**: All utility and executor accounts auto-discovered from `ALTO_UTILITY_PRIVATE_KEY` and `ALTO_EXECUTOR_PRIVATE_KEYS`
- Gas refilled automatically when any bundler account drops below `WORKER_MIN_GAS_LIMIT`

### EntryPoint Integration
- EntryPoint gas reserves maintained automatically
- Worker ensures EntryPoint can process UserOperations

## Monitoring & Metrics

### Gas Usage Tracking
- **Per-Account Gas Monitoring**: Real-time balance checks
- **Refill Event Logging**: Detailed logs of gas distribution
- **Cost Analysis**: Gas spent vs. revenue collected

### Performance Metrics
- **Refill Frequency**: How often accounts need gas
- **USDC Transfer Volume**: Revenue to worker transfers
- **Gas Efficiency**: Cost per monitored account

## Error Handling

### Bootstrap Failures
- **Missing Private Keys**: Clear error messages with setup instructions
- **Insufficient Funding**: Exact balance requirements shown
- **Network Issues**: Retry logic with exponential backoff

### Runtime Errors
- **Swap Failures**: DEX quote validation, retry logic
- **Transfer Failures**: Gas estimation, nonce management
- **Balance Check Errors**: RPC timeout handling

## Security Considerations

### Private Key Management
- **Bootstrap Key**: Minimal permissions, only for initial setup
- **Revenue Key**: Limited to USDC transfers from revenue account
- **Worker Key**: Full operational permissions for swaps/transfers

### Fund Safety
- **Revenue Isolation**: Earnings kept separate from operations
- **Minimum Reserves**: Accounts never drained completely
- **Auto-Refill Logic**: Prevents service disruption from low balances

## Troubleshooting

### Common Issues

1. **Bootstrap funding insufficient**
   - Check balances on bootstrap address
   - Ensure exactly 100 USDC + 0.01 ETH gas
   - Verify private key configuration

2. **Gas refill failures**
   - Check worker USDC balance
   - Verify DEX router configuration
   - Check RPC connectivity

3. **USDC transfer failures**
   - Verify revenue account has sufficient USDC
   - Check revenue private key permissions
   - Validate contract addresses

### Debug Commands

```bash
# Check bootstrap funding
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["BOOTSTRAP_ADDRESS","latest"],"id":1}'

# Check worker balances
# Check gas monitoring logs
# Verify DEX router status
```

## Future Enhancements

- **Dynamic Thresholds**: AI-based gas level optimization
- **Multi-Dex Routing**: Best price discovery across DEXs
- **Predictive Refilling**: Machine learning for gas usage prediction
- **Multi-Chain Support**: Cross-chain gas management
- **Advanced Analytics**: Profitability dashboards and reporting