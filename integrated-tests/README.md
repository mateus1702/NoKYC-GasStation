# Integrated Tests

Cross-service integration and soak tests for the NoKYC-GasStation AA stack.

## Prerequisites

1. Start the AA stack:
   ```bash
   docker compose -f infra/docker/docker-compose.yml --env-file .env up -d
   ```
2. Wait for services: anvil, contract-deployer, bundler-alto, paymaster-api, valkey, config-bootstrap, dashboard.

## Run

```bash
cd integrated-tests
npm install

# Project4 variable fee
npm run test:project4:fee
npm run test:project4:fee:loop   # Until USDC depleted

# Referral (optional params[2] referral context)
npm run test:project4:referral

# Security
npm run test:project4:underpricing
npm run test:vuln:gas-griefing
npm run test:vuln:gas-estimation
npm run test:all-vulnerabilities

# Profitability
npm run test:profitability           # Quick e2e (minutes)
npm run test:profitability:refill    # Increasing gas profile + refill assertion
npm run test:profitability:soak      # Long-run soak (hours, configurable)
```

## Env (optional)

| Var | Default |
|-----|---------|
| TOOLS_RPC_URL | http://127.0.0.1:8545 |
| TOOLS_PAYMASTER_URL | http://127.0.0.1:3000 |
| TOOLS_BUNDLER_URL | http://127.0.0.1:4337 (Alto on host; not paymaster `/bundler/rpc` proxy) |
| TOOLS_PRIVATE_KEY | Anvil account #0 |
| TOOLS_PAYMASTER_ADDRESS | Fetched from API if unset |
| TOOLS_MIN_EXPECTED_USDC_E6 | Override for underpricing test; else PAYMASTER_API_MIN_POSTOP_FEE_USDC_E6 |
| TOOLS_USDC_WHALE | Whale address for funding |
| TOOLS_USDC_WHALE_CANDIDATES | Comma-separated whale addresses |
| TOOLS_USDC_FUND_AMOUNT | 1000 (USDC, 6 decimals) |
| TOOLS_SOAK_DURATION_MINUTES | 60 (profitability soak) |
| TOOLS_SOAK_PROFIT_THRESHOLD_USDC_E6 | 1000000 (1 USDC) |
