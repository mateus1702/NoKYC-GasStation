import { config } from "dotenv";
import { resolve } from "path";
import hre from "hardhat";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { readFileSync } from "fs";

config({ path: resolve(process.cwd(), "..", ".env") });

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

async function main() {
  const networkConfig = hre.config.networks[hre.network.name] as { url?: string };
  const rpcUrl = networkConfig?.url ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const ethersProvider = new JsonRpcProvider(rpcUrl);
  const deployer =
    process.env.CONTRACT_DEPLOYER_PRIVATE_KEY
      ? new Wallet(process.env.CONTRACT_DEPLOYER_PRIVATE_KEY, ethersProvider)
      : Wallet.fromPhrase(DEFAULT_MNEMONIC, ethersProvider);
  const network = (hre as { network?: { name?: string } }).network?.name ?? "localhost";
  const chainId = (await ethersProvider.getNetwork()).chainId;

  // Polygon mainnet or localhost fork (chainId 137): use Polygon USDC
  const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const usdcAddress =
    chainId === 137n
      ? POLYGON_USDC
      : chainId === 80002n
        ? "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582"
        : process.env.USDC_ADDRESS;

  if (!usdcAddress) throw new Error("USDC_ADDRESS required (set for localhost fork or non-Polygon networks)");
  const usdc = usdcAddress;
  const verifier = process.env.PAYMASTER_VERIFIER ?? deployer.address;
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;

  console.log(`[deploy] network=${network} chainId=${chainId}`);
  console.log(`[deploy] usdc=${usdc}`);
  console.log(`[deploy] deployer=${deployer.address} verifier=${verifier} treasury=${treasury}`);

  const artifactPath = resolve(
    process.cwd(),
    "artifacts",
    "contracts",
    "Project4Paymaster.sol",
    "Project4Paymaster.json"
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const Paymaster = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const paymaster = await Paymaster.deploy(ENTRYPOINT_V07, usdc, verifier, treasury);

  await paymaster.waitForDeployment();
  const address = await paymaster.getAddress();

  console.log(`[deploy] paymaster address=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
