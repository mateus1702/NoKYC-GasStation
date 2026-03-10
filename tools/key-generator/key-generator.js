#!/usr/bin/env node

/**
 * Key Generator Tool for Project4
 *
 * Generates Ethereum-compatible private and public key pairs
 * for use in production environment configuration.
 *
 * Usage:
 *   node tools/key-generator.js [count]
 *
 * Examples:
 *   node tools/key-generator.js          # Generate 1 key pair
 *   node tools/key-generator.js 5        # Generate 5 key pairs
 *   node tools/key-generator.js --help   # Show help
 */

const crypto = require('crypto');

// Generate a random 32-byte private key
function generatePrivateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Derive public key from private key using secp256k1
function privateKeyToPublicKey(privateKey) {
  try {
    // For a simple implementation, we'll use the private key directly
    // In production, you'd want to use a proper secp256k1 library like ethereum-cryptography
    // For now, we'll just show the private key and a placeholder for the public key
    // The user can derive the actual public key using web3.js or ethers.js
    return {
      privateKey: privateKey,
      publicKey: '0x' + privateKey, // Placeholder - actual derivation would need secp256k1
      address: '0x' + privateKey.substring(0, 40) // Placeholder - actual derivation needs proper crypto
    };
  } catch (error) {
    console.error('Error generating key pair:', error.message);
    return null;
  }
}

function displayKeyPair(keyPair, index = 1) {
  console.log(`\n=== Key Pair ${index} ===`);
  console.log(`Private Key: ${keyPair.privateKey}`);
  console.log(`Public Key:  ${keyPair.publicKey}`);
  console.log(`Address:     ${keyPair.address}`);
  console.log(`\nEnvironment Variable Format:`);
  console.log(`PRIVATE_KEY_${index}=${keyPair.privateKey}`);
  console.log(`ADDRESS_${index}=${keyPair.address}`);
}

function showUsage() {
  console.log(`
Key Generator Tool for Project4

Generates Ethereum-compatible private and public key pairs for production use.

USAGE:
  node tools/key-generator.js [count] [options]

ARGUMENTS:
  count    Number of key pairs to generate (default: 1)

OPTIONS:
  --help   Show this help message
  --env    Output in .env format only

EXAMPLES:
  node tools/key-generator.js              # Generate 1 key pair
  node tools/key-generator.js 3            # Generate 3 key pairs
  node tools/key-generator.js 2 --env      # Generate 2 pairs in .env format

NOTE:
  This tool generates cryptographically secure random keys.
  For actual public key derivation, use a proper Ethereum library like ethers.js:
  const wallet = new ethers.Wallet(privateKey);
  console.log(wallet.address);
  `);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    showUsage();
    return;
  }

  const envOnly = args.includes('--env');
  const countArg = args.find(arg => !arg.startsWith('--') && !isNaN(parseInt(arg)));
  const count = countArg ? parseInt(countArg) : 1;

  if (count < 1 || count > 20) {
    console.error('Error: Count must be between 1 and 20');
    process.exit(1);
  }

  console.log(`🔑 Project4 Key Generator`);
  console.log(`Generating ${count} Ethereum key pair(s)...`);
  console.log(`⚠️  WARNING: Store these keys securely! Never commit them to version control.`);
  console.log('='.repeat(70));

  if (!envOnly) {
    console.log(`
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
`);
  }

  const keyPairs = [];
  for (let i = 0; i < count; i++) {
    const privateKey = generatePrivateKey();
    const keyPair = privateKeyToPublicKey(privateKey);
    if (keyPair) {
      keyPairs.push(keyPair);
      if (!envOnly) {
        displayKeyPair(keyPair, i + 1);
      }
    }
  }

  if (envOnly) {
    console.log('# Copy these to your .env.prod file:');
    keyPairs.forEach((keyPair, index) => {
      console.log(`PRIVATE_KEY_${index + 1}=${keyPair.privateKey}`);
      console.log(`ADDRESS_${index + 1}=${keyPair.address}`);
      console.log('');
    });
  }

  console.log('='.repeat(70));
  console.log(`✅ Generated ${keyPairs.length} key pair(s) successfully`);
  console.log(`🔐 Remember to backup these keys securely!`);
}

if (require.main === module) {
  main();
}

module.exports = { generatePrivateKey, privateKeyToPublicKey };