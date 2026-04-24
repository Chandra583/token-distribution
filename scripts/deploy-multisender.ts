import { ethers } from "hardhat";

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying MultiSender with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB");

  const MultiSender = await ethers.getContractFactory("MultiSender");
  console.log("Deploying...");
  const multisender = await MultiSender.deploy();
  await multisender.waitForDeployment();

  const address = await multisender.getAddress();
  console.log("─────────────────────────────────────────────");
  console.log("MultiSender deployed to:", address);
  console.log("─────────────────────────────────────────────");
  console.log("Next step: copy the address above and set it in your .env:");
  console.log(`  MULTISENDER_ADDRESS=${address}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
