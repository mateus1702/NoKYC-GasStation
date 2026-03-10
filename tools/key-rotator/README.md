# Key Rotator

Rotates sensitive keys in `.env.prod` and validates each generated address is a plain EOA on your target RPC (`eth_getCode == 0x`).

## What It Updates

- `CONTRACT_DEPLOYER_PRIVATE_KEY`
- `PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY`
- `PAYMASTER_CONTRACT_SIGNER_ADDRESS`
- `ALTO_UTILITY_PRIVATE_KEY`
- `ALTO_EXECUTOR_PRIVATE_KEYS`
- `DASHBOARD_ALTO_UTILITY_KEY`
- `DASHBOARD_ALTO_EXECUTOR_KEYS`
- `WORKER_BOOTSTRAP_PRIVATE_KEY`
- `WORKER_REVENUE_PRIVATE_KEY`
- `WORKER_REVENUE_ADDRESS`
- `WORKER_TREASURY_PRIVATE_KEY`
- `PAYMASTER_CONTRACT_TREASURY_ADDRESS`
- `DASHBOARD_TREASURY_ADDRESS`

It also updates key-related inline comments in `.env.prod`, creates a backup, then writes the updated file.

## Install

```bash
cd tools/key-rotator
npm install
```

## Usage

From the project root:

```bash
node tools/key-rotator/rotate-env-prod-keys.js --env .env.prod --rpc https://polygon-rpc.com
```

Or from the tool directory:

```bash
cd tools/key-rotator
npm run rotate -- --env ../../.env.prod --rpc https://polygon-rpc.com
```

## Options

- `--env <path>`: path to env file (default: `.env.prod` from current directory)
- `--rpc <url>`: RPC URL to validate generated addresses
- `--max-attempts <n>`: max retries per generated wallet (default: `25`)

If `--rpc` is not provided, it uses `PRODUCTION_RPC_URL` from the env file.

## Safety

- Creates backup file: `.env.prod.bak.<timestamp>`
- Never logs private keys except where comments in `.env.prod` intentionally contain them
- Fails fast on RPC errors

