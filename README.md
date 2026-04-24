# BNB Chain Token Distribution System

A production-grade BEP-20 token creation and mass wallet distribution system for BNB Smart Chain. Distributes tokens to **100,000 unique wallets** across **500 batched on-chain transactions** using three Solidity gas optimizations.

---

## Proven Results (Local Hardhat Test)

| Metric | Value |
|---|---|
| Total wallets | 100,000 |
| Successful wallets | **100,000 (100%)** |
| Failed wallets | **0** |
| Total batches | 500 |
| Total time | **27m 53s** |
| Avg gas / batch | 5,742,274 |
| Total gas used | 2,871,137,384 |
| Gas cost @ 10 gwei | **28.71 BNB** |
| Throughput | 59.8 wallets/s |

---

## Project Structure

```
bnb-token-distribution/
├── contracts/
│   ├── ABCToken.sol              # BEP-20 token — 50M pre-minted
│   └── MultiSender.sol           # Gas-optimized batch distributor
├── scripts/
│   ├── deploy-token.ts           # Deploy ABCToken
│   ├── deploy-multisender.ts     # Deploy MultiSender
│   ├── generate-wallets.ts       # BIP44 HD derivation — 100k wallets
│   ├── prepare-distribution.ts   # Random amounts + bytes32 packing
│   ├── distribute.ts             # Main distribution engine
│   └── export-results.ts         # Export CSV + Excel report
├── output/                        # (gitignored)
│   ├── wallets.csv               # 100,000 wallet addresses + keys
│   ├── MASTER_MNEMONIC.txt       # HD wallet master seed (keep secret)
│   ├── distribution-plan.json    # Resume checkpoint
│   ├── distribution-log.csv      # Final distribution log
│   ├── distribution-log.xlsx     # Excel report (3 sheets)
│   └── distribution.log          # Full timestamped run log
├── .env.example                   # Environment variable template
├── .env                           # Actual config (gitignored)
├── .gitignore
├── hardhat.config.ts
├── package.json
├── tsconfig.json
└── remappings.txt
```

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | >= 18 |
| npm | >= 9 |
| TypeScript | ^5.4 |

---

## Setup

### 1. Install dependencies

```bash
cd bnb-token-distribution
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

**For local testing** (Hardhat):
```env
ALCHEMY_RPC_URL=http://127.0.0.1:8545
FALLBACK_RPC_1=http://127.0.0.1:8545
FALLBACK_RPC_2=http://127.0.0.1:8545
PRIVATE_KEY=ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TOKEN_ADDRESS=        # fill after deploy
MULTISENDER_ADDRESS=  # fill after deploy
```

**For BSC Testnet**:
```env
ALCHEMY_RPC_URL=https://bnb-testnet.g.alchemy.com/v2/YOUR_KEY
FALLBACK_RPC_1=https://data-seed-prebsc-1-s1.binance.org:8545
FALLBACK_RPC_2=https://data-seed-prebsc-2-s1.binance.org:8545
PRIVATE_KEY=your_deployer_private_key_here
TOKEN_ADDRESS=        # fill after deploy
MULTISENDER_ADDRESS=  # fill after deploy
```

### 3. Compile contracts

```bash
npm run compile
```

---

## Running the System

Run each step in order. Steps 1–4 run once; step 5 can be resumed if interrupted.

### Step 1 — Start local node (local testing only)

```bash
# Terminal 1 — keep this running
npx hardhat node
```

### Step 2 — Deploy ABCToken

```bash
# Local
npx hardhat run scripts/deploy-token.ts --network localhost

# BSC Testnet
npm run deploy:token
```

Copy the printed `TOKEN_ADDRESS` into `.env`.

### Step 3 — Deploy MultiSender

```bash
# Local
npx hardhat run scripts/deploy-multisender.ts --network localhost

# BSC Testnet
npm run deploy:multisender
```

Copy the printed `MULTISENDER_ADDRESS` into `.env`.

### Step 4 — Generate 100,000 wallets

```bash
npm run generate:wallets
```

**Output:**
- `output/wallets.csv` — 100,000 rows: index, address, privateKey, derivationPath
- `output/MASTER_MNEMONIC.txt` — master seed phrase

> ⚠️ **Security:** Keep `MASTER_MNEMONIC.txt` and `wallets.csv` private. They control all 100,000 wallets.

**Time:** ~8–9 minutes (BIP44 HD derivation for 100k wallets)

### Step 5 — Prepare distribution plan

```bash
npm run prepare:distribution
```

**Output:** `output/distribution-plan.json` — 100,000 entries with random amounts (100–300 tokens) and packed calldata.

**Time:** ~4 seconds

### Step 6 — Run distribution

```bash
npm run distribute
```

The script will:
1. Check and approve token allowance for MultiSender
2. Send 500 batches of 200 wallets each (5 in parallel)
3. Auto-retry any failed batches (up to 5 drain passes)
4. Save checkpoint after every parallel group
5. Export `distribution-log.csv` and `distribution-log.xlsx` on completion

**The script will NOT exit until all 100,000 wallets are successfully sent.**

> If interrupted (Ctrl+C), state is saved. Re-run `npm run distribute` to resume from the last checkpoint.

### Step 7 — Export results (optional)

```bash
npm run export
```

Generates fresh `distribution-log.csv` and `distribution-log.xlsx` from the current plan state.

---

## Architecture

```
generate-wallets.ts
    │  wallets.csv (100k wallets, BIP44)
    ▼
prepare-distribution.ts
    │  distribution-plan.json (random amounts, packed bytes32)
    ▼
distribute.ts
    │
    ├── ensureApproval()      approve MultiSender allowance
    │
    ├── SerialTxSubmitter     serialises nonce → sign → broadcast
    │
    ├── RpcManager            Alchemy primary → 2 Binance fallbacks
    │
    └── Drain Loop (5 passes)
            │
            ├── Pass 1: 500 batches × 200 wallets, 5 parallel
            ├── Pass 2: retry any failed batches from Pass 1
            └── Pass N: until 0 unsent wallets remain
                    │
                    ▼
            distribution-plan.json   (checkpoint, atomic write)
            distribution-log.csv     (final output)
            distribution-log.xlsx    (Excel report)
```

---

## Gas Optimizations

Three optimizations are applied in `MultiSender.sol`:

### 1. Packed Calldata

Each recipient is encoded as a single `bytes32` word:

```
bits 255–96 : address   (20 bytes)
bits  95– 0 : uint96    (12 bytes — whole token amount)
```

**Savings:** 32 bytes/recipient vs 64 bytes (naive) → **38% less calldata gas**

Built in `prepare-distribution.ts`:
```typescript
ethers.solidityPacked(["address", "uint96"], [address, amountWholeTokens])
```

Unpacked in `MultiSender.sol`:
```solidity
address recipient = address(uint160(uint256(packed[i]) >> 96));
uint256 amount    = uint256(uint96(uint256(packed[i]))) * 1e18;
```

### 2. Bitmap Duplicate Guard

```solidity
mapping(uint256 => uint256) private _claimed;
```

One 256-bit storage slot holds flags for **256 wallet indices**.

```solidity
uint256 bucket = index / 256;   // which slot
uint256 bit    = index % 256;   // which bit in that slot
```

**Savings:** ~78 gas per flag vs 20,000 gas (`mapping(address => bool)`) → **256× cheaper duplicate prevention**

### 3. Unchecked Loop Increment

```solidity
unchecked { ++i; }
```

Removes Solidity 0.8 overflow check from loop counter. **Saves ~40 gas × 200 iterations = 8,000 gas per batch.**

### Gas Comparison

| Approach | Gas / batch | Total gas (500 batches) | Cost @ 10 gwei |
|---|---|---|---|
| **This system** | 5,742,274 | 2,871,137,384 | **28.71 BNB** |
| Basic (no opts) | ~10,400,000 | ~5,200,000,000 | ~52.00 BNB |
| **Savings** | **-45%** | **-2.33B gas** | **-23.29 BNB** |

---

## RPC Strategy

| Provider | Role | Trigger |
|---|---|---|
| Alchemy (primary) | All nonce reads + broadcasts | Always tried first |
| Binance Fallback 1 | Backup broadcast | Alchemy returns 429 / timeout |
| Binance Fallback 2 | Last resort | Fallback 1 also rate-limited |

Non-rate-limit errors (nonce conflict, revert) are thrown immediately — no rotation.

---

## Retry & Resume Logic

### Per-batch retry
Each batch gets 3 attempts with exponential backoff:
```
Attempt 1 fails → wait 5s
Attempt 2 fails → wait 10s
Attempt 3 fails → wait 15s → mark as failed for drain loop
```

### Drain loop
After all 500 batches attempt in Pass 1, any failed entries are automatically re-queued:
```
Pass 1: 500 batches → e.g. 490 succeed, 10 fail
Pass 2: 10 batches → e.g. 9 succeed, 1 fails
Pass 3: 1 batch   → succeeds → "All wallets sent"
```
Maximum 5 passes. Stops early if no progress (e.g. out of BNB).

### Resume on restart
Every parallel group writes a checkpoint to `distribution-plan.json` atomically. On restart:
```
Already sent:  95,200
Remaining:       4,800
Resuming from last checkpoint automatically
```

---

## Security Notes

| Concern | Mitigation |
|---|---|
| Private key exposure | Stored in `.env` only — never in code |
| `.env` in git | `.gitignore` covers `.env`, `output/`, `wallets.csv` |
| Duplicate transfers | On-chain bitmap — `_claimed[bucket]` set before `transferFrom` |
| Reentrancy | `ReentrancyGuard` on `multisend()` |
| Wallet reuse | Each BIP44 index is unique — `m/44'/60'/0'/0/{i}` |
| Batch overflow | `require(len <= 200)` enforced on-chain |

---

## Output Files Reference

| File | Description |
|---|---|
| `output/wallets.csv` | index, address, privateKey, derivationPath |
| `output/MASTER_MNEMONIC.txt` | BIP44 master mnemonic (controls all wallets) |
| `output/distribution-plan.json` | Per-wallet state: sent, txHash, timestamp |
| `output/distribution-log.csv` | Sent wallets: address, amount, amountWei, txHash, timestamp |
| `output/distribution-log.xlsx` | Sheet 1: Distribution Log, Sheet 2: Unsent (if any), Sheet 3: Summary |
| `output/distribution.log` | Full timestamped console log of the run |

---

## Deploying to BSC Testnet

1. Get tBNB from [https://www.bnbchain.org/en/testnet-faucet](https://www.bnbchain.org/en/testnet-faucet)
2. Get a free Alchemy API key from [https://www.alchemy.com](https://www.alchemy.com)
3. Update `.env` with BSC Testnet values (see Setup section)
4. Run the same steps — no code changes required

```bash
npm run deploy:token
npm run deploy:multisender
# update .env with printed addresses
npm run generate:wallets
npm run prepare:distribution
npm run distribute
npm run export
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | BNB Smart Chain (BSC) |
| Smart contracts | Solidity 0.8.20 |
| Contract framework | Hardhat 2.22 |
| Contract library | OpenZeppelin 5.0 |
| Runtime | Node.js + TypeScript |
| Blockchain SDK | ethers.js v6 |
| Wallet generation | BIP44 HD derivation |
| Excel export | ExcelJS |
| Secrets | dotenv |

---

## Time Estimates (BSC Testnet, 3s block time)

| Step | Estimated Time |
|---|---|
| Generate 100k wallets | ~8–9 minutes |
| Prepare distribution plan | ~4 seconds |
| Deploy contracts | ~30 seconds |
| Full distribution (500 batches) | ~5–6 minutes |
| Export results | ~4 seconds |
| **Total end-to-end** | **~15 minutes** |

> Local Hardhat (instant mining): distribution completes in ~28 minutes due to serial nonce management overhead on the local node. BSC Testnet with 3s blocks is faster in practice.
