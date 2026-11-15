import fs from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";

// Load .env locally (GitHub Actions injects these variables from secrets)
dotenv.config();

// Which contract to deploy. Defaults to the contract in contracts/HelloWorld.sol.
// Override with CONTRACT_NAME=<name> if you add another contract.
const CONTRACT_NAME = process.env.CONTRACT_NAME || "helloworld";
// Constructor arguments as a JSON array, e.g. CONSTRUCTOR_ARGS='["0xabc...", 100]'
const CONSTRUCTOR_ARGS = JSON.parse(process.env.CONSTRUCTOR_ARGS || "[]");

function required(name, value) {
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name}. Add it as a secret in the GitHub "Testnet" environment (or in .env locally).`);
  }
  return value.trim();
}

async function main() {
  // 1. Read the solc standard-JSON output produced by the Docker compile step
  const outputPath = "./build/output.json";
  if (!fs.existsSync(outputPath)) {
    throw new Error("build/output.json not found. Run 'npm run compile' first.");
  }
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    throw new Error("Compilation errors:\n" + errors.map((e) => e.formattedMessage).join("\n"));
  }

  // 2. Find the contract's ABI and bytecode
  const sourceFile = Object.keys(output.contracts || {}).find(
    (file) => output.contracts[file][CONTRACT_NAME]
  );
  if (!sourceFile) {
    const available = Object.values(output.contracts || {}).flatMap((c) => Object.keys(c));
    throw new Error(`Contract "${CONTRACT_NAME}" not found in build output. Available: ${available.join(", ")}`);
  }
  const { abi, evm } = output.contracts[sourceFile][CONTRACT_NAME];
  const bytecode = evm.bytecode.object;

  // 3. Connect to Sepolia
  const rpcUrl = required("SEPOLIA_RPC_URL", process.env.SEPOLIA_RPC_URL);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // 4. Clean up the private key (accepts either secret name)
  let rawKey = required(
    "SEPOLIA_PRIVATE_KEY",
    process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY
  )
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, "");
  if (!rawKey.startsWith("0x")) rawKey = "0x" + rawKey;
  if (rawKey.length !== 66) {
    throw new Error(`Invalid private key length: ${rawKey.length}. Expected 66 characters (0x + 64 hex chars).`);
  }

  const wallet = new ethers.Wallet(rawKey, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(`RPC is not Sepolia (chainId ${network.chainId}). Check SEPOLIA_RPC_URL.`);
  }
  const balance = await provider.getBalance(wallet.address);
  console.log("Deploying contracts with the account:", wallet.address);
  console.log("Account balance:", ethers.formatEther(balance), "SepoliaETH");
  if (balance === 0n) {
    throw new Error("Deployer has 0 SepoliaETH. Fund it from https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
  }

  // 5. Deploy
  console.log(`Deploying ${CONTRACT_NAME}...`);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...CONSTRUCTOR_ARGS);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log(`${CONTRACT_NAME} successfully deployed to: ${contractAddress}`);
  console.log(`Deploy tx: https://sepolia.etherscan.io/tx/${contract.deploymentTransaction().hash}`);
  console.log(`View on Sepolia Etherscan: https://sepolia.etherscan.io/address/${contractAddress}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
