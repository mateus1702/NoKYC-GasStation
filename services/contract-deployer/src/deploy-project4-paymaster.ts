/**
 * Deploy Project4Paymaster and optionally write address to file.
 * Requires CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH env pointing to contracts/artifacts (or artifact JSON path).
 */
import {
	http,
	createPublicClient,
	createTestClient,
	createWalletClient,
	defineChain,
	parseEther,
	walletActions,
	type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;

export async function deployProject4Paymaster(): Promise<Address> {
	const rpc = process.env.ANVIL_RPC?.trim();
	if (!rpc) throw new Error("ANVIL_RPC required (set in .env)");
	const artifactsPath = process.env.CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH!;
	const outputFile = process.env.CONTRACT_DEPLOYER_PAYMASTER_ADDRESS_FILE;

	const tempClient = createPublicClient({
		chain: defineChain({ id: 1, name: "x", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }),
		transport: http(rpc),
	});

	// Check if paymaster was already deployed (verify on chain)
	if (outputFile && existsSync(outputFile)) {
		try {
			const existingAddress = readFileSync(outputFile, "utf8").trim() as Address;
			if (existingAddress && existingAddress.length > 0) {
				const bytecode = await tempClient.getCode({ address: existingAddress });
				if (bytecode && bytecode !== "0x" && bytecode.length > 2) {
					console.log(`[Project4Paymaster] Already deployed at ${existingAddress}, verified on chain, skipping deployment`);
					return existingAddress;
				}
				console.log(`[Project4Paymaster] Address file points to ${existingAddress} but no contract on chain, redeploying`);
			}
		} catch (error) {
			console.log(`[Project4Paymaster] Error reading/verifying existing address file: ${error}`);
		}
	}

	const artifactFile = resolve(
		artifactsPath,
		"contracts",
		"Project4Paymaster.sol",
		"Project4Paymaster.json"
	);

	if (!existsSync(artifactFile)) {
		console.log("[Project4Paymaster] Artifact not found, skipping deployment");
		throw new Error(`Artifact not found: ${artifactFile}`);
	}

	const artifact = JSON.parse(readFileSync(artifactFile, "utf8"));
	const chainId = await tempClient.getChainId();
	const chain = defineChain({
		id: Number(chainId),
		name: "chain",
		nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [rpc] } },
	});

	const isProduction = process.env.CONTRACT_DEPLOYER_PRODUCTION === "true";
	const deployer = isProduction
		? (() => {
				const pk = process.env.CONTRACT_DEPLOYER_PRIVATE_KEY?.trim();
				if (!pk) throw new Error("CONTRACT_DEPLOYER_PRIVATE_KEY required in production");
				return privateKeyToAccount(pk as `0x${string}`);
			})()
		: mnemonicToAccount("test test test test test test test test test test test junk", {
				addressIndex: 0,
			});

	const publicClient = createPublicClient({
		chain,
		transport: http(rpc),
	});

	if (!isProduction) {
		const anvilClient = createTestClient({
			transport: http(rpc),
			mode: "anvil",
			chain,
		});
		await anvilClient.setBalance({ address: deployer.address, value: parseEther("1000") });
	}
	// Production: deployer wallet must be pre-funded with MATIC/ETH

	const walletClient = createWalletClient({
		account: deployer,
		chain,
		transport: http(rpc),
	}).extend(walletActions);

	const usdc = (process.env.PAYMASTER_CONTRACT_USDC_ADDRESS || POLYGON_USDC) as Address;
	// Verifier must match PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY used by paymaster-api; prefer key over ADDRESS so .env cannot drift.
	const verifier = ((): Address => {
		const pk = process.env.PAYMASTER_CONTRACT_SIGNER_PRIVATE_KEY?.trim();
		if (pk) {
			return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address;
		}
		const envAddr = process.env.PAYMASTER_CONTRACT_SIGNER_ADDRESS?.trim();
		if (envAddr) return envAddr as Address;
		return deployer.address;
	})();
	// Constructor requires a non-zero treasury; we always set treasury to the paymaster address after deploy
	// so USDC fees accrue on the contract (see setTreasury below).
	const treasuryConstructor = deployer.address;

	const hash = await walletClient.deployContract({
		abi: artifact.abi,
		bytecode: artifact.bytecode as `0x${string}`,
		args: [ENTRYPOINT_V07, usdc, verifier, treasuryConstructor],
		gas: 5_000_000n,
	});

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (!receipt.contractAddress) throw new Error("No contract address in receipt");

	const address = receipt.contractAddress as Address;
	console.log(`[Project4Paymaster] Deployed at ${address}`);

	const hashTreasury = await walletClient.writeContract({
		address,
		abi: artifact.abi,
		functionName: "setTreasury",
		args: [address],
	});
	await publicClient.waitForTransactionReceipt({ hash: hashTreasury });
	console.log(`[Project4Paymaster] setTreasury(${address}) — fee USDC settles on paymaster contract`);

	// No auto-deposit of ETH to EntryPoint — operational refill / manual funding handles stake and deposit.

	if (outputFile) {
		writeFileSync(outputFile, address, "utf8");
		console.log(`[Project4Paymaster] Wrote address to ${outputFile}`);
	}

	return address;
}
