# MEV Auction Hook — Mechanism Specification

## Overview

The MEV Auction Hook is a Uniswap v4 `beforeSwap` hook that converts every large swap into a sealed-bid ascending auction. The winning bid is donated to in-range liquidity providers via `poolManager.donate()`. Small swaps use an express lane and execute immediately with no auction overhead.

## Parameters

| Parameter | Symbol | Default | Description |
|---|---|---|---|
| Small swap threshold | `T` | 1 ether | Swaps with `abs(amountSpecified) < T` skip the auction |
| Auction window | `W` | 3 blocks | Duration of the open bidding period after a swap request |

Both are constructor immutables. They cannot be changed after deployment.

## State per request

Each swap intent is stored as a `SwapRequest` struct:

```
sender          address     Who submitted the swap request
key             PoolKey     Which pool to swap in
params          SwapParams  zeroForOne, amountSpecified, sqrtPriceLimitX96 (normalised)
deadlineBlock   uint256     Last block at which bids are accepted (= block.number + W)
highestBid      uint256     Current highest bid amount
highestBidder   address     Who placed the highest bid (or address(0) if none)
isCompleted     bool        Whether the swap has been executed or cancelled
```

Requests are indexed from 0 by `nextRequestId`. The mapping `pendingRefunds[bidder][currency]` tracks outbid funds available for withdrawal.

## Auction lifecycle

### 1. Request — `requestSwap(key, params)`

**Preconditions:**
- `params.amountSpecified < 0` (exact-input only)
- Caller has approved the hook to spend `abs(amountSpecified)` of the input currency (for ERC-20), or sends the correct ETH value (for native ETH)

**Execution:**
1. Transfer input tokens from caller into hook custody
2. Normalise `sqrtPriceLimitX96` to `MIN_SQRT_PRICE + 1` / `MAX_SQRT_PRICE - 1` if passed as zero
3. Store the `SwapRequest` with `deadlineBlock = block.number + W`
4. If `abs(amountSpecified) < T`: execute immediately via express lane (`_doExecuteSwap`), emit `SwapExecuted`
5. Else: emit `SwapRequested`, open bidding window

**Input currency direction:**
- `zeroForOne = true` → input is `currency0`
- `zeroForOne = false` → input is `currency1`

### 2. Bid — `submitBid(requestId, bidAmount)`

**Preconditions:**
- Request exists and is not completed
- `block.number < deadlineBlock` (auction still open)
- `bidAmount > highestBid` (must strictly outbid)
- For ERC-20 bids: caller has approved the bid currency to the hook, and `bidAmount` is passed as an argument
- For native ETH bids: `msg.value` is the bid amount (bidAmount argument is ignored)

**Execution:**
1. Accept bid in the same currency as the swap input
2. Credit the previous `highestBid` to `pendingRefunds[previousBidder][bidCurrency]` (pull-payment)
3. Update `highestBid` and `highestBidder`
4. Emit `BidSubmitted`

The pull-payment pattern prevents a griefing attack where a malicious bidder makes their refund address revert, locking the auction.

### 3. Execute — `executeSwap(requestId)`

**Preconditions:**
- Request exists and is not completed
- `block.number >= deadlineBlock` (auction window closed)

**Execution:**
1. Mark request completed
2. Call `poolManager.unlock(abi.encode(requestId))`
3. In `unlockCallback`:
   a. Execute the swap via `poolManager.swap(key, normalizedParams, "")`
   b. If `highestBid > 0`: donate bid to LPs via `poolManager.donate(key, bid, 0, "")` (or the reverse for currency1 bids)
   c. Take the output tokens to the original `sender`
   d. Settle the input tokens + bid from hook balance to PoolManager
4. Emit `SwapExecuted`

Any address may call `executeSwap`. The caller receives no special reward (this keeps the execution incentive simple — searchers who won the auction have a natural incentive to execute).

If no bids were placed (`highestBid == 0`), the swap still executes normally. The LP donation is zero. The trader's swap is not blocked.

### 4. Cancel — `cancelSwap(requestId)`

**Preconditions:**
- Caller is the original requester
- Request is not completed
- `highestBid == 0` (no bids yet — once a bid is in, the requester cannot cancel)

**Execution:**
1. Mark request completed
2. Refund input tokens to requester
3. Emit `SwapCancelled`

### 5. Withdraw refund — `withdrawRefund(currencyAddress)`

Any outbid bidder can call this at any time to pull their previously outbid funds. Reverts with `NoRefundAvailable` if the caller has no pending refund in that currency.

## Direct swap prevention

The hook's `beforeSwap` callback reverts with `DirectSwapNotAllowed` unless `_swapInProgress == true`. This flag is only set inside `unlockCallback` during an authorised `executeSwap` call.

This means: **it is impossible to swap on this pool without going through the auction.** All volume flows through `requestSwap → (auction) → executeSwap`.

## MEV Auction Hook flags

```
beforeSwap:         true   (enforces the no-bypass rule)
afterSwap:          false
all other flags:    false
```

The hook only touches the `beforeSwap` path. It does not modify prices, quotes, or any other pool behaviour.

## Economic properties

For a pool with volume `V`, informed flow fraction `f`, and average MEV per informed swap `m`:

```
Extractable MEV per day = V × f × m
LP donation per day     ≈ V × f × m × c    where c = searcher competition ratio (0–1)
LP revenue boost        = donation / (V × fee_bps)
Uninformed trader cost  = 0 bps             (express lane or no extra charge)
```

At 75% searcher competition, a $1M/day pool with 0.30% base fee and 15% informed flow gains approximately **+10.9% LP revenue** over the baseline fee alone.

See `analysis/economics.py` for the full sensitivity model.

## Security properties

| Property | Mechanism |
|---|---|
| Auction bypass impossible | `beforeSwap` reverts all swaps not from `unlockCallback` |
| No locked funds | Failed auctions (0 bids) still execute; cancelled requests get full refund |
| No griefing via refunds | Pull-payment pattern — outbid funds never pushed to untrusted address |
| No oracle dependence | All state is from the pool contract and caller inputs |
| No keeper needed | Any address can call `executeSwap` after the window; there is always an incentive for the winning bidder |
