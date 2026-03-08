import { config } from "dotenv";
import { resolve } from "path";
import hre from "hardhat";
import { readFileSync } from "fs";
import { ethers, JsonRpcProvider, Wallet, ContractFactory } from "ethers";

config({ path: resolve(process.cwd(), "..", ".env") });

const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  const networkConfig = hre.config.networks[hre.network.name] as { url?: string };
  const rpcUrl = networkConfig?.url ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const ethersProvider = new JsonRpcProvider(rpcUrl);
  const deployer = Wallet.fromPhrase(DEFAULT_MNEMONIC, ethersProvider);

  // Read paymaster address
  const addressFile = resolve(process.cwd(), "..", "deploy-output", "paymaster-address");
  const paymasterAddress = readFileSync(addressFile, "utf8").trim();

  console.log(`Funding paymaster ${paymasterAddress} with 1 ETH...`);

  // Get paymaster contract
  const artifactPath = resolve(
    process.cwd(),
    "artifacts",
    "contracts",
    "Project4Paymaster.sol",
    "Project4Paymaster.json"
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const Paymaster = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const paymaster = Paymaster.attach(paymasterAddress);

  // Deposit 1 ETH to EntryPoint via paymaster
  const tx = await paymaster.deposit({ value: ethers.parseEther("1") });
  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();

  console.log("Paymaster funded successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});