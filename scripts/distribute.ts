import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ethers, JsonRpcProvider, Wallet, Contract, TransactionResponse, TransactionReceipt } from "ethers";

dotenv.config();

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(__dirname, "../output");
const PLAN_FILE = path.join(OUTPUT_DIR, "distribution-plan.json");
const LOG_FILE = path.join(OUTPUT_DIR, "distribution.log");
const CSV_LOG_FILE = path.join(OUTPUT_DIR, "distribution-log.csv");
const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/contracts");

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 300;
const PARALLEL_BATCHES = 5;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 10_000, 15_000];
const GAS_LIMIT = 14_000_000n;
const GAS_PRICE = ethers.parseUnits("10", "gwei");
const CONFIRMATIONS = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DistributionEntry {
  index: number;
  address: string;
  amount: number;
  amountWei: string;
  packedHex: string;
  sent: boolean;
  txHash: string | null;
  timestamp: string | null;
}

interface BatchResult {
  batchIndex: number;
  success: boolean;
  txHash?: string;
  gasUsed?: bigint;
  error?: string;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logStream.write(line + "\n");
}

function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  const line = `[${new Date().toISOString()}] ERROR: ${message}${detail ? " — " + detail : ""}`;
  console.error(line);
  logStream.write(line + "\n");
}

// ─── RPC Manager ──────────────────────────────────────────────────────────────

class RpcManager {
  private readonly primaryUrl: string;
  private readonly fallback1Url: string;
  private readonly fallback2Url: string;

  private _primary: JsonRpcProvider;
  private _fallback1: JsonRpcProvider;
  private _fallback2: JsonRpcProvider;

  private roundRobinIndex: number = 0;
  private readonly allProviders: JsonRpcProvider[];

  constructor() {
    this.primaryUrl = requireEnv("ALCHEMY_RPC_URL");
    this.fallback1Url = requireEnv("FALLBACK_RPC_1");
    this.fallback2Url = requireEnv("FALLBACK_RPC_2");

    this._primary = new JsonRpcProvider(this.primaryUrl);
    this._fallback1 = new JsonRpcProvider(this.fallback1Url);
    this._fallback2 = new JsonRpcProvider(this.fallback2Url);

    this.allProviders = [this._primary, this._fallback1, this._fallback2];
  }

  /** Always use Alchemy for nonce reads — most reliable. */
  getPrimary(): JsonRpcProvider {
    return this._primary;
  }

  /** Round-robin across all 3 providers for load distribution. */
  getNext(): JsonRpcProvider {
    const provider = this.allProviders[this.roundRobinIndex % 3];
    this.roundRobinIndex++;
    return provider;
  }

  /**
   * Broadcast a signed transaction. Tries primary first; on 429 / network
   * error rotates to fallback1 then fallback2. Logs which provider succeeded.
   */
  async broadcast(signedTx: string): Promise<TransactionResponse> {
    const providers: Array<{ name: string; provider: JsonRpcProvider }> = [
      { name: "Alchemy (primary)", provider: this._primary },
      { name: "Binance Fallback 1", provider: this._fallback1 },
      { name: "Binance Fallback 2", provider: this._fallback2 },
    ];

    let lastError: unknown;

    for (const { name, provider } of providers) {
      try {
        const tx = await provider.broadcastTransaction(signedTx);
        log(`  Broadcast via ${name}`);
        return tx;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isRateLimit =
          message.includes("429") ||
          message.includes("SERVER_ERROR") ||
          message.includes("TIMEOUT") ||
          message.includes("timeout") ||
          message.includes("rate limit");

        if (isRateLimit) {
          log(`  ${name} rate-limited or unreachable, trying next provider...`);
          lastError = err;
          continue;
        }

        // Non-rate-limit errors (e.g. nonce conflict, already known) — rethrow
        throw err;
      }
    }

    throw new Error(`All RPC providers exhausted. Last error: ${String(lastError)}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function loadPlan(): DistributionEntry[] {
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`distribution-plan.json not found at ${PLAN_FILE}. Run prepare-distribution.ts first.`);
  }
  const raw = fs.readFileSync(PLAN_FILE, "utf8");
  return JSON.parse(raw) as DistributionEntry[];
}

/** Atomic synchronous write — the resume checkpoint. */
function savePlan(plan: DistributionEntry[]): void {
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
}

/** Load MultiSender ABI from Hardhat artifacts. */
function loadMultiSenderAbi(): ethers.InterfaceAbi {
  const artifactPath = path.join(ARTIFACTS_DIR, "MultiSender.sol", "MultiSender.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `MultiSender artifact not found at ${artifactPath}. Run  npx hardhat compile  first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { abi: ethers.InterfaceAbi };
  return artifact.abi;
}

/** Load ABCToken ABI from Hardhat artifacts. */
function loadTokenAbi(): ethers.InterfaceAbi {
  const artifactPath = path.join(ARTIFACTS_DIR, "ABCToken.sol", "ABCToken.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `ABCToken artifact not found at ${artifactPath}. Run  npx hardhat compile  first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { abi: ethers.InterfaceAbi };
  return artifact.abi;
}

// ─── Approval Check ──────────────────────────────────────────────────────────

async function ensureApproval(
  tokenAddress: string,
  multisenderAddress: string,
  deployer: Wallet,
  unsentEntries: DistributionEntry[]
): Promise<void> {
  const tokenAbi = loadTokenAbi();
  const token = new Contract(tokenAddress, tokenAbi, deployer);

  const totalNeeded: bigint = unsentEntries.reduce(
    (acc, entry) => acc + BigInt(entry.amountWei),
    0n
  );

  log(`Total tokens needed: ${ethers.formatEther(totalNeeded)} ABC`);

  const allowance = await token.allowance(deployer.address, multisenderAddress) as bigint;
  log(`Current allowance: ${ethers.formatEther(allowance)} ABC`);

  if (allowance < totalNeeded) {
    log(`Approving ${ethers.formatEther(totalNeeded)} ABC for MultiSender...`);
    const tx = await token.approve(multisenderAddress, totalNeeded) as TransactionResponse;
    log(`  Approval TX: ${tx.hash}`);
    await tx.wait(1);
    log(`  Approved. Allowance updated.`);
  } else {
    log("Allowance sufficient — skipping approval.");
  }
}

// ─── Batch Sender ────────────────────────────────────────────────────────────

async function sendBatch(
  batch: DistributionEntry[],
  batchIndex: number,
  totalBatches: number,
  multisender: Contract,
  tokenAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager
): Promise<TransactionReceipt> {
  const indices: number[] = batch.map((w) => w.index);
  const packedArr: string[] = batch.map((w) => w.packedHex);

  // Always fetch nonce from the reliable primary provider
  const primaryProvider = rpcManager.getPrimary();
  const nonce = await primaryProvider.getTransactionCount(deployer.address, "pending");

  // Encode calldata
  const calldata = multisender.interface.encodeFunctionData("multisend", [
    tokenAddress,
    indices,
    packedArr,
  ]);

  // Sign and broadcast
  const network = await primaryProvider.getNetwork();
  const signedTx = await deployer.signTransaction({
    to: await multisender.getAddress(),
    data: calldata,
    gasLimit: GAS_LIMIT,
    gasPrice: GAS_PRICE,
    nonce,
    chainId: network.chainId,
    value: 0n,
  });

  const tx = await rpcManager.broadcast(signedTx);

  // Wait for confirmations via primary (most reliable for receipt)
  const receipt = await tx.wait(CONFIRMATIONS);
  if (!receipt) throw new Error("Transaction receipt is null");

  log(
    `Batch ${batchIndex}/${totalBatches} | Wallets: ${batch.length} | TX: ${receipt.hash} | Gas: ${receipt.gasUsed.toString()} | Status: CONFIRMED`
  );

  return receipt;
}

async function sendBatchWithRetry(
  batch: DistributionEntry[],
  batchIndex: number,
  totalBatches: number,
  multisender: Contract,
  tokenAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager
): Promise<BatchResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const receipt = await sendBatch(
        batch, batchIndex, totalBatches, multisender, tokenAddress, deployer, rpcManager
      );
      return { batchIndex, success: true, txHash: receipt.hash, gasUsed: receipt.gasUsed };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        logError(`Batch ${batchIndex} attempt ${attempt}/${MAX_RETRIES} failed: ${message}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        const finalDelay = RETRY_DELAYS_MS[MAX_RETRIES - 1];
        logError(`Batch ${batchIndex} attempt ${attempt}/${MAX_RETRIES} failed: ${message}. Waiting ${finalDelay / 1000}s then marking as FAILED.`);
        await sleep(finalDelay);
        return { batchIndex, success: false, error: message };
      }
    }
  }
  // Unreachable but satisfies TypeScript
  return { batchIndex, success: false, error: "Max retries exceeded" };
}

// ─── CSV Log Writer ──────────────────────────────────────────────────────────

function writeCsvLog(plan: DistributionEntry[]): void {
  const sent = plan.filter((e) => e.sent);
  const lines = ["index,address,amount,amountWei,txHash,timestamp"];
  for (const entry of sent) {
    lines.push(
      `${entry.index},${entry.address},${entry.amount},${entry.amountWei},${entry.txHash ?? ""},${entry.timestamp ?? ""}`
    );
  }
  fs.writeFileSync(CSV_LOG_FILE, lines.join("\n"), "utf8");
  log(`distribution-log.csv written with ${sent.length.toLocaleString()} entries.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  log("═══════════════════════════════════════════════════════════");
  log("BNB Token Distribution — Starting");
  log("═══════════════════════════════════════════════════════════");

  // ── Load env ──
  const tokenAddress = requireEnv("TOKEN_ADDRESS");
  const multisenderAddress = requireEnv("MULTISENDER_ADDRESS");
  const privateKey = requireEnv("PRIVATE_KEY");

  // ── Setup providers & signer ──
  const rpcManager = new RpcManager();
  const primaryProvider = rpcManager.getPrimary();
  const deployer = new Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    primaryProvider
  );
  log(`Deployer address: ${deployer.address}`);

  const balance = await primaryProvider.getBalance(deployer.address);
  log(`Deployer BNB balance: ${ethers.formatEther(balance)} BNB`);

  // ── Load contracts ──
  const multisenderAbi = loadMultiSenderAbi();
  const multisender = new Contract(multisenderAddress, multisenderAbi, deployer);

  // ── Load plan & compute resume state ──
  const plan = loadPlan();
  const unsentEntries = plan.filter((e) => !e.sent);
  const alreadySent = plan.length - unsentEntries.length;

  log(`Total wallets in plan: ${plan.length.toLocaleString()}`);
  log(`Already sent: ${alreadySent.toLocaleString()}`);
  log(`Remaining: ${unsentEntries.length.toLocaleString()}`);

  if (unsentEntries.length === 0) {
    log("All wallets already sent! Writing final CSV log.");
    writeCsvLog(plan);
    log("Done.");
    process.exit(0);
  }

  const batchesDone = Math.floor(alreadySent / BATCH_SIZE);
  const totalBatches = Math.ceil(plan.length / BATCH_SIZE);
  log(`Resuming: ${batchesDone} batches already done, ${Math.ceil(unsentEntries.length / BATCH_SIZE)} remaining`);

  // ── Ensure token approval ──
  await ensureApproval(tokenAddress, multisenderAddress, deployer, unsentEntries);

  // ── Batch execution ──
  const batches = chunkArray(unsentEntries, BATCH_SIZE);
  const parallelGroups = chunkArray(batches, PARALLEL_BATCHES);

  // We track the global batch number for display purposes
  let globalBatchCounter = batchesDone;
  let successCount = alreadySent;
  let failCount = 0;
  const startTime = Date.now();

  log(`\nStarting distribution: ${batches.length} batches, ${PARALLEL_BATCHES} in parallel`);
  log("─────────────────────────────────────────────────────────────");

  for (let groupIdx = 0; groupIdx < parallelGroups.length; groupIdx++) {
    const group = parallelGroups[groupIdx];

    const batchPromises = group.map((batch) => {
      globalBatchCounter++;
      const currentBatchNum = globalBatchCounter;
      return sendBatchWithRetry(
        batch,
        currentBatchNum,
        totalBatches,
        multisender,
        tokenAddress,
        deployer,
        rpcManager
      );
    });

    const results = await Promise.allSettled(batchPromises);

    // Process results and update plan
    let batchGroupOffset = 0;
    for (const settled of results) {
      const currentBatch = group[batchGroupOffset];
      batchGroupOffset++;

      if (settled.status === "fulfilled") {
        const result = settled.value;

        if (result.success) {
          // Mark all entries in this batch as sent
          for (const entry of currentBatch) {
            const planEntry = plan.find((p) => p.index === entry.index);
            if (planEntry) {
              planEntry.sent = true;
              planEntry.txHash = result.txHash ?? null;
              planEntry.timestamp = new Date().toISOString();
            }
          }
          successCount += currentBatch.length;
        } else {
          logError(`Batch ${result.batchIndex} permanently failed: ${result.error ?? "unknown"}`);
          failCount += currentBatch.length;
        }
      } else {
        logError(`Batch Promise rejected (unexpected):`, settled.reason);
        failCount += currentBatch.length;
      }
    }

    // Atomic checkpoint write after each parallel group
    savePlan(plan);
    log(`Group ${groupIdx + 1}/${parallelGroups.length} complete. Checkpoint saved.`);
  }

  // ── Final summary ──
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const finalBalance = await primaryProvider.getBalance(deployer.address);
  const bnbUsed = ethers.formatEther(balance - finalBalance);

  log("\n═══════════════════════════════════════════════════════════");
  log("DISTRIBUTION COMPLETE");
  log("═══════════════════════════════════════════════════════════");
  log(`Total time:     ${totalTime}s`);
  log(`Success:        ${successCount.toLocaleString()} wallets`);
  log(`Failed:         ${failCount.toLocaleString()} wallets`);
  log(`BNB used:       ${bnbUsed} BNB`);
  log("═══════════════════════════════════════════════════════════");

  writeCsvLog(plan);
  logStream.end();
}

// ─── SIGINT Handler ──────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  const msg = `[${new Date().toISOString()}] Interrupted. State saved. Run again to resume.`;
  console.log("\n" + msg);
  logStream.write(msg + "\n");
  logStream.end();
  process.exit(0);
});

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  logError("distribute.ts fatal error:", err);
  logStream.end();
  process.exit(1);
});
