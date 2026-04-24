import * as fs from "fs";
import * as path from "path";
import ExcelJS from "exceljs";

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR    = path.resolve(__dirname, "../output");
const PLAN_FILE     = path.join(OUTPUT_DIR, "distribution-plan.json");
const CSV_LOG_FILE  = path.join(OUTPUT_DIR, "distribution-log.csv");
const XLSX_LOG_FILE = path.join(OUTPUT_DIR, "distribution-log.xlsx");

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadPlan(): DistributionEntry[] {
  if (!fs.existsSync(PLAN_FILE)) {
    console.error(`ERROR: ${PLAN_FILE} not found. Run distribute.ts first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")) as DistributionEntry[];
}

function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60).toString().padStart(2, "0");
  return `${mins}m ${secs}s`;
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function writeCsv(plan: DistributionEntry[]): void {
  const sent   = plan.filter((e) => e.sent);
  const unsent = plan.filter((e) => !e.sent);

  const lines = ["index,address,amount,amountWei,txHash,timestamp"];
  for (const e of sent)
    lines.push(`${e.index},${e.address},${e.amount},${e.amountWei},${e.txHash ?? ""},${e.timestamp ?? ""}`);

  fs.writeFileSync(CSV_LOG_FILE, lines.join("\n"), "utf8");
  console.log(`✔ CSV  → ${CSV_LOG_FILE}`);
  console.log(`       ${sent.length.toLocaleString()} sent rows written`);
  if (unsent.length > 0)
    console.log(`  ⚠  ${unsent.length.toLocaleString()} wallets still UNSENT (sent: false) — not included in CSV`);
}

// ─── Excel Export ─────────────────────────────────────────────────────────────

async function writeExcel(plan: DistributionEntry[]): Promise<void> {
  const sent   = plan.filter((e) => e.sent);
  const unsent = plan.filter((e) => !e.sent);

  const wb = new ExcelJS.Workbook();
  wb.creator  = "BNB Token Distribution";
  wb.created  = new Date();
  wb.modified = new Date();

  // ── Sheet 1: Sent wallets ──────────────────────────────────────────────────
  const ws = wb.addWorksheet("Distribution Log", {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultColWidth: 20 },
  });

  ws.columns = [
    { header: "Index",         key: "index",     width: 10  },
    { header: "Wallet Address",key: "address",   width: 45  },
    { header: "Tokens",        key: "amount",    width: 10  },
    { header: "Amount (Wei)",  key: "amountWei", width: 28  },
    { header: "TX Hash",       key: "txHash",    width: 68  },
    { header: "Timestamp (UTC)", key: "timestamp", width: 26 },
  ];

  // Header style — dark blue bg, white bold text
  const headerRow = ws.getRow(1);
  headerRow.font      = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  headerRow.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
  headerRow.height    = 20;

  // Data rows
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
    if (r % 2 === 0)
      ws.getRow(r).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FA" } };
  }

  // Auto-filter on header row
  ws.autoFilter = { from: "A1", to: "F1" };

  // ── Sheet 2: Unsent wallets (if any) ─────────────────────────────────────
  if (unsent.length > 0) {
    const ws2 = wb.addWorksheet("Unsent (Failed)", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    ws2.columns = [
      { header: "Index",          key: "index",   width: 10 },
      { header: "Wallet Address", key: "address", width: 45 },
      { header: "Tokens",         key: "amount",  width: 10 },
    ];
    ws2.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws2.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC0392B" } };
    for (const e of unsent)
      ws2.addRow({ index: e.index, address: e.address, amount: e.amount });
  }

  // ── Sheet 3: Summary ──────────────────────────────────────────────────────
  const sumWs = wb.addWorksheet("Summary");
  sumWs.columns = [
    { header: "Metric", key: "metric", width: 30 },
    { header: "Value",  key: "value",  width: 30 },
  ];
  sumWs.getRow(1).font = { bold: true };
  sumWs.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };

  sumWs.addRows([
    { metric: "Total wallets in plan",  value: plan.length },
    { metric: "Successfully sent",      value: sent.length },
    { metric: "Failed / unsent",        value: unsent.length },
    { metric: "Completion %",           value: `${((sent.length / plan.length) * 100).toFixed(2)}%` },
    { metric: "Exported at (UTC)",      value: new Date().toISOString() },
  ]);

  await wb.xlsx.writeFile(XLSX_LOG_FILE);
  console.log(`✔ XLSX → ${XLSX_LOG_FILE}`);
  console.log(`       Sheet 1: "Distribution Log" — ${sent.length.toLocaleString()} rows`);
  if (unsent.length > 0)
    console.log(`       Sheet 2: "Unsent (Failed)"  — ${unsent.length.toLocaleString()} rows`);
  console.log(`       Sheet 3: "Summary"`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now();

  console.log("══════════════════════════════════════════════");
  console.log(" BNB Distribution — Export Results");
  console.log("══════════════════════════════════════════════");

  const plan   = loadPlan();
  const sent   = plan.filter((e) => e.sent).length;
  const unsent = plan.length - sent;
  const pct    = ((sent / plan.length) * 100).toFixed(2);

  console.log(`Total wallets:    ${plan.length.toLocaleString()}`);
  console.log(`Sent:             ${sent.toLocaleString()} (${pct}%)`);
  console.log(`Unsent:           ${unsent.toLocaleString()}`);
  console.log("");

  writeCsv(plan);
  await writeExcel(plan);

  console.log("");
  console.log(`══════════════════════════════════════════════`);
  console.log(` Export complete in ${formatDuration(Date.now() - t0)}`);
  console.log(`══════════════════════════════════════════════`);
}

main().catch((err: unknown) => {
  console.error("Export failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
