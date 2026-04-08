/**
 * Deploy GasBurner and write address to file.
 * Anvil-only (non-production). Requires CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH.
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
import { mnemonicToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

export async function deployGasBurner(): Promise<Address> {
	const rpc = process.env.ANVIL_RPC?.trim();
	if (!rpc) throw new Error("ANVIL_RPC required (set in .env)");
	const artifactsPath = process.env.CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH!;
	const outputFile = process.env.CONTRACT_DEPLOYER_GAS_BURNER_ADDRESS_FILE;

	if (!artifactsPath) {
		console.log("[GasBurner] CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH not set, skipping");
		throw new Error("CONTRACT_DEPLOYER_CONTRACTS_ARTIFACTS_PATH required for GasBurner");
	}

	const tempClient = createPublicClient({
		chain: defineChain({
			id: 1,
			name: "x",
			nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [rpc] } },
		}),
		transport: http(rpc),
	});

	// Check if already deployed (verify on chain)
	if (outputFile && existsSync(outputFile)) {
		try {
			const existingAddress = readFileSync(outputFile, "utf8").trim() as Address;
			if (existingAddress && existingAddress.length > 0) {
				const bytecode = await tempClient.getCode({ address: existingAddress });
				if (bytecode && bytecode !== "0x" && bytecode.length > 2) {
					console.log(
						`[GasBurner] Already deployed at ${existingAddress}, verified on chain, skipping deployment`
					);
					return existingAddress;
				}
				console.log(
					`[GasBurner] Address file points to ${existingAddress} but no contract on chain, redeploying`
				);
			}
		} catch (error) {
			console.log(`[GasBurner] Error reading/verifying existing address file: ${error}`);
		}
	}

	const artifactFile = resolve(artifactsPath, "contracts", "GasBurner.sol", "GasBurner.json");

	if (!existsSync(artifactFile)) {
		console.log("[GasBurner] Artifact not found, skipping deployment");
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

	const deployer = mnemonicToAccount("test test test test test test test test test test test junk", {
		addressIndex: 0,
	});

	const anvilClient = createTestClient({
		transport: http(rpc),
		mode: "anvil",
		chain,
	});
	await anvilClient.setBalance({ address: deployer.address, value: parseEther("1000") });

	const publicClient = createPublicClient({
		chain,
		transport: http(rpc),
	});

	const walletClient = createWalletClient({
		account: deployer,
		chain,
		transport: http(rpc),
	}).extend(walletActions);

	const hash = await walletClient.deployContract({
		abi: artifact.abi,
		bytecode: artifact.bytecode as `0x${string}`,
		args: [],
		gas: 10_000_000n,
	});

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (!receipt.contractAddress) throw new Error("No contract address in receipt");

	const address = receipt.contractAddress as Address;
	console.log(`[GasBurner] Deployed at ${address}`);

	if (outputFile) {
		writeFileSync(outputFile, address, "utf8");
		console.log(`[GasBurner] Wrote address to ${outputFile}`);
	}

	return address;
}
