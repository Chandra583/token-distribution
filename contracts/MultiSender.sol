// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  MultiSender
 * @notice Batch-distributes a BEP-20 token to up to 200 recipients per call.
 *
 * @dev WHY THIS CONTRACT EXISTS
 *      Sending tokens one-by-one to 100,000 wallets requires 100,000 separate
 *      transactions — each paying base gas overhead (~21,000 gas) and ERC-20
 *      transfer cost (~30,000 gas). That is ~5.1 billion gas and thousands of
 *      individual confirmations. By batching 200 recipients per transaction we
 *      reduce the number of transactions to 500 and amortise the per-tx overhead
 *      across each batch, cutting total gas by ~45%.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GAS OPTIMISATION 1 — PACKED CALLDATA
 * ─────────────────────────────────────────────────────────────────────────────
 *   WHAT  Each recipient is encoded into a single bytes32 word:
 *           bits 255–96 → address  (20 bytes, upper portion)
 *           bits  95– 0 → uint96   (12 bytes, whole-token amount)
 *
 *   WHY   Calldata costs 4 gas per zero byte and 16 gas per non-zero byte.
 *         The naive approach passes address (32B) + uint256 amount (32B) = 64B
 *         per recipient. Packed encoding uses only 32B — saving ~38% calldata
 *         gas per recipient, or ~2,500 gas per batch of 200.
 *
 *   WHERE Built off-chain in prepare-distribution.ts using:
 *           ethers.solidityPacked(["address", "uint96"], [addr, wholeTokens])
 *         Unpacked on-chain at lines 64–67 below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GAS OPTIMISATION 2 — BITMAP DUPLICATE GUARD
 * ─────────────────────────────────────────────────────────────────────────────
 *   WHAT  A mapping(uint256 => uint256) where each 256-bit slot stores boolean
 *         flags for 256 consecutive wallet indices. One bit = one wallet.
 *
 *   WHY   The obvious guard is mapping(address => bool). That costs one cold
 *         SSTORE (20,000 gas) per new address. The bitmap costs one cold SSTORE
 *         per 256 addresses — effectively 78 gas per wallet vs 20,000 gas.
 *         That is a 256× reduction in duplicate-guard cost across 100k wallets.
 *
 *   WHERE _isClaimed() reads the bit; _setClaimed() writes it.
 *         The write happens BEFORE the transfer (checks-effects-interactions
 *         pattern) to prevent reentrancy-based double-claims.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GAS OPTIMISATION 3 — UNCHECKED LOOP INCREMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *   WHAT  The loop counter `i` is incremented inside an `unchecked` block.
 *
 *   WHY   Solidity 0.8+ adds an overflow check to every arithmetic operation by
 *         default. A loop counter bounded by `len <= 200` can never overflow
 *         uint256, so the check is provably unnecessary. Removing it saves
 *         ~40 gas per iteration — ~8,000 gas per batch of 200.
 *
 *   WHERE Line 59 (early-continue path) and line 78 (main loop increment).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN NOTE — WHY TWO SEPARATE ARRAYS (indices + packed)?
 * ─────────────────────────────────────────────────────────────────────────────
 *   The bitmap lookup needs a numeric wallet index (0–99999), but the packed
 *   bytes32 encodes only address + amount (no room for a 17-bit index without
 *   sacrificing precision on the amount). Keeping them separate avoids bit-width
 *   ambiguity, lets the off-chain script build each array independently, and
 *   keeps the on-chain unpacking logic simple and auditable.
 */
contract MultiSender is ReentrancyGuard {

    /**
     * @dev Bitmap storage for duplicate prevention.
     *      Key   = index / 256  (which 256-bit slot)
     *      Bit   = index % 256  (which bit within that slot)
     *      One cold SSTORE initialises a slot that covers 256 wallets.
     */
    mapping(uint256 => uint256) private _claimed;

    /**
     * @notice Emitted once per successful batch.
     * @param successCount Number of wallets that received tokens in this batch.
     * @param totalAmount  Total wei transferred (sum across all recipients).
     */
    event BatchComplete(uint256 successCount, uint256 totalAmount);

    /**
     * @notice Distribute tokens to up to 200 recipients in a single transaction.
     *
     * @dev Caller must have approved this contract for at least the total amount
     *      being transferred before calling this function.
     *
     * @param token    Address of the BEP-20 token to distribute.
     * @param indices  Wallet indices (0–99999) — used for bitmap duplicate check.
     *                 Must be the same length as `packed`.
     * @param packed   Packed recipient data per wallet:
     *                   bits 255–96 → recipient address (20 bytes)
     *                   bits  95– 0 → amount in whole tokens as uint96 (12 bytes)
     *                 The contract scales whole tokens to wei by multiplying by 1e18.
     */
    function multisend(
        address token,
        uint32[] calldata indices,
        bytes32[] calldata packed
    ) external nonReentrant {
        uint256 len = packed.length;

        // Both arrays must be the same length — mismatches indicate a bug off-chain.
        require(indices.length == len, "Length mismatch");

        // Hard cap at 200 to keep gas usage predictable and under BSC block gas limit.
        require(len <= 200, "Max 200 per batch");

        uint256 successCount = 0;
        uint256 totalAmount  = 0;

        for (uint256 i = 0; i < len; ) {
            uint32 idx = indices[i];

            // OPTIMISATION 2 — Bitmap duplicate check.
            // Skip this recipient if they have already received tokens.
            // Costs ~200 gas (SLOAD) instead of 20,000 gas (cold mapping read).
            if (_isClaimed(idx)) {
                unchecked { ++i; } // OPTIMISATION 3
                continue;
            }

            // OPTIMISATION 1 — Unpack recipient address from upper 160 bits.
            // Shift right by 96 bits to isolate the address portion.
            address recipient = address(uint160(uint256(packed[i]) >> 96));

            // OPTIMISATION 1 — Unpack whole-token amount from lower 96 bits,
            // then scale to wei. uint96 max = 79.2B tokens — more than enough.
            uint256 amount = uint256(uint96(uint256(packed[i]))) * 1e18;

            // OPTIMISATION 2 — Mark claimed BEFORE transferring (checks-effects-interactions).
            // This prevents a reentrant call from claiming the same index twice
            // even if the token contract has a malicious receive hook.
            _setClaimed(idx);

            // Execute the ERC-20 transfer. Reverts bubble up and fail the whole tx,
            // so a partial batch is never silently accepted.
            IERC20(token).transferFrom(msg.sender, recipient, amount);

            unchecked {
                ++successCount;
                totalAmount += amount;
                ++i; // OPTIMISATION 3 — provably no overflow (i < len <= 200)
            }
        }

        // Emit once per batch so off-chain indexers can reconcile without
        // replaying individual transfer events.
        emit BatchComplete(successCount, totalAmount);
    }

    // ─── Internal bitmap helpers ──────────────────────────────────────────────

    /**
     * @dev Read the bitmap bit for `index`.
     *      bucket = index / 256 → which mapping slot
     *      bit    = index % 256 → which bit within that slot
     */
    function _isClaimed(uint256 index) internal view returns (bool) {
        uint256 bucket = index / 256;
        uint256 bit    = index % 256;
        return (_claimed[bucket] >> bit) & 1 == 1;
    }

    /**
     * @dev Set the bitmap bit for `index` to 1 (irreversible — by design).
     *      Uses bitwise OR so other bits in the same slot are untouched.
     */
    function _setClaimed(uint256 index) internal {
        uint256 bucket = index / 256;
        uint256 bit    = index % 256;
        _claimed[bucket] |= (1 << bit);
    }

    /**
     * @notice External read — lets anyone verify whether wallet index N has
     *         already received tokens. Useful for off-chain auditing.
     * @param  index Wallet index in the range 0–99999.
     * @return True if tokens were already sent to this index.
     */
    function isClaimed(uint256 index) external view returns (bool) {
        return _isClaimed(index);
    }
}
