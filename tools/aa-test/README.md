# AA Sponsor Tests

Submit sponsored UserOps against the local AA stack (Project4 totals-based USDC paymaster).

## Prereqs

1. Start the AA stack:
   ```bash
   cd c:\repos\project4
   docker compose -f infra/docker/docker-compose.yml --env-file .env up -d
   ```

2. Wait for services: anvil, contract-deployer, bundler-alto, paymaster-api, valkey, worker. Worker refills EntryPoint + native reserve via single swap (min/cap thresholds).

## Run

```bash
cd tools/aa-test
npm install
npm run test                      # Same as test:project4:fee
npm run test:project4:fee         # SimpleAccount with variable USDC fee (Project4)
npm run test:project4:fee:loop    # Keep sending UserOps until USDC is near empty
npm run test:project4:underpricing # Regression: paymaster must not underprice adversarial gas params

# Vulnerability Confirmation Tests
npm run test:vuln:gas-griefing     # Gas griefing attack simulation
npm run test:vuln:gas-estimation   # Gas estimation attack vectors
npm run test:all-vulnerabilities   # Run all vulnerability confirmations

# Business Model Tests
npm run test:profitability          # End-to-end profitability validation
npm run test:contract-tests        # Contract-level security tests
```

## Env (optional)

| Var | Default |
|-----|---------|
| RPC_URL | http://127.0.0.1:8545 |
| BUNDLER_URL | http://127.0.0.1:4337 |
| PAYMASTER_URL | http://127.0.0.1:3000 |
| PRIVATE_KEY | Anvil account #0 |
