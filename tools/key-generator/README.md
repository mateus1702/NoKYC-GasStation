# Key Generator Tool

Generate Ethereum-compatible private and public key pairs for use in production environments.

### Installation

```bash
cd tools/key-generator
npm install
```

### Usage

#### Basic Key Generator (No dependencies)
```bash
# Generate 1 key pair
node key-generator.js

# Generate 5 key pairs
node key-generator.js 5

# Generate keys in .env format only
node key-generator.js 3 --env
```

#### Advanced Key Generator (Requires ethers.js)
```bash
# Install dependencies first
npm install

# Generate 1 key pair with proper Ethereum address derivation
node key-generator-advanced.js

# Generate 3 key pairs
node key-generator-advanced.js 3

# Generate keys in .env format only (no mnemonics)
node key-generator-advanced.js 2 --env --no-mnemonic
```

#### NPM Scripts
```bash
# Use the advanced generator (recommended)
npm run keys 3

# Use the basic generator
npm run keys:basic 2
```

### Output Example

```
🔑 Project4 Advanced Key Generator (ethers.js)
Generating 1 Ethereum key pair(s)...
⚠️  WARNING: Store these keys securely! Never commit them to version control.
🔐 Keys are generated using cryptographically secure random number generation.

For production use, copy these values to your .env.prod file.

Required keys for Project4 services:
• CONTRACT_DEPLOYER_PRIVATE_KEY    - For deploying contracts
• ALTO_UTILITY_PRIVATE_KEY         - For bundler utility operations
• ALTO_EXECUTOR_PRIVATE_KEYS       - For bundler execution (comma-separated)
• PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY - For paymaster signing
• DASHBOARD_ALTO_UTILITY_KEY       - For dashboard operations
• DASHBOARD_ALTO_EXECUTOR_KEYS     - For dashboard execution (comma-separated)
• WORKER_BOOTSTRAP_PRIVATE_KEY     - For worker bootstrap
• WORKER_REVENUE_PRIVATE_KEY       - For worker revenue collection
• WORKER_TREASURY_PRIVATE_KEY      - For worker treasury operations

💡 Tip: Use different keys for different services for better security.

=== Key Pair 1 ===
Address:     0x742d35Cc6634C0532925a3b8B8b5d1F9b2d1d8b1
Private Key: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
Public Key:  0x04abc123def456ghi789jkl012mno345pqr678stu901vwx234yzabc567def890
Mnemonic:    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about

Environment Variable Format:
PRIVATE_KEY_1=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
ADDRESS_1=0x742d35Cc6634C0532925a3b8B8b5d1F9b2d1d8b1
======================================================================
✅ Generated 1 key pair(s) successfully
🔐 Remember to backup these keys securely!
📝 For maximum security, use hardware wallets or secure key management services in production.
```

### Security Notes

⚠️ **Important Security Considerations:**

1. **Never commit private keys to version control**
2. **Store keys securely** - Use environment variables or secure key management services
3. **Use different keys** for different services when possible
4. **Backup mnemonics** securely if you need them for recovery
5. **Consider hardware wallets** or HSMs for production deployments

### Production Environment Integration

Copy the generated keys to your `.env.prod` file:

```bash
# Example .env.prod entries
CONTRACT_DEPLOYER_PRIVATE_KEY=0x1234567890abcdef...
ALTO_UTILITY_PRIVATE_KEY=0xabcdef1234567890...
PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY=0x7890123456abcdef...
# ... etc
```

### Troubleshooting

- **"ethers.js is required"**: Run `npm install` in the tools directory
- **Permission denied**: Make sure the scripts are executable: `chmod +x *.js`
- **Node version issues**: Requires Node.js >= 16.0.0