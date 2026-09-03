# GovernedMevAuctionHook — Mechanism Specification

## Overview

`GovernedMevAuctionHook` is a Uniswap v4 hook that converts every large swap on its pool into an ascending on-chain auction. The winning bid is split between a donation to in-range liquidity providers (`poolManager.donate()`) and a rebate to the trader who requested the swap. The **split** is not a constant: it is the liquidity-weighted average of the pool's LP votes. Small swaps use an express lane and execute immediately with no auction overhead.

## Parameters

| Parameter | Symbol | Default | Description |
|---|---|---|---|
| Small swap threshold | `T` | 1 ether | Swaps with `abs(amountSpecified) < T` skip the auction |
| Auction window | `W` | 3 blocks | Open bidding period after a swap request |
| Default LP share | `S₀` | 10,000 bps | Split applied before any LP has voted (100% to LPs) |

`T` and `W` are constructor immutables. `S₀` is a constant.

## Hook flags

```
beforeSwap:          true   (enforces the no-bypass rule)
afterAddLiquidity:   true   (tracks LP voting weight)
afterRemoveLiquidity:true   (tracks LP voting weight)
all other flags:     false
```

The hook does not modify prices, quotes, or swap math. `afterAddLiquidity` / `afterRemoveLiquidity` return `ZERO_DELTA`.

## Auction state per request

```
sender          address     Who submitted the swap request
key             PoolKey     Which pool to swap in
params          SwapParams  zeroForOne, amountSpecified, sqrtPriceLimitX96 (normalised)
deadlineBlock   uint256     Last block at which bids are accepted (= block.number + W)
highestBid      uint256     Current highest bid amount
highestBidder   address     Who placed the highest bid (address(0) if none)
isCompleted     bool        Whether the swap has been executed or cancelled
```

Requests are indexed from 0 by `nextRequestId`. `pendingRefunds[bidder][currency]` tracks outbid funds available for withdrawal.

## Auction lifecycle

### 1. Request — `requestSwap(key, params)`

**Preconditions:** `params.amountSpecified < 0` (exact-input only); caller has approved the hook for `abs(amountSpecified)` of the input currency (ERC-20) or sends the exact ETH value (native).

**Execution:**
1. Transfer input tokens into hook custody.
2. Normalise `sqrtPriceLimitX96` to `MIN_SQRT_PRICE + 1` / `MAX_SQRT_PRICE - 1` if passed as zero.
3. Store the `SwapRequest` with `deadlineBlock = block.number + W`.
4. If `abs(amountSpecified) < T`: execute immediately via `_doExecuteSwap`.
5. Else: emit `SwapRequested`, opening the bidding window.

Input currency: `zeroForOne = true` → `currency0`; `false` → `currency1`.

### 2. Bid — `submitBid(requestId, bidAmount)`

**Preconditions:** request exists and not completed; `block.number < deadlineBlock`; `bidAmount > highestBid`. ERC-20 bids pass the amount as an argument and require approval; native bids use `msg.value`.

**Execution:**
1. Accept the bid in the same currency as the swap input.
2. Credit the previous `highestBid` to `pendingRefunds[previousBidder][bidCurrency]` (pull-payment).
3. Update `highestBid` / `highestBidder`; emit `BidSubmitted`.

### 3. Execute — `executeSwap(requestId)`

**Preconditions:** request exists and not completed; `block.number >= deadlineBlock`.

**Execution:**
1. Mark completed; call `poolManager.unlock(abi.encode(requestId, msg.sender))`.
2. In `unlockCallback`:
   a. `poolManager.swap(key, normalizedParams, "")`.
   b. Compute `lpShare = highestBid · effectiveLpShareBps(poolId) / 10_000`, `rebate = highestBid − lpShare`.
   c. If `lpShare > 0`: `poolManager.donate(key, lpShare, 0, "")` (or `(0, lpShare)` for a currency1 bid).
   d. `poolManager.take` the swap output to `sender`.
   e. Settle the swap input + `lpShare` from hook balance to the PoolManager.
   f. If `rebate > 0`: transfer it from the hook's balance to `sender`.
   g. Emit `SwapExecuted(requestId, executor, lpShare, rebate)`.

Any address may call `executeSwap`; it receives no reward. If `highestBid == 0`, the swap still executes with `lpShare = rebate = 0`.

### 4. Cancel — `cancelSwap(requestId)`

Only the requester, only before any bid, only if not completed. Refunds the input in full; emits `SwapCancelled`.

### 5. Withdraw refund — `withdrawRefund(currencyAddress)`

Any outbid bidder pulls their outbid funds. Reverts `NoRefundAvailable` if none.

## Direct swap prevention

`beforeSwap` reverts `DirectSwapNotAllowed` unless `_swapInProgress == true`, a flag set only inside `unlockCallback` during an authorised `executeSwap`. **It is impossible to swap on this pool without going through the auction.**

## Governance

### Voting — `vote(key, lpShareBps)`

**Preconditions:** `lpShareBps <= 10_000`.

**Execution:** the caller's contribution to the pool's weighted-vote sums is set (or replaced) using their current tracked weight `w = lpLiquidity[poolId][caller]`:

```
weightedVoteSum[poolId] += w · lpShareBps          (minus the old term on re-vote)
votingWeight[poolId]    += w                        (only on first vote)
```

A caller with `w == 0` may still vote; the vote is stored and takes effect when weight is later added.

### Effective split — `effectiveLpShareBps(poolId)`

```
votingWeight == 0  →  DEFAULT_LP_SHARE_BPS  (10_000)
otherwise          →  weightedVoteSum / votingWeight     (integer division, floor)
```

`getGovernanceInfo(key)` bundles `effectiveLpShareBps`, `traderRebateBps = 10_000 − effectiveLpShareBps`, `totalLiquidity`, and `votingWeight` for the frontend.

### LP weight tracking

`afterAddLiquidity` / `afterRemoveLiquidity` maintain `lpLiquidity[poolId][lp]` and `totalLiquidity[poolId]`. When the affected LP `hasVoted`, `votingWeight` and `weightedVoteSum` are adjusted by `Δweight` and `Δweight · lpVoteBps` so the weighted average stays exact in O(1).

### LP attribution

The `sender` in the liquidity callbacks is the PositionManager, not the LP. The LP is resolved as follows:

1. **Position key** `pk = keccak256(abi.encode(sender, tickLower, tickUpper, salt))`. For PositionManager positions `salt = bytes32(tokenId)`, so `pk` is stable across a position's adds and removes.
2. On an add where `positionAttribution[poolId][pk]` is unset, the hook decodes `hookData` as `abi.encode(address lp, bytes signature)` (inside a `try` so malformed data is ignored, not reverted) and checks:
   - `lp != address(0)`, `signature.length != 0`
   - `SignatureChecker.isValidSignatureNow(lp, digest, signature)` where
     `digest = toEthSignedMessageHash(keccak256(abi.encode(block.chainid, address(this), poolId, lp)))`
   If valid, `positionAttribution[poolId][pk] = lp`.
3. Tracked liquidity for the position is accumulated in `positionTrackedLiquidity[poolId][pk]`, and `_addWeight(poolId, lp, Δ)` is called.
4. On a remove, the hook reads `positionAttribution[poolId][pk]` — **`hookData` is not consulted** — and calls `_removeWeight` for that LP, clamped to `positionTrackedLiquidity[poolId][pk]`.

`attributionDigest(key, lp)` exposes the digest for signing. The attestation is bound to chain / hook / pool / LP but not to amount, nonce or position, so one signature covers all of an LP's deposits in the pool.

Liquidity added without a valid attestation is untracked: it earns fees and donations but carries zero voting weight, and never affects the vote sums.

## Properties

| Property | Mechanism |
|---|---|
| Auction bypass impossible | `beforeSwap` reverts all swaps not from `unlockCallback` |
| No locked funds | Zero-bid auctions still execute; cancelled requests refund in full |
| No refund griefing | Pull-payment — outbid funds never pushed to an untrusted address |
| No vote-weight desync | Attribution pinned to position key; removes ignore `hookData` |
| Attestations unforgeable for others | `SignatureChecker` over a chain/hook/pool/LP-bound digest |
| Malformed `hookData` is safe | Decoded in a `try`; failure ⇒ untracked, not reverted |
| No oracle dependence | State from the pool contract, caller inputs, and signatures only |
| No keeper needed | Anyone may `executeSwap` after the window; the winning bidder is incentivised |

### Known limitation

Transferring a position NFT does not transfer governance weight — ERC-721 transfers are invisible to the hook. Weight stays with the address that signed the attestation until that position's liquidity is removed.

## Economic properties

For a pool with volume `V`, informed flow fraction `f`, average MEV per informed swap `m`, searcher competition `c ∈ [0,1]`, and effective LP share `s ∈ [0,1]`:

```
Extractable MEV per day     = V · f · m
Winning bids per day        ≈ V · f · m · c
LP donation per day         ≈ V · f · m · c · s
Trader rebate per day       ≈ V · f · m · c · (1 − s)
LP revenue boost            = (V · f · m · c · s) / (V · fee_bps)
Uninformed trader cost      = 0 bps
```

At `s = 1` (default), 75% competition, a $1M/day pool with 0.30% fee and 15% informed flow gains ≈ **+10.9% LP revenue**. Voting `s < 1` trades part of that boost for a trader-facing rebate that can attract volume. See `analysis/economics.py`.
