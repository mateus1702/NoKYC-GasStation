# 🚀 NoKYC-GasStation
## ERC-4337 Account Abstraction Stack with Variable USDC Pricing

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Docker Ready](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com/)
[![ERC-4337](https://img.shields.io/badge/ERC--4337-Account%20Abstraction-purple.svg)](https://eips.ethereum.org/EIPS/eip-4337)

**NoKYC-GasStation** is a production-ready ERC-4337 Account Abstraction stack featuring a USDC-denominated paymaster with **on-chain procurement counters** and paymaster-API signing. See [MIGRATION_PAYMASTER.md](MIGRATION_PAYMASTER.md) for the latest economics model.

## 🌐 Live Demos

- **📊 Dashboard**: View the live monitoring dashboard at [https://www.nokycgas.com/](https://www.nokycgas.com/)
- **📧 PrivateMail**: Check out the PrivateMail service at [https://www.privatemail.foo/](https://www.privatemail.foo/) - see the repository at [https://github.com/mateus1702/PrivateEmail](https://github.com/mateus1702/PrivateEmail)

## 🏗️ Architecture Overview

### Core Services

| Service | Description | Port |
|---------|-------------|------|
| **🔗 Paymaster Contract** | ERC-4337 compatible paymaster on Polygon | - |
| **🔧 Paymaster API** | JSON-RPC server handling paymaster operations | `3000` |
| **📊 Dashboard** | Web interface for monitoring and analytics | `3001` |
| **🗄️ Valkey (Redis)** | High-performance key-value store for pricing data | `6379` |
| **🔨 Bundler (Alto)** | ERC-4337 bundler for UserOperation processing | `4337` |
| **⛽ Anvil** | Local Ethereum development network | `8545` |

### 🎯 Key Features

- **💰 Variable USDC Pricing**: Gas costs denominated in USDC based on historical swap data
- **🔒 Security First**: Protection against gas griefing, estimation attacks, and manipulation
- **📈 Dynamic Pricing**: Real-time pricing updates via arbitrage/MEV strategies
- **🛡️ Fraud Protection**: Rate limiting, circuit breakers, and attack mitigation
- **📊 Monitoring**: Comprehensive dashboard with real-time metrics and UserOp tracking
- **🐳 Docker Ready**: Complete development environment with Docker Compose
- **⚡ High Performance**: Valkey-backed pricing with sub-millisecond lookups
- **🔄 Operations**: Optional paymaster-api owner-driven refill (`withdrawUsdc` / `recordGasPurchase`) with multi-target native top-ups (EntryPoint deposit, paymaster native, Alto utility + executors)

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 20.0.0
- **Docker** & **Docker Compose**
- **Git**
- **Polygon RPC URL** (for production deployment)

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/mateus1702/NoKYC-GasStation.git
cd NoKYC-GasStation

# Copy environment template
cp .env.example .env

# Edit .env with your configuration (see Configuration section below)
# For development, most defaults should work
```

### 2. Launch Development Stack

```bash
# Build and start all services (first time setup)
docker compose -f infra/docker/docker-compose.yml --env-file .env up -d --build

# Wait for services to be healthy (~2-3 minutes)
docker compose -f infra/docker/docker-compose.yml --env-file .env ps

# View logs to monitor startup progress
docker compose -f infra/docker/docker-compose.yml --env-file .env logs -f
```

### 3. Verify Installation

Once all services show as healthy, access:

- **📊 Dashboard**: http://localhost:3001 (login: `admin` / `user`)
- **🔧 Paymaster API**: http://localhost:3000/health · gas price: http://localhost:3000/gas-price
- **🔨 Bundler**: http://localhost:4337/health

## 🧪 Testing

### Fast Unit Tests (No Infrastructure Required)

```bash
# Run all contract tests
npm run test:contracts

# Test profitability logic (fast unit tests)
npm run test:profitability:logic
```

### Integration Tests (Requires Docker Stack)

```bash
# Variable fee integration test
npm run test:project4:fee

# Run until USDC depleted (stress test)
npm run test:project4:fee:loop

# Security: Underpricing attack simulation
npm run test:project4:underpricing

# Security: All vulnerability tests
npm run test:all-vulnerabilities

# Profitability: Quick end-to-end (~5 minutes)
npm run test:profitability

# Profitability: Gas refill focused test
npm run test:profitability:refill

# Profitability: Long-run soak test (configurable hours)
npm run test:profitability:soak
```

### For Faster Refill Detection

Deploy the GasBurner contract (Anvil only):
```bash
# In .env, set:
CONTRACT_DEPLOYER_DEPLOY_GAS_BURNER=true
CONTRACT_DEPLOYER_GAS_BURNER_ADDRESS_FILE=/deploy-output/gas-burner-address
```

Then run refill tests with higher gas usage:
```bash
# Configure staging parameters in .env
TOOLS_REFILL_BURN_LOOPS_STAGE1=1000
TOOLS_REFILL_BURN_WRITES_STAGE1=500
```

## 🔧 Configuration

### Environment Variables

#### Core Infrastructure
```bash
# Blockchain RPC
PRODUCTION_RPC_URL=https://polygon-rpc.com/
ANVIL_FORK_URL=https://polygon-rpc.com/
ANVIL_FORK_BLOCK_NUMBER=83635022
ANVIL_CHAIN_ID=137

# Service URLs (Docker internal networking)
PAYMASTER_API_RPC_URL=http://anvil:8545
PAYMASTER_API_BUNDLER_URL=http://bundler-alto:4337
VALKEY_URL=redis://valkey:6379
VALKEY_KEY_PREFIX=project4
```

#### Pricing Configuration
```bash
# Service fee (500 = 5%)
PAYMASTER_API_SERVICE_FEE_BPS=500

# Minimum post-operation fee (enforced even if gas calculation = 0)
PAYMASTER_API_MIN_POSTOP_FEE_USDC_E6=10000

# Quote validity period
PAYMASTER_API_VALIDITY_SECONDS=300

# Cost buffer (100 = 1% safety margin)
PAYMASTER_API_QUOTE_BUFFER_BPS=100
```

#### Contract Addresses
```bash
# Polygon Mainnet
PAYMASTER_CONTRACT_USDC_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS=0x0000000071727De22E5E9d8BAf0edAc6f37da032

# Optional: legacy on-chain treasury() override; deploy sets treasury to paymaster contract after deploy.
# PAYMASTER_CONTRACT_TREASURY_ADDRESS=0x...
```

#### Security Settings
```bash
# Gas limits per UserOp
PAYMASTER_CONTRACT_MAX_GAS_PER_USER_OP=50000000

# Rate limiting (1 hour window)
RATE_LIMIT_PERIOD_SECONDS=3600
RATE_LIMIT_MAX_GAS_PER_PERIOD=1000000000

# Circuit breaker (pause if too much gas processed)
CIRCUIT_BREAKER_GAS_THRESHOLD=10000000000
```

### Migration: USDC fee sink

Existing deployments: call `setTreasury(<paymasterContractAddress>)` as owner so postOp fees accrue on the paymaster contract. New deploys do this automatically in `contract-deployer`.

### Key Management

Use the included **Key Rotator** tool to generate secure production keys:

```bash
cd tools/key-rotator
npm install
node rotate-env-prod-keys.js --env ../../.env.prod --rpc https://polygon-rpc.com
```

This generates EOA-validated keys for:
- Contract deployment
- Paymaster operations
- Bundler utilities

## 📚 API Reference

### Paymaster API Endpoints

#### HTTP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/paymaster-address` | Get deployed paymaster address |
| `GET` | `/gas-burner-address` | Get GasBurner contract address (if deployed) |

#### JSON-RPC Methods

##### `pm_sponsorUserOperation`
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

**Optional Referral Context (params[2]):**
```json
{
  "referralAddress": "0x...",
  "referralBps": 200
}
```

**Response:**
```json
{
  "paymaster": "0x...",
  "paymasterVerificationGasLimit": "0x...",
  "paymasterPostOpGasLimit": "0x...",
  "paymasterData": "0x...",
  "validUntil": 1234567890,
  "estimatedBaseCostUsdcE6": "100000",
  "estimatedReferralUsdcE6": "2000",
  "estimatedTotalCostUsdcE6": "102000",
  "estimatedNormalGasUnits": "800000",
  "estimatedDeployGasUnits": "3000000",
  "minUsdcReserveNormalE6": "40000000",
  "minUsdcReserveDeployE6": "150000000",
  "estimatedGas": "800000"
}
```

`estimatedBaseCostUsdcE6` / `estimatedTotalCostUsdcE6` / `estimatedGas` use **profile-specific** max gas units (**`PAYMASTER_API_NORMAL_MAX_GAS_UNITS`** vs **`PAYMASTER_API_DEPLOY_MAX_GAS_UNITS`**) with **`maxFeePerGas`** (from the partial UserOp packed `gasFees` / `maxFeePerGas` when present, else RPC gas price) and signed **`usdcPerWeiE6`**: **`gasCap × maxFeePerGas × usdcPerWeiE6 / 1e18`**. The signed paymaster payload always includes **both** `estimatedNormalGasUnits` and `estimatedDeployGasUnits`; the **contract** applies the reserve check using **`initCode`**: no factory data → normal cap, with `initCode` → deploy cap. **`postOp`** charges **`actualGasCost × usdcPerWeiE6 / 1e18`** (plus min fee floor and referral). `minUsdcReserveNormalE6` / `minUsdcReserveDeployE6` match the on-chain reserve formula.

##### `pm_getPaymasterStubData`
Returns minimal paymaster data for gas estimation without full bundler simulation.

##### `getUserOperationGasPrice`
Returns gas price recommendations compatible with Pimlico and Alchemy.

### Bundler Proxy (CORS-Friendly)

The Paymaster API exposes the Alto bundler behind `/bundler/rpc` to avoid CORS issues for browser-based consumers.

**Example - Send UserOperation:**
```bash
curl -X POST http://localhost:3000/bundler/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_sendUserOperation",
    "params": [userOp, "0x0000000071727De22E5e9d8BAf0edAc6f37da032"],
    "id": 1
  }'
```

**Migration Note:** Replace `http://<host>:4337` with `https://<paymaster-domain>/bundler/rpc` in production.

## 🚀 Production Deployment

### 1. Environment Setup

```bash
# Create production environment file
cp .env.example .env.prod

# Generate secure keys
node tools/key-rotator/rotate-env-prod-keys.js --env .env.prod --rpc https://polygon-rpc.com

# Configure production settings
# - Set PRODUCTION_RPC_URL to your Polygon RPC provider
# - Configure domain names and TLS certificates
# - Set up monitoring and alerting
```

### 2. Deploy with Docker Compose

```bash
# Production deployment
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod up -d --build

# Verify deployment
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod ps
```

### 3. Initial Funding

**Paymaster contract & refill**: USDC from users settles on the paymaster contract (`treasury == paymaster`). Fund **EntryPoint deposit** (native) for the paymaster address, **USDC on the paymaster** for swaps, and bundler utility/executor EOAs. Refill uses **`PAYMASTER_REFILL_OWNER_PRIVATE_KEY`** (must equal on-chain owner). Minimum native per monitored party is stored in Valkey **`PAYMASTER_API_REFILL_MIN_NATIVE_WEI`** (dashboard Control plane) or defaults to **10 ETH** wei.

### 4. Health Checks

```bash
# Check all services
curl https://your-domain.com/health
curl https://your-domain.com/paymaster-address

# Verify bundler proxy
curl -X POST https://your-domain.com/bundler/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_supportedEntryPoints","params":[],"id":1}'
```

## 🔒 Security Features

### Fraud Protection Mechanisms

- **🔥 Gas Griefing Mitigation**: Circuit breakers pause operations if gas usage exceeds thresholds
- **⚡ Rate Limiting**: Per-user gas limits prevent estimation attacks
- **💰 Minimum Fee Enforcement**: Guarantees revenue even with optimized gas usage
- **🔍 Variance Monitoring**: Detects unusual gas estimation patterns
- **🛡️ Attack Simulation**: Built-in tests for common vulnerabilities

### Key Security Settings

```bash
# Rate limiting (1 hour windows)
RATE_LIMIT_PERIOD_SECONDS=3600
RATE_LIMIT_MAX_GAS_PER_PERIOD=1000000000

# Circuit breaker (10B gas triggers pause)
CIRCUIT_BREAKER_GAS_THRESHOLD=10000000000

# Gas limits per UserOp
PAYMASTER_CONTRACT_MAX_GAS_PER_USER_OP=50000000
```

## 📊 Monitoring & Dashboard

The dashboard provides real-time insights into:

- **📈 UserOperation Activity**: Live transaction monitoring with gas usage analytics
- **💵 Revenue Tracking**: Fee collection and profitability metrics
- **⚡ Performance Metrics**: Response times, success rates, and error tracking
- **⛽ Gas & treasury**: EntryPoint deposit, bundler balances, treasury USDC/native (paymaster-api handles refills)
- **📊 Pricing Data**: Historical cost data and pricing trends

### Dashboard Features

- **Real-time Updates**: WebSocket-powered live data
- **UserOp Explorer**: Detailed transaction inspection with decoded logs
- **Revenue Analytics**: Daily/weekly/monthly earnings visualization
- **System Health**: Service status and error monitoring
- **Configuration Management**: Runtime configuration viewing

## 🔧 Development

### Project Structure

```
NoKYC-GasStation/
├── contracts/              # Solidity smart contracts
│   ├── contracts/          # Main contracts (Paymaster, GasBurner)
│   ├── test/               # Contract unit tests
│   └── scripts/            # Deployment scripts
├── services/
│   ├── paymaster-api/      # JSON-RPC API server
│   ├── shared/             # Common utilities & pricing logic
│   ├── dashboard/          # Next.js monitoring interface
│   ├── bundler-alto/       # Alto bundler configuration
│   ├── contract-deployer/  # Contract deployment service
│   └── anvil/              # Local blockchain setup
├── tools/
│   ├── key-rotator/        # Key generation utility
│   └── aa-test/            # Legacy test scripts (forwarded)
├── integrated-tests/       # Cross-service integration tests
├── infra/
│   └── docker/             # Docker configurations
└── docs/                   # Additional documentation
```

### Building Services

```bash
# Build all services
npm run build

# Build specific services
npm run build:contracts
npm run build:paymaster-api
npm run build:dashboard
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

## 🔍 Troubleshooting

### Common Issues

| Issue | Symptom | Solution |
|-------|---------|----------|
| `unsupported version v1` | Bundler configuration error | Ensure Alto config includes `api-version: v1,v2` |
| `pm_getPaymasterStubData` errors | Connectivity or configuration issue | Check `BUNDLER_URL` and `REDIS_KEY_PREFIX` consistency |
| `entry point ... does not exist` | Contract deployment incomplete | Wait for contract-deployer to complete successfully |
| Dashboard shows no UserOps | Block range too small | Increase `ALTO_BLOCK_RANGE_LIMIT` setting |
| Paymaster USDC / EntryPoint low | Refill or ops fail | Fund paymaster USDC and EntryPoint deposit; ensure Alto keys + owner refill key env; adjust min wei in Control plane if needed |
| High gas quotes | Abnormal pricing data | Check Uniswap router configuration and network congestion |

### Service Health Checks

```bash
# Individual service health
curl http://localhost:3000/health    # Paymaster API
curl http://localhost:4337/health    # Bundler
curl http://localhost:3001/api/health # Dashboard

# Docker service status
docker compose -f infra/docker/docker-compose.yml --env-file .env ps
```

### Logs and Debugging

```bash
# View recent logs
docker compose -f infra/docker/docker-compose.yml --env-file .env logs --tail=100 paymaster-api

# Follow logs in real-time
docker compose -f infra/docker/docker-compose.yml --env-file .env logs -f paymaster-api

# View all service logs
docker compose -f infra/docker/docker-compose.yml --env-file .env logs
```

## 🤝 Contributing

We welcome contributions! Please follow these guidelines:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/your-feature-name`
3. **Test** thoroughly - ensure all existing tests pass
4. **Add tests** for new functionality
5. **Document** changes in code and README if needed
6. **Submit** a pull request with a clear description

### Development Setup

```bash
# Install dependencies
npm install

# Run tests before committing
npm run test:all-vulnerabilities
npm run test:profitability

# Build all services
npm run build
```

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **ERC-4337** Account Abstraction specification
- **Alto** - High-performance ERC-4337 bundler
- **Viem** - TypeScript Ethereum library
- **Foundry** - Ethereum development toolchain
- **Next.js** - React framework for the dashboard

---

**Built with ❤️ for the Account Abstraction ecosystem**

For dApp integration, see the [PrivateMail Sponsor SDK](https://github.com/mateus1702/PrivateEmail) for seamless paymaster sponsorship.