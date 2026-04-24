import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ethers, JsonRpcProvider, Wallet, Contract, TransactionResponse, TransactionReceipt } from "ethers";
import ExcelJS from "exceljs";

dotenv.config();

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR    = path.resolve(__dirname, "../output");
const PLAN_FILE     = path.join(OUTPUT_DIR, "distribution-plan.json");
const LOG_FILE      = path.join(OUTPUT_DIR, "distribution.log");
const CSV_LOG_FILE  = path.join(OUTPUT_DIR, "distribution-log.csv");
const XLSX_LOG_FILE = path.join(OUTPUT_DIR, "distribution-log.xlsx");
const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/contracts");

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE       = 200;
const PARALLEL_BATCHES = 5;
const MAX_RETRIES      = 3;
const RETRY_DELAYS_MS  = [5_000, 10_000, 15_000];
const MAX_DRAIN_PASSES = 5;   // max times to re-queue permanently-failed batches

// 200 cold ERC20 transfers ≈ 7 M gas; 10 M gives ~30 % headroom.
const GAS_LIMIT    = 10_000_000n;
const GAS_PRICE    = ethers.parseUnits("10", "gwei");
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

// ─── Time formatter ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(0).padStart(2, "0");
  return `${mins}m ${secs}s`;
}

// ─── RPC Manager ──────────────────────────────────────────────────────────────

class RpcManager {
  private _primary:  JsonRpcProvider;
  private _fallback1: JsonRpcProvider;
  private _fallback2: JsonRpcProvider;

  constructor() {
    this._primary   = new JsonRpcProvider(requireEnv("ALCHEMY_RPC_URL"));
    this._fallback1 = new JsonRpcProvider(requireEnv("FALLBACK_RPC_1"));
    this._fallback2 = new JsonRpcProvider(requireEnv("FALLBACK_RPC_2"));
  }

  getPrimary(): JsonRpcProvider { return this._primary; }

  async broadcast(signedTx: string): Promise<TransactionResponse> {
    const providers = [
      { name: "Alchemy (primary)",  provider: this._primary   },
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
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes("429") || msg.includes("rate limit") ||
                            msg.includes("SERVER_ERROR") || msg.includes("TIMEOUT") ||
                            msg.includes("timeout");
        if (isRateLimit) { log(`  ${name} rate-limited — trying next...`); lastError = err; continue; }
        throw err;
      }
    }
    throw new Error(`All RPC providers exhausted. Last error: ${String(lastError)}`);
  }
}

// ─── Serial TX Submitter ─────────────────────────────────────────────────────
// Serialises sign+broadcast so txs always arrive at the node in nonce order.
// Receipt waiting is NOT serialised — confirmations run concurrently.

class SerialTxSubmitter {
  private queue: Promise<void> = Promise.resolve();

  submit(fn: () => Promise<TransactionResponse>): Promise<TransactionResponse> {
    let resolve!: (tx: TransactionResponse) => void;
    let reject!:  (err: unknown) => void;
    const promise = new Promise<TransactionResponse>((res, rej) => { resolve = res; reject = rej; });
    this.queue = this.queue.then(async () => {
      try { resolve(await fn()); } catch (err) { reject(err); }
    });
    return promise;
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
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function loadPlan(): DistributionEntry[] {
  if (!fs.existsSync(PLAN_FILE))
    throw new Error(`distribution-plan.json not found at ${PLAN_FILE}. Run prepare-distribution.ts first.`);
  return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")) as DistributionEntry[];
}

function savePlan(plan: DistributionEntry[]): void {
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
}

function loadMultiSenderAbi(): ethers.InterfaceAbi {
  const p = path.join(ARTIFACTS_DIR, "MultiSender.sol", "MultiSender.json");
  if (!fs.existsSync(p)) throw new Error(`MultiSender artifact not found at ${p}. Run npx hardhat compile first.`);
  return (JSON.parse(fs.readFileSync(p, "utf8")) as { abi: ethers.InterfaceAbi }).abi;
}

function loadTokenAbi(): ethers.InterfaceAbi {
  const p = path.join(ARTIFACTS_DIR, "ABCToken.sol", "ABCToken.json");
  if (!fs.existsSync(p)) throw new Error(`ABCToken artifact not found at ${p}. Run npx hardhat compile first.`);
  return (JSON.parse(fs.readFileSync(p, "utf8")) as { abi: ethers.InterfaceAbi }).abi;
}

// ─── Approval Check ──────────────────────────────────────────────────────────

async function ensureApproval(
  tokenAddress: string,
  multisenderAddress: string,
  deployer: Wallet,
  unsentEntries: DistributionEntry[]
): Promise<void> {
  const token = new Contract(tokenAddress, loadTokenAbi(), deployer);
  const totalNeeded = unsentEntries.reduce((acc, e) => acc + BigInt(e.amountWei), 0n);
  log(`Total tokens needed:  ${ethers.formatEther(totalNeeded)} ABC`);
  const allowance = await token.allowance(deployer.address, multisenderAddress) as bigint;
  log(`Current allowance:    ${ethers.formatEther(allowance)} ABC`);
  if (allowance < totalNeeded) {
    log(`Approving ${ethers.formatEther(totalNeeded)} ABC for MultiSender...`);
    const tx = await token.approve(multisenderAddress, totalNeeded) as TransactionResponse;
    log(`  Approval TX: ${tx.hash}`);
    await tx.wait(1);
    log(`  Approved.`);
  } else {
    log("Allowance sufficient — skipping approval.");
  }
}

// ─── Batch Sender ────────────────────────────────────────────────────────────

async function sendBatch(
  batch: DistributionEntry[],
  batchLabel: string,
  multisender: Contract,
  tokenAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager,
  submitter: SerialTxSubmitter,
  chainId: bigint
): Promise<TransactionReceipt> {
  const indices   = batch.map((w) => w.index);
  const packedArr = batch.map((w) => w.packedHex);
  const calldata  = multisender.interface.encodeFunctionData("multisend", [tokenAddress, indices, packedArr]);
  const to        = await multisender.getAddress();

  const tx = await submitter.submit(async () => {
    const nonce    = await rpcManager.getPrimary().getTransactionCount(deployer.address, "pending");
    const signedTx = await deployer.signTransaction({ to, data: calldata, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, nonce, chainId, value: 0n });
    return rpcManager.broadcast(signedTx);
  });

  const receipt = await tx.wait(CONFIRMATIONS);
  if (!receipt) throw new Error("Transaction receipt is null");
  if (receipt.status === 0) throw new Error(`Transaction reverted on-chain: ${receipt.hash}`);

  log(`${batchLabel} | Wallets: ${batch.length} | TX: ${receipt.hash} | Gas: ${receipt.gasUsed.toLocaleString()} | CONFIRMED`);
  return receipt;
}

async function sendBatchWithRetry(
  batch: DistributionEntry[],
  batchLabel: string,
  multisender: Contract,
  tokenAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager,
  submitter: SerialTxSubmitter,
  chainId: bigint
): Promise<BatchResult> {
  const batchIndex = batch[0]?.index ?? -1;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const receipt = await sendBatch(batch, batchLabel, multisender, tokenAddress, deployer, rpcManager, submitter, chainId);
      return { batchIndex, success: true, txHash: receipt.hash, gasUsed: receipt.gasUsed };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        logError(`${batchLabel} attempt ${attempt}/${MAX_RETRIES} failed: ${message}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        logError(`${batchLabel} attempt ${attempt}/${MAX_RETRIES} FINAL failure: ${message}.`);
        return { batchIndex, success: false, error: message };
      }
    }
  }
  return { batchIndex, success: false, error: "Max retries exceeded" };
}

// ─── Output Writers ──────────────────────────────────────────────────────────

function writeCsvLog(plan: DistributionEntry[]): void {
  const sent = plan.filter((e) => e.sent);
  const lines = ["index,address,amount,amountWei,txHash,timestamp"];
  for (const e of sent)
    lines.push(`${e.index},${e.address},${e.amount},${e.amountWei},${e.txHash ?? ""},${e.timestamp ?? ""}`);
  fs.writeFileSync(CSV_LOG_FILE, lines.join("\n"), "utf8");
  log(`distribution-log.csv written with ${sent.length.toLocaleString()} entries.`);
}

async function writeExcelLog(plan: DistributionEntry[]): Promise<void> {
  const sent = plan.filter((e) => e.sent);
  const wb   = new ExcelJS.Workbook();
  wb.creator  = "BNB Token Distribution";
  wb.created  = new Date();

  const ws = wb.addWorksheet("Distribution Log", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "Index",      key: "index",     width: 10 },
    { header: "Address",    key: "address",   width: 44 },
    { header: "Tokens",     key: "amount",    width: 10 },
    { header: "Amount (Wei)", key: "amountWei", width: 26 },
    { header: "TX Hash",    key: "txHash",    width: 68 },
    { header: "Timestamp",  key: "timestamp", width: 26 },
  ];

  // Bold, coloured header row
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  for (const e of sent) {
    ws.addRow({
      index:     e.index,
      address:   e.address,
      amount:    e.amount,
      amountWei: e.amountWei,
      txHash:    e.txHash ?? "",
      timestamp: e.timestamp ?? "",
    });
  }

  // Alternate row shading
  for (let r = 2; r <= sent.length + 1; r++) {
    if (r % 2 === 0) {
      ws.getRow(r).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FA" } };
    }
  }

  // Summary sheet
  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ header: "Metric", key: "metric", width: 30 }, { header: "Value", key: "value", width: 30 }];
  summary.getRow(1).font = { bold: true };
  summary.addRows([
    { metric: "Total wallets in plan", value: plan.length },
    { metric: "Successfully sent",     value: sent.length },
    { metric: "Failed / unsent",       value: plan.length - sent.length },
    { metric: "Generated at",          value: new Date().toISOString() },
  ]);

  await wb.xlsx.writeFile(XLSX_LOG_FILE);
  log(`distribution-log.xlsx written with ${sent.length.toLocaleString()} entries.`);
}

// ─── Batch runner (one pass over a list of entries) ──────────────────────────

async function runPass(
  entries: DistributionEntry[],
  plan: DistributionEntry[],
  passLabel: string,
  totalPlanSize: number,
  multisender: Contract,
  tokenAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager,
  submitter: SerialTxSubmitter,
  chainId: bigint,
  counters: { successCount: number; failCount: number; totalGasUsed: bigint; successBatches: number },
  startTime: number
): Promise<number> {
  // Returns count of newly failed wallets in this pass
  const batches        = chunkArray(entries, BATCH_SIZE);
  const parallelGroups = chunkArray(batches, PARALLEL_BATCHES);
  let newlyFailed = 0;

  log(`${passLabel}: ${entries.length.toLocaleString()} wallets → ${batches.length} batches, ${PARALLEL_BATCHES} parallel`);

  for (let groupIdx = 0; groupIdx < parallelGroups.length; groupIdx++) {
    const group = parallelGroups[groupIdx];

    const batchPromises = group.map((batch, pos) => {
      const label = `[${passLabel} G${groupIdx + 1}/${parallelGroups.length} B${pos + 1}]`;
      return sendBatchWithRetry(batch, label, multisender, tokenAddress, deployer, rpcManager, submitter, chainId);
    });

    const results = await Promise.allSettled(batchPromises);

    let offset = 0;
    for (const settled of results) {
      const currentBatch = group[offset++];

      if (settled.status === "fulfilled" && settled.value.success) {
        const result = settled.value;
        for (const entry of currentBatch) {
          const planEntry = plan.find((p) => p.index === entry.index);
          if (planEntry) {
            planEntry.sent      = true;
            planEntry.txHash    = result.txHash ?? null;
            planEntry.timestamp = new Date().toISOString();
          }
        }
        counters.successCount  += currentBatch.length;
        counters.totalGasUsed  += settled.value.gasUsed ?? 0n;
        counters.successBatches++;
      } else {
        const reason = settled.status === "rejected"
          ? String(settled.reason)
          : (settled.value.error ?? "unknown");
        logError(`Batch permanently failed (will retry in next pass): ${reason}`);
        newlyFailed += currentBatch.length;
        counters.failCount += currentBatch.length;
      }
    }

    savePlan(plan);

    const elapsed   = Date.now() - startTime;
    const groupsDone = groupIdx + 1;
    const groupsLeft = parallelGroups.length - groupsDone;
    const avgMs      = elapsed / groupsDone;
    const etaMs      = groupsLeft * avgMs;
    log(`  Group ${groupsDone}/${parallelGroups.length} done | Elapsed: ${formatDuration(elapsed)} | ETA: ~${formatDuration(etaMs)}`);
  }

  return newlyFailed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  log("═══════════════════════════════════════════════════════════");
  log("BNB Token Distribution — Starting");
  log("═══════════════════════════════════════════════════════════");

  const tokenAddress       = requireEnv("TOKEN_ADDRESS");
  const multisenderAddress = requireEnv("MULTISENDER_ADDRESS");
  const privateKey         = requireEnv("PRIVATE_KEY");

  const rpcManager      = new RpcManager();
  const primaryProvider = rpcManager.getPrimary();
  const deployer        = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, primaryProvider);
  log(`Deployer address:      ${deployer.address}`);

  const startingBalance = await primaryProvider.getBalance(deployer.address);
  log(`Deployer BNB balance:  ${ethers.formatEther(startingBalance)} BNB`);

  const multisender = new Contract(multisenderAddress, loadMultiSenderAbi(), deployer);

  const plan        = loadPlan();
  const alreadySent = plan.filter((e) => e.sent).length;

  log(`Total wallets in plan: ${plan.length.toLocaleString()}`);
  log(`Already sent:          ${alreadySent.toLocaleString()}`);
  log(`Remaining:             ${(plan.length - alreadySent).toLocaleString()}`);

  if (plan.every((e) => e.sent)) {
    log("All wallets already sent! Writing outputs.");
    writeCsvLog(plan);
    await writeExcelLog(plan);
    log("Done.");
    process.exit(0);
  }

  // Re-check allowance for all unsent entries
  await ensureApproval(tokenAddress, multisenderAddress, deployer, plan.filter((e) => !e.sent));

  const { chainId } = await primaryProvider.getNetwork();
  log(`Chain ID: ${chainId}`);

  // Single submitter for the entire run
  const submitter = new SerialTxSubmitter();

  const counters = { successCount: alreadySent, failCount: 0, totalGasUsed: 0n, successBatches: 0 };
  const startTime = Date.now();

  // ── Drain loop ────────────────────────────────────────────────────────────
  // After every pass, re-queue any wallets that are still unsent.
  // Stops when ALL wallets are sent, OR no progress in a pass (truly stuck).

  for (let pass = 1; pass <= MAX_DRAIN_PASSES; pass++) {
    const unsent = plan.filter((e) => !e.sent);
    if (unsent.length === 0) break;

    log(`\n── Pass ${pass}/${MAX_DRAIN_PASSES} — ${unsent.length.toLocaleString()} wallets to send ──`);

    const prevFail = counters.failCount;
    counters.failCount = 0; // reset per-pass fail count

    await runPass(
      unsent, plan, `Pass${pass}`,
      plan.length, multisender, tokenAddress, deployer,
      rpcManager, submitter, chainId, counters, startTime
    );

    const stillUnsent = plan.filter((e) => !e.sent).length;
    if (stillUnsent === 0) { log("All wallets sent — exiting drain loop."); break; }

    // No progress → truly stuck (e.g. out of BNB, contract broken)
    if (counters.failCount >= prevFail && pass > 1) {
      logError(`No progress in pass ${pass} — ${stillUnsent} wallets remain unsent. Stopping.`);
      break;
    }

    if (pass < MAX_DRAIN_PASSES) {
      log(`Pass ${pass} done. ${stillUnsent} still unsent — starting pass ${pass + 1} in 5s...`);
      await sleep(5_000);
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const totalMs      = Date.now() - startTime;
  const finalBalance = await primaryProvider.getBalance(deployer.address);
  const bnbUsed      = startingBalance - finalBalance;
  const avgGas       = counters.successBatches > 0 ? counters.totalGasUsed / BigInt(counters.successBatches) : 0n;
  const gasCostWei   = counters.totalGasUsed * GAS_PRICE;
  const totalSentFinal = plan.filter((e) => e.sent).length;
  const totalFailFinal = plan.length - totalSentFinal;

  log("\n═══════════════════════════════════════════════════════════");
  log("DISTRIBUTION COMPLETE");
  log("═══════════════════════════════════════════════════════════");
  log(`Total time:            ${formatDuration(totalMs)}`);
  log(`Successful wallets:    ${totalSentFinal.toLocaleString()}`);
  log(`Failed wallets:        ${totalFailFinal.toLocaleString()}`);
  log(`Successful batches:    ${counters.successBatches}`);
  log(`Avg gas / batch:       ${avgGas.toLocaleString()} gas`);
  log(`Total gas used:        ${counters.totalGasUsed.toLocaleString()} gas`);
  log(`Gas cost @ 10 gwei:    ${ethers.formatEther(gasCostWei)} BNB (calc)`);
  log(`BNB balance consumed:  ${ethers.formatEther(bnbUsed)} BNB (actual)`);
  log(`Throughput:            ${(totalSentFinal / (totalMs / 1000)).toFixed(1)} wallets/s`);
  log("═══════════════════════════════════════════════════════════");

  writeCsvLog(plan);
  await writeExcelLog(plan);
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
