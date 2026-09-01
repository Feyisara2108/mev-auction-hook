# MEV Auction Hook

A Uniswap v4 hook that intercepts every swap, holds the input tokens, and runs a short on-chain auction before execution. MEV searchers compete to fill the trade. The winning bid is donated directly to in-range liquidity providers.

Think of it as redirecting the value that bots were going to extract anyway — straight back to the people whose capital made the trade possible.

## Why

Liquidity providers on Uniswap bear all the downside of informed flow. Arbitrageurs trade against stale prices whenever the pool lags the market, and LPs absorb the difference as impermanent loss. The swap fee is supposed to compensate for this, but research shows it does not. Milionis et al. show that LVR (loss-versus-rebalancing) is the dominant drain on LP capital, and Fritsch & Canidio find that fees fail to cover arbitrage losses across most major pools.

The actual problem is not the fee level. It is that the value MEV bots capture never reaches LPs at all. Sandwich bots, backrunners, and arbitrageurs extract value from pools they depend on, and LPs see none of it. Pools compensate by running wider spreads or charging higher fees, which punishes ordinary traders for damage they did not cause.

Charging searchers for the right to fill a trade is the obvious fix. Making that work without any off-chain infrastructure is the hard part.

## How

A swap goes through three steps instead of one.

1. **`requestSwap(key, params)`** — The user submits a swap intent. Input tokens are taken into hook custody immediately. Swaps below a configurable `smallSwapThreshold` execute inline via an express lane — no delay, no auction. Large swaps open a bidding window.

2. **`submitBid(requestId, bidAmount)`** — During the window, any MEV searcher submits a bid denominated in the swap's input currency (currency0 for zeroForOne swaps, currency1 for the reverse). Each bid must exceed the previous high. Outbid bidders' funds are credited to a pull-payment mapping rather than pushed back directly — this removes the revert-griefing vector present in push-refund designs.

3. **`executeSwap(requestId)`** — After the window closes, anyone calls this. The swap executes inside a `poolManager.unlock()` callback. The winning bid is donated to in-range LPs via `poolManager.donate()`. The output goes to the original requester, not the caller.

The `beforeSwap` hook reverts any swap that does not originate from an authorised `executeSwap` call. It is not possible to bypass the auction — 100% of swap volume on this pool flows through it.

If no bids arrive before the window closes, the swap still executes normally with zero donation. A trade can never be permanently blocked by a lack of searcher interest.

## What is actually new here

On-chain MEV recapture for LPs is a recognised goal. Several designs have approached it:

| Project | Auction coordination | Requires off-chain infra |
|---|---|---|
| MEV Blocker | Off-chain RPC relay | Yes |
| CoW Protocol | Off-chain solver network | Yes |
| Flashbots Protect | Mempool-level | Yes |
| EigenLayer AVS hooks | Off-chain AVS operators | Yes |
| This | Direct calls to the hook contract | No |

Every prior design that achieves meaningful recapture relies on off-chain actors — relayers, solvers, or AVS operators — to coordinate the auction. This requires infrastructure to run, introduces trust assumptions in the coordination layer, and cannot be deployed by simply initialising a pool.

This hook requires none of that. The entire auction — intent submission, bidding, winner determination, and swap execution — happens through direct on-chain calls to a single deployed contract. There is no keeper, no relayer, no off-chain component of any kind.

## Layout

```
src/        Hook contract (MevAuctionHook.sol)
test/       Forge test suite (MevAuctionHook.t.sol)
script/     Deploy and interaction scripts (numbered 04–09)
```

## Development

```bash
forge test -vv
```

20 tests pass, covering: express lane execution, competitive bidding, outbid refund withdrawal, direct swap bypass rejection, LP fee growth after donation (both currency0 and currency1 donation paths), zero-bid execution, timing guards, replay protection, swap cancellation, and a simulation of MEV recapture over 10 swaps.

## Deployment (Unichain Sepolia)

```bash
# 1. Copy the env template and fill in your values
cp .env.example .env

# 2. Deploy the hook (mines a CREATE2 address encoding BEFORE_SWAP flag)
forge script script/04_DeployMevAuctionHook.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast --verify \
  --verifier-url https://api-sepolia.uniscan.xyz/api \
  --etherscan-api-key $UNISCAN_API_KEY \
  -vvv

# 3. Copy the deployed address to HOOK_ADDRESS in .env
# 4. Set TOKEN0_ADDRESS and TOKEN1_ADDRESS in .env

# 5. Create pool and seed liquidity
forge script script/05_CreatePool.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 6. Request a swap (opens a 3-block auction)
forge script script/06_RequestSwap.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 7. Place a bid (as an MEV searcher)
#    Set REQUEST_ID and BID_AMOUNT in .env first
forge script script/07_SubmitBid.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 8. Execute the swap after the window closes (~3 seconds on Unichain)
forge script script/08_ExecuteSwap.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 9. (Optional) Withdraw any outbid refunds
forge script script/09_WithdrawRefund.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `smallSwapThreshold` | 1 ether | Swaps below this bypass the auction entirely |
| `auctionWindowBlocks` | 3 blocks | Bidding window duration (~3 s on Unichain) |

Both are constructor arguments and immutable after deployment.

## Status

Work in progress. Not audited. Do not use with real funds.
