import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

const OUTPUT_DIR = path.resolve(__dirname, "../output");
const WALLETS_CSV = path.join(OUTPUT_DIR, "wallets.csv");
const MNEMONIC_FILE = path.join(OUTPUT_DIR, "MASTER_MNEMONIC.txt");

const TOTAL_WALLETS = 100_000;
const LOG_INTERVAL = 10_000;
const BIP44_BASE_PATH = "m/44'/60'/0'/0";

interface WalletEntry {
  index: number;
  address: string;
  privateKey: string;
  derivationPath: string;
}

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

async function generateWallets(): Promise<void> {
  ensureOutputDir();

  console.log("Generating random mnemonic...");
  const randomWallet = ethers.Wallet.createRandom();
  const mnemonic = randomWallet.mnemonic?.phrase;
  if (!mnemonic) {
    throw new Error("Failed to generate mnemonic");
  }

  // Save mnemonic immediately — this is the master backup
  fs.writeFileSync(MNEMONIC_FILE, mnemonic, "utf8");
  console.log(`Master mnemonic saved to: ${MNEMONIC_FILE}`);
  console.log("KEEP THIS FILE SECURE — it controls all 100,000 wallets.\n");

  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic);

  const startTime = Date.now();
  const csvLines: string[] = ["index,address,privateKey,derivationPath"];

  for (let i = 0; i < TOTAL_WALLETS; i++) {
    const derivationPath = `${BIP44_BASE_PATH}/${i}`;
    const child = hdNode.derivePath(`44'/60'/0'/0/${i}`);

    const entry: WalletEntry = {
      index: i,
      address: child.address,
      privateKey: child.privateKey,
      derivationPath: derivationPath,
    };

    csvLines.push(
      `${entry.index},${entry.address},${entry.privateKey},${entry.derivationPath}`
    );

    if ((i + 1) % LOG_INTERVAL === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `Generated ${(i + 1).toLocaleString()}/${TOTAL_WALLETS.toLocaleString()} wallets... (${elapsed}s)`
      );
    }
  }

  console.log("\nWriting wallets.csv...");
  fs.writeFileSync(WALLETS_CSV, csvLines.join("\n"), "utf8");

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Done in ${totalTime}s`);
  console.log(`✓ Saved ${TOTAL_WALLETS.toLocaleString()} wallets to: ${WALLETS_CSV}`);
  console.log(`✓ Master mnemonic at: ${MNEMONIC_FILE}`);
  console.log("\nNext step: run  npx ts-node scripts/prepare-distribution.ts");
}

generateWallets().catch((err: unknown) => {
  console.error("generate-wallets failed:", err);
  process.exit(1);
});
