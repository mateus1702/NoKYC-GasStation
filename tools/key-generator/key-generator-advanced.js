#!/usr/bin/env node

/**
 * Advanced Key Generator Tool for Project4
 *
 * Generates Ethereum-compatible private and public key pairs using ethers.js
 * for use in production environment configuration.
 *
 * Prerequisites: npm install ethers
 *
 * Usage:
 *   node tools/key-generator-advanced.js [count]
 *
 * Examples:
 *   node tools/key-generator-advanced.js          # Generate 1 key pair
 *   node tools/key-generator-advanced.js 5        # Generate 5 key pairs
 *   node tools/key-generator-advanced.js --help   # Show help
 */

// Check if ethers is available
let ethers;
try {
  ethers = require('ethers');
} catch (error) {
  console.error(`
❌ ethers.js is required but not installed.

To install ethers.js:
  npm install ethers

Or globally:
  npm install -g ethers

Then run this tool again.
  `);
  process.exit(1);
}

function generateKeyPair() {
  try {
    // Generate a random wallet
    const wallet = ethers.Wallet.createRandom();

    return {
      privateKey: wallet.privateKey,
      publicKey: wallet.publicKey,
      address: wallet.address,
      mnemonic: wallet.mnemonic.phrase
    };
  } catch (error) {
    console.error('Error generating key pair:', error.message);
    return null;
  }
}

function displayKeyPair(keyPair, index = 1) {
  console.log(`\n=== Key Pair ${index} ===`);
  console.log(`Address:     ${keyPair.address}`);
  console.log(`Private Key: ${keyPair.privateKey}`);
  console.log(`Public Key:  ${keyPair.publicKey}`);
  console.log(`Mnemonic:    ${keyPair.mnemonic}`);
  console.log(`\nEnvironment Variable Format:`);
  console.log(`PRIVATE_KEY_${index}=${keyPair.privateKey}`);
  console.log(`ADDRESS_${index}=${keyPair.address}`);
}

function showUsage() {
  console.log(`
Advanced Key Generator Tool for Project4

Generates Ethereum-compatible private and public key pairs using ethers.js.

USAGE:
  node tools/key-generator-advanced.js [count] [options]

ARGUMENTS:
  count    Number of key pairs to generate (default: 1)

OPTIONS:
  --help   Show this help message
  --env    Output in .env format only
  --no-mnemonic  Don't show mnemonic phrases

EXAMPLES:
  node tools/key-generator-advanced.js              # Generate 1 key pair
  node tools/key-generator-advanced.js 3            # Generate 3 key pairs
  node tools/key-generator-advanced.js 2 --env      # Generate 2 pairs in .env format

NOTE:
  This tool uses ethers.js for cryptographically secure key generation
  and proper Ethereum address derivation.
  `);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    showUsage();
    return;
  }

  const envOnly = args.includes('--env');
  const noMnemonic = args.includes('--no-mnemonic');
  const countArg = args.find(arg => !arg.startsWith('--') && !isNaN(parseInt(arg)));
  const count = countArg ? parseInt(countArg) : 1;

  if (count < 1 || count > 20) {
    console.error('Error: Count must be between 1 and 20');
    process.exit(1);
  }

  console.log(`🔑 Project4 Advanced Key Generator (ethers.js)`);
  console.log(`Generating ${count} Ethereum key pair(s)...`);
  console.log(`⚠️  WARNING: Store these keys securely! Never commit them to version control.`);
  console.log(`🔐 Keys are generated using cryptographically secure random number generation.`);
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

💡 Tip: Use different keys for different services for better security.
`);
  }

  const keyPairs = [];
  for (let i = 0; i < count; i++) {
    const keyPair = generateKeyPair();
    if (keyPair) {
      keyPairs.push(keyPair);
      if (!envOnly) {
        displayKeyPair(keyPair, i + 1);
        if (noMnemonic) {
          // Remove mnemonic from display if requested
          delete keyPair.mnemonic;
        }
      }
    }
  }

  if (envOnly) {
    console.log('# Copy these to your .env.prod file:');
    keyPairs.forEach((keyPair, index) => {
      console.log(`PRIVATE_KEY_${index + 1}=${keyPair.privateKey}`);
      console.log(`ADDRESS_${index + 1}=${keyPair.address}`);
      if (keyPair.mnemonic && !noMnemonic) {
        console.log(`MNEMONIC_${index + 1}=${keyPair.mnemonic}`);
      }
      console.log('');
    });
  }

  console.log('='.repeat(70));
  console.log(`✅ Generated ${keyPairs.length} key pair(s) successfully`);
  console.log(`🔐 Remember to backup these keys securely!`);
  console.log(`📝 For maximum security, use hardware wallets or secure key management services in production.`);
}

if (require.main === module) {
  main();
}

module.exports = { generateKeyPair };