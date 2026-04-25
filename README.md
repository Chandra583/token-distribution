# BNB Chain Token Distribution System

A production-grade BEP-20 token creation and mass wallet distribution system for BNB Smart Chain.
Distributes **50,000,000 ABC tokens** to **100,000 wallets** via gas-optimized batch transactions.

---

## 1. Setup Steps

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 18 |
| npm | >= 9 |
| Alchemy API key | Free tier or above |

### Step 1 — Install dependencies

```bash
cd bnb-token-distribution
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

**For BSC Testnet:**
```env
ALCHEMY_RPC_URL=https://bnb-testnet.g.alchemy.com/v2/YOUR_KEY
FALLBACK_RPC_1=https://data-seed-prebsc-1-s1.binance.org:8545
FALLBACK_RPC_2=https://data-seed-prebsc-2-s1.binance.org:8545
PRIVATE_KEY=<your_deployer_private_key>
TOKEN_ADDRESS=        # fill after deploy
MULTISENDER_ADDRESS=  # fill after deploy
```

> Never commit `.env` to git. It contains your private key.

**For local testing (Hardhat):**
```env
ALCHEMY_RPC_URL=http://127.0.0.1:8545
FALLBACK_RPC_1=http://127.0.0.1:8545
FALLBACK_RPC_2=http://127.0.0.1:8545
PRIVATE_KEY=<your_hardhat_account_private_key>   # from: npx hardhat node
```

### Step 3 — Compile contracts

```bash
npm run compile
```

---

## 2. How to Run Scripts

### Script 1 — Deploy ABCToken

```bash
# Local
npx hardhat run scripts/deploy-token.ts --network localhost

# BSC Testnet
npm run deploy:token
```

Copy the printed `TOKEN_ADDRESS` into `.env`.

### Script 2 — Deploy MultiSender

```bash
# Local
npx hardhat run scripts/deploy-multisender.ts --network localhost

# BSC Testnet
npm run deploy:multisender
```

Copy the printed `MULTISENDER_ADDRESS` into `.env`.

### Script 3 — Generate 100,000 wallets

```bash
npm run generate:wallets
```

Output: `output/wallets.csv`, `output/MASTER_MNEMONIC.txt`

> Keep `MASTER_MNEMONIC.txt` secure offline — it controls all 100k wallets.

### Script 4 — Prepare distribution plan

```bash
npm run prepare:distribution
```

Output: `output/distribution-plan.json`

### Script 5 — Run distribution

```bash
npm run distribute
```

The script:
1. Approves MultiSender allowance once
2. Sends **334 batches × 300 wallets** (5 parallel per group)
3. Retries failed batches automatically (3 attempts, exponential backoff)
4. Drain-loops until all 100,000 wallets are sent
5. Saves checkpoint after each group — **safe to interrupt and resume**
6. Exports `distribution-log.csv` + `distribution-log.xlsx` on completion

> Resume anytime: re-run `npm run distribute` — already-sent wallets are skipped.

### Script 6 — Export results (optional)

```bash
npm run export
```

---

## 3. Gas Cost Estimation

### Why gas optimization matters

Naive 1-by-1 sends = 100,000 transactions = **8.1B gas (~$24,300)**.  
This system applies three layers to reduce it to **2.86B gas (~$5,160 at 3 gwei)**.

```
Naive 1-by-1          →  8.1B gas   (~40.5 BNB)   baseline
+ Batch (300/tx)      →  6.0B gas   (~30.0 BNB)   -26%
+ Packed calldata     →  3.7B gas   (~18.5 BNB)   -38% further
+ Bitmap guard        →  2.86B gas  (~14.3 BNB)   saves 256× on flags
```
<img width="874" height="375" alt="image" src="https://github.com/user-attachments/assets/038a7d11-4eef-44c6-9fdc-4923b4745a39" />

### Optimization 1 — Packed Calldata (38% less calldata gas)

Naive: `address` (32B) + `uint256` (32B) = **64 bytes per recipient**  
Packed: `bytes32` encodes both = **32 bytes per recipient**

```
bits 255–96 → address  (20 bytes)
bits  95– 0 → uint96   (12 bytes, whole-token amount)
```

Built in `prepare-distribution.ts`, unpacked in `MultiSender.sol`.
<img width="790" height="692" alt="image" src="https://github.com/user-attachments/assets/e23c3eac-d665-4a6b-b003-2f9c8111db02" />

### Optimization 2 — Bitmap Duplicate Guard (256× cheaper than bool mapping)

`mapping(address => bool)` = 20,000 gas cold SSTORE per address.  
`mapping(uint256 => uint256)` bitmap = 1 cold SSTORE per **256 addresses**.

```solidity
uint256 bucket = index / 256;   // which 256-bit slot
uint256 bit    = index % 256;   // which bit within that slot
_claimed[bucket] |= (1 << bit); // set flag
```

### Optimization 3 — Unchecked Loop Increment

```solidity
unchecked { ++i; } // loop bounded by len <= 300 — overflow impossible
```

Saves ~40 gas × 300 iterations = **~12,000 gas per batch**.

### Gas cost by gas price (100k wallets, 300/batch)

Gas consumed is **identical regardless of Alchemy plan** — the plan affects speed, not cost.

| Gas price | Total gas | Cost |
|-----------|-----------|------|
| BSC Testnet | 2,863,989,520 | **Free (tBNB)** |
| 3 gwei (BSC mainnet avg) | 2,863,989,520 | **8.59 BNB (~$5,160)** |
| 5 gwei | 2,863,989,520 | **14.32 BNB (~$8,592)** |
| 10 gwei (our test) | 2,863,989,520 | **28.64 BNB (~$17,184)** |

> USD estimate assumes BNB = $600. BSC mainnet typically runs 1–5 gwei.

---

## 4. Time Taken

### Proven Results — All Batch Size Tests (Local Hardhat)

> Three batch sizes were tested end-to-end. **300 wallets/batch is the optimal configuration** — fewest transactions, lowest gas, fastest time.

| Metric | 200/batch | 250/batch | **300/batch ✓ Best** |
|--------|-----------|-----------|----------------------|
| Total wallets | 100,000 | 100,000 | **100,000** |
| Successful wallets | 100,000 | 100,000 | **100,000** |
| Failed wallets | 0 | 0 | **0** |
| Total batches | 500 | 400 | **334** |
| Total time | 27m 53s | 21m 16s | **16m 11s** |
| Avg gas / batch | 5,742,274 | 7,167,146 | **8,574,818** |
| Total gas used | 2,871,137,384 | 2,866,858,692 | **2,863,989,520** |
| Gas cost @ 10 gwei | 28.71 BNB | 28.67 BNB | **28.64 BNB** |
| Throughput | 59.8 wallets/s | 78.4 wallets/s | **103.0 wallets/s** |
| Nonce errors | None | None | Few (auto-recovered) |

> **Why 300 beats 200:** Fewer transactions = fewer base overheads.
> Every tx pays ~21,000 gas just to exist. 500 txs = 10.5M wasted gas; 334 txs = 7.0M wasted gas.
> **300/batch saves 3.5M gas (~0.035 BNB) vs 200/batch.**

> **Why not 305+:** Above 300, parallel batches race for the same nonce. 305, 310, 320, 350 were all tested and failed.

### Expected time per step

| Step | Expected Duration |
|------|-------------------|
| `generate-wallets.ts` | ~3–5 minutes |
| `prepare-distribution.ts` | ~5 seconds |
| Deploy contracts | ~30 seconds |
| `distribute.ts` (300/batch) | ~16 minutes (local) / ~5 minutes (BSC Testnet) |
| `export-results.ts` | ~5 seconds |

### Alchemy Plan Comparison — Time on BSC Testnet

> BSC Testnet block time = **3 seconds**. Each batch = 1 tx = needs 1 block confirmation.
> With 5 parallel batches per group: **67 groups × 5 batches = 334 batches total.**

Each group of 5 batches needs approximately **25–35 RPC calls**:
- 5× `eth_getTransactionCount` (nonce)
- 5× `eth_sendRawTransaction` (broadcast)
- ~15–25× `eth_getTransactionReceipt` (confirmation polling)

| Alchemy Plan | Rate Limit | RPC overhead/group | Block wait/group | **Total for 100k wallets** |
|---|---|---|---|---|
| **Free** | 25 req/s | ~1.4s (queuing starts) | ~3–4s | ~20–30 min |
| **Pay as You Go** | 300 req/s | ~0.12s (negligible) | ~3–4s | **~4–5 min** |
| **Enterprise** | 1,000 req/s | ~0.04s (instant) | ~3–4s | **~3–4 min** |

> **Conclusion:** Both Pay as You Go and Enterprise are **block-time limited** (3s BSC), not RPC limited.
> Enterprise gains only ~30–60 seconds over Pay as You Go for 100k wallets.
> Free tier causes noticeable queuing delays — expect 20–30 minutes.

### For 1 Million wallets (scale-up projection)

| Plan | Batches | Est. Time | Gas | Cost @ 3 gwei |
|------|---------|-----------|-----|---------------|
| Free | 3,334 | ~3–5 hours | 28.6B gas | ~85.9 BNB |
| **Pay as You Go** | 3,334 | **~40 min** | 28.6B gas | ~85.9 BNB |
| **Enterprise** | 3,334 | **~35 min** | 28.6B gas | ~85.9 BNB |

> Gas scales linearly — 10× wallets = 10× gas cost. Time scales linearly too.

---

## 5. Project Structure

```
bnb-token-distribution/
├── contracts/
│   ├── ABCToken.sol              # BEP-20 token — 50M pre-minted
│   └── MultiSender.sol           # Gas-optimized batch distributor (300/tx cap)
├── scripts/
│   ├── deploy-token.ts           # Deploy ABCToken
│   ├── deploy-multisender.ts     # Deploy MultiSender
│   ├── generate-wallets.ts       # BIP44 HD derivation — 100k wallets
│   ├── prepare-distribution.ts   # Random amounts + bytes32 packing
│   ├── distribute.ts             # Main distribution engine
│   └── export-results.ts         # Export CSV + Excel report
├── output/                        # (gitignored — contains keys + data)
│   ├── wallets.csv
│   ├── MASTER_MNEMONIC.txt
│   ├── distribution-plan.json
│   ├── distribution-log.csv
│   ├── distribution-log.xlsx
│   └── distribution.log
├── .env                           # Secrets (gitignored)
├── .env.example
├── hardhat.config.ts
├── package.json
└── tsconfig.json
```

---

## 6. Architecture

```
generate-wallets.ts
    │  wallets.csv (100k wallets, BIP44 m/44'/60'/0'/0/{i})
    ▼
prepare-distribution.ts
    │  distribution-plan.json (random 100–300 tokens, packed bytes32)
    ▼
distribute.ts
    │
    ├── ensureApproval()        one-time allowance for full remaining amount
    ├── RpcManager              Alchemy primary → Binance FB1 → Binance FB2
    │
    └── Drain Loop (max 5 passes)
            │
            ├── Per pass: chunk unsent into 300-wallet batches
            ├── Group 5 batches in parallel, sign serially (nonce safety)
            ├── sendBatchWithRetry: 3 attempts, 5s/10s/15s backoff
            ├── savePlan() after every group (resume checkpoint)
            └── Exit when unsent == 0 or no progress
                    │
                    ▼
            distribution-plan.json  (atomic checkpoint)
            distribution-log.csv    (audit trail)
            distribution-log.xlsx   (Excel — 3 sheets)
```

---

## 7. RPC Strategy

| Provider | Role | Trigger |
|----------|------|---------|
| Alchemy (primary) | Nonce reads + all broadcasts | Always tried first |
| Binance Fallback 1 | Backup broadcast | 429 / timeout from Alchemy |
| Binance Fallback 2 | Last resort | Fallback 1 also rate-limited |

Non-retryable errors (nonce conflict, revert) throw immediately — no rotation.

---

## 8. Retry & Resume Logic

### Per-batch retry (3 attempts, exponential backoff)
```
Attempt 1 fails → wait 5s  → retry
Attempt 2 fails → wait 10s → retry
Attempt 3 fails → wait 15s → mark failed for drain loop
```

### Drain loop (up to 5 passes)
```
Pass 1: 334 batches → 330 succeed, 4 fail
Pass 2:   4 batches → all 4 succeed
→ "All wallets sent"
```

### Resume on restart
```
Already sent:  95,100 wallets
Remaining:      4,900 wallets
Resuming automatically from checkpoint...
```

---

## 9. Security Notes

| Concern | Mitigation |
|---------|-----------|
| Private key exposure | `.env` only — never in code or README |
| `.env` in git | `.gitignore` covers `.env`, `output/` |
| Duplicate transfers | On-chain bitmap — `_claimed[bucket]` set before `transferFrom` |
| Reentrancy | `ReentrancyGuard` on `multisend()` |
| Wallet reuse | Unique BIP44 index per wallet — `m/44'/60'/0'/0/{i}` |
| Batch overflow | `require(len <= 300)` enforced on-chain |

---

## 10. Output Files

| File | Description |
|------|-------------|
| `output/wallets.csv` | index, address, privateKey, derivationPath |
| `output/MASTER_MNEMONIC.txt` | BIP44 master seed |
| `output/distribution-plan.json` | Per-wallet: sent, txHash, timestamp (resume source) |
| `output/distribution-log.csv` | Sent wallets: address, amount, txHash, timestamp |
| `output/distribution-log.xlsx` | Sheet 1: Log, Sheet 2: Unsent, Sheet 3: Summary |
| `output/distribution.log` | Full timestamped run log |

---

## 11. Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | BNB Smart Chain (BSC) Testnet |
| Smart contracts | Solidity 0.8.20 + OpenZeppelin 5.0 |
| Contract framework | Hardhat 2.22 |
| Runtime | Node.js 18 + TypeScript 5.4 |
| Blockchain SDK | ethers.js v6 |
| Wallet generation | BIP44 HD derivation |
| Excel export | ExcelJS |
| Secrets | dotenv |

---

## 12. Contract Addresses (BSC Testnet)

| Contract | Address |
|----------|---------|
| ABCToken | _pending deployment_ |
| MultiSender | _pending deployment_ |
