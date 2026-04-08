import "../../src/load-env.js";
/**
 * Legacy test (bundler-estimate-based underpricing guard). Obsolete after counter + cap-based sponsor pricing.
 * Kept so npm scripts keep stable entrypoints; exits 0.
 *
 * Run: npm run test:project4:underpricing (from integrated-tests)
 */
async function main() {
  console.log(
    "[test-project4-underpricing] SKIPPED: sponsor path uses on-chain caps + counters, not bundler eth_estimateUserOperationGas for quotes."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
