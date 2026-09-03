# LP-Governed MEV Auction Hook

A Uniswap v4 hook that turns every large swap into a short on-chain auction for execution rights, then splits the winning bid between a donation to in-range liquidity providers and a rebate to the trader — **with the LPs of each pool voting on that split, weighted by their own liquidity.**

**Searcher bids that would otherwise leave the pool as extracted MEV stay inside it. Where that value goes — all to LPs, or partly back to traders — is a decision the LPs make on-chain.**

## The problem

Liquidity providers on Uniswap bear the downside of informed flow. Arbitrageurs and MEV bots trade against stale prices, extract value from pools, and LPs absorb the loss as impermanent loss. The swap fee is supposed to compensate for this — but empirical data shows it does not cover arbitrage losses across most major pools (Milionis et al. 2022; Canidio and Fritsch 2024).

The real problem is not the fee level. It is where the value goes. MEV bots extract it and take it out of the protocol entirely. LPs see nothing. Pools respond by widening spreads or raising fees, which punishes ordinary traders for damage they did not cause.

A pool has one fee and no way to tell an arbitrageur from a retail trader. This hook creates a market for execution rights — MEV that would have been extracted is instead auctioned, and the proceeds stay in the pool under rules the LPs set.

## How it works

A large swap goes through three steps instead of one.

**1. `requestSwap(key, params)`** — The user submits a swap intent. Input tokens transfer immediately into hook custody. Swaps below a configurable `smallSwapThreshold` execute inline via an express lane with no delay and no auction. Large swaps open a timed bidding window.

**2. `submitBid(requestId, bidAmount)`** — During the window, any MEV searcher submits a bid denominated in the swap's input currency. Each bid must exceed the previous high. Outbid bidders' funds go into a pull-payment mapping rather than being pushed back — this removes the revert-griefing vector that exists in push-refund designs. Searchers call `withdrawRefund()` to pull their funds when outbid.

**3. `executeSwap(requestId)`** — After the window closes, anyone calls this. The swap executes inside a `poolManager.unlock()` callback. The winning bid is split: the LP share is donated to in-range liquidity providers via `poolManager.donate()`, and the remainder is rebated to the original requester. The output tokens go to the requester, not the executor.

The `beforeSwap` hook reverts any swap that does not originate from an authorised `executeSwap` call. Bypassing the auction is not possible — 100% of swap volume on this pool flows through it.

If no bids arrive before the window closes, the swap still executes normally with zero donation and zero rebate. A trade can never be permanently blocked by a lack of searcher interest.

## LP governance — the new part

The revenue split is not a constant. Each pool's LPs decide it, continuously and on-chain.

**`vote(key, lpShareBps)`** — An LP sets the share of each winning bid that should go to LPs (0–10,000 bps); the remainder is the trader rebate. The vote is weighted by the caller's tracked liquidity in the pool.

**Effective split** — the liquidity-weighted average of all votes, recomputed in O(1) on every vote and every liquidity change:

```
effectiveLpShareBps = Σ(weight_i · vote_i) / Σ(weight_i)      over LPs who have voted
```

Before any LP votes, the pool uses a default of **100% to LPs** — identical to a pure MEV-recapture hook. A pool of passive LPs can leave it there. A pool competing for order flow can vote to hand traders a rebate and pull volume from other venues. The mechanism is the same; the economics are the LPs' call.

### How the hook knows who the LP is

v4 liquidity is added through the PositionManager singleton, so the `afterAddLiquidity` callback never sees the real LP — only the PositionManager. The hook resolves the LP from a **one-time signed attestation**:

- The LP signs the digest returned by `attributionDigest(key, lp)` — bound to the chain, this hook, the pool and the LP address, so it cannot be replayed elsewhere. It is not bound to an amount or nonce, so a frontend captures it once.
- The signature is passed as `hookData = abi.encode(lp, signature)` on the add-liquidity call. The hook verifies it (EOA or ERC-1271) before crediting voting weight.
- Attribution is then **pinned to the position key**. Removals debit the same LP the add credited, regardless of the `hookData` supplied at removal — closing the weight-desync vector.

Liquidity added without a valid attestation simply carries no governance weight; it still earns fees and donations normally.

**Known limitation:** transferring the position NFT to a new owner does not move the vote weight — the hook cannot observe ERC-721 transfers. This is the accepted trade-off for staying compatible with the standard PositionManager and the Uniswap UI.

## What is actually new here

On-chain MEV recapture for LPs is a recognised goal. Several established designs exist:

| Project | Auction mechanism | Requires off-chain infra | LPs set the economics |
|---|---|---|---|
| MEV Blocker | Off-chain RPC relay | Yes | No |
| CoW Protocol | Off-chain solver network | Yes | No |
| Flashbots Protect | Mempool-level | Yes | No |
| EigenLayer AVS hooks | Off-chain AVS operators | Yes | No |
| **This** | **Direct on-chain calls to the hook** | **No** | **Yes — per pool, liquidity-weighted** |

All major deployed MEV recapture systems rely on off-chain actors — relayers, solvers, or AVS operators — to coordinate the auction. This hook requires none of that: intent submission, bidding, winner determination, and swap execution all happen through direct on-chain calls to a single deployed contract. There is no keeper, no relayer, no off-chain component of any kind. And the revenue split is itself an on-chain, LP-controlled parameter rather than a protocol constant.

## Projected impact

Economic model with stated assumptions — not a backtest. All parameters are explicit and can be challenged. See `analysis/economics.py`. The model below assumes the default 100%-to-LP split; a pool that votes a trader rebate trades some of the LP boost for higher volume.

**At 75% searcher competition, 3-block auction window:**

| Pool | Daily volume | Baseline LP revenue | MEV donated to LPs | LP revenue boost | Extra cost to traders |
|---|---|---|---|---|---|
| Small community pool | $100K/day | $300/day | +$7/day | **+2.4%** | 0 bps |
| Mid-size pool | $1M/day | $3,000/day | +$328/day | **+10.9%** | 0 bps |
| High-volume pair (5 bps fee) | $10M/day | $5,000/day | +$7,500/day | **+150%** | 0 bps |

**Key result:** Small swaps use the express lane and execute immediately — zero extra cost. Large swaps experience a ~3-second delay on Unichain while the auction window is open; the opportunity cost of price movement during that window is negligible but not precisely zero. There is no additional fee on the swap itself — only the MEV value that would have been extracted anyway is auctioned.

**Sensitivity to searcher competition:**

| Searcher competition | LP revenue boost ($1M pool) | MEV captured/day |
|---|---|---|
| 30% | +4.4% | $131/day |
| 50% | +7.3% | $219/day |
| 75% | +10.9% | $328/day |
| 90% | +13.1% | $394/day |

The hook works even with low competition — any non-zero bid adds revenue that would otherwise have left the pool.

## Security design decisions

**Pull-payment refunds, not push.** Outbid searchers cannot grief the auction by making their refund address revert. Funds accumulate in `pendingRefunds[bidder][currency]` and are pulled at the bidder's discretion.

**beforeSwap as a mandatory gate.** The hook sets `beforeSwap: true` and reverts any swap not executed through its own `unlockCallback`. Direct pool swaps are impossible on this pool. Searchers cannot route around the auction.

**Vote weight cannot desync.** LP attribution is pinned to the position key on the first attested add. Removals never trust `hookData`, so a malicious removal cannot mis-credit weight or corrupt the weighted-average sums.

**Signature attestations are bound and verified.** `attributionDigest` binds chain id, hook address, pool id and LP. The hook verifies via OpenZeppelin `SignatureChecker` (EOA and ERC-1271). A forged attestation for an address the caller does not control is rejected.

**Express lane for small swaps.** Swaps below `smallSwapThreshold` execute immediately, same as a normal pool.

**Bid currency matches swap direction.** For `zeroForOne` swaps, bids and the trader rebate are in `currency0`; for the reverse, `currency1`. This avoids multi-currency accounting.

**No oracle, no off-chain state.** The hook derives all decisions from on-chain inputs only: block numbers, token amounts, caller addresses, and signed attestations. There is nothing to manipulate or spoof.

## Honest limits

The 3-block (~3 second) window is short by design for demo purposes. A production deployment would use a longer window to give more searchers time to participate.

The hook only captures value from swaps on its own pool. It does not affect other venues.

Transferring a position NFT does not move governance weight (see above).

The auction recaptures MEV only in proportion to how competitive the bidding is. With a single searcher and no rival, the bid floor is minimal. With zero searchers, nothing is captured — but the trade still executes.

In the current demo environment there are no independent MEV searchers. The demo uses the same wallet as both swapper and bidder to show the full auction cycle. A real deployment with meaningful volume creates the same incentive structure that drives searcher activity in every competitive MEV environment — the difference is that here the bidding happens on-chain, and the proceeds go to LPs (and optionally traders) rather than to validators.

Not audited. The demo pool uses mock tokens with an unguarded mint function. Do not use with real funds.

## Deployment

Live on **Unichain Sepolia** (chain ID 1301), source verified.

| Contract | Address |
|---|---|
| **Hook (`GovernedMevAuctionHook`)** | [`0x503c79Ce11bC76E7aEeafcbe1db9A19d8D148580`](https://sepolia.uniscan.xyz/address/0x503c79Ce11bC76E7aEeafcbe1db9A19d8D148580) ✓ verified |
| TKNB — pool `currency0` | `0xC0DaC1ca4ac03140733850e39b0dBd115Ec0e5f3` |
| TKNA — pool `currency1` | `0xD490Dc2cD0b58f6a1C31C3B491eb515A720c93D7` |
| PoolManager (Uniswap) | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |

Pool ID `0x988a10555891c2fd1459a6c50f93a725a2324ff809273d410efa84c68cd99995` — fee 3000 (0.3%), tickSpacing 60. Note the token sort order: TKNB sorts below TKNA, so **TKNB is `currency0`**.

Hook flags: `beforeSwap`, `afterAddLiquidity`, `afterRemoveLiquidity` — the low bits of the address are `0x580`, mined with CREATE2. The hook does not touch pricing and routers quote it normally.

### Verified on-chain behaviour

The complete cycle has been executed against this deployment: liquidity added with a signed attestation (crediting 111.78e18 of voting weight), a vote cast at **6000 bps**, a 2-token swap requested, a 0.1 bid submitted, and the swap executed. The trader received back exactly `40000000000000000` wei — the 40% rebate the LP vote dictated — with the remaining 60% donated to LPs and **zero dust left in the hook**.

### Deploying your own

```bash
forge script script/12_DeployGovernedMevAuctionHook.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
```

Then set `HOOK_ADDRESS` (and the frontend's `NEXT_PUBLIC_HOOK_ADDRESS`) to the deployed address and continue with the demo below.

> **The optimizer must stay enabled** (`optimizer = true`, `optimizer_runs = 200` in `foundry.toml`). Unoptimized this contract compiles to ~27.9 KB and is rejected by EIP-170's 24,576-byte limit; optimized it is 15,440 bytes.

Source verification is a separate step and works on an already-deployed address:

```bash
forge verify-contract <HOOK_ADDRESS> \
  src/GovernedMevAuctionHook.sol:GovernedMevAuctionHook \
  --chain 1301 --etherscan-api-key $UNISCAN_API_KEY --compiler-version 0.8.30 \
  --constructor-args $(cast abi-encode 'constructor(address,uint256,uint256)' \
      0x00B036B58a818B1BC34d502D3fE730Db729e62AC 1000000000000000000 3) \
  --watch
```

Do not pass `--verifier-url https://api-sepolia.uniscan.xyz/api` — that is the retired Etherscan V1 endpoint. Omitting it routes through the V2 multichain API, which is what Uniscan now runs.

## Tests

```bash
forge test -vv
```

**49 tests pass** across two suites (plus 6 from the v4 template's `EasyPosm` helper).

`test/GovernedMevAuctionHook.t.sol` — 13 tests on the core governance path: liquidity-weighted vote averaging, vote weight following liquidity changes, the governed split donating to LPs and rebating to the trader, rejection of forged and unsigned attestations, and proof that a removal carrying someone else's attestation cannot desync the vote sums.

`test/GovernedMevAuctionHookEdgeCases.t.sol` — 36 tests grouped in four blocks:

| Block | Coverage |
|---|---|
| Auction mechanics | Express-lane inline settlement, `beforeSwap` bypass rejection, competitive bidding with pull-refund withdrawal, executor cannot take the output, zero-bid execution, reverse-direction (`oneForZero`) donation and rebate in `currency1` |
| Input validation | One test per custom error — `OnlyExactIn`, `UnexpectedETH`, `BidTooLow` (bids must *strictly* exceed), `RequestNotFound`, `AuctionAlreadyClosed`, `AuctionStillOpen`, `AlreadyExecuted`, `NoRefundAvailable`, `NotRequester`, `BidsAlreadySubmitted`, `InvalidShare` |
| Governance boundaries | 0 bps (whole bid rebated) and 10,000 bps accepted while 10,001 reverts; re-voting replaces rather than double-counts weight; a zero-weight vote activates when liquidity arrives; an exiting LP drops out of the average; integer division floors |
| Attribution | Malformed `hookData` cannot brick a deposit; the legacy bare-address format is ignored; an attestation signed for another pool on the same hook is rejected; topping up an attributed position needs no `hookData` and cannot be hijacked; ERC-1271 contract wallets are accepted; `attributionDigest` matches the recipe the frontend signs |

Two value-conservation invariants are asserted directly: after an awkward split (3333 bps on an odd-wei bid) the hook holds **zero** of both tokens, and a fuzzed vote/bid pair always leaves the trader exactly `bid − floor(bid × bps / 10000)` with nothing retained by the hook. A third fuzz test asserts that a signature from any key other than the LP's never credits that LP, never tracks liquidity, and never moves the split.

## Running the demo

```bash
# 1. Deploy the hook
forge script script/12_DeployGovernedMevAuctionHook.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
# → set HOOK_ADDRESS in .env

# 2. Deploy test tokens and create the pool
forge script script/10_DeployTestTokens.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
forge script script/05_CreatePool.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 3. Add governed liquidity (signs the attribution attestation for you) and vote
forge script script/14_AddLiquidityGoverned.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
LP_SHARE_BPS=6000 forge script script/13_Vote.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 4. Run the auction cycle
forge script script/11_DemoAuction.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
# wait for the window to close, then:
forge script script/08_ExecuteSwap.s.sol \
  --rpc-url $UNICHAIN_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv

# 5. Or use the frontend
cd frontend && npm install && npm run letdev
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `smallSwapThreshold` | 1 ether | Swaps below this use the express lane — no auction |
| `auctionWindowBlocks` | 3 blocks | Bidding window (~3 s on Unichain, 36 s on mainnet) |
| `DEFAULT_LP_SHARE_BPS` | 10,000 | Split used before any LP has voted (100% to LPs) |

`smallSwapThreshold` and `auctionWindowBlocks` are constructor immutables.

## Layout

```
src/
  GovernedMevAuctionHook.sol   The hook: auction + LP-governed split + attribution
test/
  GovernedMevAuctionHook.t.sol          13 tests — core governance path
  GovernedMevAuctionHookEdgeCases.t.sol 36 tests — mechanics, errors, boundaries, fuzz
script/
  05_CreatePool.s.sol
  06_RequestSwap.s.sol
  07_SubmitBid.s.sol
  08_ExecuteSwap.s.sol
  09_WithdrawRefund.s.sol
  10_DeployTestTokens.s.sol
  11_DemoAuction.s.sol             requestSwap + submitBid in one broadcast
  12_DeployGovernedMevAuctionHook.s.sol
  13_Vote.s.sol                    cast an LP governance vote
  14_AddLiquidityGoverned.s.sol    add liquidity with a signed attribution
analysis/
  economics.py                 LP revenue boost vs pool parameters
docs/
  SPEC.md                      Formal mechanism specification
frontend/                      Next.js app — swap, auctions, governance, activity
```

## Status

Built for the Atrium Academy UHI10 Hookathon. Theme: Sustainable Liquidity & MEV Protection. Not audited. Do not use with real funds.
