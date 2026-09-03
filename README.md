# MEV Auction Hook

A Uniswap v4 hook that intercepts every large swap, runs a short on-chain auction for execution rights, and donates the winning bid directly to in-range liquidity providers.

**MEV doesn't leave the pool. It stays inside as LP revenue.**

Live on Unichain Sepolia. Hook at `0xd73e4A0D49c5144e475A4a8F91C051D5B0a00080`.

## The problem

Liquidity providers on Uniswap bear all the downside of informed flow. Arbitrageurs and MEV bots trade against stale prices, extract value from pools, and LPs absorb the loss as impermanent loss. The swap fee is supposed to compensate for this risk — but research shows it does not cover arbitrage losses across most major pools.

The real problem is not the fee level. It is where the value goes. MEV bots extract it and take it out of the protocol entirely. LPs see nothing. Pools respond by widening spreads or raising fees, which punishes ordinary traders for damage they did not cause.

A pool has one fee and no way to tell an arbitrageur from a retail trader. This hook creates one.

## How it works

A large swap goes through three steps instead of one.

**1. `requestSwap(key, params)`** — The user submits a swap intent. Input tokens transfer immediately into hook custody. Swaps below a configurable `smallSwapThreshold` execute inline via an express lane with no delay and no auction. Large swaps open a timed bidding window.

**2. `submitBid(requestId, bidAmount)`** — During the window, any MEV searcher submits a bid denominated in the swap's input currency. Each bid must exceed the previous high. Outbid bidders' funds go into a pull-payment mapping rather than being pushed back — this removes the revert-griefing vector that exists in push-refund designs. Searchers call `withdrawRefund()` to pull their funds when outbid.

**3. `executeSwap(requestId)`** — After the window closes, anyone calls this. The swap executes inside a `poolManager.unlock()` callback. The winning bid is donated to in-range liquidity providers via `poolManager.donate()`. The output tokens go to the original requester, not the executor.

The `beforeSwap` hook reverts any swap that does not originate from an authorised `executeSwap` call. Bypassing the auction is not possible — 100% of swap volume on this pool flows through it.

If no bids arrive before the window closes, the swap still executes normally with zero donation. A trade can never be permanently blocked by a lack of searcher interest.

## What is actually new here

On-chain MEV recapture for LPs is a recognised goal. Several established designs exist:

| Project | Auction mechanism | Requires off-chain infra |
|---|---|---|
| MEV Blocker | Off-chain RPC relay | Yes |
| CoW Protocol | Off-chain solver network | Yes |
| Flashbots Protect | Mempool-level | Yes |
| EigenLayer AVS hooks | Off-chain AVS operators | Yes |
| **This** | **Direct on-chain calls to the hook** | **No** |

Every prior design that achieves meaningful recapture relies on off-chain actors — relayers, solvers, or AVS operators — to coordinate the auction. This introduces infrastructure requirements, trust assumptions in the coordination layer, and deployment friction that prevents permissionless use.

This hook requires none of that. The entire auction — intent submission, bidding, winner determination, and swap execution — happens through direct on-chain calls to a single deployed contract. There is no keeper, no relayer, no off-chain component of any kind.

## Evidence

Modelled against realistic pool parameters using `analysis/economics.py`. All assumptions are explicit in the script.

**At 75% searcher competition, 3-block auction window:**

| Pool | Daily volume | Baseline LP revenue | MEV donated to LPs | LP revenue boost | Extra cost to traders |
|---|---|---|---|---|---|
| Small community pool | $100K/day | $300/day | +$7/day | **+2.4%** | 0 bps |
| Mid-size pool | $1M/day | $3,000/day | +$328/day | **+10.9%** | 0 bps |
| High-volume pair (5 bps fee) | $10M/day | $5,000/day | +$7,500/day | **+150%** | 0 bps |

**Key result:** Uninformed traders pay zero extra cost. Small swaps use the express lane and execute immediately. Large uninformed swaps also pay no extra — there is no additional fee on the swap, only on the MEV the swap generates. The auction charges the MEV value that would have been extracted anyway.

**Sensitivity to searcher competition:**

| Searcher competition | LP revenue boost ($1M pool) | MEV captured/day |
|---|---|---|
| 30% | +4.4% | $131/day |
| 50% | +7.3% | $219/day |
| 75% | +10.9% | $328/day |
| 90% | +13.1% | $394/day |

The hook works even with low competition — any non-zero bid adds LP revenue that would otherwise have left the pool.

## Security design decisions

**Pull-payment refunds, not push.** Outbid searchers cannot grief the auction by making their refund address revert. Funds accumulate in `pendingRefunds[bidder][currency]` and are pulled at the bidder's discretion.

**beforeSwap as a mandatory gate.** The hook sets `beforeSwap: true` and reverts any swap not executed through its own `unlockCallback`. Direct pool swaps are impossible on this pool. Searchers cannot route around the auction.

**Express lane for small swaps.** Swaps below `smallSwapThreshold` execute immediately, same as a normal pool. The auction overhead is only for trades large enough to generate meaningful MEV.

**Bid currency matches swap direction.** For `zeroForOne` swaps, bids are in `currency0`. For the reverse, bids are in `currency1`. This keeps the bid denominated in the same asset as the trade, avoiding multi-currency accounting complexity.

**No oracle, no off-chain state.** The hook derives all decisions from on-chain inputs only: block numbers, token amounts, and caller addresses. There is nothing to manipulate or spoof.

## Honest limits

The 3-block (~3 second) window is short by design for demo purposes. A production deployment would use a longer window to attract more competitive bidding, approaching the upper bound of the sensitivity table above.

The hook only captures value from swaps on this specific pool. It does not affect other venues.

In the current demo environment, there are no independent MEV searchers. The demo uses the same wallet as both swapper and executor to show the full auction cycle. In a real deployment with real volume, searchers would monitor the chain for open auctions and compete to fill them.

Not audited. The demo pool uses mock tokens with an unguarded mint function. Do not use with real funds.

## Deployment

Unichain Sepolia, chain ID 1301.

| Contract | Address |
|---|---|
| Hook | `0xd73e4A0D49c5144e475A4a8F91C051D5B0a00080` |
| PoolManager | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
| TKNA (test token) | `0xD9776CeAe2DA210Ad271dF7316a287938ddE6565` |
| TKNB (test token) | `0xeC5Ccc8F8dD84Cf4A5156692D037e72B65a09c03` |

Pool parameters: fee 3000 (0.3%), tickSpacing 60.

Hook flags: `beforeSwap` only. The hook does not touch pricing and routers quote it normally.

Explorer: [unichain-sepolia.blockscout.com](https://unichain-sepolia.blockscout.com/address/0xd73e4A0D49c5144e475A4a8F91C051D5B0a00080)

## Tests

```bash
forge test -vv
```

20 tests pass. Coverage includes: express lane execution, competitive bidding across multiple searchers, outbid refund withdrawal, direct swap bypass rejection, LP fee growth after donation (both currency directions), zero-bid execution, auction timing guards, replay protection, swap cancellation with full refund, and a 10-swap simulation of the full MEV recapture cycle.

## Running the demo

```bash
# 1. Deploy the hook (CREATE2 mines an address with beforeSwap bit set)
forge script script/04_DeployMevAuctionHook.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast -vvv

# 2. Deploy test tokens and create pool with liquidity
forge script script/10_DeployTestTokens.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

forge script script/05_CreatePool.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 3. Run the full auction cycle
forge script script/06_RequestSwap.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
# (wait ~3 seconds for the window on Unichain)
forge script script/07_SubmitBid.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
# (wait for window to close)
forge script script/08_ExecuteSwap.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 4. Or use the frontend
cd mev-shield-ui && npm run dev
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `smallSwapThreshold` | 1 ether | Swaps below this use the express lane — no auction |
| `auctionWindowBlocks` | 3 blocks | Bidding window (~3 s on Unichain, 36 s on mainnet) |

Both are constructor immutables. Set them at deploy time for your target use case.

## Layout

```
src/
  MevAuctionHook.sol      Main hook contract
test/
  MevAuctionHook.t.sol    20 Forge tests
script/
  04_DeployMevAuctionHook.s.sol
  05_CreatePool.s.sol
  06_RequestSwap.s.sol
  07_SubmitBid.s.sol
  08_ExecuteSwap.s.sol
  09_WithdrawRefund.s.sol
  10_DeployTestTokens.s.sol
analysis/
  economics.py            Economic model: LP revenue boost vs pool parameters
docs/
  SPEC.md                 Formal mechanism specification
mev-shield-ui/            Next.js frontend — live contract interaction
```

## Status

Built for the Atrium Academy UHI10 Hookathon. Theme: Sustainable Liquidity & MEV Protection. Not audited. Do not use with real funds.
