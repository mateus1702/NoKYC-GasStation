# Project4 Tools

This directory contains utility tools for Project4 development and deployment.

## Available Tools

### 🔄 [Key Rotator](./key-rotator/)
Rotate `.env.prod` private keys and validate each generated address is a plain EOA on your RPC before writing.

**Quick Start:**
```bash
cd tools/key-rotator
npm install
node rotate-env-prod-keys.js --env ../../.env.prod --rpc https://polygon-rpc.com
```

See [key-rotator/README.md](./key-rotator/README.md) for detailed usage instructions.

### 🧪 [AA Test](./aa-test/)
Account Abstraction testing utilities.

*(More tools coming soon)*