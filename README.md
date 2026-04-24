# BNB Chain Token Distribution System

A production-grade BEP-20 token distribution system for BSC Testnet.
Distributes **50,000,000 ABC tokens** to **100,000 wallets** via gas-optimized
batch transactions on BNB Smart Chain Testnet.

---

## Prerequisites

- **Node.js 18+** and **npm**
- **Hardhat** (installed via npm — no global install needed)
- **Alchemy API key** for BSC Testnet RPC — sign up at https://www.alchemy.com/
- A BSC Testnet wallet with enough tBNB for gas
  (faucet: https://www.bnbchain.org/en/testnet-faucet)

---

## Setup Steps

### 1. Install dependencies

```bash
cd bnb-token-distribution
npm install
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```
ALCHEMY_RPC_URL=https://bnb-testnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=your_deployer_private_key_here
FALLBACK_RPC_1=https://data-seed-prebsc-1-s1.binance.org:8545
FALLBACK_RPC_2=https://data-seed-prebsc-2-s1.binance.org:8545
TOKEN_ADDRESS=           # fill after step 4
MULTISENDER_ADDRESS=     # fill after step 5
```

### 3. Compile contracts

```bash
npx hardhat compile
```

### 4. Deploy ABCToken

```bash
npx hardhat run scripts/deploy-token.ts --network bscTestnet
```

Copy the printed address into `.env` as `TOKEN_ADDRESS`.

### 5. Deploy MultiSender

```bash
npx hardhat run scripts/deploy-multisender.ts --network bscTestnet
```

Copy the printed address into `.env` as `MULTISENDER_ADDRESS`.

### 6. Generate 100,000 wallets

```bash
npx ts-node scripts/generate-wallets.ts
```

Outputs:
- `output/wallets.csv` — index, address, privateKey, derivationPath
- `output/MASTER_MNEMONIC.txt` — BIP44 master seed (keep secure)

Expected time: **3–5 minutes**

### 7. Prepare distribution plan

```bash
npx ts-node scripts/prepare-distribution.ts
```

Outputs:
- `output/distribution-plan.json` — per-wallet amounts, packed calldata, sent status

### 8. Run distribution

```bash
npx ts-node scripts/distribute.ts
```

Outputs:
- `output/distribution.log` — timestamped log of every batch
- `output/distribution-log.csv` — final record of all sent wallets

Expected time: **5–10 minutes** (500 batches × 5 parallel)

---

## Architecture Overview

### Why Batch Push instead of Merkle Claim

All 100,000 wallets are freshly generated and controlled by the deployer.
A Merkle-based claim pattern would require each wallet to independently hold
tBNB and call `claim()` — impossible for newly generated wallets with zero
balance. Batch Push sends tokens directly from the deployer to every wallet:
no user action required, no per-wallet BNB needed.

### Data Flow

```
generate-wallets.ts
        │ wallets.csv
        ▼
prepare-distribution.ts
        │ distribution-plan.json
        ▼
distribute.ts ──► RpcManager ──► Alchemy (primary)
        │                   └──► Binance Fallback RPCs
        │
        ├──► approve()  ──► ABCToken.sol
        └──► multisend() ──► MultiSender.sol ──► transferFrom × 200
```

### Resume Capability

After every parallel group of 5 batches completes, `distribute.ts` writes
the entire `distribution-plan.json` back to disk synchronously
(`fs.writeFileSync`). Each processed entry has `sent: true`, `txHash`, and
`timestamp`. On restart the script filters out `sent === true` entries and
picks up exactly where it left off.

Ctrl+C is also intercepted — the SIGINT handler logs the interruption and
exits cleanly; the last checkpoint is preserved.

---

## Gas Optimization Breakdown

Three optimizations are applied together in `MultiSender.sol`:

### 1. Packed Calldata (Optimization 1)

Instead of two separate arrays (`address[]` + `uint256[]`), each recipient
is encoded as a single `bytes32`:

```
bits 255–96 : address  (20 bytes)
bits  95– 0 : uint96   (12 bytes — whole-token amount, e.g. 147)
```

The contract unpacks and scales: `amount * 1e18` → actual wei.

**Saving:** 32 bytes/recipient vs 52 bytes → **~38% less calldata gas**

### 2. Bitmap Duplicate Guard (Optimization 2)

```solidity
mapping(uint256 => uint256) private _claimed;
```

One 256-bit storage slot tracks 256 wallet indices. Reading costs ~200 gas
(warm SLOAD); the first write costs ~20,000 gas but amortizes over 256
addresses vs 20,000 gas × 256 for a `mapping(address => bool)`.

**Saving:** 1 storage slot per 256 addresses → **~256× cheaper than bool mapping**

### 3. Unchecked Loop Increment (Optimization 3)

```solidity
unchecked { ++i; }
```

Solidity 0.8+ adds overflow checks on all arithmetic by default. The loop
counter can never overflow `uint256`, so the check is provably unnecessary.

**Saving:** ~40 gas per loop iteration

### Combined Gas Estimate

| Approach                    | Gas (est.)  | BNB @ 5 gwei | USD @ $600 |
|-----------------------------|-------------|--------------|------------|
| Naive 1-by-1                | 8.1B gas    | 40.5 BNB     | $24,300    |
| Batch only (200/tx)         | 6.0B gas    | 30.0 BNB     | $18,000    |
| Batch + packed calldata     | ~3.7B gas   | 18.5 BNB     | $11,100    |
| Batch + packed + bitmap     | ~3.5B gas   | 17.5 BNB     | $10,500    |

> **Note:** BSC Testnet gas is free. Mainnet figures are shown for reference
> and assume 5 gwei gas price and $600/BNB.

---

## RPC Strategy

**Primary:** Alchemy BSC Testnet (`ALCHEMY_RPC_URL`) — used for all nonce reads
and as the first broadcast target. Alchemy has the highest reliability and
rate limits.

**Fallbacks:** Two public Binance testnet nodes (`FALLBACK_RPC_1`,
`FALLBACK_RPC_2`). If Alchemy returns a 429, SERVER_ERROR, or TIMEOUT during
the 500 parallel batches, `RpcManager.broadcast()` transparently rotates to
the next provider without stopping execution.

---

## Time Estimates

| Step                    | Expected Duration |
|-------------------------|-------------------|
| `generate-wallets.ts`   | 3–5 minutes       |
| `prepare-distribution.ts` | < 30 seconds    |
| `distribute.ts`         | 5–10 minutes      |

---

## Security Notes

- `.env` is listed in `.gitignore` and is never committed.
- `output/` is listed in `.gitignore` — it contains wallet private keys.
- `output/MASTER_MNEMONIC.txt` controls all 100,000 generated wallets. Store
  it securely offline after generation.
- The on-chain bitmap in `MultiSender.sol` prevents duplicate sends even if
  `distribute.ts` is re-run or `multisend()` is called again externally.
  Anyone can verify: `multisender.isClaimed(walletIndex)` returns `true` for
  already-paid indices.

---

## Contract Addresses (BSC Testnet)

Fill in after deployment:

| Contract      | Address |
|---------------|---------|
| ABCToken      | _pending deployment_ |
| MultiSender   | _pending deployment_ |

---

## Resume Instructions

If `distribute.ts` is interrupted for any reason, simply re-run it:

```bash
npx ts-node scripts/distribute.ts
```

The script reads `output/distribution-plan.json`, skips all entries where
`sent === true`, and continues from the first unsent wallet. No duplicate
on-chain transfers will occur — the bitmap in `MultiSender.sol` provides a
second layer of protection even if the off-chain state is somehow incorrect.
# token-distribution
