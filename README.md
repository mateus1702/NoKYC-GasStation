# NoKYC-GasStation - ERC-4337 Paymaster with Variable USDC Pricing

NoKYC-GasStation is a complete ERC-4337 Account Abstraction stack featuring a sophisticated USDC-denominated paymaster with Redis-backed variable pricing. The system dynamically prices gas based on historical acquisition costs and includes comprehensive security measures.

## Architecture

### Services

- **🔗 Paymaster Contract**: ERC-4337 compatible paymaster on Polygon
- **🔧 Paymaster API**: JSON-RPC server handling paymaster operations
- **👷 Worker**: Background service managing liquidity and pricing
- **📊 Dashboard**: Web interface for monitoring and analytics
- **🗄️ Valkey (Redis)**: High-performance key-value store for pricing data
- **🔨 Bundler (Alto)**: ERC-4337 bundler for UserOperation processing

### Key Features

- **💰 Variable USDC Pricing**: Gas costs denominated in USDC based on historical swap data
- **🔒 Security First**: Protection against gas griefing, estimation attacks, and manipulation
- **📈 Dynamic Pricing**: Real-time pricing updates via arbitrage/MEV strategies
- **🛡️ Fraud Protection**: Rate limiting, circuit breakers, and attack mitigation
- **📊 Monitoring**: Comprehensive dashboard with real-time metrics
- **🐳 Docker Ready**: Complete development environment with Docker Compose

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker & Docker Compose
- Git

### 1. Clone and Setup

```bash
git clone <repository-url>
cd project4

# Copy environment template
cp .env.example .env

# Fill in required environment variables (see .env section below)
```

### 2. Launch Development Stack

```bash
# Build and start all services
docker compose -f infra/docker/docker-compose.yml --env-file .env up -d --build

# Wait for services to be healthy (~2-3 minutes)
docker compose -f infra/docker/docker-compose.yml --env-file .env ps
```

### 3. Run Tests

```bash
# Variable fee integration test
npm run test:project4:fee

# Run until USDC depleted
npm run test:project4:fee:loop

# Underpricing attack test
npm run test:project4:underpricing

# Security vulnerability tests
npm run test:all-vulnerabilities
```

### 4. Access Services

- **Dashboard**: http://localhost:3001
- **Paymaster API**: http://localhost:3000
- **Bundler (direct)**: http://localhost:4337
- **Bundler (CORS proxy)**: http://localhost:3000/bundler/rpc — use this for browser-based consumers
- **Anvil RPC**: http://localhost:8545
- **Valkey**: localhost:6379

## API Reference

### Paymaster API Endpoints

#### `pm_getPaymasterStubData`
Returns minimal paymaster data for gas estimation without full bundler simulation.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "pm_getPaymasterStubData",
  "params": [userOp, entryPointAddress],
  "id": 1
}
```

#### `pm_sponsorUserOperation` / `pm_getPaymasterData`
Returns complete sponsored paymaster data with pricing and gas estimation.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "pm_sponsorUserOperation",
  "params": [userOp, entryPointAddress],
  "id": 1
}
```

#### `getUserOperationGasPrice`
Returns gas price recommendations.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "getUserOperationGasPrice",
  "params": [],
  "id": 1
}
```

### Response Format

```json
{
  "paymaster": "0x...",
  "paymasterVerificationGasLimit": "0x...",
  "paymasterPostOpGasLimit": "0x...",
  "paymasterData": "0x..."
}
```

### Bundler Proxy (CORS)

The Paymaster API exposes Alto behind `POST /bundler/rpc` so browser-based consumers avoid CORS. Use the paymaster domain + `/bundler/rpc` instead of calling the bundler on port 4337 directly.

**Migration**: If you currently call `http://<host>:4337`, switch to `https://<paymaster-domain>/bundler/rpc` (same base URL as the paymaster API).

**Allowed methods**: `eth_sendUserOperation`, `eth_estimateUserOperationGas`, `eth_getUserOperationByHash`, `eth_getUserOperationReceipt`, `eth_supportedEntryPoints`, `getUserOperationGasPrice`, `pimlico_getUserOperationGasPrice`.

**Example – eth_supportedEntryPoints:**

```bash
curl -X POST http://localhost:3000/bundler/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_supportedEntryPoints","params":[],"id":1}'
```

**Example – eth_sendUserOperation:**

```bash
curl -X POST http://localhost:3000/bundler/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_sendUserOperation","params":[userOp,entryPointAddress],"id":1}'
```

Replace `localhost:3000` with your paymaster API base URL in production.

## Configuration (.env)

### Core Infrastructure
```bash
# Anvil (Local Blockchain)
ANVIL_FORK_URL=https://rpc.ankr.com/polygon/...
ANVIL_FORK_BLOCK_NUMBER=83635022
ANVIL_CHAIN_ID=137

# External Services
PAYMASTER_API_RPC_URL=http://anvil:8545
PAYMASTER_API_BUNDLER_URL=http://bundler-alto:4337
VALKEY_URL=redis://valkey:6379
```

### Pricing Configuration
```bash
# Service Fee (500 = 5%)
PAYMASTER_API_SERVICE_FEE_BPS=500

# Buffer for gas estimation variance (1000 = 10%)
PAYMASTER_API_QUOTE_BUFFER_BPS=1000

# Minimum post-op fee (10000 = 0.01 USDC)
# Enforced even if gas calculation results in 0
PAYMASTER_API_MIN_POSTOP_FEE_USDC_E6=10000
```

### Contract Addresses
```bash
# USDC Token
PAYMASTER_CONTRACT_USDC_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359

# EntryPoint v0.7
PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS=0x0000000071727De22E5E9d8BAf0edAc6f37da032
```

### Security Settings
```bash
# Gas limits per UserOp (50M gas max)
PAYMASTER_CONTRACT_MAX_GAS_PER_USER_OP=50000000

# Rate limiting (1 hour window)
RATE_LIMIT_PERIOD_SECONDS=3600
RATE_LIMIT_MAX_GAS_PER_PERIOD=1000000000

# Circuit breaker (10B gas triggers pause)
CIRCUIT_BREAKER_GAS_THRESHOLD=10000000000
```

## Development

### Project Structure

```
project4/
├── contracts/           # Solidity contracts
├── services/
│   ├── paymaster-api/   # JSON-RPC API server
│   ├── shared/          # Common utilities & pricing
│   ├── worker/          # Background worker service
│   └── dashboard/       # Web monitoring interface
├── tools/
│   └── aa-test/         # Integration tests
└── infra/
    └── docker/          # Docker configuration
```

### Building Services

```bash
# Build all services
npm run build

# Build specific service
npm run build:contracts
npm run build:paymaster-api
npm run build:worker
npm run build:dashboard
```

### Running Tests

```bash
# Contract unit tests
npm run test:contracts

# Integration tests
npm run test:project4:fee          # Variable fee test
npm run test:project4:underpricing  # Security test
npm run test:all-vulnerabilities    # All security tests
```

### Manual Service Management

```bash
# View service status
docker compose -f infra/docker/docker-compose.yml --env-file .env ps

# View logs
docker compose -f infra/docker/docker-compose.yml --env-file .env logs paymaster-api

# Restart specific service
docker compose -f infra/docker/docker-compose.yml --env-file .env restart paymaster-api

# Clean restart (rebuild + fresh state)
docker rm -f $(docker ps -aq)
docker compose -f infra/docker/docker-compose.yml --env-file .env up -d --build
```

## Pricing Mechanism

### How It Works

1. **Worker Service** performs arbitrage/MEV swaps, spending USDC to acquire gas
2. **Pricing Data** stored in Valkey: `(totalUsdcSpent × 10^18) / totalGasAcquired`
3. **Paymaster API** calculates: `chargeAmount = (actualGasUsed × unitCost) / 10^18`
4. **Contract** enforces minimum fee and caps at authorized maximum

### Pricing Flow

```
UserOp Execution → Gas Measurement → USDC Cost Calculation → Fee Enforcement
       ↓                ↓                    ↓                    ↓
   Bundler        paymaster.postOp()    unitCostUsdcPerWei    MIN_POSTOP_FEE_USDC_E6
   executes       measures actualGas     × actualGasCost      applied if charge = 0
```

### Security Features

- **Gas Estimation Attack Protection**: Rate limiting and variance monitoring
- **Gas Griefing Mitigation**: Circuit breakers and per-user limits
- **Pricing Manipulation Defense**: Paymaster-controlled gas prices for cost calculation
- **Minimum Fee Enforcement**: Guarantees revenue even with low gas usage

## Troubleshooting

### Common Issues

- **`unsupported version v1`**: Ensure bundler config includes `api-version: v1,v2`
- **`pm_getPaymasterStubData` errors**: Check `BUNDLER_URL` connectivity and `REDIS_KEY_PREFIX` consistency
- **`entry point ... does not exist`**: Wait for contract-deployer to complete
- **Dashboard shows no UserOps**: Check `ALTO_BLOCK_RANGE_LIMIT` setting

### Service Health Checks

```bash
# Check all services
curl http://localhost:3000/health    # Paymaster API
curl http://localhost:4337/health    # Bundler
curl http://localhost:8080/health    # Worker
```

### Logs and Debugging

```bash
# View recent logs
docker compose -f infra/docker/docker-compose.yml --env-file .env logs --tail=100 paymaster-api

# Follow logs in real-time
docker compose -f infra/docker/docker-compose.yml --env-file .env logs -f paymaster-api
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with comprehensive tests
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details